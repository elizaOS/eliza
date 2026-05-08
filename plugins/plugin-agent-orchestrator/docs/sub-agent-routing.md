# Sub-agent routing

> Canonical orchestration path for ACPX sub-agents. Replaces the
> autonomous-coordinator model from `plugin-agent-orchestrator/swarm-*`.

## Goals

1. **Origin tracking.** When the main agent spawns a sub-agent in response to
   a user message in room R, the sub-agent's terminal output (`task_complete`,
   `error`, `blocked`) lands back in room R, addressed appropriately.
2. **Main-agent-in-the-loop.** When a sub-agent reports done, the **main
   agent** — not a separate coordinator — decides whether to:
   - reply to the user (sub-agent finished, here's the result),
   - reply to the sub-agent via `SEND_TO_AGENT` (proof not satisfying; keep
     going),
   - or both in one turn.
3. **Cache friendliness.** Sub-agent updates should not invalidate the
   stable provider/system prefix on every event.

## Components

### `AcpService` (existing)

Spawn surface. `createTaskAction` records origin context in
`session.metadata` at spawn time:

```ts
{
  messageId: message.id,    // parent message UUID
  roomId:    message.roomId,
  worldId:   message.worldId,
  userId:    message.entityId,
  label,
  source:    content.source,
}
```

### `SubAgentRouter` (new — `services/sub-agent-router.ts`)

Subscribes to `AcpService.onSessionEvent`. On `task_complete`, `error`, or
`blocked` (boundary events only — not streaming chunks), it:

1. Reads `session.metadata` for origin keys.
2. Constructs a synthetic `Memory` with:
   - `entityId` = a stable per-session sub-agent UUID
     (`createUniqueUuid(runtime, "acpx:sub-agent:<sessionId>")`),
   - `agentId`  = `runtime.agentId`,
   - `roomId`   = origin `roomId`,
   - `content.source` = `"sub_agent"`,
   - `content.inReplyTo` = origin `messageId`,
   - `content.metadata.subAgent*` carries the structured event
     (`subAgentSessionId`, `subAgentLabel`, `subAgentEvent`,
     `subAgentStatus`, `subAgentAgentType`, `originUserId`,
     `originMessageId`, `originSource`).
3. Persists the memory via `runtime.createMemory(..., "messages")`.
4. Delivers via `runtime.messageService.handleMessage(runtime, memory)`.

The runtime's connector hooks (`outgoing_before_deliver`) handle delivery to
Telegram/Discord/UI — same path a real user message would follow. There is
no callback held by the router.

#### Why only boundary events

Streaming events (`agent_message_chunk`, `tool_running`, `ready`) would
re-fire the planner constantly and burn the prompt cache. Live status is
exposed via the provider instead. The router is the channel for events
that warrant an action decision.

#### Dedup / idempotency

Events are deduped in-memory by
`<sessionId>|<event>|<status>|<short hash of payload>`. Same sub-agent
re-emitting the same `task_complete` payload posts once. A different
response payload posts again — that's "the sub-agent did more work and
reported a new state".

#### Disable switch

`ACPX_SUB_AGENT_ROUTER_DISABLED=1` keeps the service registered but unbound
(useful for tests, headless backfills, or staging where you want spawning
without runtime injection).

### `activeSubAgentsProvider` (new — `providers/active-sub-agents.ts`)

Cache-friendly view of live sub-agent sessions. Filters to:

- sessions whose `metadata.roomId` is set (i.e. routed by `createTaskAction`),
- sessions not in a terminal status (`stopped`, `completed`, `error`,
  `errored`, `cancelled`).

The text is **structural only** — id, label, agentType, status, last two
workdir segments. No timestamps, no message excerpts. Sorted by `sessionId`
so the rendered text is byte-stable across turns when the active set is
unchanged.

This is the live status channel. The synthetic Memory posted by the router
is the per-event channel.

### Action set

The main agent's planner sees:

- **`REPLY`** (from the bootstrap action set) — replies to the user in
  current room.
- **`SEND_TO_AGENT { sessionId, text }`** — pushes a follow-up to a
  live sub-agent. Use when the sub-agent's proof is unsatisfying or it
  asked a clarifying question.
- **`STOP_AGENT { sessionId }`** — terminates. Use when the sub-agent's
  output is clearly final and you don't want it idling.
- **`ACPX_CREATE_TASK`** — spawn additional sub-agents.

Multi-action plans (e.g. `[REPLY, SEND_TO_AGENT]`) are supported by the
planner and execute sequentially in one turn.

## Cache discipline

Anthropic prompt caching breaks at segment boundaries (see
`plugin-anthropic/models/text.ts`). The plugin marks providers and action
examples as `stable: true`. Sub-agent flow is designed around this:

- **Stable prefix (cached):** system prompt, character bio, action examples,
  active-sub-agents provider text (structural only, sorted, deterministic).
- **Volatile suffix (re-tokenized):** the sub-agent's synthetic message
  text (the per-event narration).

Each new sub-agent event invalidates only the message tail. The provider
text changes only when a session enters or leaves the active set, not on
every chunk.

A per-session router invocation is one cache-miss tail; everything before
the most recent turn stays warm.

## Loop safety

- The router emits **inbound** memories with `entityId` set to the
  sub-agent's pseudo-UUID (not `runtime.agentId`), so the runtime processes
  them as messages from another entity, not as the agent's own outputs.
- The main agent's reply via `SEND_TO_AGENT` does not directly trigger a
  new `task_complete`. The sub-agent has to actually do work first, which
  bounds re-entry.
- Dedup prevents accidental double-injection from event re-emission.

## Migration from swarm-coordinator

`plugin-agent-orchestrator`'s `swarm-coordinator.ts` and
`swarm-decision-loop.ts` are bound to `PTYService` only. Sessions spawned
through `AcpService` (the canonical path now) bypass them entirely.

The swarm coordinator's autonomous decision logic
(`makeCoordinationDecision`, `buildTurnCompletePrompt`,
`buildBlockedEventMessage`) is replaced by the main agent's normal action
selection over the synthetic Memory.

When all PTY-spawned call sites migrate to AcpService, the swarm-* services
can be removed in a follow-up. Until then they remain dormant alongside
the new path.

## Testing

- `__tests__/unit/sub-agent-router.test.ts` — origin tracking, dedup,
  streaming-event filtering, disable switch, error narration, fallback
  emit, unsubscribe.
- `__tests__/unit/active-sub-agents.test.ts` — origin filtering, terminal
  exclusion, deterministic sort, no volatile fields, action-hint text.

## Related files

- [src/services/sub-agent-router.ts](../src/services/sub-agent-router.ts)
- [src/providers/active-sub-agents.ts](../src/providers/active-sub-agents.ts)
- [src/services/acp-service.ts](../src/services/acp-service.ts)
- [src/actions/create-task.ts](../src/actions/create-task.ts)
- [src/actions/send-to-agent.ts](../src/actions/send-to-agent.ts)
