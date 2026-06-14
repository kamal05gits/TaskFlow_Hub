const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  DATA_DIR: path.join(__dirname, "data"),
  DB_FILE: path.join(__dirname, "data", "db.json"),
  PUBLIC_DIR: path.join(__dirname, "public"),
  COOKIE_EXPIRY_SECONDS: 60 * 60 * 24 * 7 // 1 week
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const EDITABLE_TASK_PROPERTIES = new Set(["title", "description", "dueDate", "priority", "status"]);

let database = { users: [], sessions: [], tasks: [] };
let writeQueue = Promise.resolve();
const activeSseSubscribers = new Map();

// --- Core Helper Utilities ---
const getTimestamp = () => new Date().toISOString();
const generateUUID = () => crypto.randomUUID();
const cleanEmail = (email) => String(email || "").trim().toLowerCase();

const formatPublicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  createdAt: user.createdAt
});

function computeHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function checkPassword(password, storedCombinedHash) {
  const [salt, savedHash] = String(storedCombinedHash || "").split(":");
  if (!salt || !savedHash) return false;
  
  const currentHash = computeHash(password, salt).split(":")[1];
  const currentBuffer = Buffer.from(currentHash, "hex");
  const savedBuffer = Buffer.from(savedHash, "hex");
  
  // timingSafeEqual requires buffers of identical length to avoid throwing a crash error
  if (currentBuffer.length !== savedBuffer.length) return false;
  return crypto.timingSafeEqual(currentBuffer, savedBuffer);
}

// --- Persistence Layer ---
async function initializeStorage() {
  await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });
  try {
    const rawData = await fs.readFile(CONFIG.DB_FILE, "utf8");
    database = JSON.parse(rawData);
    database.users ||= [];
    database.sessions ||= [];
    database.tasks ||= [];
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    await persistStorage();
  }
}

function persistStorage() {
  writeQueue = writeQueue.then(() =>
    fs.writeFile(CONFIG.DB_FILE, JSON.stringify(database, null, 2), "utf8")
  );
  return writeQueue;
}

function purgeExpiredSessions() {
  const nowMs = Date.now();
  const initialCount = database.sessions.length;
  database.sessions = database.sessions.filter(s => new Date(s.expiresAt).getTime() > nowMs);
  if (database.sessions.length !== initialCount) {
    persistStorage().catch(err => console.error("Session cleanup failure:", err));
  }
}

// --- HTTP Request and Cookie Parsing ---
function parseIncomingCookies(request) {
  return Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map(pair => pair.trim())
      .filter(Boolean)
      .map(pair => {
        const idx = pair.indexOf("=");
        if (idx === -1) return [pair, ""];
        return [decodeURIComponent(pair.slice(0, idx)), decodeURIComponent(pair.slice(idx + 1))];
      })
  );
}

function createSessionRecord(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + CONFIG.COOKIE_EXPIRY_SECONDS * 1000).toISOString();
  database.sessions.push({ token, userId, expiresAt, createdAt: getTimestamp() });
  return { token, expiresAt };
}

function resolveSessionUser(request) {
  purgeExpiredSessions();
  const token = parseIncomingCookies(request).session;
  if (!token) return null;

  const session = database.sessions.find(s => s.token === token);
  if (!session) return null;

  return database.users.find(u => u.id === session.userId) || null;
}

function writeSessionCookie(response, token) {
  response.setHeader(
    "Set-Cookie",
    `session=${encodeURIComponent(token)}; Max-Age=${CONFIG.COOKIE_EXPIRY_SECONDS}; Path=/; HttpOnly; SameSite=Lax`
  );
}

function destroySessionCookie(response) {
  response.setHeader("Set-Cookie", "session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
}

// --- API Helpers ---
const replyWithJson = (res, code, payload) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
};

const replyWithError = (res, code, msg) => replyWithJson(res, code, { error: msg });

async function extractJsonBody(request) {
  let accumulated = "";
  for await (const chunk of request) {
    accumulated += chunk;
    if (accumulated.length > 1000000) throw new Error("Payload size limit exceeded.");
  }
  if (!accumulated.trim()) return {};
  try {
    return JSON.parse(accumulated);
  } catch {
    const error = new Error("Malformed JSON body.");
    error.statusCode = 400;
    throw error;
  }
}

// --- Business Domain Handlers: Tasks ---
function getClientOrderedTasks(userId) {
  return database.tasks
    .filter(t => t.userId === userId)
    .sort((a, b) => {
      const statuses = { "in-progress": 0, todo: 1, done: 2 };
      const priorities = { high: 0, medium: 1, low: 2 };
      return (
        statuses[a.status] - statuses[b.status] ||
        priorities[a.priority] - priorities[b.priority] ||
        String(a.dueDate || "9999-12-31").localeCompare(String(b.dueDate || "9999-12-31")) ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    })
    .map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      dueDate: t.dueDate,
      priority: t.priority,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    }));
}

function processAndValidateTask(payload, isPartialUpdate = false) {
  const sanitised = {};

  if (!isPartialUpdate || Object.hasOwn(payload, "title")) {
    const title = String(payload.title || "").trim();
    if (!title) throw Object.assign(new Error("Task title is required."), { statusCode: 400 });
    if (title.length > 120) throw Object.assign(new Error("Title maximum capacity is 120 characters."), { statusCode: 400 });
    // Sanitize to prevent malicious script strings
    sanitised.title = title;
  }
  if (!isPartialUpdate || Object.hasOwn(payload, "description")) {
    sanitised.description = String(payload.description || "").trim().slice(0, 1000);
  }
  if (!isPartialUpdate || Object.hasOwn(payload, "dueDate")) {
    const dateStr = String(payload.dueDate || "").trim();
    if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw Object.assign(new Error("Invalid due date structure. Use YYYY-MM-DD."), { statusCode: 400 });
    }
    sanitised.dueDate = dateStr;
  }
  if (!isPartialUpdate || Object.hasOwn(payload, "priority")) {
    const priority = String(payload.priority || "medium").toLowerCase();
    if (!["low", "medium", "high"].includes(priority)) {
      throw Object.assign(new Error("Priority options: low, medium, high."), { statusCode: 400 });
    }
    sanitised.priority = priority;
  }
  if (!isPartialUpdate || Object.hasOwn(payload, "status")) {
    const status = String(payload.status || "todo").toLowerCase();
    if (!["todo", "in-progress", "done"].includes(status)) {
      throw Object.assign(new Error("Status options: todo, in-progress, done."), { statusCode: 400 });
    }
    sanitised.status = status;
  }
  return sanitised;
}

function dispatchSseUpdate(userId) {
  const subscribers = activeSseSubscribers.get(userId);
  if (!subscribers || subscribers.size === 0) return;

  const dataPayload = { tasks: getClientOrderedTasks(userId), updatedAt: getTimestamp() };
  for (const clientResponse of subscribers) {
    clientResponse.write(`event: tasks-changed\n`);
    clientResponse.write(`data: ${JSON.stringify(dataPayload)}\n\n`);
  }
}

// --- Router Engines ---
async function routeAuthentication(req, res, pathName) {
  if (req.method === "POST" && pathName === "/api/auth/register") {
    const body = await extractJsonBody(req);
    const name = String(body.name || "").trim();
    const email = cleanEmail(body.email);
    const password = String(body.password || "");

    if (!name || !email || !password) { replyWithError(res, 400, "All registration fields required."); return true; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { replyWithError(res, 400, "Invalid email pattern."); return true; }
    if (password.length < 8) { replyWithError(res, 400, "Password length threshold not achieved (Min: 8)."); return true; }
    if (database.users.some(u => u.email === email)) { replyWithError(res, 409, "Account already assigned to this email."); return true; }
    
    const newUser = { id: generateUUID(), name, email, passwordHash: computeHash(password), createdAt: getTimestamp() };
    database.users.push(newUser);
    const session = createSessionRecord(newUser.id);
    await persistStorage();

    writeSessionCookie(res, session.token);
    replyWithJson(res, 201, { user: formatPublicUser(newUser) });
    return true;
  }

  if (req.method === "POST" && pathName === "/api/auth/login") {
    const body = await extractJsonBody(req);
    const email = cleanEmail(body.email);
    const password = String(body.password || "");
    const user = database.users.find(u => u.email === email);

    if (!user || !checkPassword(password, user.passwordHash)) {
      replyWithError(res, 401, "Credential verification failed.");
      return true;
    }

    const session = createSessionRecord(user.id);
    await persistStorage();
    writeSessionCookie(res, session.token);
    replyWithJson(res, 200, { user: formatPublicUser(user) });
    return true;
  }

  if (req.method === "POST" && pathName === "/api/auth/logout") {
    const token = parseIncomingCookies(req).session;
    if (token) {
      database.sessions = database.sessions.filter(s => s.token !== token);
      await persistStorage();
    }
    destroySessionCookie(res);
    replyWithJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && pathName === "/api/auth/me") {
    const user = resolveSessionUser(req);
    replyWithJson(res, 200, { user: user ? formatPublicUser(user) : null });
    return true;
  }

  return false;
}

async function routeTasks(req, res, pathName) {
  const currentUser = resolveSessionUser(req);
  if (!currentUser) {
    replyWithError(res, 401, "Authentication required.");
    return true;
  }

  if (req.method === "GET" && pathName === "/api/tasks") {
    replyWithJson(res, 200, { tasks: getClientOrderedTasks(currentUser.id) });
    return true;
  }

  if (req.method === "GET" && pathName === "/api/tasks/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    res.flushHeaders(); // Instruct Node to push early headers out directly to client connection
    
    res.write(`event: tasks-changed\n`);
    res.write(`data: ${JSON.stringify({ tasks: getClientOrderedTasks(currentUser.id), updatedAt: getTimestamp() })}\n\n`);

    if (!activeSseSubscribers.has(currentUser.id)) {
      activeSseSubscribers.set(currentUser.id, new Set());
    }
    const set = activeSseSubscribers.get(currentUser.id);
    set.add(res);

    req.on("close", () => {
      set.delete(res);
      if (set.size === 0) activeSseSubscribers.delete(currentUser.id);
    });
    return true;
  }

  if (req.method === "POST" && pathName === "/api/tasks") {
    const cleanPayload = processAndValidateTask(await extractJsonBody(req));
    const createdTask = {
      id: generateUUID(),
      userId: currentUser.id,
      ...cleanPayload,
      createdAt: getTimestamp(),
      updatedAt: getTimestamp()
    };
    database.tasks.push(createdTask);
    await persistStorage();
    dispatchSseUpdate(currentUser.id);
    replyWithJson(res, 201, { task: createdTask });
    return true;
  }

  const matchesIdRoute = pathName.match(/^\/api\/tasks\/([^/]+)$/);
  if (!matchesIdRoute) return false;

  const activeId = matchesIdRoute[1];
  const originalTask = database.tasks.find(t => t.id === activeId && t.userId === currentUser.id);
  if (!originalTask) {
    replyWithError(res, 404, "Requested operational objective missing.");
    return true;
  }

  if (req.method === "PATCH") {
    const clientUpdate = await extractJsonBody(req);
    const verifiedDelta = Object.fromEntries(
      Object.entries(clientUpdate).filter(([k]) => EDITABLE_TASK_PROPERTIES.has(k))
    );

    if (Object.keys(verifiedDelta).length === 0) {
      replyWithError(res, 400, "Executable updates field map evaluates to empty.");
      return true;
    }

    Object.assign(originalTask, processAndValidateTask(verifiedDelta, true), {
      updatedAt: getTimestamp()
    });
    await persistStorage();
    dispatchSseUpdate(currentUser.id);
    replyWithJson(res, 200, { task: originalTask });
    return true;
  }

  if (req.method === "DELETE") {
    database.tasks = database.tasks.filter(t => t.id !== originalTask.id);
    await persistStorage();
    dispatchSseUpdate(currentUser.id);
    replyWithJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function deliverStaticAsset(req, res, pathName) {
  const safeAssetPath = pathName === "/" ? "/index.html" : pathName;
  const normalizedFile = path.normalize(decodeURIComponent(safeAssetPath));
  const absolutePath = path.join(CONFIG.PUBLIC_DIR, normalizedFile);

  if (!absolutePath.startsWith(CONFIG.PUBLIC_DIR)) {
    return replyWithError(res, 403, "Access restriction breach.");
  }

  try {
    const data = await fs.readFile(absolutePath);
    const extension = path.extname(absolutePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[extension] || "application/octet-stream" });
    res.end(data);
  } catch {
    // Single-page fallback for frontend routing consistency
    try {
      const indexHtml = await fs.readFile(path.join(CONFIG.PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
      res.end(indexHtml);
    } catch (criticalErr) {
      replyWithError(res, 500, "Fatal application file lookup error.");
    }
  }
}

// --- Main HTTP Application Kernel ---
async function applicationKernel(req, res) {
  try {
    const targetUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const segmentPath = targetUrl.pathname;

    if (segmentPath.startsWith("/api/auth")) {
      const active = await routeAuthentication(req, res, segmentPath);
      if (active === false) replyWithError(res, 404, "Authentication path unmapped.");
      return;
    }

    if (segmentPath.startsWith("/api/tasks")) {
      const active = await routeTasks(req, res, segmentPath);
      if (active === false) replyWithError(res, 404, "Task path structure unmapped.");
      return;
    }

    await deliverStaticAsset(req, res, segmentPath);
  } catch (err) {
    console.error("Unhandled runtime error exception:", err);
    // Safe response structure if headers weren't sent yet
    if (!res.headersSent) {
      replyWithError(res, err.statusCode || 500, err.message || "Internal environment fault.");
    }
  }
}

// --- System Bootstrap ---
initializeStorage()
  .then(() => {
    http.createServer(applicationKernel).listen(CONFIG.PORT, () => {
      console.log(`[Runtime Server Active] Listening at http://localhost:${CONFIG.PORT}`);
    });
  })
  .catch(err => {
    console.error("System storage initialization breakdown:", err);
    process.exit(1);
  });