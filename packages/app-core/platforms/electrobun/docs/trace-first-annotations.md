# Top Trace-First Annotations

This document is the review boundary for the first trace-hook pass. It annotates the highest-value trace-first packages without migrating plugins, adding Remotes, adding static UI, or changing runtime ownership.

These packages stay in their current architecture roles. Trace should make their behavior visible before any dynamic-view or voice-facing product work expands.

## Selection Criteria

- User-visible or agent-visible work crosses a network, model, subprocess, browser, desktop, or workflow boundary.
- The package already owns a semantic runtime/plugin surface.
- Trace events can be added without changing the package into a Remote.
- Dynamic views, if any, are contextual inspection views, not dashboards.
- Host/system access still routes through the runtime broker or an existing Remote where that boundary already exists.

## Annotated Targets

| Target | Keep As | First Trace Scope | Dynamic View Scope | Broker Boundary | Review Note |
| --- | --- | --- | --- | --- | --- |
| `plugin-discord` | connector plugin | message ingress, slash command, reply, voice join/leave, rate limit, permission failure, send failure | none in the first pass | none | Keep Discord transport logic in the connector. Trace should explain message flow and failures. |
| `plugin-github` | connector plugin | issue/PR read, notification ingest, API call start/end/error, rate limit, mutation result | PR/issue context view only when an agent opens one | use `eliza.git` only for local repository operations | Keep GitHub API ownership in the connector. Local repo work is a separate capability boundary. |
| `plugin-browser` | native semantic plugin | browser session create, navigation, page context ingest, companion sync, connector auth state, bridge failure | task/browser context view | broker only host browser/window operations that need desktop access | Do not make browser a Remote. The plugin remains the semantic surface. |
| `plugin-computeruse` | native semantic plugin | screenshot, OCR, approval request/decision, click/key/window action, denial, failure | scene/approval/task inspection view | future `eliza.computer` only if host implementation needs a capability provider | Do not fold all desktop automation into Electrobun. Trace first, then decide if a narrow host capability is justified. |
| `plugin-documents` | app plugin | ingest, parse, index, search, recall, citation, export, failure | document recall/citation inspection view | none | Keep as an app/plugin bundle. Dynamic views should inspect document context, not replace the app surface. |
| `plugin-local-inference` | model plugin | catalog read, model status, model load/unload, generation request, ASR/TTS route, download/probe failure | none in the first pass | coordinate desktop/runtime operations through `eliza.local-model` where needed | Keep local inference source of truth in the plugin/shared catalog. The Remote wraps host coordination. |
| `plugin-native-talkmode` | voice plugin | VAD, ASR partial/final, runtime handoff, model first token, TTS first audio, playback, interrupt, error | reuse trace dynamic view | none | Keep talk mode as a voice participant. `eliza.voice` observes and coordinates; it does not replace the plugin. |
| `plugin-native-screencapture` | native semantic plugin | capture request, permission result, capture complete, recording start/stop, file artifact, failure | capture result inspection view | future `eliza.computer` only if a host capability boundary is needed | Keep the plugin as the agent-facing capture action surface. |
| `plugin-workflow` | app plugin | workflow draft, validation, repair, activation, node start/end/error, execution result | workflow run/node graph inspection view | none | Trace node lifecycle before adding any workflow view behavior. |
| `plugin-agent-orchestrator` | dev-tooling plugin | subagent spawn, prompt, tool call, stream chunk summary, blocked, complete, cancel, error | subagent/task timeline view | use existing runtime/broker paths for filesystem, terminal, and git work | Keep ACP/subagent orchestration in the plugin. Trace makes nested work inspectable. |
| `plugin-agent-skills` | dev-tooling plugin | skill discovery, load, validation, dependency resolution, execution start/end/error | contextual skill manifest/resource view | filesystem access stays inside the plugin storage mode or brokered host path | Keep progressive disclosure and storage semantics in the plugin. |
| `plugin-task-coordinator` | app plugin | task create/update, assignment, lifecycle transition, terminal result, failure | task graph/status view | none | Keep as an app/plugin bundle. Trace should explain task coordination before any new views. |
| `plugin-training` | app plugin | dataset import, trajectory capture, evaluation start/end, export, failure | training/evaluation artifact view | none | Keep training as an app/plugin bundle. Trace should capture evidence and artifacts without adding a dashboard. |

## Review Boundary

The first implementation pass should pick one small cluster, not every row:

1. Connector ingress and egress: `plugin-discord`, `plugin-github`.
2. Desktop/browser action visibility: `plugin-browser`, `plugin-computeruse`, `plugin-native-screencapture`.
3. Agent work visibility: `plugin-agent-orchestrator`, `plugin-agent-skills`.
4. Model/voice visibility: `plugin-local-inference`, `plugin-native-talkmode`.
5. App/workflow visibility: `plugin-documents`, `plugin-workflow`, `plugin-task-coordinator`, `plugin-training`.

Do not add package metadata fields until maintainers agree on a repo convention. Prefer README or central-doc annotations for review, then add trace hooks in a separate implementation pass.

## Non-Goals

- Do not convert these packages to Remotes.
- Do not add static Surface panels.
- Do not replace `packages/app`.
- Do not create a Swift host/controller path.
- Do not send ASR partials, browser events, connector events, or workflow events into new runtime paths just to trace them.
- Do not add dynamic views before the trace events are useful enough to inspect.
