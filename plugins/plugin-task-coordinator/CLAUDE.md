# @elizaos/plugin-task-coordinator

Coding-agent task coordinator and session control surface for elizaOS agents.

## Purpose / role

This plugin adds a GUI workbench for managing coding-agent task threads and PTY sessions. It registers task coordinator, orchestrator, and cockpit views into the elizaOS app shell. All agent/task state is owned by `@elizaos/plugin-agent-orchestrator` — this plugin is the display and control layer only. Its sole server-side runtime contribution is a single view-scoped slash command for the orchestrator view (`/orchestrator-status`), registered through `@elizaos/plugin-commands`, plus its deterministic handler action (no providers, services, or evaluators).

The plugin is opt-in: it must be listed in the agent's plugin configuration. Once loaded, it registers its views into the app shell and fills the slot registry entries (`CodingAgentControlChip`, `CodingAgentSettingsSection`, `CodingAgentTasksPanel`, `PtyConsoleBase`) that `@elizaos/ui` leaves empty without this plugin.

## Plugin surface

The plugin surface is primarily views and slot-registry fills, plus one slash command + handler action (no providers, services, or evaluators).

### Slash command (`src/orchestrator-command.ts`)

| command | view scope | target | handler action |
|---|---|---|---|
| `/orchestrator-status` | `orchestrator` (#8798) | `agent` | `ORCHESTRATOR_STATUS_COMMAND` |

The plugin's `init()` calls `registerOrchestratorCommands(runtime.agentId)`, which registers the command into the per-runtime `@elizaos/plugin-commands` registry. Being `views`-scoped, it appears in `GET /api/commands` only while the orchestrator view is the active surface; the registered `orchestratorStatusCommandAction` is its deterministic, slash-only handler. This proves a non-core, view-owning plugin can light up the universal slash-command surface end to end (#8790).

### Views registered (`src/index.ts`)

Three GUI views.

| view id | path | viewKind | modalities | componentExport | description |
|---|---|---|---|---|---|
| `task-coordinator` | `/task-coordinator` | `preview` | `gui` | `TaskCoordinatorView` | Coding-agent task threads, sessions, and controls |
| `orchestrator` | `/orchestrator` | `developer` (`developerOnly`) | `gui` | `OrchestratorView` | Multi-agent task orchestration workbench |
| `cockpit` | `/cockpit` | `developer` (`developerOnly`) | `gui` | `CockpitRoute` | Mobile-first coding cockpit — shaw's live task-room deck + per-session mode picker + tap-in interactive terminal, on one screen |

`TaskCoordinatorView` (`src/TaskCoordinatorView.tsx`) is a GUI route component built with the spatial presentational layer. `OrchestratorView` (`src/OrchestratorView.tsx`) mounts the rich DOM workbench directly. `CockpitRoute` (`src/CockpitRoute.tsx`) composes the shared `CockpitView` deck with `CockpitSessionPane` (drill-in) and `CockpitInteractiveTerminal` (the tap-in coding PTY terminal). `CodingAgentTasksPanel` still fills the `@elizaos/ui` Tasks-page slot (`register-slots.ts`) and is separate from the route `componentExport`.

The `task-coordinator` view declares capabilities: `list-sessions`, `list-task-threads`, `open-thread`, `stop-session`, `refresh`.

The `orchestrator` view declares typed capability descriptors. Capability IDs: `orchestrator-status`, `orchestrator-list-tasks`, `orchestrator-open-task`, `orchestrator-create-task`, `orchestrator-pause-task`, `orchestrator-resume-task`, `orchestrator-pause-all`, `orchestrator-resume-all`, `orchestrator-delete-task`, `orchestrator-fork-task`, `orchestrator-update-task`, `orchestrator-validate-task`, `orchestrator-add-agent`, `orchestrator-stop-agent`, `orchestrator-send-message`.

### Slot registry fills (`src/register-slots.ts`)

Calls `registerTaskCoordinatorSlots` from `@elizaos/ui` with:

- `CodingAgentControlChip` — header chip showing active session count; stop-all button.
- `CodingAgentSettingsSection` — agent settings panel (per-framework tabs: elizaOS, Pi Agent, OpenCode, Claude, Codex; auth, model, approval-preset config).
- `CodingAgentTasksPanel` — main task-thread list + PTY console view.
- `PtyConsoleBase` — PTY output streamer; subscribes to `pty-output` WS events.

### Registration side effects (`src/register.ts`)

`register.ts` is a side-effect module (imported for its effects, not exports). It activates the slot-registry fills and signed native pages:

- **`import "./register-slots.js"`** — activates the slot-registry fills below (the `@elizaos/ui` empty-slot defaults). Without this import the UI renders empty slots.
- **`registerAppShellPage(...)`** — registers lazy, in-bundle renderers for `task-coordinator`, `orchestrator`, and `cockpit`. iOS and Android strip agent-served JavaScript from `/api/views`, so these registrations are the native render path; web and desktop continue to prefer the runtime manifest bundles.

The three GUI views still declare the standard **view manifest** in `src/index.ts` (`bundlePath` + `componentExport`) as the runtime metadata and web/desktop bundle path. Keep the native registrations aligned with those ids, paths, kinds, surfaces, and component exports.

## Layout

```
src/
  index.ts                         Plugin definition — views + capabilities, init() command registration, handler action
  orchestrator-command.ts          /orchestrator-status slash command def + deterministic handler action (#8790)
  register.ts                      Slot and signed native-page side effects
  register-slots.ts                Slot registry fills for ui empty-slot defaults
  CodingAgentTasksPanel.tsx        Task thread list + PTY session panel; re-exports OrchestratorWorkbench
  CodingAgentTasksPanel.interact.ts  View-bundle `interact` capability handler (split for Fast-Refresh compat)
  task-coordinator-view-bundle.ts  Vite view-bundle entry; re-exports all view components + interact handler
  OrchestratorWorkbench.tsx        Live task-list/timeline coordinator; re-exports TaskInspector + mobile geometry for cockpit compatibility
  orchestrator-task-inspector.tsx  Status header, task inspector, add-agent and recovery controls
  orchestrator-operator-detail.tsx Timeline/session detail drawer, tabs, event and usage inspection
  orchestrator-workbench-list.tsx  Task-list filter and compact task metadata projection
  CockpitRoute.tsx                 /cockpit route: deck + drill-in + tap-in terminal (GUI-only)
  CockpitSessionPane.tsx           Drill-in single-room view (transcript/terminal + mobile inspector drawer)
  CockpitInteractiveTerminal.tsx   Tap-in real eliza-code PTY terminal (spawn→xterm→WS I/O)
  CockpitTerminalPanel.tsx         Read-mostly PTY-output watch panel for a session
  use-orchestrator-data.ts         Live data hook (detail+timeline, fast-poll, SSE, loud-failure mutations)
  orchestrator-workbench-glyphs.tsx  Shared glyphs/translate/status-filter helpers
  CodingAgentControlChip.tsx       Header chip: active session count + stop-all
  CodingAgentSettingsSection.tsx   Per-framework settings panel
  coding-agent-settings-shared.ts  Shared types/constants for settings sub-components
  AgentTabsSection.tsx             Framework tab row inside settings panel
  GlobalPrefsSection.tsx           Global preference controls
  LlmProviderSection.tsx           LLM provider selector
  ModelConfigSection.tsx           Model config controls
  GitHubConnectionCard.tsx         GitHub connection card — guided credential setup (PAT paste + OAuth device sign-in via /api/github/device/*)
  PtyConsoleBase.tsx               PTY output streamer (drawer/side-panel/full variants)
  PtyConsoleDrawer.tsx             Drawer variant wrapper
  PtyConsoleSidePanel.tsx          Side-panel variant wrapper
  PtyTerminalPane.tsx              Full terminal pane variant
  TaskCardList.tsx                 Shared visual task-card language for /orchestrator and /task-coordinator landings
  orchestrator-capabilities.ts     Capability dispatch handlers for /orchestrator view (voice/chat driven)
  orchestrator-params.ts           Shared parameter helpers for orchestrator capability handlers
  orchestrator-stream.tsx          Conversation-view builder for orchestrator event/message records
  orchestrator-stream.helpers.ts   Helper utilities for orchestrator-stream
  orchestrator-diff.tsx            Diff view component for file-change tool cards
  orchestrator-diff.helpers.ts     Helper utilities for orchestrator-diff
  orchestrator-markdown.tsx        Markdown renderer (marked) for chat prose; shared MarkdownText
  orchestrator-markdown.helpers.ts Helper utilities for orchestrator-markdown
  orchestrator-plan.tsx            Plan/checklist block renderer
  orchestrator-reasoning.tsx       Collapsible reasoning block renderer
  view-format.ts                   Pure display formatters (time, tokens, USD, ANSI-strip)
  session-hydration.ts             Re-exports mapServerTasksToSessions + TERMINAL_STATUSES from @elizaos/ui
  pty-status-dots.ts               Re-exports PULSE_STATUSES + STATUS_DOT from @elizaos/ui
  components/
    TaskCoordinatorSpatialView.tsx  Spatial-vocabulary task coordinator GUI body
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
2. Handle the capability dispatch in `src/orchestrator-capabilities.ts` inside the capability dispatch map.

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

- **Two build steps.** The plugin has both a tsup JS build (`build:js`) and a Vite view-bundle build (`build:views`). The view bundle entry is `src/task-coordinator-view-bundle.ts` and outputs `dist/views/bundle.js`. Both must be built; `build` runs them in sequence.
- **View bundle re-exports.** `task-coordinator-view-bundle.ts` re-exports the three route components the manifest declares — `TaskCoordinatorView`, `OrchestratorView`, and `CockpitRoute` — plus the shared `interact` capability handler, so the built bundle serves every `componentExport` name. `OrchestratorWorkbench` ships inside the bundle transitively as the `Escape` child of `OrchestratorView`, not as a named export; `CodingAgentTasksPanel` is intentionally absent — it reaches its mount through the slot registry (`register-slots.ts` → the built-in Tasks page). The bundle is built with `codeSplitting: false` (single self-contained module) — a lazy chunk would re-import `./bundle.js` without the host-external query the loader used, so its bare `@elizaos/ui`/`react` imports would fail (this is what broke the cockpit terminal's lazy `@xterm` import; #11040/#11043).
- **Slot registry is a side-effect import.** `register-slots.ts` must be imported by the host app to activate the slot fills. Without it, the UI renders empty slot defaults in place of the coding-agent components.
- **Minimal server runtime.** This plugin registers no providers, services, or evaluators, and its only action is the `/orchestrator-status` slash-command handler (`src/orchestrator-command.ts`). All task/session state lives in `@elizaos/plugin-agent-orchestrator`. API boundary helpers in `src/api/` are utilities for route handlers in app-core, not plugin-registered routes.
- **PTY console buffer cap.** `PtyConsoleBase` caps displayed output at 200,000 characters (`MAX_BUFFER_CHARS`). Older output is silently trimmed from the head.
- **Live e2e test requires real Codex CLI.** `test:e2e:manual` (`test/coding-agent-codex-artifact.live.e2e.test.ts`) is skipped unless the `codex` binary is in PATH and `~/.codex/auth.json` exists.
- **Task coordinator spatial view.** `src/components/TaskCoordinatorSpatialView.tsx` is authored with the spatial vocabulary and is the presentational body of the shipped task-coordinator GUI route.
- See the root `CLAUDE.md` for repo-wide conventions (logger-only, ESM, naming, architecture rules).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
