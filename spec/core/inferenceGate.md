# Local inference priority admission

One process-wide gate serializes local inference. Interactive requests precede queued background requests without preempting an active holder. Source [inference-priority-gate.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/utils/inference-priority-gate.ts).

## Story: Prioritize interactive inference without changing requests

As a caller I acquire the local inference lane in FIFO priority order and preserve every prompt byte and generation setting.

### At most one request owns the inference lane

Queue-wait deadlines apply only to waiting background requests. Immediate idle admission can start even when the requested wait budget is zero.

```quint
type InferencePriority = Interactive | Background
type InferencePhase = QueuedInference | RunningInference | InferenceSucceeded | InferenceFailed | InferenceTimedOut | InferenceAborted
type InferenceRequest = { id: int, priority: InferencePriority, phase: InferencePhase, prompt: str, maxTokens: int, enqueuedAt: int, expiresAt: int, hasDeadline: bool, signalAborted: bool }
type InferenceGate = { now: int, holder: int, requests: List[InferenceRequest] }
pure val initial: InferenceGate = { now: 0, holder: 0, requests: List() }
pure val requestIdValues = Set(1, 2, 3)
pure val waitMsValues = Set(0, 1, 5)
pure val elapsedValues = Set(0, 1, 5)
pure val promptValues = Set("complete prompt a", "complete prompt b")
pure val maxTokensValues = Set(-1, 100, 4096)
pure def canRequestInference(s: InferenceGate, requestId: int, priority: InferencePriority, prompt: str, maxTokens: int, waitMs: int, hasDeadline: bool, signalAborted: bool): bool = requestId > 0 and not(s.requests.some(r => r.id == requestId))
pure def requestInference(s: InferenceGate, requestId: int, priority: InferencePriority, prompt: str, maxTokens: int, waitMs: int, hasDeadline: bool, signalAborted: bool): InferenceGate = {
  val immediately = not(signalAborted) and s.holder == 0 and (priority == Interactive or not(s.requests.some(r => r.phase == QueuedInference and r.priority == Interactive)))
  val boundedWait = if (waitMs < 0) 0 else waitMs
  { ...s, holder: if (immediately) requestId else s.holder, requests: s.requests.append({id: requestId, priority: priority, phase: if (signalAborted) InferenceAborted else if (immediately) RunningInference else QueuedInference, prompt: prompt, maxTokens: maxTokens, enqueuedAt: s.now, expiresAt: s.now + boundedWait, hasDeadline: priority == Background and hasDeadline, signalAborted: signalAborted}) }
}
pure def alwaysOneInferenceHolder(s: InferenceGate): bool = s.requests.select(r => r.phase == RunningInference).length() == (if (s.holder == 0) 0 else 1) and s.requests.every(r => r.phase == RunningInference implies r.id == s.holder)
pure def alwaysInferenceIdsUnique(s: InferenceGate): bool = s.requests.every(r => r.id > 0 and s.requests.select(other => other.id == r.id).length() == 1)
pure def alwaysInteractiveHasNoQueueDeadline(s: InferenceGate): bool = s.requests.every(r => r.priority == Interactive implies not(r.hasDeadline))
pure def sometimesInteractiveWaitsForBackground(s: InferenceGate): bool = s.requests.some(r => r.phase == RunningInference and r.priority == Background) and s.requests.some(r => r.phase == QueuedInference and r.priority == Interactive)
```

### Release chooses the first unexpired interactive waiter before background

A completed holder releases the lane even when its inference failed. Expired background work is rejected before native invocation.

```quint
pure def expired(r: InferenceRequest, now: int): bool = r.hasDeadline and now >= r.expiresAt
pure val absentRequest: InferenceRequest = {id: 0, priority: Background, phase: InferenceFailed, prompt: "", maxTokens: -1, enqueuedAt: 0, expiresAt: 0, hasDeadline: false, signalAborted: false}
pure def nextInference(s: InferenceGate): InferenceRequest = {
  val interactive = s.requests.select(r => r.phase == QueuedInference and r.priority == Interactive)
  val background = s.requests.select(r => r.phase == QueuedInference and r.priority == Background and not(expired(r, s.now)))
  interactive.concat(background).nthOr(0, absentRequest)
}
pure def canFinishInference(s: InferenceGate, ok: bool): bool = s.holder != 0
pure def finishInference(s: InferenceGate, ok: bool): InferenceGate = {
  val selected = nextInference(s)
  { ...s, holder: selected.id, requests: s.requests.listMap(r =>
    if (r.id == s.holder) { ...r, phase: if (ok) InferenceSucceeded else InferenceFailed }
    else if (r.id == selected.id) { ...r, phase: RunningInference }
    else if (r.phase == QueuedInference and expired(r, s.now)) { ...r, phase: InferenceTimedOut }
    else r) }
}
pure def canAdvanceInferenceClock(s: InferenceGate, elapsed: int): bool = elapsed >= 0
pure def advanceInferenceClock(s: InferenceGate, elapsed: int): InferenceGate = { ...s, now: s.now + elapsed }
pure def canExpireInference(s: InferenceGate, requestId: int): bool = s.requests.some(r => r.id == requestId and r.phase == QueuedInference and expired(r, s.now))
pure def expireInference(s: InferenceGate, requestId: int): InferenceGate = { ...s, requests: s.requests.listMap(r => if (r.id == requestId) { ...r, phase: InferenceTimedOut } else r) }
pure def alwaysTimedOutOnlyBackground(s: InferenceGate): bool = s.requests.every(r => r.phase == InferenceTimedOut implies r.priority == Background and r.hasDeadline)
pure def sometimesExpiredBeforeNative(s: InferenceGate): bool = s.requests.some(r => r.phase == InferenceTimedOut)
pure def sometimesInteractivePrecedesQueuedBackground(s: InferenceGate): bool = s.requests.some(r => r.phase == RunningInference and r.priority == Interactive) and s.requests.some(r => r.phase == QueuedInference and r.priority == Background)
```

### Cancelling a waiter preserves the active holder and request bytes

Gate cancellation removes waiting work. An already acquired native invocation retains lane ownership until its own completion.

```quint
pure def canAbortInferenceSignal(s: InferenceGate, requestId: int): bool = s.requests.some(r => r.id == requestId and not(r.signalAborted))
pure def abortInferenceSignal(s: InferenceGate, requestId: int): InferenceGate = { ...s, requests: s.requests.listMap(r => if (r.id == requestId) { ...r, signalAborted: true, phase: if (r.phase == QueuedInference) InferenceAborted else r.phase } else r) }
pure def stepRequestBytesPreserved(before: InferenceGate, after: InferenceGate): bool = before.requests.every(r => after.requests.some(other => other.id == r.id and other.prompt == r.prompt and other.maxTokens == r.maxTokens))
pure def stepRunningInferenceNotPreempted(before: InferenceGate, via: str, after: InferenceGate): bool = before.holder != 0 and via != "finishInference" implies after.holder == before.holder
pure def sometimesAbortDoesNotPreempt(s: InferenceGate): bool = s.requests.some(r => r.phase == RunningInference and r.signalAborted)
pure val fair_finishInference = "weak"
pure val fair_expireInference = "strong"
pure def leadsToRunningInferenceSettled(s: InferenceGate, later: InferenceGate): bool = s.requests.every(r => r.phase == RunningInference implies later.requests.some(other => other.id == r.id and (other.phase == InferenceSucceeded or other.phase == InferenceFailed)))
```
