# TaskFlow Pipeline Hub

An agile, full-stack architectural sandbox designed to showcase modern vanilla Node.js capabilities, lifecycle state management, secure session tracking, real-time reactive UI streaming, and high-contrast styling systems.

## Core Architectural Systems

- **Secure Session Shroud**: Identity routing using encrypted PBKDF2 cryptography alongside secure, HTTP-only session tokens.
- **Neo-Brutalist Layout Engine**: A stark, highly accessible UI design framework engineered using crisp borders, distinct geometric cards, and minimal Indigo styling primitives.
- **Reactive Stream Layer**: Employs structural Server-Sent Events (SSE) to push local system directive updates down to active client browser windows instantly.
- **Flexible Workspace Views**: Instant switching between an itemized linear pipeline checklist or an agile Kanban visual workspace status array.

## Workspace Ecosystem Mapping

```text
server.js                - Native Node HTTP routing engine, auth logic handlers, & transactional data pipeline layers.
public/index.html        - Structural layout foundation leveraging strict element contexts.
public/styles.css        - Contemporary high-contrast Neo-Brutalist interface system & dark theme overrides.
public/app.js            - Frontend loop coordination, live state tracking, UI layout factory, and client API dispatchers.
data/db.json             - JSON runtime flat-file store (generated dynamically during first kernel bootstrap).

System API Registry
Session & Identity Engine

    POST /api/auth/register — Requests registration of new identity profiles.

    POST /api/auth/login    — Requests verification of existing identity profiles.

    POST /api/auth/logout   — Destroys contemporary session cookie references.

    GET /api/auth/me        — Resolves the authenticated context footprint.

Objective Delta Engine

    GET /api/tasks          — Compiles all active operational objectives.

    GET /api/tasks/stream   — Pins open an asynchronous live SSE sync gateway.

    POST /api/tasks         — Persists a newly established directive payload.

    PATCH /api/tasks/:id    — Patches attributes within an existing directive delta map.

    DELETE /api/tasks/:id   — Permanently purges specific records from storage arrays.

Bootstrap Sequence

Execute the native process engine manually:
Bash

npm start

Or run with automatic hot-reloads during maintenance:
Bash

npm run dev

Point your local user agent to http://localhost:3000 to start mapping out your pipeline tasks."# TaskFlow_Hub" 
