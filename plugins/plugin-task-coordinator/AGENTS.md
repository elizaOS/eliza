# @elizaos/plugin-task-coordinator

Coding-agent task coordinator and session control surface for elizaOS agents.

## Purpose / role

This plugin adds a UI workbench for managing coding-agent task threads and PTY sessions. It registers view panels (standard, XR, and TUI variants) into the elizaOS app shell for both the task coordinator and the multi-agent orchestrator surfaces. It has no server-side runtime component (no actions, providers, services, or evaluators); all agent/task state is owned by `@elizaos/plugin-agent-orchestrator` — this plugin is the display and control layer only.

The plugin is opt-in: it must be listed in the agent's plugin configuration. Once loaded, it registers its views into the app shell and fills the slot registry entries (`CodingAgentControlChip`, `CodingAgentSettingsSection`, `CodingAgentTasksPanel`, `PtyConsoleBase`) that `@elizaos/ui` leaves empty without this plugin.

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

Registers three pages in the `developer` group via `registerAppShellPage` from `@elizaos/ui/app-shell-registry`:

- `/odysseus` (order 69, `fullBleed: true`) — the `OdysseusShell` chat UI (see `src/odysseus/`).
- `/orchestrator` (order 70, `fullBleed: true`) — the `OrchestratorWorkbench`.
- `/orchestrator/tui` (order 71) — the TUI variant.

`fullBleed: true` opts the page into edge-to-edge mounting (no host header / tab-bar / padding) — these views own their full window. The flag is defined on `AppShellPageRegistration` in `@elizaos/ui`.

## Layout

```
src/
  index.ts                         Plugin definition — views + capabilities declared here
  register.ts                      App-shell page registration (/odysseus, /orchestrator, /orchestrator/tui)
  register-slots.ts                Slot registry fills for ui empty-slot defaults
  register-terminal-view.tsx       Registers OrchestratorSpatialView in the @elizaos/tui terminal registry
  CodingAgentTasksPanel.tsx        Task thread list + PTY session panel; re-exports OrchestratorWorkbench
  CodingAgentTasksPanel.interact.ts  View-bundle `interact` capability handler (split for Fast-Refresh compat)
  task-coordinator-view-bundle.ts  Vite view-bundle entry; re-exports all view components + interact handler
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
  odysseus/                        Odysseus-style orchestrator chat UI (full-bleed /odysseus page)
    OdysseusShell.tsx              Root shell: sidebar/rail, composer, tool-window host
    SessionSidebar.tsx IconRail.tsx  Labeled nav sidebar + its collapsed 48px icon rail
    Composer.tsx ChatContainer.tsx ChatMessages.tsx MessageBubble.tsx ChatTopBar.tsx  Chat column
    MemoryPanel.tsx SkillsPanel.tsx NotesPanel.tsx SettingsPanel.tsx PresetsPanel.tsx ThemeMenu.tsx  Panels
    TasksView/ModelsView/EmailView/CalendarView/GroupChatView/AdminView/GalleryView/
      GalleryEditorView/CompareView/ResearchView/VoiceView/CookbookView/DocumentLibraryView.tsx  Tool views
    WindowManager.tsx WindowManager.context.ts  Cross-view window registry + context
    MinimizedDock.tsx ResizeHandles.tsx  Minimize dock + resize handles
    SearchPalette.tsx EmojiPicker.tsx Spinner.tsx BgEffect.tsx  Misc UI
    odysseus-theme.ts              ODYSSEUS_CSS — the theme stylesheet (CSS-in-template-literal)
    hooks/                         useWindowControls, useKeyboardShortcuts, useTaskRoom, useChatSubmit, useEscapeClose
    util/storage.ts                Namespaced localStorage helpers
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
- **View bundle re-exports.** `task-coordinator-view-bundle.ts` re-exports all view components (`CodingAgentTasksPanel`, `TaskCoordinatorTuiView`, `OrchestratorWorkbench`, `OrchestratorTuiView`) plus the shared `interact` capability handler so the built bundle serves all `componentExport` names the view manifest declares.
- **Slot registry is a side-effect import.** `register-slots.ts` must be imported by the host app to activate the slot fills. Without it, the UI renders empty slot defaults in place of the coding-agent components.
- **No server runtime.** This plugin registers zero actions, providers, services, or evaluators. All task/session state lives in `@elizaos/plugin-agent-orchestrator`. API boundary helpers in `src/api/` are utilities for route handlers in app-core, not plugin-registered routes.
- **PTY console buffer cap.** `PtyConsoleBase` caps displayed output at 200,000 characters (`MAX_BUFFER_CHARS`). Older output is silently trimmed from the head.
- **Live e2e test requires real Codex CLI.** `test:e2e:manual` (`test/coding-agent-codex-artifact.live.e2e.test.ts`) is skipped unless the `codex` binary is in PATH and `~/.codex/auth.json` exists.
- **Spatial view.** `src/components/OrchestratorSpatialView.tsx` is authored once using the spatial vocabulary and renders in both GUI/XR and terminal (TUI) contexts via `register-terminal-view.tsx`. It is purely presentational (typed snapshot + action callback in, primitives out).
- See the root `AGENTS.md` for repo-wide conventions (logger-only, ESM, naming, architecture rules).
