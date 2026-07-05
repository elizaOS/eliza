# Evidence — #13536 inline chat activity pipeline

Surfaces orchestrator/task/sub-agent/tool/workflow/todo activity inline in the
chat thread, driven by the existing `pty-session-event` WS stream (the one
scheduler) — no second mechanism, no new poll for data already on the stream.

## Rendered pixels (real components)

- `task-pipeline-desktop.png` / `task-pipeline-mobile.png` — the real
  `SubagentBlock` / `PlanChecklist` / `WorkflowSteps` / `ToolCallEventLog`
  components rendered in headless chromium, populated with the exact
  `SubagentActivity`/plan shapes the WS-driven `task-activity-store` produces from
  a real `pty-session-event` run. Shows: the expanded task card ("Ship the
  planner loop", active, 2/2 agents), a builder sub-agent with a live plan
  checklist (completed → in-progress → pending) and two in-place tool-call steps
  (read → success, edit → running), a nested reviewer child session (indented,
  streaming reasoning), the `[WORKFLOW]` Deploy pipeline (done/running/pending),
  and the standalone `[CHECKLIST]` Migration todo. Orange accent only, no blue;
  clean console (0 errors).
- Harness: `packages/ui/src/components/chat/widgets/__e2e__/run-task-pipeline-e2e.mjs`
  (`bun run --cwd packages/ui test:task-pipeline-e2e`).

## Stream-driven data path (real, not mocked)

The WS reconstruction + reducer are proven end to end in
`packages/ui/src/state/task-activity-store.test.ts`: a subscriber binds the store
to the socket, then a genuine server `pty-session-event` frame is delivered
through the REAL client fan-out (`client.deliverWsMessageForTest` →
`ElizaClient.dispatchWsData`, the same path the live socket's `onmessage` runs) →
`bindWs` reconstructs the `SwarmEvent` → `toSwarmActivity` → the reducer regroups
it into the task→sub-agent→step tree. No mock stands in for the store, the
normalizer, or the client fan-out.

## Backend / schema

- Typed discriminated envelope + normalizer: `packages/core/src/types/swarm-coordinator.ts`
  (`SwarmActivityEnvelope`, `toSwarmActivity`) — tests
  `packages/core/src/__tests__/swarm-activity.test.ts`.
- `seq`/`taskId`/`parentSessionId` projected onto every dispatched event:
  `plugins/plugin-agent-orchestrator/src/services/swarm-coordinator-service.ts`.
- `summarizePtyEvent` extended for the previously-dropped
  message/reasoning/plan/ready/login_required/reconnected kinds:
  `packages/core/src/activity-plaintext.ts` — tests
  `packages/core/src/__tests__/activity-plaintext.test.ts`.

## Agent-emittable widgets (reachable, not dead)

`[CHECKLIST]` and `[WORKFLOW]` are taught to the model in the `uiCatalog` provider
(`packages/agent/src/providers/ui-catalog.ts`, Methods 5 & 6), so the agent can
emit them end to end (model → marker → parser → widget). Grammar-drift guard:
`packages/agent/src/providers/ui-catalog.followups.test.ts` asserts the catalog's
example blocks satisfy the exact parser regexes.

## Design note

`plugins/plugin-agent-orchestrator/docs/inline-activity-pipeline.md` — how
OpenCode/Codex/Claude-Code pipe a turn and the elizaOS mapping mirrored here.

## Not captured here

- Live-LLM trajectory of a full orchestrator run emitting the markers: N/A for
  this render-layer PR — the model→marker path is covered by the ui-catalog
  grammar test; a live orchestrator drive requires provider creds + a running ACP
  backend (pending-hardware leg), and the WS→render path it would exercise is
  already proven real above.
