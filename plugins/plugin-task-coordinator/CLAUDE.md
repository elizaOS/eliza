# @elizaos/plugin-task-coordinator

Coding-agent task coordinator and session control surface for elizaOS agents.

## Purpose / role

This plugin adds a UI workbench for managing coding-agent task threads and PTY sessions. It registers view panels (standard, XR, and TUI variants) into the elizaOS app shell for both the task coordinator and the multi-agent orchestrator surfaces. All agent/task state is owned by `@elizaos/plugin-agent-orchestrator` — this plugin is the display and control layer only. Its sole server-side runtime contribution is a single view-scoped slash command for the orchestrator view (`/orchestrator-status`), registered through `@elizaos/plugin-commands`, plus its deterministic handler action (no providers, services, or evaluators).

The plugin is opt-in: it must be listed in the agent's plugin configuration. Once loaded, it registers its views into the app shell and fills the slot registry entries (`CodingAgentControlChip`, `CodingAgentSettingsSection`, `CodingAgentTasksPanel`, `PtyConsoleBase`) that `@elizaos/ui` leaves empty without this plugin.

## Plugin surface

The plugin surface is primarily views and slot-registry fills, plus one slash command + handler action (no providers, services, or evaluators).

### Slash command (`src/orchestrator-command.ts`)

| command | view scope | target | handler action |
|---|---|---|---|
| `/orchestrator-status` | `orchestrator` (#8798) | `agent` | `ORCHESTRATOR_STATUS_COMMAND` |

The plugin's `init()` calls `registerOrchestratorCommands(runtime.agentId)`, which registers the command into the per-runtime `@elizaos/plugin-commands` registry. Being `views`-scoped, it appears in `GET /api/commands` only while the orchestrator view is the active surface; the registered `orchestratorStatusCommandAction` is its deterministic, slash-only handler. This proves a non-core, view-owning plugin can light up the universal slash-command surface end to end (#8790).

### Views registered (`src/index.ts`)

Three views. The first two are ONE adaptive declaration each, spanning all three modalities from a single component; the third (`cockpit`) is GUI-only.

| view id | path | viewKind | modalities | componentExport | description |
|---|---|---|---|---|---|
| `task-coordinator` | `/task-coordinator` | `preview` | `gui`, `xr`, `tui` | `TaskCoordinatorView` | Coding-agent task threads, sessions, and controls |
| `orchestrator` | `/orchestrator` | `developer` (`developerOnly`) | `gui`, `xr`, `tui` | `OrchestratorView` | Multi-agent task orchestration workbench |
| `cockpit` | `/cockpit` | `developer` (`developerOnly`) | `gui` | `CockpitRoute` | Mobile-first coding cockpit — shaw's live task-room deck + per-session mode picker + tap-in interactive terminal, on one screen |

`TaskCoordinatorView` (`src/TaskCoordinatorView.tsx`) and `OrchestratorView` (`src/OrchestratorView.tsx`) are the tri-modal route components — each authored once and rendered inside a `SpatialSurface` that auto-detects GUI vs XR. `OrchestratorView` wraps the rich GUI/XR `OrchestratorWorkbench` in the spatial `Escape` hatch and degrades to the `OrchestratorSpatialView` summary in TUI; `TaskCoordinatorView` renders the presentational `TaskCoordinatorSpatialView` directly. `CockpitRoute` (`src/CockpitRoute.tsx`) is GUI-only (no `xr`/`tui`) — it composes the shared `CockpitView` deck with `CockpitSessionPane` (drill-in) and `CockpitInteractiveTerminal` (the tap-in `eliza-code` PTY terminal). The `tui` modality of the first two renders for real in the terminal — `register-terminal-view.tsx` registers `TaskCoordinatorSpatialView` and `OrchestratorSpatialView` into the `@elizaos/tui` terminal registry, each driven by a host-pushed snapshot. `CodingAgentTasksPanel` was not deleted; it still fills the `@elizaos/ui` Tasks-page slot (`register-slots.ts`) and is simply no longer a route `componentExport`.

The `task-coordinator` view declares capabilities: `list-sessions`, `list-task-threads`, `open-thread`, `stop-session`, `refresh`.

The `orchestrator` view declares capabilities — typed descriptors the TUI layer uses to drive the workbench. Capability IDs: `orchestrator-status`, `orchestrator-list-tasks`, `orchestrator-open-task`, `orchestrator-create-task`, `orchestrator-pause-task`, `orchestrator-resume-task`, `orchestrator-pause-all`, `orchestrator-resume-all`, `orchestrator-delete-task`, `orchestrator-fork-task`, `orchestrator-update-task`, `orchestrator-validate-task`, `orchestrator-add-agent`, `orchestrator-stop-agent`, `orchestrator-send-message`.

### Slot registry fills (`src/register-slots.ts`)

Calls `registerTaskCoordinatorSlots` from `@elizaos/ui` with:

- `CodingAgentControlChip` — header chip showing active session count; stop-all button.
- `CodingAgentSettingsSection` — agent settings panel (per-framework tabs: elizaOS, Pi Agent, OpenCode, Claude, Codex; auth, model, approval-preset config).
- `CodingAgentTasksPanel` — main task-thread list + PTY console view.
- `PtyConsoleBase` — PTY output streamer; subscribes to `pty-output` WS events.

### Registration side effects (`src/register.ts`)

`register.ts` is a side-effect module (imported for its effects, not exports). It does two things:

- **`import "./register-slots.js"`** — activates the slot-registry fills below (the `@elizaos/ui` empty-slot defaults). Without this import the UI renders empty slots.
- **Terminal-view registration (DOM-guarded)** — when there is no `window` (the Node agent / terminal host), it lazily imports `register-terminal-view` and calls `registerOrchestratorTerminalView()` + `registerTaskCoordinatorTerminalView()` so the two tri-modal views render inline in the terminal. Lazy + guarded so the terminal engine never enters browser/mobile bundles; best-effort (a failure never blocks plugin load).

The three GUI/XR views (`task-coordinator`, `orchestrator`, `cockpit`) reach the app shell through the standard **view manifest** in `src/index.ts` (`bundlePath` + `componentExport`), NOT via `registerAppShellPage` — this plugin registers no app-shell pages.

## Layout

```
src/
  index.ts                         Plugin definition — views + capabilities, init() command registration, handler action
  orchestrator-command.ts          /orchestrator-status slash command def + deterministic handler action (#8790)
  register.ts                      Slot import + DOM-guarded terminal-view registration
  register-slots.ts                Slot registry fills for ui empty-slot defaults
  register-terminal-view.tsx       Registers OrchestratorSpatialView in the @elizaos/tui terminal registry
  CodingAgentTasksPanel.tsx        Task thread list + PTY session panel; re-exports OrchestratorWorkbench
  CodingAgentTasksPanel.interact.ts  View-bundle `interact` capability handler (split for Fast-Refresh compat)
  task-coordinator-view-bundle.ts  Vite view-bundle entry; re-exports all view components + interact handler
  OrchestratorWorkbench.tsx        Multi-agent orchestration workbench (main UI); exports TaskInspector + useIsMobile/INSPECTOR_DRAWER_STYLE reused by the cockpit
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
  GitHubConnectionCard.tsx         GitHub connection status card
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
    OrchestratorSpatialView.tsx    Spatial-vocabulary orchestrator workbench; renders in GUI/XR and TUI
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
- **Spatial view.** `src/components/OrchestratorSpatialView.tsx` is authored once using the spatial vocabulary and renders in both GUI/XR and terminal (TUI) contexts via `register-terminal-view.tsx`. It is purely presentational (typed snapshot + action callback in, primitives out).
- See the root `AGENTS.md` for repo-wide conventions (logger-only, ESM, naming, architecture rules).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->
