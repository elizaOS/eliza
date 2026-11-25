# Router loop guard, streaming directives, and interruption classification

This specification models the subagent router's loop-guard bounds, at-most-once completion deduplication, streaming parent-agent directive extraction, and mid-turn interruption routing.

## Story: Bound subagent round-trips, deduplicate completion relays, and dispatch streaming parent directives once

> As an owner, I want runaway subagent retry loops capped, completion summaries relayed at most once per session, streaming parent-agent directives dispatched exactly once without stalling on malformed prose, and mid-turn messages classified cleanly.

### Router round-trips, state-lost respawns, and completion relays obey strict caps

Each session tracks its round-trip count against `roundTripCap`, its lineage `session_state_lost` respawn count against `respawnCap`, and a completion-posted flag. Once completion is posted for a session, duplicate completion events are rejected atomically (compare-and-swap deduplication).

```quint
type LoopDecision = LoopProceed | LoopCapExceeded | LoopDuplicateCompletion
type RouterGuardState = {
  roundTrips: int,
  roundTripCap: int,
  stateLostRespawns: int,
  respawnCap: int,
  completionPosted: bool,
  lastDecision: LoopDecision
}
pure val initial: RouterGuardState = {
  roundTrips: 0,
  roundTripCap: 4,
  stateLostRespawns: 0,
  respawnCap: 2,
  completionPosted: false,
  lastDecision: LoopProceed
}
pure def isApproachingCap(used: int, cap: int): bool =
  cap > 0 and used * 4 >= cap * 3 and used < cap
pure def canAdvanceRoundTrip(g: RouterGuardState): bool =
  not(g.completionPosted)
pure def advanceRoundTrip(g: RouterGuardState): RouterGuardState =
  if (g.roundTrips < g.roundTripCap)
    { ...g, roundTrips: g.roundTrips + 1, lastDecision: LoopProceed }
  else
    { ...g, lastDecision: LoopCapExceeded }
pure def canRecordStateLostRespawn(g: RouterGuardState): bool =
  not(g.completionPosted)
pure def recordStateLostRespawn(g: RouterGuardState): RouterGuardState =
  if (g.stateLostRespawns < g.respawnCap)
    { ...g, stateLostRespawns: g.stateLostRespawns + 1, lastDecision: LoopProceed }
  else
    { ...g, lastDecision: LoopCapExceeded }
pure def postCompletion(g: RouterGuardState): RouterGuardState =
  if (g.completionPosted)
    { ...g, lastDecision: LoopDuplicateCompletion }
  else
    { ...g, completionPosted: true, lastDecision: LoopProceed }
pure def alwaysLoopCountersWithinCaps(g: RouterGuardState): bool =
  g.roundTrips >= 0 and g.roundTrips <= g.roundTripCap and g.roundTripCap == 4 and g.stateLostRespawns >= 0 and g.stateLostRespawns <= g.respawnCap and g.respawnCap == 2
pure def stepCompletionIsMonotonic(before: RouterGuardState, after: RouterGuardState): bool =
  before.completionPosted implies after.completionPosted
pure def sometimesRoundTripCapExceeded(g: RouterGuardState): bool =
  g.roundTrips == g.roundTripCap and g.lastDecision == LoopCapExceeded
pure def sometimesDuplicateCompletionBlocked(g: RouterGuardState): bool =
  g.completionPosted and g.lastDecision == LoopDuplicateCompletion
```

### Streaming parent directives are buffered across chunks and malformed markers never block later directives

A subagent output stream may contain plain prose, a prose mention of the directive marker, a malformed object, a complete directive, or a directive split into an opening chunk followed by a closing chunk. Only an opening chunk stays buffered; prose mentions and malformed payloads are discarded immediately so subsequent directives still dispatch.

```quint
type StreamChunkKind = ChunkProse | ChunkMention | ChunkMalformed | ChunkDirective | ChunkOpening | ChunkClosing
type DirectiveStepResult = { pendingAfter: bool, dispatchedNow: bool }
pure def advanceDirectiveChunk(pendingBefore: bool, chunk: StreamChunkKind): DirectiveStepResult =
  if (pendingBefore)
    (if (chunk == ChunkClosing) { pendingAfter: false, dispatchedNow: true }
     else if (chunk == ChunkOpening) { pendingAfter: true, dispatchedNow: false }
     else { pendingAfter: false, dispatchedNow: false })
  else match chunk {
    | ChunkDirective => { pendingAfter: false, dispatchedNow: true }
    | ChunkOpening => { pendingAfter: true, dispatchedNow: false }
    | ChunkProse => { pendingAfter: false, dispatchedNow: false }
    | ChunkMention => { pendingAfter: false, dispatchedNow: false }
    | ChunkMalformed => { pendingAfter: false, dispatchedNow: false }
    | ChunkClosing => { pendingAfter: false, dispatchedNow: false }
  }
pure def lawMalformedOrMentionNeverStaysPending(chunk: StreamChunkKind): bool =
  (chunk == ChunkMention or chunk == ChunkMalformed) implies
    (not(advanceDirectiveChunk(false, chunk).pendingAfter) and not(advanceDirectiveChunk(false, chunk).dispatchedNow))
pure def lawSplitDirectiveDispatchesOnClose(pendingBefore: bool): bool =
  advanceDirectiveChunk(true, ChunkClosing).dispatchedNow and not(advanceDirectiveChunk(true, ChunkClosing).pendingAfter)
```

### Mid-turn room messages classify cleanly into ignore, queue, interrupt, or new task

When a subagent is busy, an explicit stop or redirect interrupts the turn, a follow-up instruction queues into the inbox, an unrelated request starts a new task, and ambient chatter is ignored. When idle, a directed instruction delivers immediately without interrupting.

```quint
type InterruptionIntent = IntentAmbient | IntentStop | IntentRedirect | IntentFollowUp | IntentUnrelated
type InterruptionAction = InterruptionIgnore | InterruptionQueue | InterruptionInterrupt | InterruptionNewTask
pure def classifyInterruption(addressed: bool, sessionBusy: bool, intent: InterruptionIntent): InterruptionAction =
  if (not(addressed) or intent == IntentAmbient) InterruptionIgnore
  else if (intent == IntentUnrelated) InterruptionNewTask
  else if (intent == IntentStop or intent == IntentRedirect)
    (if (sessionBusy) InterruptionInterrupt else InterruptionIgnore)
  else if (sessionBusy) InterruptionQueue
  else InterruptionNewTask
pure def lawAmbientOrUnaddressedAlwaysIgnored(addressed: bool, sessionBusy: bool, intent: InterruptionIntent): bool =
  (not(addressed) or intent == IntentAmbient) implies classifyInterruption(addressed, sessionBusy, intent) == InterruptionIgnore
pure def lawBusyStopAlwaysInterrupts(intent: InterruptionIntent): bool =
  (intent == IntentStop or intent == IntentRedirect) implies classifyInterruption(true, true, intent) == InterruptionInterrupt
```
