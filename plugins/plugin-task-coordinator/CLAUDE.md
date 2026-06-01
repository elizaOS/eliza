# @elizaos/plugin-task-coordinator

Coding-agent task coordinator and session control surface for elizaOS agents.

## Purpose / role

This plugin adds a UI workbench for managing coding-agent task threads and PTY sessions. It registers view panels (standard, XR, and TUI variants) into the elizaOS app shell for both the task coordinator and the multi-agent orchestrator surfaces. It has no server-side runtime component (no actions, providers, services, or evaluators); all agent/task state is owned by `@elizaos/plugin-agent-orchestrator` — this plugin is the display and control layer only.

The plugin is opt-in: it must be listed in the agent's plugin configuration. Once loaded, it registers its views into the app shell and fills the slot registry entries (`CodingAgentControlChip`, `CodingAgentSettingsSection`, `CodingAgentTasksPanel`, `PtyConsoleBase`) that `@elizaos/ui` exposes as null placeholders without this plugin.

## Plugin surface

No actions, providers, services, or evaluators are registered. The plugin surface is entirely views and slot-registry fills.

### Views registered (`src/index.ts`)

| view id | path | viewType | componentExport | description |
|---|---|---|---|---|
| `task-coordinator` | `/task-coordinator` | default | `CodingAgentTasksPanel` | Task threads + PTY session panel |
| `task-coordinator` | `/task-coordinator` | `xr` | `CodingAgentTasksPanel` | XR variant |
| `task-coordinator` | `/task-coordinator/tui` | `tui` | `TaskCoordinatorTuiView` | TUI terminal variant |
| `orchestrator` | `/orchestrator` | default | `OrchestratorWorkbench` | Multi-agent orchestration workbench |
| `orchestrator` | `/orchestrator` | `xr` | `OrchestratorWorkbench` | XR variant |
| `orchestrator` | `/orchestrator/tui` | `tui` | `OrchestratorTuiView` | TUI terminal variant |

The task-coordinator TUI view declares capabilities: `list-sessions`, `list-task-threads`, `open-thread`, `stop-session`, `refresh`.

The orchestrator views declare capabilities — typed descriptors the TUI layer uses to drive the workbench. Capability IDs: `orchestrator-status`, `orchestrator-list-tasks`, `orchestrator-open-task`, `orchestrator-create-task`, `orchestrator-pause-task`, `orchestrator-resume-task`, `orchestrator-pause-all`, `orchestrator-resume-all`, `orchestrator-delete-task`, `orchestrator-fork-task`, `orchestrator-update-task`, `orchestrator-validate-task`, `orchestrator-add-agent`, `orchestrator-stop-agent`, `orchestrator-send-message`.

### Slot registry fills (`src/register-slots.ts`)

Calls `registerTaskCoordinatorSlots` from `@elizaos/ui` with:

- `CodingAgentControlChip` — header chip showing active session count; stop-all button.
- `CodingAgentSettingsSection` — agent settings panel (per-framework tabs: elizaOS, Pi Agent, OpenCode, Claude, Codex; auth, model, approval-preset config).
- `CodingAgentTasksPanel` — main task-thread list + PTY console view.
- `PtyConsoleBase` — PTY output streamer; subscribes to `pty-output` WS events.

### App shell pages (`src/register.ts`)

Registers `/orchestrator` (order 70) and `/orchestrator/tui` (order 71) in the `developer` group via `registerAppShellPage` from `@elizaos/ui/app-shell-registry`.

## Layout

```
src/
  index.ts                         Plugin definition — views + capabilities declared here
  register.ts                      App-shell page registration (orchestrator routes)
  register-slots.ts                Slot registry fills for ui null-placeholders
  CodingAgentTasksPanel.tsx        Task thread list + PTY session panel; re-exports OrchestratorWorkbench
  OrchestratorWorkbench.tsx        Multi-agent orchestration workbench (main UI)
  CodingAgentControlChip.tsx       Header chip: active session count + stop-all
  CodingAgentSettingsSection.tsx   Per-framework settings panel
  coding-agent-settings-shared.ts  Shared types/constants for settings sub-components
  AgentTabsSection.tsx             Framework tab row inside settings panel
  GlobalPrefsSection.tsx           Global preference controls
  LlmProviderSection.tsx           LLM provider selector
  ModelConfigSection.tsx           Model config controls
  GitHubConnectionCard.tsx         GitHub connection status card
  PtyConsoleBase.tsx               PTY output streamer (drawer/side-panel/full variants)
  PtyConsoleDrawer.tsx             Drawer variant wrapper
  PtyConsoleSidePanel.tsx          Side-panel variant wrapper
  PtyTerminalPane.tsx              Full terminal pane variant
  orchestrator-stream.tsx          Conversation-view builder for orchestrator event/message records
  orchestrator-diff.tsx            Diff view component for file-change tool cards
  view-format.ts                   Pure display formatters (time, tokens, USD, ANSI-strip)
  session-hydration.ts             Re-exports mapServerTasksToSessions + TERMINAL_STATUSES from @elizaos/ui
  pty-status-dots.ts               Re-exports PULSE_STATUSES + STATUS_DOT from @elizaos/ui
  api/
    coding-agents-auth-sanitize.ts       Sanitizes triggerAuth() responses (whitelist + URL scheme check)
    coding-agents-preflight-normalize.ts Normalizes preflight auth field to typed NormalizedPreflightAuth
```

## Commands

Only scripts that exist in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-task-coordinator build          # JS + views bundle + type declarations
bun run --cwd plugins/plugin-task-coordinator build:js       # tsup (server/plugin JS only)
bun run --cwd plugins/plugin-task-coordinator build:views    # Vite view bundle → dist/views/bundle.js
bun run --cwd plugins/plugin-task-coordinator build:types    # tsc --noCheck declarations
bun run --cwd plugins/plugin-task-coordinator clean          # rm -rf dist
bun run --cwd plugins/plugin-task-coordinator test           # vitest unit suite
bun run --cwd plugins/plugin-task-coordinator test:unit      # same as test
bun run --cwd plugins/plugin-task-coordinator test:e2e:manual  # live Codex e2e (requires codex CLI + auth)
```

## Config / env vars

This plugin reads no env vars directly. Coding-agent framework selection and per-framework settings are stored as agent preferences via the `@elizaos/ui` client. The settings UI in `CodingAgentSettingsSection.tsx` uses env-prefix constants from `coding-agent-settings-shared.ts`:

| Agent tab | Env prefix constant | Value |
|---|---|---|
| elizaos | `ENV_PREFIX.elizaos` | `ELIZA_ELIZAOS` |
| pi-agent | `ENV_PREFIX["pi-agent"]` | `ELIZA_PI_AGENT` |
| claude | `ENV_PREFIX.claude` | `ELIZA_CLAUDE` |
| codex | `ENV_PREFIX.codex` | `ELIZA_CODEX` |
| opencode | `ENV_PREFIX.opencode` | `ELIZA_OPENCODE` |

These prefixes are used to build preference keys sent to the agent prefs API; they are not read from `process.env` at runtime in this plugin.

## How to extend

### Add a new orchestrator capability

1. Add an entry to `ORCHESTRATOR_CAPABILITIES` in `src/index.ts` with a unique `id`, a `description`, and typed `params`.
2. Handle the capability dispatch in `OrchestratorWorkbench.tsx` inside `runOrchestratorCapability` (or the equivalent dispatch map).

### Add a new agent framework tab

1. Add the new key to `AgentTab` union type in `src/coding-agent-settings-shared.ts`.
2. Add it to `AGENT_TABS`, `AGENT_LABELS`, `AGENT_PROVIDER_MAP`, `ADAPTER_NAME_TO_TAB`, and `ENV_PREFIX`.
3. Add any fallback models to `FALLBACK_MODELS` keyed by provider name.
4. Handle the new tab in `AgentTabsSection.tsx` and `CodingAgentSettingsSection.tsx`.

### Add a new view component

1. Create the React component file in `src/`.
2. Register it in `src/index.ts` as a new entry in the `views` array with a unique `id`, `path`, and `componentExport`.
3. If it needs app-shell registration, add it in `src/register.ts`.
4. If it fills a slot, add it in `src/register-slots.ts` and update `registerTaskCoordinatorSlots` call.

## Conventions / gotchas

- **Two build steps.** The plugin has both a tsup JS build (`build:js`) and a Vite view-bundle build (`build:views`). The view bundle entry is `src/CodingAgentTasksPanel.tsx` and outputs `dist/views/bundle.js`. Both must be built; `build` runs them in sequence.
- **View bundle re-exports.** `CodingAgentTasksPanel.tsx` re-exports `OrchestratorWorkbench` so a single bundle serves all `componentExport` names the view manifest declares.
- **Slot registry is a side-effect import.** `register-slots.ts` must be imported by the host app to activate the slot fills. Without it, the UI renders null placeholders in place of the coding-agent components.
- **No server runtime.** This plugin registers zero actions, providers, services, or evaluators. All task/session state lives in `@elizaos/plugin-agent-orchestrator`. API boundary helpers in `src/api/` are utilities for route handlers in app-core, not plugin-registered routes.
- **PTY console buffer cap.** `PtyConsoleBase` caps displayed output at 200,000 characters (`MAX_BUFFER_CHARS`). Older output is silently trimmed from the head.
- **Live e2e test requires real Codex CLI.** `test:e2e:manual` (`test/coding-agent-codex-artifact.live.e2e.test.ts`) is skipped unless the `codex` binary is in PATH and `~/.codex/auth.json` exists.
- See the root `AGENTS.md` for repo-wide conventions (logger-only, ESM, naming, architecture rules).
