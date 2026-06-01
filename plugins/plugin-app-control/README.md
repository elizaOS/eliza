# @elizaos/plugin-app-control

An elizaOS plugin that lets an Eliza agent launch, close, list, scaffold, and verify Eliza apps; manage UI views contributed by plugins; and customize the live homescreen canvas.

## What it does

Loading this plugin gives an Eliza agent three new actions:

**APP** — Unified app lifecycle control. The agent can:
- Launch a registered app by name (`"launch shopify"`)
- Relaunch (stop then start) a running app, optionally running verification after (`"relaunch shopify and verify"`)
- List installed and currently-running apps (`"what apps are open?"`)
- Load apps from a local directory into the registry (`"load apps from /my/dev/apps"`)
- Scaffold a new Eliza app through a multi-turn flow that asks new/edit/cancel, scaffolds from the min-app template, and dispatches a coding agent with AppVerificationService validation (`"build me a note-taking app"`)

**VIEWS** — Full view management. The agent can navigate to any UI view contributed by any loaded plugin; report the currently-open view; search views by name; open the view manager; broadcast events to mounted views; interact with a view (click, get state, focus, etc.); pin a view as a desktop tab; open a view in a separate window; and create, edit, or delete view plugins through a coding-agent backed flow.

**HOMESCREEN** — Live homescreen customization. The agent reads the current scene document, asks the model to rewrite it based on the user's description, and pushes the updated document to the client. Also supports history operations: undo, redo, reset, duplicate, delete, save.

## Capabilities added to the agent

| Action | Contexts gated | Role gate |
|---|---|---|
| `APP` | `automation`, `settings`, `code` | Owner |
| `VIEWS` (read modes) | `general`, `automation`, `settings`, `code` | User |
| `VIEWS` (create/edit/delete) | `general`, `automation`, `settings`, `code` | Owner |
| `HOMESCREEN` | `general`, `settings` | User |

The `available_apps` provider injects installed + running app data into the agent's planning context when operating in the `settings` or `automation` context, so the agent can pick a target without an extra round-trip.

## Installation

Add `@elizaos/plugin-app-control` to your agent's plugin list. The plugin is not default-enabled.

```ts
import appControlPlugin from "@elizaos/plugin-app-control";

const runtime = new AgentRuntime({
  // ...
  plugins: [appControlPlugin],
});
```

## Required environment / config

None are required for basic operation. The plugin auto-discovers the Eliza dashboard port via `resolveServerOnlyPort`.

| Variable | Purpose |
|---|---|
| `ELIZA_REPO_ROOT` / `ELIZA_WORKSPACE_DIR` | Repo root used when scaffolding new apps or view plugins. Defaults to `cwd()`. |
| `ELIZA_STATE_DIR` | State directory for the app registry, audit logs, and granted-permissions store. Defaults to `~/.eliza`. |
| `ELIZA_PROTECTED_APPS` | Comma-separated app slugs the agent may not delete. |
| `ELIZA_BROWSER_VERIFY_OPTIONAL` | Set to `1` to make browser checks in AppVerificationService non-fatal. |
| `ELIZA_CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` | Chrome binary path for browser-based app verification (optional peer dep `puppeteer-core`). |
| `ELIZA_BUILD_VARIANT=store` / `ELIZA_PLATFORM=ios\|android` | Disables dynamic plugin creation on restricted distribution platforms. |

## Services registered

| Service | Purpose |
|---|---|
| `AppRegistryService` | Persists `load_from_directory` registrations so they survive restarts. |
| `AppVerificationService` | Typecheck / lint / test / build / launch / browser pipeline for newly created apps and plugins. |
| `AppWorkerHostService` | Runs apps that declare `isolation: "worker"` in a dedicated `node:worker_threads` Worker with typed RPC. |
| `VerificationRoomBridgeService` | Posts verification results back into the user's chat room once the background coding agent finishes. |

## Views registered

The plugin contributes a **View Manager** view (GUI, XR, and TUI variants) at `/views` — a browser for all views contributed by loaded plugins.

## For agent developers

See [CLAUDE.md](CLAUDE.md) for file layout, how to add new sub-modes, service wiring, and plugin-specific gotchas.
