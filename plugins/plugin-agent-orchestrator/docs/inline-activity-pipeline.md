# Inline chat activity pipeline (#13536)

How elizaOS surfaces orchestrator/task/sub-agent/tool/workflow/todo activity
**inline in the chat thread** as it happens — the Codex / Claude-Code / OpenCode
turn-pipelining model, mapped onto the event stream elizaOS already emits. This
note records the mapping so the next engineer does not reinvent it or add a
second mechanism.

## How the reference agents pipe a turn

All three interleave one ordered activity stream inside the assistant turn, not
a separate rail:

- **Claude Code** — the turn is a sequence of *text*, *thinking*, and *tool_use*
  blocks. Each tool call is a collapsible row that transitions running → result
  in place; a sub-agent (Task tool) is a nested block with its own indented
  stream; the todo list (`TodoWrite`) is a live checklist that mutates in place
  rather than reprinting.
- **Codex** — the same shape over its exec/event protocol: streamed
  reasoning + message deltas, `tool_call` items that resolve to `tool_result`,
  and a plan/update surface rendered as a checklist.
- **OpenCode** — an ordered `part` stream per message (`text`, `reasoning`,
  `tool`, `step-start/finish`), child sessions nested under the parent, and a
  `todowrite`/`plan` tool whose latest snapshot is the checklist.

The common model: **one stream, ordered by sequence, grouped into a
task → sub-agent → step tree, with a plan/todo snapshot that mutates in place.**
We mirror it; we do not invent a new one.

## The elizaOS mapping

elizaOS already emits the equivalent events — the work was a typed envelope plus
an inline renderer, not new plumbing.

| Reference concept        | elizaOS source                                                        | Inline surface |
| ------------------------ | --------------------------------------------------------------------- | -------------- |
| ordered turn stream      | `SwarmEvent` over the `pty-session-event` WS channel                   | ordered by stamped `seq` |
| streamed text / thinking | ACP `message` / `reasoning` events                                    | sub-agent "current line" |
| tool call running→result | ACP `tool_running` events (`SwarmActivityTool`)                       | `ToolCallEventLog` step row |
| sub-agent / child session| a session's `sessionId`, nested via `parentSessionId`                 | `SubagentBlock` (indented) |
| plan / todo snapshot     | ACP `plan` events (`SwarmActivityPlanEntry[]`)                        | `PlanChecklist` (mutates in place) |
| task grouping            | the owning task thread projected as `taskId`                          | the `[TASK:<id>]` card |
| agent-authored todo list | `[CHECKLIST]` marker in a reply                                       | `PlanChecklist` |
| agent-authored pipeline  | `[WORKFLOW]` marker in a reply                                        | `WorkflowSteps` |

### The three seams

1. **Wire projection** — the client cannot reconstruct order or grouping from a
   flat, non-order-preserving WS stream, so `SwarmCoordinatorService.dispatchSwarmEvent`
   stamps every event with a monotonic `seq`, the owning `taskId` (resolved from
   the task context the service already maintains), and a `parentSessionId` when
   the payload names a nesting parent. Assigned once, at dispatch, so every emit
   site (including escalation/validator dispatches) gets the same projection.

2. **Typed envelope** — `SwarmEvent.data` is `unknown` because it is assembled
   from ACP-adapter payloads whose shape varies by backend. `toSwarmActivity`
   (`packages/core/src/types/swarm-coordinator.ts`) is the single boundary that
   validates one raw event and narrows it to a `SwarmActivityEnvelope` variant
   (`message | reasoning | plan | tool | lifecycle`) or `null` when nothing is
   renderable. Every widget reads the typed envelope; none pokes at `data`. Pure
   and dependency-free so it runs identically in server tests and the browser.

3. **Stream-driven store** — `task-activity-store` (`packages/ui/src/state`)
   subscribes **once** to `pty-session-event`, runs each event through
   `toSwarmActivity`, and regroups the flat stream into the task → sub-agent →
   step tree via `useSyncExternalStore`. A task card selects its own subtree with
   `useTaskActivity(taskId)` and re-renders only on its own events. **This is
   what lets the `[TASK]` card drop its old 5s poll** — the one durable hydrate
   fetch fills header fields that predate the current WS session; everything
   after arrives on the stream.

## One scheduler, not two

The inline pipeline is a **read model** over the existing orchestrator event
stream — the same `SwarmEvent`s the sidebar rail already consumes. It adds **no
new scheduler, no new poll for data already on the stream, and no second
knowledge store.** The sidebar rail stays as the flat "all activity" overflow;
the thread carries the focused, grouped pipeline. `summarizePtyEvent`
(`activity-plaintext.ts`) was extended so the previously-dropped
`message`/`reasoning`/`plan`/`ready`/`login_required`/`reconnected` events render
as useful text in the rail instead of raw event names.

## Making the agent-authored widgets reachable

`[CHECKLIST]` and `[WORKFLOW]` are taught to the model in the `uiWidgets`
provider (`packages/agent/src/providers/ui-catalog.ts`) alongside
`[FOLLOWUPS]`/`[FORM]`, so they are reachable end to end (model → marker →
parser → widget), not speculative dead widgets. A re-emitted block mutates the
list in place — the agent's own turn-to-turn plan/pipeline tracking, distinct
from the WS-driven plan inside an orchestrator task card (which the agent must
not duplicate).
