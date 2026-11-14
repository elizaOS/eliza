# Local inference priority admission

One process-wide gate serializes local inference. Interactive requests precede queued background requests without preempting an active holder. Source [inference-priority-gate.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/utils/inference-priority-gate.ts).

## Story: Prioritize interactive inference without changing requests

As a caller I acquire the native lane in FIFO priority order with the full request bytes and token limit. The admission boundary retains label, holder acquisition time, and the identity of the waiter that owns each native timer and abort listener. The constructor's clock is injectable. Its default wall clock can move backward.

### Native inference starts only for lane owners

Immediate idle acquisition ignores a background request's queue wait budget. A queued, bounded background request owns its capture timer until grant, timeout or removal. A queued request with a signal similarly owns its installed listener. Signal pre-abort rejects initial acquisition without queueing or invoking native inference. Native work begins after the acquisition promise resolves and releases the lane on either outcome.

```quint
type InferencePriority = Interactive | Background
type InferencePhase = QueuedInference | AcquiredInference | RunningInference | InferenceSucceeded | InferenceFailed | InferenceTimedOut | InferenceAborted
type TokenLimit = NoTokenLimit | TokenLimitValue({limit: int})
type InferenceInput = {priority: InferencePriority, prompt: str, maxTokens: TokenLimit, waitMs: int, hasDeadline: bool, label: str, hasSignal: bool, signalAborted: bool}
type TimeoutOrigin = NoTimeout | WaitTimerTimeout | HandoffTimeout
type InferenceRequest = {id: int, priority: InferencePriority, phase: InferencePhase, prompt: str, maxTokens: TokenLimit, label: str, enqueuedAt: int, acquiredAt: int, expiresAt: int, timer: bool, listener: bool, hasSignal: bool, signalAborted: bool, timeout: TimeoutOrigin, waitedMs: int, holderAtTimeout: int, holderLabel: str}
type InferenceGate = {now: int, holder: int, requests: List[InferenceRequest]}
pure val initial: InferenceGate = {now: 0, holder: 0, requests: List()}
pure val requestIdValues = Set(1, 2, 3, 4)
pure val observedTimeValues = Set(-2, 0, 1, 5, 20)
pure val absentTokenLimit: TokenLimit = NoTokenLimit
pure val noTimeoutOrigin: TimeoutOrigin = NoTimeout
pure val abortedAdmission: InferencePhase = InferenceAborted
pure val immediateAdmission: InferencePhase = AcquiredInference
pure val queuedAdmission: InferencePhase = QueuedInference
pure val inputValues = Set(
  {priority: Interactive, prompt: "complete interactive", maxTokens: TokenLimitValue({limit: 4096}), label: "chat", waitMs: 1, hasDeadline: true, hasSignal: true, signalAborted: false},
  {priority: Interactive, prompt: "already cancelled", maxTokens: absentTokenLimit, label: "chat", waitMs: 0, hasDeadline: false, hasSignal: true, signalAborted: true},
  {priority: Background, prompt: "complete zero wait", maxTokens: TokenLimitValue({limit: 100}), label: "task", waitMs: 0, hasDeadline: true, hasSignal: false, signalAborted: false},
  {priority: Background, prompt: "complete long wait", maxTokens: absentTokenLimit, label: "task-slow", waitMs: 5, hasDeadline: true, hasSignal: true, signalAborted: false},
  {priority: Background, prompt: "complete unbounded wait", maxTokens: TokenLimitValue({limit: -1}), label: "task-unbounded", waitMs: -1, hasDeadline: false, hasSignal: false, signalAborted: false}
)
pure val absentRequest: InferenceRequest = {id: 0, priority: Background, phase: InferenceFailed, prompt: "", maxTokens: absentTokenLimit, label: "", enqueuedAt: 0, acquiredAt: 0, expiresAt: 0, timer: false, listener: false, hasSignal: false, signalAborted: false, timeout: NoTimeout, waitedMs: 0, holderAtTimeout: 0, holderLabel: ""}
pure def inferenceRequest(s: InferenceGate, requestId: int): InferenceRequest = s.requests.select(r => r.id == requestId).nthOr(0, absentRequest)
pure def isLaneHolder(r: InferenceRequest): bool = r.phase == AcquiredInference or r.phase == RunningInference
pure def canRequestInference(s: InferenceGate, requestId: int, input: InferenceInput): bool = requestId > 0 and not(s.requests.some(r => r.id == requestId)) and (not(input.signalAborted) or input.hasSignal)
pure def requestInference(s: InferenceGate, requestId: int, input: InferenceInput): InferenceGate = {
  val immediately = not(input.signalAborted) and s.holder == 0 and (input.priority == Interactive or not(s.requests.some(r => r.phase == QueuedInference and r.priority == Interactive)))
  val waiting = not(input.signalAborted) and not(immediately)
  val boundedWait = if (input.waitMs < 0) 0 else input.waitMs
  val request: InferenceRequest = {
    id: requestId, priority: input.priority, phase: if (input.signalAborted) abortedAdmission else if (immediately) immediateAdmission else queuedAdmission,
    prompt: input.prompt, maxTokens: input.maxTokens, label: input.label,
    enqueuedAt: s.now, acquiredAt: if (immediately) s.now else 0, expiresAt: s.now + boundedWait,
    timer: waiting and input.priority == Background and input.hasDeadline, listener: waiting and input.hasSignal,
    hasSignal: input.hasSignal, signalAborted: input.signalAborted, timeout: noTimeoutOrigin, waitedMs: 0, holderAtTimeout: 0, holderLabel: ""
  }
  { ...s, holder: if (immediately) requestId else s.holder, requests: s.requests.append(request) }
}
pure def canInvokeInference(s: InferenceGate): bool = s.holder > 0 and inferenceRequest(s, s.holder).phase == AcquiredInference
pure def invokeInference(s: InferenceGate): InferenceGate = { ...s, requests: s.requests.listMap(r => if (r.id == s.holder) { ...r, phase: RunningInference } else r) }
pure def alwaysOneInferenceHolder(s: InferenceGate): bool = s.requests.select(r => isLaneHolder(r)).length() == (if (s.holder == 0) 0 else 1) and s.requests.every(r => isLaneHolder(r) implies r.id == s.holder)
pure def alwaysInferenceIdsUnique(s: InferenceGate): bool = s.requests.every(r => r.id > 0 and s.requests.select(other => other.id == r.id).length() == 1)
pure def alwaysWaitingHooksOwned(s: InferenceGate): bool = s.requests.every(r => (r.timer implies r.priority == Background and r.phase == QueuedInference) and (r.listener iff r.hasSignal and r.phase == QueuedInference))
pure def sometimesInteractiveWaitsForBackground(s: InferenceGate): bool = s.requests.some(r => isLaneHolder(r) and r.priority == Background) and s.requests.some(r => r.phase == QueuedInference and r.priority == Interactive)
```

### Handoff prunes the examined background prefix only

Completing a holder releases its lane and synchronously scans FIFO queues. A queued interactive request takes the lane before any background request is checked. With no interactive waiter, release rejects expired background entries until it grants the first eligible background entry or observes an empty queue. An expired entry behind the new holder remains queued and retains its own timer. The handoff diagnostic captures the released holder. The model projects a single clock observation per synchronous handoff. Source refinement still needs to account for distinct clock reads within one scan and reentry through an injected clock or logger.

```quint
type Handoff = {granted: int, expired: List[int]}
pure val noHandoff: Handoff = {granted: 0, expired: List()}
pure def expired(r: InferenceRequest, now: int): bool = r.timer and now >= r.expiresAt
pure def scanBackground(scan: Handoff, r: InferenceRequest, now: int): Handoff =
  if (scan.granted != 0 or r.phase != QueuedInference or r.priority != Background) scan
  else if (expired(r, now)) { ...scan, expired: scan.expired.append(r.id) } else { ...scan, granted: r.id }
pure def handoff(s: InferenceGate): Handoff = {
  val interactive = s.requests.select(r => r.phase == QueuedInference and r.priority == Interactive).nthOr(0, absentRequest)
  if (interactive.id != 0) { ...noHandoff, granted: interactive.id }
  else s.requests.foldl(noHandoff, (scan, r) => scanBackground(scan, r, s.now))
}
pure def expireWithOwner(r: InferenceRequest, now: int, holder: InferenceRequest, origin: TimeoutOrigin): InferenceRequest = {
  ...r, phase: InferenceTimedOut, timer: false, listener: false, timeout: origin,
  waitedMs: now - r.enqueuedAt, holderAtTimeout: holder.id, holderLabel: holder.label
}
pure def changeAtHandoff(r: InferenceRequest, oldOwner: InferenceRequest, selection: Handoff, now: int, ok: bool): InferenceRequest =
  if (r.id == oldOwner.id) { ...r, phase: if (ok) InferenceSucceeded else InferenceFailed }
  else if (r.id == selection.granted) { ...r, phase: AcquiredInference, acquiredAt: now, timer: false, listener: false }
  else if (selection.expired.includes(r.id)) expireWithOwner(r, now, oldOwner, HandoffTimeout)
  else r
pure def canFinishInference(s: InferenceGate, ok: bool): bool = s.holder > 0 and inferenceRequest(s, s.holder).phase == RunningInference
pure def finishInference(s: InferenceGate, ok: bool): InferenceGate = {
  val selection = handoff(s)
  val oldOwner = inferenceRequest(s, s.holder)
  { ...s, holder: selection.granted, requests: s.requests.listMap(r => changeAtHandoff(r, oldOwner, selection, s.now, ok)) }
}
pure def observeClock(s: InferenceGate, observedTime: int): InferenceGate = { ...s, now: observedTime }
pure def alwaysTimedOutOnlyBackground(s: InferenceGate): bool = s.requests.every(r => (r.phase == InferenceTimedOut iff r.timeout != NoTimeout) and (r.phase == InferenceTimedOut implies r.priority == Background))
pure def sometimesExpiredBeforeNative(s: InferenceGate): bool = s.requests.some(r => r.timeout == HandoffTimeout)
pure def sometimesInteractivePrecedesQueuedBackground(s: InferenceGate): bool = s.requests.some(r => isLaneHolder(r) and r.priority == Interactive) and s.requests.some(r => r.phase == QueuedInference and r.priority == Background)
pure def sometimesHandoffLeavesExpiredTail(s: InferenceGate): bool = s.requests.some(r => r.id == s.holder and r.priority == Background and r.phase == AcquiredInference) and s.requests.some(r => r.timeout == HandoffTimeout) and s.requests.some(r => r.phase == QueuedInference and expired(r, s.now))
```

### Queued timeout and signal callbacks release only their own attachment

Delivery of the captured native timer is an environment event. Its callback may reject the still-waiting request even if the wall clock moved backward, since it does not recheck the wall-clock deadline. Handoff diagnostics and timer diagnostics retain their separate holder identities. An already acquired native invocation retains the lane after signal cancellation.

```quint
pure def canFireWaitTimer(s: InferenceGate, requestId: int): bool = s.requests.some(r => r.id == requestId and r.phase == QueuedInference and r.timer)
pure def fireWaitTimer(s: InferenceGate, requestId: int): InferenceGate = { ...s, requests: s.requests.listMap(r => if (r.id == requestId) expireWithOwner(r, s.now, inferenceRequest(s, s.holder), WaitTimerTimeout) else r) }
pure def canAbortInferenceSignal(s: InferenceGate, requestId: int): bool = s.requests.some(r => r.id == requestId and r.hasSignal and not(r.signalAborted))
pure def abortInferenceSignal(s: InferenceGate, requestId: int): InferenceGate = { ...s, requests: s.requests.listMap(r => if (r.id == requestId and r.listener) { ...r, signalAborted: true, phase: InferenceAborted, timer: false, listener: false } else if (r.id == requestId) { ...r, signalAborted: true } else r) }
pure def hasTokenLimit(value: TokenLimit): bool = match value { | NoTokenLimit => false | TokenLimitValue(limit) => true }
pure def tokenLimitNumber(value: TokenLimit): int = match value { | NoTokenLimit => 0 | TokenLimitValue(limit) => limit.limit }
pure def sameTokenLimit(first: TokenLimit, second: TokenLimit): bool = hasTokenLimit(first) == hasTokenLimit(second) and tokenLimitNumber(first) == tokenLimitNumber(second)
pure def stepRequestBytesPreserved(before: InferenceGate, after: InferenceGate): bool = before.requests.every(r => after.requests.some(other => other.id == r.id and other.prompt == r.prompt and sameTokenLimit(other.maxTokens, r.maxTokens) and other.label == r.label))
pure def stepRunningInferenceNotPreempted(before: InferenceGate, via: str, after: InferenceGate): bool = before.holder != 0 and via != "finishInference" implies after.holder == before.holder
pure def sometimesAbortDoesNotPreempt(s: InferenceGate): bool = s.requests.some(r => r.phase == RunningInference and r.signalAborted)
pure def sometimesTimerSurvivesClockRewind(s: InferenceGate): bool = s.requests.some(r => r.timeout == WaitTimerTimeout and r.waitedMs < 0)
pure val fair_invokeInference = "weak"
pure val fair_finishInference = "weak"
pure val fair_fireWaitTimer = "strong"
pure def leadsToRunningInferenceSettled(s: InferenceGate, later: InferenceGate): bool = s.requests.every(r => isLaneHolder(r) implies later.requests.some(other => other.id == r.id and (other.phase == InferenceSucceeded or other.phase == InferenceFailed)))
pure def leadsToCapturedTimersReleased(s: InferenceGate, later: InferenceGate): bool = s.requests.every(r => r.timer implies not(inferenceRequest(later, r.id).timer))
```
