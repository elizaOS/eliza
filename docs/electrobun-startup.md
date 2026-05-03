# Electrobun desktop app: startup and exception handling

This doc explains how the embedded agent starts in the packaged desktop app and **why** the exception-handling guards in `eliza/packages/app-core/platforms/electrobun/src/native/agent.ts` must not be removed.

## Startup sequence

1. **Electrobun main process** starts, creates the window, and resolves the renderer URL (Vite dev server via `ELIZA_RENDERER_URL` or the built-in static asset server for packaged `apps/app/dist`).
2. **`AgentManager.start()`** (in `native/agent.ts`) spawns a **child Bun process**: `bun run <eliza-dist>/entry.js start` (or the equivalent path for your bundle layout). The child is **not** an in-process dynamic import of `server.js` / `eliza.js`.
3. **Child process** boots the Eliza CLI entrypoint, starts the API server, and runs the elizaOS runtime in headless mode inside that process.
4. **Main process** health-polls `http://127.0.0.1:{port}/api/health` until the child reports ready (or times out / errors).
5. **Main process** pushes `apiBaseUpdate` (and related RPC) to the renderer so `window.__ELIZA_API_BASE__` matches the live API.

If the child fails to start or never becomes healthy:

- The **Electrobun window stays up** so the user is not left with a blank shell.
- **Status** is set to `state: "error"` with an error message so the UI can show **Agent unavailable: …** instead of a generic **Failed to fetch**.

For **dev orchestration** (Vite + API + Electrobun in separate processes), see [Desktop local development](/apps/desktop-local-development).

## Why the guards exist

**Goal:** When the runtime fails to load (e.g. missing native binary), the user should see a clear error in the UI, not a dead window. That requires (1) the main process and renderer staying alive, and (2) status / RPC updates so the UI can show **Agent unavailable: …**.

Without explicit handling:

1. If the **child process crashes** or health never succeeds, the main process must surface that as **error** state to the renderer.
2. If the **outer `start()`** tore down the window or assumed the API lived in-process, the renderer could lose **API base** and show **Failed to fetch** with no explanation.

So we keep:

- **Child process isolation** — API + runtime failures are contained in the child; the main process observes exit codes / health.
- **try/catch and `.catch()` where still applicable** — Any remaining async paths that could reject should set **error** state instead of leaving the UI uninitialized.
- **Outer paths that must NOT kill the shell** when the goal is to show an in-app error — align with `native/agent.ts` comments and this doc.

## Do not remove as "excess"

Code reviews or automated "deslop" passes sometimes remove try/catch or `.catch()` as "redundant" or "excess exception handling." In this module, those guards are **intentional**: they keep the app window usable when the runtime fails to load. Removing them would bring back broken behavior (dead window, **Failed to fetch**, no error message).

The file and key sites in `agent.ts` include **WHY** comments that reference this doc. When editing that file, preserve the guards and the rationale.

## Logs

Packaged app writes a startup log to:

- **macOS:** `~/Library/Application Support/Eliza/eliza-startup.log`
- **Windows:** `%APPDATA%\Eliza\eliza-startup.log`
- **Linux:** `~/.config/Eliza/eliza-startup.log`

Use it to debug load failures (missing modules, native binary path, etc.).

## See also

- [Plugin resolution and NODE_PATH](/plugin-resolution-and-node-path) — why dynamic plugin imports need `NODE_PATH` and where it's set.
- [Build and release](/build-and-release) — CI pipeline, Rosetta builds, plugin/dep copying.
