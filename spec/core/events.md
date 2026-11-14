# Agent events and subscriptions

[AgentEventService](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/services/agent-event.ts)
owns agent and heartbeat subscriptions, run context, per-run sequence and
the last heartbeat. [Runtime diagnostics](./diagnostics.md) owns the recent
error ring and asynchronous subscriber delivery. This machine models the
synchronous diagnostic forward that calls the agent event service again.
The [legacy bounded model](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/AgentEventService.qnt)
supplies earlier sequence and subscription contracts.

## Story: Emit ordered events with their run session

As an observer I receive the original event and its resulting diagnostics
with per-run sequence numbers and the original attribution.

### Each emission captures its payload and allocates the next run sequence

Emitting creates a sequence for an unknown run. Registering context copies
the supplied values. Updating an existing context ignores empty string
fields and applies either boolean heartbeat value when supplied. Clearing
a run removes its sequence and context together. Active emissions retain
the metadata and sequence captured before fanout began.

The boundary retains a nonblank caller session verbatim and supplies an
empty string for an absent or whitespace-only caller session. The saved
session key is used in that latter case. Data references identify complete
captured event payloads and original thrown objects. Times are observations
of the host clock.

```quint
type ListenerChannel = AgentChannel | HeartbeatChannel
type EmissionKind = AgentEmission | AgentDiagnostic | AgentWarning | HeartbeatEmission
type DeliveryPhase = VisitingListeners | ReportingErrors | ReadyToFinish
type HeartbeatStatus = NoHeartbeat | HeartbeatSent | HeartbeatFailed | HeartbeatOkEmpty | HeartbeatOkToken | HeartbeatSkipped
type HeartbeatIndicator = NoIndicator | AlertIndicator | ErrorIndicator | OkIndicator
type RunContext = { session: str, verbosity: str, heartbeatPresent: bool, heartbeat: bool, agentId: str, roomId: str }
type RunClock = { id: str, sequence: int, context: RunContext }
type Subscription = { callback: int, channel: ListenerChannel, generation: int }
type EventInput = { runId: str, requestedSession: str, stream: str, dataRef: int, agentId: str, roomId: str, timestamp: int }
type HeartbeatPayload = { status: HeartbeatStatus, indicator: HeartbeatIndicator, target: str, preview: str, durationPresent: bool, durationMs: int, mediaPresent: bool, hasMedia: bool, reason: str, channel: str, silentPresent: bool, silent: bool, timestamp: int }
type EventEnvelope = { emissionId: int, runId: str, sequence: int, stream: str, session: str, requestedSession: str, savedSession: str, dataRef: int, agentId: str, roomId: str, timestamp: int, listenerErrorCount: int }
type ListenerFailure = { callback: int, generation: int, errorRef: int }
type EventFrame = { kind: EmissionKind, phase: DeliveryPhase, envelope: EventEnvelope, heartbeat: HeartbeatPayload, cursor: int, callback: int, failures: List[ListenerFailure], reportCursor: int, parent: int, warningStarted: bool }
type EventState = { runs: List[RunClock], listeners: List[Subscription], nextGeneration: int, nextEmission: int, frames: List[EventFrame], lastHeartbeat: HeartbeatPayload, suppliedIndicator: HeartbeatIndicator, allocated: List[EventEnvelope], fanoutFinished: Set[int], completed: Set[int], reported: List[ListenerFailure], warnings: int, blockedReports: int }
pure val noIndicator: HeartbeatIndicator = NoIndicator
pure val noHeartbeatStatus: HeartbeatStatus = NoHeartbeat
pure val agentChannel: ListenerChannel = AgentChannel
pure val heartbeatChannel: ListenerChannel = HeartbeatChannel
pure val agentEmission: EmissionKind = AgentEmission
pure val agentDiagnostic: EmissionKind = AgentDiagnostic
pure val agentWarning: EmissionKind = AgentWarning
pure val heartbeatEmission: EmissionKind = HeartbeatEmission
pure val visitingListeners: DeliveryPhase = VisitingListeners
pure val reportingErrors: DeliveryPhase = ReportingErrors
pure val readyToFinish: DeliveryPhase = ReadyToFinish
pure val emptyContext: RunContext = { session: "", verbosity: "", heartbeatPresent: false, heartbeat: false, agentId: "", roomId: "" }
pure val emptyHeartbeat: HeartbeatPayload = { status: NoHeartbeat, indicator: NoIndicator, target: "", preview: "", durationPresent: false, durationMs: 0, mediaPresent: false, hasMedia: false, reason: "", channel: "", silentPresent: false, silent: false, timestamp: 0 }
pure val noEnvelope: EventEnvelope = { emissionId: 0, runId: "", sequence: 0, stream: "", session: "", requestedSession: "", savedSession: "", dataRef: 0, agentId: "", roomId: "", timestamp: 0, listenerErrorCount: 0 }
pure val noFrame: EventFrame = { kind: AgentEmission, phase: ReadyToFinish, envelope: noEnvelope, heartbeat: emptyHeartbeat, cursor: 0, callback: 0, failures: List(), reportCursor: 0, parent: 0, warningStarted: false }
pure val initial: EventState = { runs: List(), listeners: List(), nextGeneration: 1, nextEmission: 1, frames: List(), lastHeartbeat: emptyHeartbeat, suppliedIndicator: NoIndicator, allocated: List(), fanoutFinished: Set(), completed: Set(), reported: List(), warnings: 0, blockedReports: 0 }
pure val runIdValues = Set("run-a", "run-b", "")
pure val contextValues = Set(emptyContext, { ...emptyContext, session: "saved", verbosity: "debug", heartbeatPresent: true, heartbeat: true, agentId: "a", roomId: "r" }, { ...emptyContext, heartbeatPresent: true, heartbeat: false })
pure val exampleEvent: EventInput = { runId: "run-a", requestedSession: "", stream: "tool", dataRef: 10, agentId: "a", roomId: "r", timestamp: 5 }
pure val inputValues = Set(exampleEvent, { ...exampleEvent, runId: "run-b", requestedSession: " routed ", stream: "error", dataRef: 11, timestamp: 2 })
pure val callbackValues = Set(1, 2, 3)
pure val generationValues = Set(1, 2, 3, 4)
pure val errorRefValues = Set(0, 100)
pure val timestampValues = Set(2, 5)
pure def runContext(s: EventState, runId: str): RunContext = s.runs.select(r => r.id == runId).nthOr(0, {id: runId, sequence: 0, context: emptyContext}).context
pure def eventRun(s: EventState, runId: str): int = s.runs.select(r => r.id == runId).nthOr(0, {id: runId, sequence: 0, context: emptyContext}).sequence
pure def mergeRunContext(prior: RunContext, incoming: RunContext): RunContext = {
  session: if (incoming.session == "") prior.session else incoming.session,
  verbosity: if (incoming.verbosity == "") prior.verbosity else incoming.verbosity,
  heartbeatPresent: prior.heartbeatPresent or incoming.heartbeatPresent,
  heartbeat: if (incoming.heartbeatPresent) incoming.heartbeat else prior.heartbeat,
  agentId: if (incoming.agentId == "") prior.agentId else incoming.agentId,
  roomId: if (incoming.roomId == "") prior.roomId else incoming.roomId }
pure def canRegisterRun(s: EventState, runId: str, context: RunContext): bool = runId != ""
pure def registerRun(s: EventState, runId: str, context: RunContext): EventState =
  { ...s, runs: if (s.runs.some(r => r.id == runId)) s.runs.listMap(r => if (r.id == runId) { ...r, context: mergeRunContext(r.context, context) } else r) else s.runs.append({id: runId, sequence: 0, context: context}) }
pure def clearRun(s: EventState, runId: str): EventState = { ...s, runs: s.runs.select(r => r.id != runId) }
pure def top(s: EventState): EventFrame = s.frames.nthOr(s.frames.length() - 1, noFrame)
pure def withTop(frame: EventFrame, s: EventState): EventState = { ...s, frames: s.frames.removeAt(s.frames.length() - 1).append(frame) }
pure def pushAgent(input: EventInput, kind: EmissionKind, parent: int, errorCount: int, s: EventState): EventState = {
  val sequence = eventRun(s, input.runId) + 1
  val envelope: EventEnvelope = {emissionId: s.nextEmission, runId: input.runId, sequence: sequence, stream: input.stream, session: if (input.requestedSession == "") runContext(s, input.runId).session else input.requestedSession, requestedSession: input.requestedSession, savedSession: runContext(s, input.runId).session, dataRef: input.dataRef, agentId: input.agentId, roomId: input.roomId, timestamp: input.timestamp, listenerErrorCount: errorCount}
  val frame: EventFrame = { ...noFrame, kind: kind, phase: visitingListeners, envelope: envelope, parent: parent }
  { ...s, frames: s.frames.append(frame), nextEmission: s.nextEmission + 1, allocated: s.allocated.append(envelope), runs: if (s.runs.some(r => r.id == input.runId)) s.runs.listMap(r => if (r.id == input.runId) { ...r, sequence: sequence } else r) else s.runs.append({id: input.runId, sequence: 1, context: emptyContext}) }
}
pure def canAdmitEvent(s: EventState): bool = s.frames.length() == 0 or top(s).callback > 0
pure def admitEvent(s: EventState, input: EventInput): EventState = pushAgent(input, agentEmission, top(s).envelope.emissionId, 0, s)
pure def alwaysRunSequencesNonnegative(s: EventState): bool = s.runs.every(r => r.sequence >= 0 and s.runs.select(peer => peer.id == r.id).length() == 1)
pure def stepEmissionAllocatesRunSequence(before: EventState, via: str, after: EventState): bool = (via == "admitEvent" or via == "emitListenerWarning") implies top(after).envelope.sequence == eventRun(before, top(after).envelope.runId) + 1
pure def alwaysSessionUsesCallerOrRun(s: EventState): bool = s.allocated.every(envelope => envelope.session == (if (envelope.requestedSession == "") envelope.savedSession else envelope.requestedSession))
```

### Fanout visits the live listener map in insertion order

Each channel has its own registration map. Registering an already present
callback returns its existing generation. A disposer removes its exact
generation. The iterator advances before a callback begins. Removing an
unvisited listener skips that position. Removing and readding a callback
creates a new insertion position the same emission can visit. A listener can enter an
inner emission that delivers a higher sequence to a peer before the outer
emission reaches that peer. A nested
emission completes before the outer callback returns. Clearing the maps
during stop preserves the currently running callback.

```quint
pure val noSubscription: Subscription = {callback: 0, channel: AgentChannel, generation: 0}
pure def canSubscribe(s: EventState, callback: int, channel: ListenerChannel): bool = callback > 0
pure def subscribe(s: EventState, callback: int, channel: ListenerChannel): EventState =
  if (s.listeners.some(h => h.callback == callback and h.channel == channel)) s
  else { ...s, listeners: s.listeners.append({callback: callback, channel: channel, generation: s.nextGeneration}), nextGeneration: s.nextGeneration + 1 }
pure def canDetach(s: EventState, callback: int, channel: ListenerChannel, generation: int): bool = callback > 0 and generation > 0
pure def detach(s: EventState, callback: int, channel: ListenerChannel, generation: int): EventState =
  { ...s, listeners: s.listeners.select(h => h.callback != callback or h.channel != channel or h.generation != generation) }
pure def listenerChannel(frame: EventFrame): ListenerChannel = if (frame.kind == heartbeatEmission) heartbeatChannel else agentChannel
pure def nextListener(s: EventState): Subscription = {
  val frame = top(s)
  s.listeners.select(h => h.channel == listenerChannel(frame) and h.generation > frame.cursor).nthOr(0, noSubscription)
}
pure def canBeginListener(s: EventState): bool = s.frames.length() > 0 and top(s).phase == visitingListeners and top(s).callback == 0 and nextListener(s).callback > 0
pure def beginListener(s: EventState): EventState = {
  val h = nextListener(s)
  withTop({ ...top(s), cursor: h.generation, callback: h.callback }, s)
}
pure def canDeliverListener(s: EventState, errorRef: int): bool = top(s).callback > 0 and errorRef >= 0
pure def deliverListener(s: EventState, errorRef: int): EventState = {
  val frame = top(s)
  withTop({ ...frame, callback: 0, failures: if (errorRef == 0) frame.failures else frame.failures.append({callback: frame.callback, generation: frame.cursor, errorRef: errorRef}), phase: if (errorRef > 0 and frame.kind == heartbeatEmission) reportingErrors else visitingListeners }, s)
}
pure def canFinishOriginal(s: EventState): bool = s.frames.length() > 0 and top(s).phase == visitingListeners and top(s).callback == 0 and nextListener(s).callback == 0
pure def finishOriginal(s: EventState): EventState = {
  val frame = top(s)
  withTop({ ...frame, phase: if (frame.reportCursor < frame.failures.length()) reportingErrors else readyToFinish }, { ...s, fanoutFinished: s.fanoutFinished.union(Set(frame.envelope.emissionId)) })
}
pure def alwaysOneCurrentRegistration(s: EventState): bool = s.nextGeneration > 0 and s.listeners.every(h => h.callback > 0 and h.generation > 0 and h.generation < s.nextGeneration and s.listeners.select(peer => peer.callback == h.callback and peer.channel == h.channel).length() == 1)
pure def alwaysListenerOrderIsMonotonic(s: EventState): bool = s.listeners.foldl(0, (priorGeneration, h) => if (priorGeneration >= 0 and h.generation > priorGeneration) h.generation else -1) >= 0
pure def alwaysListenerCursorIsValid(s: EventState): bool = s.frames.every(frame => frame.cursor >= 0 and frame.cursor < s.nextGeneration and (frame.callback > 0 implies frame.cursor > 0 and frame.phase == visitingListeners))
pure def stepListenerBeginsAtNextPosition(before: EventState, via: str, after: EventState): bool = via == "beginListener" implies top(after).cursor > top(before).cursor and top(after).cursor == nextListener(before).generation and top(after).callback == nextListener(before).callback
pure def lawStaleHandleKeepsRegistrations(s: EventState, callback: int, channel: ListenerChannel, generation: int): bool = not(s.listeners.some(h => h.callback == callback and h.channel == channel and h.generation == generation)) implies detach(s, callback, channel, generation).listeners == s.listeners
pure def sometimesNestedEmission(s: EventState): bool = s.frames.length() > 1 and top(s).kind == agentEmission
pure def sometimesDetachedCallbackLeavesPeerPending(s: EventState): bool = top(s).callback > 0 and not(s.listeners.some(h => h.generation == top(s).cursor)) and nextListener(s).callback > 0
pure def sometimesStaleDetachPreservesReplacement(s: EventState): bool = s.listeners.some(h => h.generation > 1 and h.callback == 1)
```

### Original fanout precedes its diagnostic reports

Original visitation completes before its errors are reported, in the
order listeners threw them. Each report can synchronously start a
diagnostic event. The runtime reporting latch suppresses reports made
inside that diagnostic frame. Only a non-error agent stream emits a
warning, with one warning for the whole failure list. Heartbeat reports
run immediately between callbacks, with a logger warning after that
heartbeat traversal. The diagnostic event represents the exact original
error identity, and its adapter supplies the normalized error record. The parent call remains
active until warning fanout returns.

```quint
pure def reportingLatched(s: EventState): bool = s.frames.some(frame => frame.kind == agentDiagnostic)
pure def canReportListenerError(s: EventState): bool = top(s).phase == reportingErrors and top(s).reportCursor < top(s).failures.length()
pure def reportListenerError(s: EventState, timestamp: int, canForward: bool): EventState = {
  val frame = top(s)
  val fault = frame.failures.nthOr(frame.reportCursor, {callback: 0, generation: 0, errorRef: 0})
  val cursor = frame.reportCursor + 1
  val resume = if (frame.kind == heartbeatEmission) visitingListeners else if (cursor < frame.failures.length()) reportingErrors else readyToFinish
  val progressed = withTop({ ...frame, reportCursor: cursor, phase: resume }, s)
  val observed = { ...progressed, reported: s.reported.append(fault) }
  val runId = if (frame.kind == heartbeatEmission) "runtime" else frame.envelope.runId
  val diagnostic: EventInput = {runId: runId, requestedSession: "", stream: "error", dataRef: fault.errorRef, agentId: "", roomId: "", timestamp: timestamp}
  if (reportingLatched(s)) { ...progressed, blockedReports: s.blockedReports + 1 }
  else if (canForward) pushAgent(diagnostic, agentDiagnostic, frame.envelope.emissionId, 0, observed)
  else observed
}
pure def needsWarning(frame: EventFrame): bool = frame.kind == agentEmission and frame.envelope.stream != "error" and frame.failures.length() > 0 and not(frame.warningStarted)
pure def finishFrame(frame: EventFrame, s: EventState): EventState = { ...s, frames: s.frames.removeAt(s.frames.length() - 1), completed: s.completed.union(Set(frame.envelope.emissionId)), warnings: s.warnings + (if (frame.kind == heartbeatEmission and frame.failures.length() > 0) 1 else 0) }
pure def canEmitListenerWarning(s: EventState): bool = top(s).phase == readyToFinish and needsWarning(top(s))
pure def emitListenerWarning(s: EventState, timestamp: int): EventState = {
  val frame = top(s)
  val parent = frame.envelope.emissionId
  val warning: EventInput = {runId: frame.envelope.runId, requestedSession: frame.envelope.requestedSession, stream: "error", dataRef: 0, agentId: "", roomId: "", timestamp: timestamp}
  pushAgent(warning, agentWarning, parent, frame.failures.length(), withTop({ ...frame, warningStarted: true }, s))
}
pure def canCloseEmission(s: EventState): bool = s.frames.length() > 0 and top(s).phase == readyToFinish and not(needsWarning(top(s)))
pure def closeEmission(s: EventState): EventState = finishFrame(top(s), s)
pure def alwaysReportCursorIsValid(s: EventState): bool = s.frames.every(frame => frame.reportCursor >= 0 and frame.reportCursor <= frame.failures.length() and (frame.phase == readyToFinish implies frame.reportCursor == frame.failures.length()))
pure def alwaysDiagnosticsFollowOriginal(s: EventState): bool = s.frames.every(frame => (frame.kind == agentWarning implies s.fanoutFinished.contains(frame.parent)) and (frame.kind != heartbeatEmission and frame.phase != visitingListeners implies s.fanoutFinished.contains(frame.envelope.emissionId)))
pure def alwaysAllocatedSequencesArePositive(s: EventState): bool = s.nextEmission > 0 and s.allocated.every(envelope => envelope.sequence > 0 and envelope.emissionId > 0 and envelope.emissionId < s.nextEmission)
pure def sometimesErrorAndWarningFollowOriginal(s: EventState): bool = s.reported.length() > 0 and s.allocated.some(envelope => envelope.listenerErrorCount > 0)
```

### Heartbeat snapshots use an explicit indicator before the default

The last heartbeat is replaced before fanout. Sent maps to alert, both
successful no-send statuses map to ok, failed maps to error, and skipped
has no default indicator. An explicit indicator takes precedence.
Stopping clears both maps, run state, and the last heartbeat together.

```quint
pure val sentHeartbeat: HeartbeatStatus = HeartbeatSent
pure val failedHeartbeat: HeartbeatStatus = HeartbeatFailed
pure val okEmptyHeartbeat: HeartbeatStatus = HeartbeatOkEmpty
pure val okTokenHeartbeat: HeartbeatStatus = HeartbeatOkToken
pure val alertIndicator: HeartbeatIndicator = AlertIndicator
pure val errorIndicator: HeartbeatIndicator = ErrorIndicator
pure val okIndicator: HeartbeatIndicator = OkIndicator
pure val heartbeatInputValues = Set({ ...emptyHeartbeat, status: sentHeartbeat, target: "owner", preview: "posted", timestamp: 2 }, { ...emptyHeartbeat, status: failedHeartbeat, reason: "delivery rejected", timestamp: 5 }, { ...emptyHeartbeat, status: sentHeartbeat, indicator: okIndicator })
pure def defaultIndicator(status: HeartbeatStatus): HeartbeatIndicator = if (status == sentHeartbeat) alertIndicator else if (status == failedHeartbeat) errorIndicator else if (status == okEmptyHeartbeat or status == okTokenHeartbeat) okIndicator else noIndicator
pure def selectedIndicator(status: HeartbeatStatus, overrideIndicator: HeartbeatIndicator): HeartbeatIndicator = if (overrideIndicator == noIndicator) defaultIndicator(status) else overrideIndicator
pure def canHeartbeat(s: EventState, heartbeatInput: HeartbeatPayload): bool = heartbeatInput.status != noHeartbeatStatus and canAdmitEvent(s)
pure def heartbeat(s: EventState, heartbeatInput: HeartbeatPayload): EventState = {
  val payload: HeartbeatPayload = { ...heartbeatInput, indicator: selectedIndicator(heartbeatInput.status, heartbeatInput.indicator) }
  val anchor: EventEnvelope = { ...noEnvelope, emissionId: s.nextEmission }
  val frame: EventFrame = { ...noFrame, kind: heartbeatEmission, phase: visitingListeners, envelope: anchor, heartbeat: payload, parent: top(s).envelope.emissionId }
  { ...s, frames: s.frames.append(frame), nextEmission: s.nextEmission + 1, lastHeartbeat: payload, suppliedIndicator: heartbeatInput.indicator }
}
pure def stopEvents(s: EventState): EventState = { ...s, runs: List(), listeners: List(), lastHeartbeat: emptyHeartbeat, suppliedIndicator: noIndicator }
pure def alwaysHeartbeatIndicatorAgrees(s: EventState): bool = s.lastHeartbeat.indicator == selectedIndicator(s.lastHeartbeat.status, s.suppliedIndicator)
pure def sometimesFailedHeartbeatVisible(s: EventState): bool = s.lastHeartbeat.status == failedHeartbeat and s.lastHeartbeat.indicator == errorIndicator
pure def sometimesExplicitHeartbeatIndicator(s: EventState): bool = s.suppliedIndicator != noIndicator and s.lastHeartbeat.indicator != defaultIndicator(s.lastHeartbeat.status)
pure def stepEventStopClearsIndexes(before: EventState, via: str, after: EventState): bool = via == "stopEvents" implies after.runs.length() == 0 and after.listeners.length() == 0 and after.lastHeartbeat.status == noHeartbeatStatus and after.lastHeartbeat.indicator == noIndicator
```

### Finite synchronous callback work lets the emission finish

Progress assumes callbacks eventually return and cause only finitely many
new emissions and registrations. The sampled progress rule tracks each
active top emission by identity.

```quint
pure val fair_beginListener = "weak"
pure val fair_deliverListener = "weak"
pure val fair_finishOriginal = "weak"
pure val fair_reportListenerError = "weak"
pure val fair_emitListenerWarning = "weak"
pure val fair_closeEmission = "weak"
pure def leadsToEventIdle(s: EventState, later: EventState): bool =
  s.frames.length() > 0 implies later.completed.contains(top(s).envelope.emissionId)
```
