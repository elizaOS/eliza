# Serialized asynchronous work

This model migrates `quint/Serialise.qnt` and the `createSerialise` contract in `utils/task-scheduling.ts`. Invocation appends synchronously to the promise chain. Callback settlement releases the successor for both success and failure.

## Story: Execute queued asynchronous callbacks in invocation order

As a service, I want per-owner work to execute one callback at a time and recover after a callback rejects.

### Only the head callback executes and every settlement releases its successor

Invocation order, callback start and callback settlement are distinct events. Each position names the actual callback and each settled prefix position retains its outcome. A rejected callback retains its caller's failure while releasing the queue. A nonsettling external callback can hold the queue indefinitely. Progress therefore depends on callback settlement and fair scheduling.

```quint
type SerialQueue = { calls: List[str], outcomes: List[bool], invoked: int, started: int, completed: int, failures: int }
pure val initial: SerialQueue = { calls: List(), outcomes: List(), invoked: 0, started: 0, completed: 0, failures: 0 }
pure def canInvoke(q: SerialQueue, callId: str): bool = callId != "" and not(q.calls.includes(callId))
pure def invoke(q: SerialQueue, callId: str): SerialQueue = { ...q, calls: q.calls.append(callId), invoked: q.invoked + 1 }
pure def canStart(q: SerialQueue): bool = q.started == q.completed and q.started < q.invoked
pure def start(q: SerialQueue): SerialQueue = { ...q, started: q.started + 1 }
pure def canCompleteCallback(q: SerialQueue): bool = q.started == q.completed + 1
pure def completeCallback(q: SerialQueue, success: bool): SerialQueue = { ...q, outcomes: q.outcomes.append(success), completed: q.completed + 1, failures: q.failures + (if (success) 0 else 1) }
pure def runningCall(q: SerialQueue): str = if (q.started == q.completed + 1) q.calls.nthOr(q.completed, "") else ""
pure def alwaysQueueAccountsForInvocations(q: SerialQueue): bool = q.invoked == q.calls.length() and q.completed == q.outcomes.length() and q.invoked >= q.started and q.started >= q.completed and q.completed >= 0 and q.failures >= 0 and q.failures <= q.completed
pure def alwaysOneCallbackRuns(q: SerialQueue): bool = q.started - q.completed <= 1
pure def alwaysCallIdentitiesUnique(q: SerialQueue): bool = q.calls.every(callId => callId != "" and q.calls.select(other => other == callId).length() == 1)
pure def alwaysUnfinishedHasProgress(q: SerialQueue): bool = q.completed < q.invoked implies canStart(q) or canCompleteCallback(q)
pure def sometimesRejectedCallbackSettles(q: SerialQueue): bool = q.failures > 0 and q.started == q.completed
pure def sometimesQueuedCallbackRuns(q: SerialQueue): bool = q.started > q.completed
pure val callIdValues = Set("call1", "call2", "call3", "call4")
```

### Each admitted callback completes under fair starts and callback settlement

A callback may return or throw. Both outcomes count as completion. The assumption that running callbacks settle is explicit, since the queue cannot force external work to return. New invocations join behind the already admitted callbacks.

```quint
pure val fair_start = "weak"
pure val fair_completeCallback = "weak"
pure def leadsToAdmittedCallbacksComplete(q: SerialQueue, later: SerialQueue): bool = later.outcomes.length() >= q.calls.length()
```
