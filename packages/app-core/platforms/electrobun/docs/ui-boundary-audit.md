# packages/ui Boundary Audit

Generated: 2026-05-17

Branch at audit: `codex/phase-11-event-bridge-wip`

Inspected:

- `packages/ui/package.json`
- `packages/ui/src`
- `packages/app/src`
- `packages/app-core/src`
- `packages/app-core/platforms/electrobun/src/dynamic-views`
- `packages/app-core/platforms/electrobun/src/trace`
- `packages/app-core/platforms/electrobun/src/voice`
- `packages/agent/src`

## Executive Summary

`packages/ui` is not an app, runtime, plugin, Remote, or capability executor. It is the shared rendering kit for production app surfaces, dynamic views, trace renderers, voice renderers, model status renderers, tool timelines, and plugin/app surfaces.

The audit found three hidden UI boundaries outside the obvious package:

- `packages/ui/src/App.tsx` is still the large production app routing shell, even though `packages/app` is the production composition package.
- `packages/app-core/src/runtime/desktop/*` renders detached desktop windows and tray behavior using `@elizaos/ui`.
- `packages/agent/src/api/views-*` and `packages/agent/src/shared/ui-catalog-prompt.ts` own view registry/API surfaces and LLM-facing UI vocabulary.

Do not migrate these in this phase. The right immediate action is to record the boundary and prevent capability execution from leaking into render packages.

## Expert Decision

Do the `plugin-coding-tools` edit/search/list parity decision before adding reusable trace rendering components to `packages/ui`.

Reason: trace rendering is valuable, but it is a renderer extraction. The current architectural risk is execution drift: `plugin-coding-tools` already routes FILE read/write through `eliza.fs`, SHELL through `eliza.pty`, and WORKTREE Git helpers through `eliza.git`, while edit/search/list still execute direct local filesystem mechanics. Finish the per-method parity decisions first so the execution boundary is coherent; then extract reusable trace renderers from the existing trajectory/tool-event components and `agent-run-trace.html`.

Review order:

1. Decide and document `plugin-coding-tools` list parity against `eliza.fs` list.
2. Decide and document search/glob/grep parity against `eliza.fs` search or add explicit Remote methods before routing.
3. Decide and document edit parity against an explicit edit/patch Remote method before routing.
4. Add reusable trace rendering components to `packages/ui`.

## Codebase UI Sweep Result

The sweep covered `packages/app`, `packages/app-core`, `packages/app-core/platforms/electrobun`, `packages/agent`, `packages/ui`, and plugin view surfaces.

Findings:

- `packages/app` has three renderer entry files and correctly remains production app composition.
- `packages/app-core/src/runtime/desktop` has four `.tsx` renderer roots. These are Electrobun desktop shell composition, not a second production app, but they should stay thin and compose `@elizaos/ui`.
- `packages/agent/src` has no React `.tsx` surfaces. Its UI-adjacent code is view registry/routes, static bundle serving, and LLM UI vocabulary, so it should remain a broker/spec layer rather than a renderer.
- 23 plugin packages depend on `@elizaos/ui`; 19 plugin files declare `views`. These are legitimate app/plugin surface bundles, not hidden Remotes.
- `packages/ui/src/services/local-inference` is the largest wrong-layer risk because it contains Node fs, downloader, device bridge, and service implementation code inside the rendering package.
- Browser microphone/playback helpers in `packages/ui` are acceptable browser adapters, but they must not own VAD, ASR, TTS, host playback policy, or `eliza.voice`.
- `packages/ui` already has good seeds for trace rendering: `ToolCallEventLog`, trajectory timeline components, LLM call cards, context diff lists, and pipeline graph components.

Conclusion: no additional hidden UI should be moved immediately. The consolidation plan is to keep UI surfaces where they are for review stability, mark the wrong-layer risks, and route execution paths before extracting shared trace components.

## Summary Counts

| Category | Count |
| --- | ---: |
| bridge-interface | 5 |
| primitive | 1 |
| layout | 1 |
| app-specific | 5 |
| dynamic-view-component | 3 |
| tool-component | 2 |
| voice-component | 4 |
| model-component | 1 |
| runtime-coupled | 3 |
| desktop-coupled | 2 |
| platform-adapter | 2 |
| widget | 1 |
| trace-component | 1 |

## What packages/ui Should Own

- Shared primitives: buttons, cards, inputs, tables, dialogs, popovers, labels, badges, tabs, tooltips.
- Shared layout: page panels, sidebars, workspace chrome, responsive layout utilities, navigation types.
- Shared renderers: chat transcripts, tool-call timelines, terminal output themes, Git/file/model/status renderers.
- Dynamic-view render components: view loader, view event bus helpers, safe JSON/details renderers, dynamic view frames.
- Trace render components: event list, model/tool/capability grouping, latency budget badges, trace timeline.
- Voice render components: voice pill, transcript display, latency timeline, voice turn summary, playback status.
- Bridge/client interfaces: typed HTTP/WebSocket clients and renderer-safe bridge adapters.

The key limit is that these modules should receive data, clients, and event streams. They should not instantiate host capability execution directly.

## What packages/ui Must Not Own

- Filesystem implementation.
- PTY/session implementation.
- Local Git implementation.
- Local model download/runtime control.
- AgentManager lifecycle.
- Electrobun main-process code.
- Remote invocation or worker ownership.
- TraceStore or TraceService.
- VoiceService, VAD, ASR, TTS, or host playback policy.
- Plugin semantic actions, providers, services, or connectors.

## Reusable Dynamic-View Component Candidates

| Candidate | Current path | Boundary decision |
| --- | --- | --- |
| Dynamic view loader | `packages/ui/src/components/views/DynamicViewLoader.tsx` | Keep in `packages/ui`; Electrobun owns registry/session state. |
| View event helpers | `packages/ui/src/views` | Keep as renderer/client helpers. |
| Tool event renderer | `packages/ui/src/components/tool-events/ToolCallEventLog.tsx` | Promote as reusable trace/dynamic-view renderer. |
| Local model renderers | `packages/ui/src/components/local-inference` | Keep UI renderers; data/control comes from app-core or runtime APIs. |
| Browser workspace render pieces | `packages/ui/src/components/pages/BrowserWorkspaceView.tsx` | Extract renderer pieces before any ownership move. |
| Documents render pieces | `packages/ui/src/components/pages/DocumentsView.tsx` | Extract document recall/RAG inspection components later. |
| Workflow graph render pieces | `packages/ui/src/components/pages/WorkflowGraphViewer.tsx` | Good future task/workflow dynamic view foundation. |
| App/plugin surface renderers | `packages/ui/src/components/apps` | Keep rendering here; plugin meaning stays plugin-owned. |

## Trace Component Candidates

- `packages/ui/src/components/tool-events/ToolCallEventLog.tsx`
- Future `TraceTimeline`
- Future `TraceEventDetails`
- Future `VoiceLatencyBudgetBadge`
- Future `ModelDeltaGroup`
- Future reusable pieces extracted from `packages/app-core/platforms/electrobun/src/trace/views/agent-run-trace.html`

Trace state remains in Electrobun/app-core. `packages/ui` should render trace events and latency summaries, not own trace storage or dynamic view sessions.

## Voice Component Candidates

- `packages/ui/src/components/voice-pill`
- `packages/ui/src/cloud-ui/components/voice`
- `packages/ui/src/voice/character-voice-config.ts`
- `packages/ui/src/voice/emotion.ts`
- Future `VoiceLatencyTimeline`
- Future `VoiceTurnSummary`

Browser microphone and playback helpers exist in `packages/ui/src/voice` and `packages/ui/src/cloud-ui/components/voice`. They are acceptable as browser adapters, but they overlap with the host `eliza.voice` layer. They must not become the source of truth for VAD, ASR, TTS, or host playback.

## Capability Rendering Candidates

| Capability | UI render candidate | Execution owner |
| --- | --- | --- |
| Terminal output | `packages/ui/src/terminal`, future terminal transcript component | `eliza.pty` through `eliza.runtime` |
| Local model status | `packages/ui/src/components/local-inference` | `eliza.local-model`, app-core, plugin-local-inference |
| Browser/computer context | `BrowserWorkspaceView` renderer pieces | Current browser bridge, future documented `eliza.computer` candidate only |
| Tool events | `ToolCallEventLog` | Plugin/runtime/capability broker |
| Workflow/task graphs | `WorkflowGraphViewer` renderer pieces | Plugin-workflow/task/orchestrator semantics |
| Logs/database tables | `LogsView`, `DatabaseView` renderer pieces | Runtime/app-core APIs |

## Bridge/Interface-Only Candidates

| Candidate | Current path | Decision |
| --- | --- | --- |
| API client base | `packages/ui/src/api/client-base.ts` | Keep as typed HTTP/WebSocket client. |
| Browser workspace client | `packages/ui/src/api/client-browser-workspace.ts` | Keep thin; future computer capability must not be implemented here. |
| Computer use client | `packages/ui/src/api/client-computeruse.ts` | Keep API client only. |
| Local inference client | `packages/ui/src/api/client-local-inference.ts` | Keep typed client; do not own model control. |
| Electrobun renderer bridge | `packages/ui/src/bridge/electrobun-rpc.ts` | Keep renderer-safe adapter; main-process execution stays in app-core/Electrobun. |
| Window shell routing | `packages/ui/src/platform/window-shell.ts` | Keep pure route parsing/sync helpers. |
| Desktop workspace client | `packages/ui/src/utils/desktop-workspace.ts` | Keep thin bridge client; no host implementation. |

## App-Specific Components

These are real product/app surfaces, not generic UI primitives:

- `packages/ui/src/App.tsx`
- `packages/ui/src/components/pages`
- `packages/ui/src/components/character`
- `packages/ui/src/first-run`
- `packages/ui/src/components/setup`
- `packages/app/src/main.tsx`
- `packages/app/src/components/AndroidVoicePill.tsx`
- `packages/app-core/src/runtime/desktop/AppWindowRenderer.tsx`
- `packages/app-core/src/runtime/desktop/DetachedShellRoot.tsx`
- `packages/app-core/src/runtime/desktop/DesktopTrayRuntime.tsx`

Do not move these now. The audit only records that product composition is distributed across `packages/app`, `packages/ui`, and `packages/app-core`.

## Runtime-Coupled Or Desktop-Coupled Risks

| Risk | Path | Recommendation |
| --- | --- | --- |
| Product shell hidden in shared UI | `packages/ui/src/App.tsx` | Owner decision before moving; no quick migration. |
| Route-level app pages in shared UI | `packages/ui/src/components/pages` | Extract reusable renderers before moving routes. |
| Execution-heavy local inference mirror | `packages/ui/src/services/local-inference` | Shrink to types/catalog/pure helpers or shared re-exports. |
| Concrete Electrobun bridge wrappers in UI | `packages/ui/src/bridge/electrobun-rpc.ts` | Keep thin and typed; no capability implementation. |
| Browser workspace client calls desktop bridge | `packages/ui/src/api/client-browser-workspace.ts` | Keep as bridge interface; future host execution belongs outside UI. |
| Browser mic/playback helpers overlap with host voice | `packages/ui/src/voice`, `packages/ui/src/cloud-ui/components/voice` | Treat as browser adapters only. |
| Hidden detached desktop renderers | `packages/app-core/src/runtime/desktop` | Keep as Electrobun shell composition, not product UI replacement. |
| Agent owns UI vocabulary | `packages/agent/src/shared/ui-catalog-prompt.ts` | Align with packages/ui primitives without importing React into agent runtime. |

## packages/app Inspection Result

`packages/app/src/main.tsx` is the production app composition root. It imports `@elizaos/ui`, `@elizaos/app-core`, Capacitor bridges, and app/plugin bundles like companion, phone, LifeOps, task coordinator, training, and stewardship views.

Boundary decision:

- Keep `packages/app` as production app UI.
- Do not collapse it into `packages/ui`.
- Do not replace it with `eliza.surface`.
- Do not route all product views through dynamic views.
- Use `packages/ui` as its rendering kit.

## packages/app-core Inspection Result

`packages/app-core` is mixed by design:

- Shared app/runtime APIs and services.
- Mobile/platform bootstrap.
- Electrobun shell, typed RPC, dynamic views, trace, voice, and native host code.
- Hidden desktop renderer roots in `src/runtime/desktop`.

Boundary decision:

- app-core may own platform bootstrap and Electrobun shell composition.
- app-core should not become a second production app.
- Desktop renderer roots should compose `@elizaos/ui` components and bridge to app-core/Electrobun services.
- TraceStore, TraceService, VoiceService, dynamic view registry, and sessions stay outside `packages/ui`.

## packages/agent Inspection Result

`packages/agent` is the standalone agent/backend runtime package. It contains:

- View registry and view routes at `packages/agent/src/api/views-routes.ts` and `packages/agent/src/api/views-registry.ts`.
- Static file serving for built React dashboard assets.
- UI catalog prompt data at `packages/agent/src/shared/ui-catalog-prompt.ts` and provider wiring around it.

Boundary decision:

- The agent may serve and broker plugin-declared views.
- The agent should not depend on React rendering components.
- The LLM-facing UI spec catalog should stay aligned with `packages/ui` primitive semantics.
- Dynamic view execution and capability routing stay outside the UI library.

## Deletion/Deprecation Candidates

| Candidate | Confidence | Safe now | Reason |
| --- | --- | --- | --- |
| `packages/ui/src/services/local-inference` execution-heavy mirror files | medium | no | Local fs, downloader, device bridge, and service code should not live in the rendering package once shared/app-core sources cover the contracts. |
| `packages/ui/src/App.tsx` as a public shared UI export | medium | no | This is app composition, but moving it changes package API and app boot. |
| `packages/ui/src/components/pages` route-level views | medium | no | Needs per-page renderer extraction before any ownership change. |

No files should be deleted as part of this audit.

## Owner-Decision Items

- Should `packages/ui` keep exporting `App`, or should `packages/app` own the production shell directly?
- How far should `packages/ui/src/services/local-inference` shrink toward shared type/catalog helpers?
- Should app-core desktop renderer roots remain in app-core or move into `packages/app` behind Electrobun-only adapters?
- How should `packages/agent` UI spec catalog stay synchronized with packages/ui primitives without coupling agent runtime to React?
- Should browser microphone/playback helpers remain in packages/ui as browser adapters or move under a dedicated voice client boundary?

## Recommended Next Phase

Do not migrate UI ownership next. The next reviewable slice should be:

1. Complete the `plugin-coding-tools` edit/search/list parity decision against `eliza.fs`.
2. Route only methods with explicit Remote parity.
3. Then add reusable trace rendering components to `packages/ui` using `ToolCallEventLog`, trajectory renderers, and `agent-run-trace.html` as source material.
