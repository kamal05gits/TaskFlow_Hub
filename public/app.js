const runtimeState = {
  activeSessionUser: null,
  cachedDirectives: [],
  activeFilter: "all",
  searchToken: "",
  activeAuthViewMode: "login",
  selectedEditTargetId: null,
  liveDataStreamInstance: null,
  preferredLayoutPattern: localStorage.getItem("preferredLayoutPattern") || "kanban"
};

const domRegistry = {
  authSection: document.querySelector("#authSection"),
  workspacePlatform: document.querySelector("#workspacePlatform"),
  authControllerForm: document.querySelector("#authControllerForm"),
  authSubmitAction: document.querySelector("#authSubmitAction"),
  authDiagnosticLog: document.querySelector("#authDiagnosticLog"),
  tabSwitchers: document.querySelectorAll("[data-target-mode]"),
  registerInputsBlock: document.querySelectorAll(".register-scope"),
  regNameInput: document.querySelector("#regNameInput"),
  authEmailInput: document.querySelector("#authEmailInput"),
  authPasswordInput: document.querySelector("#authPasswordInput"),
  userIdentityLabel: document.querySelector("#userIdentityLabel"),
  networkSyncIndicator: document.querySelector("#networkSyncIndicator"),
  sessionExitAction: document.querySelector("#sessionExitAction"),
  themeEngineToggle: document.querySelector("#themeEngineToggle"),
  directiveSubmissionForm: document.querySelector("#directiveSubmissionForm"),
  directiveSubmitButton: document.querySelector("#directiveSubmitButton"),
  directiveDiagnosticLog: document.querySelector("#directiveDiagnosticLog"),
  directiveTitle: document.querySelector("#directiveTitle"),
  directiveDescription: document.querySelector("#directiveDescription"),
  directiveDueDate: document.querySelector("#directiveDueDate"),
  directivePriority: document.querySelector("#directivePriority"),
  directiveStatus: document.querySelector("#directiveStatus"),
  formContextHeadline: document.querySelector("#formContextHeadline"),
  dismissEditStateBtn: document.querySelector("#dismissEditStateBtn"),
  aggregatedMetricsBanner: document.querySelector("#aggregatedMetricsBanner"),
  scopeFilterControls: document.querySelectorAll("[data-filter-scope]"),
  layoutSelectionControls: document.querySelectorAll("[data-layout-mode]"),
  searchQueryInput: document.querySelector("#searchQueryInput"),
  outputPipelineContainer: document.querySelector("#outputPipelineContainer")
};

// --- API Request Layer Utility ---
async function invokeBackendApi(endpointPath, options = {}) {
  const mergedHeaders = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const runtimeResponse = await fetch(endpointPath, { ...options, headers: mergedHeaders });
  const dataResponse = await runtimeResponse.json().catch(() => ({}));
  
  if (!runtimeResponse.ok) {
    throw new Error(dataResponse.error || "Network operation context broken.");
  }
  return dataResponse;
}

// --- View State Orchestration Engines ---
function alterAuthUIMode(targetMode) {
  runtimeState.activeAuthViewMode = targetMode;
  const isSignUp = targetMode === "register";

  domRegistry.tabSwitchers.forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.targetMode === targetMode);
  });

  domRegistry.registerInputsBlock.forEach(block => {
    block.classList.toggle("is-hidden", !isSignUp);
  });

  domRegistry.regNameInput.required = isSignUp;
  domRegistry.authPasswordInput.autocomplete = isSignUp ? "new-password" : "current-password";
  domRegistry.authSubmitAction.textContent = isSignUp ? "Establish Identity" : "Authorize Session";
  domRegistry.authDiagnosticLog.textContent = "";
}

function commitPlatformSession(userProfile) {
  runtimeState.activeSessionUser = userProfile;
  domRegistry.authSection.classList.toggle("is-hidden", Boolean(userProfile));
  domRegistry.workspacePlatform.classList.toggle("is-hidden", !userProfile);

  if (userProfile) {
    domRegistry.userIdentityLabel.textContent = `${userProfile.name} [${userProfile.email}]`;
    synchronizeDirectivesCache();
    initiateLiveSSEStream();
  } else {
    domRegistry.userIdentityLabel.textContent = "Offline Mode";
    runtimeState.cachedDirectives = [];
    terminateLiveSSEStream();
    renderActiveDirectivesLayout();
  }
}

async function verifyExistingAuthSession() {
  const { user } = await invokeBackendApi("/api/auth/me");
  commitPlatformSession(user);
}

async function synchronizeDirectivesCache() {
  const { tasks } = await invokeBackendApi("/api/tasks");
  runtimeState.cachedDirectives = tasks;
  renderActiveDirectivesLayout();
}

// --- Live Server-Sent Events Coordination Loop ---
function initiateLiveSSEStream() {
  terminateLiveSSEStream();
  runtimeState.liveDataStreamInstance = new EventSource("/api/tasks/stream");

  runtimeState.liveDataStreamInstance.addEventListener("tasks-changed", (event) => {
    const payload = JSON.parse(event.data);
    runtimeState.cachedDirectives = payload.tasks;
    renderActiveDirectivesLayout();
    if (domRegistry.networkSyncIndicator) {
      domRegistry.networkSyncIndicator.classList.add("active");
    }
  });

  runtimeState.liveDataStreamInstance.onerror = () => {
    terminateLiveSSEStream();
    if (domRegistry.networkSyncIndicator) {
      domRegistry.networkSyncIndicator.classList.remove("active");
    }
    setTimeout(() => {
      if (runtimeState.activeSessionUser) initiateLiveSSEStream();
    }, 2000);
  };
}

function terminateLiveSSEStream() {
  if (runtimeState.liveDataStreamInstance) {
    runtimeState.liveDataStreamInstance.close();
    runtimeState.liveDataStreamInstance = null;
  }
}

// --- String Formatting & Layout Transform Filters ---
function calculateMetricsMatrix() {
  return runtimeState.cachedDirectives.reduce(
    (acc, task) => {
      acc.all += 1;
      if (Object.hasOwn(acc, task.status)) acc[task.status] += 1;
      return acc;
    },
    { all: 0, todo: 0, "in-progress": 0, done: 0 }
  );
}

const mapStatusLabel = (s) => ({ todo: "Pending", "in-progress": "Active", done: "Resolved" }[s] || s);
const formatPriorityText = (p) => p.toUpperCase();

function createDateBadgeString(dateString) {
  if (!dateString) return "No static target limit";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(`${dateString}T00:00:00`));
}

function escapeOutputHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function computeFilterSet(ignoreStatusScope = false) {
  const query = runtimeState.searchToken.trim().toLowerCase();
  return runtimeState.cachedDirectives.filter(t => {
    const matchedFilter = ignoreStatusScope || runtimeState.activeFilter === "all" || t.status === runtimeState.activeFilter;
    const matchedQuery = !query || t.title.toLowerCase().includes(query) || t.description.toLowerCase().includes(query);
    return matchedFilter && matchedQuery;
  });
}

// --- Functional Component HTML Generation Factories ---
function drawMetricsBanner() {
  const tallies = calculateMetricsMatrix();
  const definitionRows = [
    ["All Directive Scopes", tallies.all],
    ["Pending Items", tallies.todo],
    ["Active Actions", tallies["in-progress"]],
    ["Resolved Focus", tallies.done]
  ];

  domRegistry.aggregatedMetricsBanner.innerHTML = definitionRows
    .map(([title, val]) => `
      <div class="stat-box">
        <h4>${val}</h4>
        <span>${title}</span>
      </div>
    `).join("");
}

function buildTaskItemCardMarkup(task) {
  const pastTargetLimit = task.dueDate && task.status !== "done" && new Date(`${task.dueDate}T23:59:59`) < new Date();
  const dateIndicatorStyles = pastTargetLimit ? "date-stamp is-overdue" : "date-stamp";
  const dateOutputMessage = pastTargetLimit ? `⚠️ OVERDUE: ${createDateBadgeString(task.dueDate)}` : createDateBadgeString(task.dueDate);

  return `
    <div class="task-item-card" data-directive-id="${task.id}">
      <div class="card-top">
        <div>
          <h3 class="card-heading">${escapeOutputHtml(task.title)}</h3>
          <p class="card-desc">${task.description ? escapeOutputHtml(task.description) : '<em>No context details written.</em>'}</p>
        </div>
        <span class="tag-badge priority-${task.priority}">${formatPriorityText(task.priority)}</span>
      </div>
      <div class="meta-footer">
        <span class="tag-badge">${mapStatusLabel(task.status)}</span>
        <span class="${dateIndicatorStyles}">${dateOutputMessage}</span>
      </div>
      <div class="card-actions-row" style="margin-top:12px; justify-content: flex-end;">
        <button class="btn btn-mini" type="button" data-directive-action="edit">Modify</button>
        <button class="btn btn-mini" type="button" data-directive-action="advance-lifecycle">
          ${task.status === "done" ? "Reactivate" : "Progress Status"}
        </button>
        <button class="btn btn-mini btn-danger" type="button" data-directive-action="purge">Delete</button>
      </div>
    </div>
  `;
}

function renderActiveDirectivesLayout() {
  drawMetricsBanner();
  const targetKanbanLayout = runtimeState.preferredLayoutPattern === "kanban";
  
  domRegistry.outputPipelineContainer.classList.toggle("layout-kanban", targetKanbanLayout);

  if (targetKanbanLayout) {
    const isolatedSet = computeFilterSet(true);
    const splitMap = { todo: [], "in-progress": [], done: [] };
    
    isolatedSet.forEach(t => { if (splitMap[t.status]) splitMap[t.status].push(t); });

    const headers = { todo: "Pending Action", "in-progress": "In Execution", done: "Resolved Status" };

    domRegistry.outputPipelineContainer.innerHTML = Object.entries(splitMap)
      .map(([statusKey, listItems]) => {
        const structuralCards = listItems.length > 0 
          ? listItems.map(buildTaskItemCardMarkup).join("") 
          : `<div class="empty-view-placeholder">No objectives under this matrix index.</div>`;

        return `
          <div class="kanban-column-wrapper">
            <div class="col-header">
              <span>${headers[statusKey]}</span>
              <span>(${listItems.length})</span>
            </div>
            ${structuralCards}
          </div>
        `;
      }).join("");
  } else {
    const regularFilteredSet = computeFilterSet(false);

    if (regularFilteredSet.length === 0) {
      domRegistry.outputPipelineContainer.innerHTML = `
        <div class="empty-view-placeholder">
          No records identified matching contemporary search or active context filters.
        </div>
      `;
      return;
    }
    domRegistry.outputPipelineContainer.innerHTML = regularFilteredSet.map(buildTaskItemCardMarkup).join("");
  }
}

// --- Input Form Operations Management ---
function clearDirectiveInputForm() {
  runtimeState.selectedEditTargetId = null;
  domRegistry.formContextHeadline.textContent = "New Directive";
  domRegistry.directiveSubmitButton.textContent = "Save Item";
  domRegistry.dismissEditStateBtn.classList.add("is-hidden");
  domRegistry.directiveDiagnosticLog.textContent = "";
  domRegistry.directiveSubmissionForm.reset();
  domRegistry.directivePriority.value = "medium";
  domRegistry.directiveStatus.value = "todo";
}

function targetTaskForEditing(task) {
  runtimeState.selectedEditTargetId = task.id;
  domRegistry.formContextHeadline.textContent = "Modify Objective";
  domRegistry.directiveSubmitButton.textContent = "Update Objective Details";
  domRegistry.dismissEditStateBtn.classList.remove("is-hidden");
  domRegistry.directiveTitle.value = task.title;
  domRegistry.directiveDescription.value = task.description;
  domRegistry.directiveDueDate.value = task.dueDate;
  domRegistry.directivePriority.value = task.priority;
  domRegistry.directiveStatus.value = task.status;
  domRegistry.directiveTitle.focus();
}

function assembleFormJsonPayload() {
  const objectFormData = new FormData(domRegistry.directiveSubmissionForm);
  return {
    title: objectFormData.get("title"),
    description: objectFormData.get("description"),
    dueDate: objectFormData.get("dueDate"),
    priority: objectFormData.get("priority"),
    status: objectFormData.get("status")
  };
}

const shiftToNextLifecyclePhase = (curr) => ({ todo: "in-progress", "in-progress": "done" }[curr] || "todo");

function promptModalConfirmationBox(headline, queryPrompt) {
  return new Promise((resolve) => {
    const shroud = document.querySelector("#globalConfirmationDialog");
    const hSlot = document.querySelector("#modalHeadingSlot");
    const bSlot = document.querySelector("#modalBodySlot");
    const cancel = document.querySelector("#modalAbortAction");
    const commit = document.querySelector("#modalProceedAction");

    hSlot.textContent = headline;
    bSlot.textContent = queryPrompt;
    shroud.classList.remove("is-hidden");

    const clearListeners = (flag) => {
      shroud.classList.add("is-hidden");
      cancel.removeEventListener("click", onAbort);
      commit.removeEventListener("click", onCommit);
      resolve(flag);
    };

    function onAbort() { clearListeners(false); }
    function onCommit() { clearListeners(true); }

    cancel.addEventListener("click", onAbort);
    commit.addEventListener("click", onCommit);
  });
}

// --- Global DOM Event Listener Mappings ---
domRegistry.tabSwitchers.forEach(btn => {
  btn.addEventListener("click", () => alterAuthUIMode(btn.dataset.targetMode));
});

domRegistry.authControllerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  domRegistry.authDiagnosticLog.textContent = "";
  domRegistry.authSubmitAction.disabled = true;

  const currentData = new FormData(domRegistry.authControllerForm);
  const executionTargetUrl = runtimeState.activeAuthViewMode === "register" ? "/api/auth/register" : "/api/auth/login";
  
  const parameters = {
    email: currentData.get("email"),
    password: currentData.get("password")
  };
  if (runtimeState.activeAuthViewMode === "register") {
    parameters.name = currentData.get("name");
  }

  try {
    const { user } = await invokeBackendApi(executionTargetUrl, {
      method: "POST",
      body: JSON.stringify(parameters)
    });
    domRegistry.authControllerForm.reset();
    commitPlatformSession(user);
  } catch (err) {
    domRegistry.authDiagnosticLog.textContent = err.message;
  } finally {
    domRegistry.authSubmitAction.disabled = false;
  }
});

domRegistry.sessionExitAction.addEventListener("click", async () => {
  const verified = await promptModalConfirmationBox("Terminate Session?", "Confirm logging out of the active dashboard pipeline workflow.");
  if (!verified) return;
  await invokeBackendApi("/api/auth/logout", { method: "POST" });
  commitPlatformSession(null);
});

domRegistry.directiveSubmissionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  domRegistry.directiveDiagnosticLog.textContent = "";
  domRegistry.directiveSubmitButton.disabled = true;

  try {
    const targetScopeId = runtimeState.selectedEditTargetId;
    const urlTarget = targetScopeId ? `/api/tasks/${targetScopeId}` : "/api/tasks";
    
    await invokeBackendApi(urlTarget, {
      method: targetScopeId ? "PATCH" : "POST",
      body: JSON.stringify(assembleFormJsonPayload())
    });
    clearDirectiveInputForm();
    await synchronizeDirectivesCache();
  } catch (err) {
    domRegistry.directiveDiagnosticLog.textContent = err.message;
  } finally {
    domRegistry.directiveSubmitButton.disabled = false;
  }
});

domRegistry.dismissEditStateBtn.addEventListener("click", clearDirectiveInputForm);

domRegistry.scopeFilterControls.forEach(btn => {
  btn.addEventListener("click", () => {
    runtimeState.activeFilter = btn.dataset.filterScope;
    domRegistry.scopeFilterControls.forEach(c => c.classList.toggle("is-active", c === btn));
    renderActiveDirectivesLayout();
  });
});

domRegistry.layoutSelectionControls.forEach(btn => {
  btn.addEventListener("click", () => {
    runtimeState.preferredLayoutPattern = btn.dataset.layoutMode;
    localStorage.setItem("preferredLayoutPattern", runtimeState.preferredLayoutPattern);
    domRegistry.layoutSelectionControls.forEach(c => c.classList.toggle("is-active", c === btn));
    renderActiveDirectivesLayout();
  });
});

domRegistry.searchQueryInput.addEventListener("input", (e) => {
  runtimeState.searchToken = e.target.value;
  renderActiveDirectivesLayout();
});

domRegistry.outputPipelineContainer.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-directive-action]");
  const elementCard = e.target.closest("[data-directive-id]");
  if (!btn || !elementCard) return;

  const objectRef = runtimeState.cachedDirectives.find(t => t.id === elementCard.dataset.directiveId);
  if (!objectRef) return;

  if (btn.dataset.directiveAction === "edit") {
    targetTaskForEditing(objectRef);
    return;
  }

  btn.disabled = true;
  try {
    if (btn.dataset.directiveAction === "purge") {
      const confirmed = await promptModalConfirmationBox(
        "Purge Operational Directive?",
        `Are you certain you wish to remove "${objectRef.title}" permanently from storage registers?`
      );
      if (confirmed) {
        await invokeBackendApi(`/api/tasks/${objectRef.id}`, { method: "DELETE" });
        if (runtimeState.selectedEditTargetId === objectRef.id) clearDirectiveInputForm();
        await synchronizeDirectivesCache();
      }
      return;
    }

    if (btn.dataset.directiveAction === "advance-lifecycle") {
      await invokeBackendApi(`/api/tasks/${objectRef.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: shiftToNextLifecyclePhase(objectRef.status) })
      });
      await synchronizeDirectivesCache();
    }
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

// --- Theme Preference Management Layer ---
const assignDOMThemeClass = (isDark) => {
  document.body.classList.toggle("dark-theme", isDark);
  localStorage.setItem("themePreference", isDark ? "dark" : "light");
};

domRegistry.themeEngineToggle.addEventListener("click", () => {
  const currentDarkState = document.body.classList.contains("dark-theme");
  assignDOMThemeClass(!currentDarkState);
});

// --- Initialization Entry Point Execution ---
(() => {
  const savedPreference = localStorage.getItem("themePreference") || "light";
  assignDOMThemeClass(savedPreference === "dark");

  domRegistry.layoutSelectionControls.forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.layoutMode === runtimeState.preferredLayoutPattern);
  });

  alterAuthUIMode("login");
  
  verifyExistingAuthSession().catch((err) => {
    console.error("Session restoration fault details:", err);
    commitPlatformSession(null);
  });
})();