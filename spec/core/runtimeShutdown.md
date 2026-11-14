# Shared shutdown attempts and quiescence

This model retains caller and attempt identities across reentrant stop, bounded failure, retry, late child work and strict retirement. Sources include [runtime.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime.ts), [retirement.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/retirement.ts) and [RuntimeLifecycle.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/RuntimeLifecycle.qnt).

## Story: Join one active shutdown attempt

As a caller I observe the exact stop operation I joined, including its failure, while another caller may retry a failed bounded attempt.

### Stop ownership is published before service preparation

The first stop closes ingress and marks admitted turns aborted. Reentrant and concurrent callers bind to the same attempt identity.

Discovered by the proof: published stop ownership closes ingress, caller IDs
remain unique, and a strict drain follows a stopped base operation. A strict
wait retains the real attempt it joined. These relations exclude states that
cannot be produced by registration or the preceding shutdown transition.

```quint
type RetirementKind = RoomWork | DeliveryWork | ServiceStartWork | ServiceStopWork | PluginWork | BeforeCloseWork
type RetirementWork = { id: int, kind: RetirementKind, aborted: bool }
type StopAttemptPhase = DrainingRooms | WaitingStarts | StoppingServices | StopSucceeded | StopFailed
type StopAttempt = { id: int, phase: StopAttemptPhase, fast: bool }
type StopCallResult = WaitingCall | SuccessfulCall | FailedCall
type StopCaller = { id: int, attempt: int, strict: bool, resultKind: StopCallResult }
type StrictPhase = NoStrictStop | StrictAwaitingAttempt | StrictDraining | StrictSucceeded | StrictFailed
type Shutdown = { admissionClosed: bool, runtimeStopped: bool, prepareCalls: int, pending: List[RetirementWork], usedWorkIds: List[int], attempts: List[StopAttempt], nextAttempt: int, activeAttempt: int, callers: List[StopCaller], retirementFailed: bool, strictPhase: StrictPhase, strictAttempt: int }
pure val initial: Shutdown = { admissionClosed: false, runtimeStopped: false, prepareCalls: 0, pending: List(), usedWorkIds: List(), attempts: List(), nextAttempt: 1, activeAttempt: 0, callers: List(), retirementFailed: false, strictPhase: NoStrictStop, strictAttempt: 0 }
pure val callerValues = Set(1, 2, 3)
pure val workIdValues = Set(1, 2, 3, 4)
pure val parentIdValues = Set(1, 2, 3)
pure val attemptIdValues = Set(1, 2, 3)
pure val missingAttempt: StopAttempt = {id: 0, phase: StopSucceeded, fast: false}
pure def stopAttempt(s: Shutdown, attemptId: int): StopAttempt = s.attempts.select(a => a.id == attemptId).nthOr(0, missingAttempt)
pure def canAdmitOwnedWork(s: Shutdown, workId: int, kind: RetirementKind): bool = not(s.admissionClosed) and workId > 0 and not(s.usedWorkIds.includes(workId))
pure def admitOwnedWork(s: Shutdown, workId: int, kind: RetirementKind): Shutdown = { ...s, pending: s.pending.append({id: workId, kind: kind, aborted: false}), usedWorkIds: s.usedWorkIds.append(workId) }
pure def beginStopOperation(fast: bool, s: Shutdown): Shutdown = {
  if (s.activeAttempt != 0 or s.runtimeStopped) s
  else { ...s, admissionClosed: true, prepareCalls: 1, activeAttempt: s.nextAttempt, nextAttempt: s.nextAttempt + 1,
    attempts: s.attempts.append({id: s.nextAttempt, phase: DrainingRooms, fast: fast}), pending: s.pending.listMap(w => if (w.kind == RoomWork) { ...w, aborted: true } else w) }
}
pure def canCallStop(s: Shutdown, caller: int, fast: bool): bool = caller > 0 and not(s.callers.some(c => c.id == caller))
pure def callStop(s: Shutdown, caller: int, fast: bool): Shutdown = {
  val started = beginStopOperation(fast, s)
  { ...started, callers: started.callers.append({id: caller, attempt: started.activeAttempt, strict: false, resultKind: if (started.activeAttempt == 0) SuccessfulCall else WaitingCall}) }
}
pure def attemptInFlight(a: StopAttempt): bool = a.phase != StopSucceeded and a.phase != StopFailed
pure def alwaysOneActiveAttempt(s: Shutdown): bool = s.attempts.every(a => attemptInFlight(a) iff a.id == s.activeAttempt) and (s.activeAttempt == 0 or s.attempts.some(a => a.id == s.activeAttempt))
pure def alwaysPreparationOnce(s: Shutdown): bool = s.prepareCalls >= 0 and s.prepareCalls <= 1 and (s.admissionClosed iff s.prepareCalls == 1)
pure def alwaysClosedIngressAbortsTurns(s: Shutdown): bool = s.admissionClosed implies s.pending.every(w => w.kind == RoomWork implies w.aborted)
pure def alwaysAttemptIdentityUnique(s: Shutdown): bool = s.nextAttempt > 0 and s.attempts.every(a => a.id > 0 and a.id < s.nextAttempt and s.attempts.select(other => other.id == a.id).length() == 1)
pure def alwaysPublishedStopOwnership(s: Shutdown): bool = (s.attempts.some(a => a.phase == StoppingServices or a.phase == StopSucceeded) implies s.runtimeStopped) and ((s.runtimeStopped or s.activeAttempt != 0 or s.strictPhase != NoStrictStop) implies s.admissionClosed) and s.callers.every(c => c.id > 0 and s.callers.select(other => other.id == c.id).length() == 1 and (c.strict implies s.strictPhase != NoStrictStop))
pure def alwaysStrictBaseOwnership(s: Shutdown): bool = ((s.strictPhase == StrictDraining or s.strictPhase == StrictSucceeded) implies s.runtimeStopped) and (s.strictPhase == StrictAwaitingAttempt implies (s.strictAttempt > 0 and s.attempts.some(a => a.id == s.strictAttempt)))
pure def sometimesConcurrentStopJoins(s: Shutdown): bool = s.callers.some(a => s.callers.some(b => a.id != b.id and a.attempt != 0 and a.attempt == b.attempt))
```

### A bounded room-drain failure remains the result of its attempt

Retry creates a fresh attempt without preparing services or reopening ingress a second time.

```quint
pure def canFinishRoomDrain(s: Shutdown, attemptId: int): bool = s.activeAttempt == attemptId and stopAttempt(s, attemptId).phase == DrainingRooms and not(s.pending.some(w => w.kind == RoomWork))
pure def finishRoomDrain(s: Shutdown, attemptId: int): Shutdown = { ...s, attempts: s.attempts.listMap(a => if (a.id == attemptId) { ...a, phase: WaitingStarts } else a) }
pure def canTimeoutRoomDrain(s: Shutdown, attemptId: int): bool = s.activeAttempt == attemptId and stopAttempt(s, attemptId).phase == DrainingRooms and stopAttempt(s, attemptId).fast and s.pending.some(w => w.kind == RoomWork)
pure def timeoutRoomDrain(s: Shutdown, attemptId: int): Shutdown = { ...s, activeAttempt: 0, retirementFailed: true, attempts: s.attempts.listMap(a => if (a.id == attemptId) { ...a, phase: StopFailed } else a) }
pure def canBeginServiceStop(s: Shutdown, attemptId: int, startWaitTimedOut: bool): bool = s.activeAttempt == attemptId and stopAttempt(s, attemptId).phase == WaitingStarts and (stopAttempt(s, attemptId).fast or startWaitTimedOut or not(s.pending.some(w => w.kind == ServiceStartWork)))
pure def beginServiceStop(s: Shutdown, attemptId: int, startWaitTimedOut: bool): Shutdown = { ...s, runtimeStopped: true, attempts: s.attempts.listMap(a => if (a.id == attemptId) { ...a, phase: StoppingServices } else a) }
pure def canFinishStopAttempt(s: Shutdown, attemptId: int, serviceWaitTimedOut: bool): bool = s.activeAttempt == attemptId and stopAttempt(s, attemptId).phase == StoppingServices and (not(s.pending.some(w => w.kind == ServiceStopWork)) or (stopAttempt(s, attemptId).fast and serviceWaitTimedOut))
pure def finishStopAttempt(s: Shutdown, attemptId: int, serviceWaitTimedOut: bool): Shutdown = { ...s, activeAttempt: 0, attempts: s.attempts.listMap(a => if (a.id == attemptId) { ...a, phase: StopSucceeded } else a) }
pure def canObserveStopAttempt(s: Shutdown, caller: int): bool = s.callers.some(c => c.id == caller and not(c.strict) and c.resultKind == WaitingCall and (stopAttempt(s, c.attempt).phase == StopSucceeded or stopAttempt(s, c.attempt).phase == StopFailed))
pure def observeStopAttempt(s: Shutdown, caller: int): Shutdown = { ...s, callers: s.callers.listMap(c => if (c.id == caller) { ...c, resultKind: if (stopAttempt(s, c.attempt).phase == StopSucceeded) SuccessfulCall else FailedCall } else c) }
pure def alwaysAttemptFailureHonest(s: Shutdown): bool = s.callers.every(c => not(c.strict) and c.resultKind == FailedCall implies stopAttempt(s, c.attempt).phase == StopFailed)
pure def sometimesFailedAttemptRetried(s: Shutdown): bool = s.attempts.some(a => a.phase == StopFailed and s.attempts.some(b => b.id > a.id))
```

## Story: Establish strict quiescence after bounded shutdown

As a host I wait for every original and spawned operation and retain teardown failures across repeated strict calls.

### Owned child work remains tracked after ingress closes

Only already-owned work may spawn a retirement child after shutdown admission closes. Completed work IDs are never reused.

```quint
pure def canSpawnRetirementChild(s: Shutdown, parentId: int, workId: int, kind: RetirementKind): bool = s.pending.some(w => w.id == parentId) and workId > 0 and not(s.usedWorkIds.includes(workId)) and kind != RoomWork
pure def spawnRetirementChild(s: Shutdown, parentId: int, workId: int, kind: RetirementKind): Shutdown = { ...s, pending: s.pending.append({id: workId, kind: kind, aborted: false}), usedWorkIds: s.usedWorkIds.append(workId) }
pure def canCompleteOwnedWork(s: Shutdown, workId: int, teardownFailed: bool): bool = s.pending.some(w => w.id == workId)
pure def completeOwnedWork(s: Shutdown, workId: int, teardownFailed: bool): Shutdown = { ...s, pending: s.pending.select(w => w.id != workId), retirementFailed: s.retirementFailed or teardownFailed }
pure def alwaysPendingWorkIdentitiesUnique(s: Shutdown): bool = s.pending.every(w => w.id > 0 and s.usedWorkIds.includes(w.id) and s.pending.select(other => other.id == w.id).length() == 1)
pure def stepRetirementFailurePersists(before: Shutdown, after: Shutdown): bool = before.retirementFailed implies after.retirementFailed
```

### All strict callers share the original strict result

Strict success requires no pending work and no retained retirement failure. Repeated strict calls observe the same result.

```quint
pure def canCallStrictStop(s: Shutdown, caller: int, fast: bool): bool = caller > 0 and not(s.callers.some(c => c.id == caller))
pure def callStrictStop(s: Shutdown, caller: int, fast: bool): Shutdown = {
  val started = if (s.strictPhase == NoStrictStop) beginStopOperation(fast, s) else s
  val phase = if (started.strictPhase == NoStrictStop) (if (started.activeAttempt == 0) StrictDraining else StrictAwaitingAttempt) else started.strictPhase
  val strictAttempt = if (started.strictPhase == NoStrictStop) started.activeAttempt else started.strictAttempt
  { ...started, strictPhase: phase, strictAttempt: strictAttempt, callers: started.callers.append({id: caller, attempt: strictAttempt, strict: true, resultKind: if (phase == StrictSucceeded) SuccessfulCall else if (phase == StrictFailed) FailedCall else WaitingCall}) }
}
pure def canObserveStrictBase(s: Shutdown): bool = s.strictPhase == StrictAwaitingAttempt and (stopAttempt(s, s.strictAttempt).phase == StopSucceeded or stopAttempt(s, s.strictAttempt).phase == StopFailed)
pure def observeStrictBase(s: Shutdown): Shutdown = { ...s, strictPhase: if (stopAttempt(s, s.strictAttempt).phase == StopFailed) StrictFailed else StrictDraining }
pure def canFinishStrictDrain(s: Shutdown): bool = s.strictPhase == StrictDraining and s.pending.length() == 0
pure def finishStrictDrain(s: Shutdown): Shutdown = { ...s, strictPhase: if (s.retirementFailed) StrictFailed else StrictSucceeded }
pure def canObserveStrictResult(s: Shutdown, caller: int): bool = s.callers.some(c => c.id == caller and c.strict and c.resultKind == WaitingCall) and (s.strictPhase == StrictSucceeded or s.strictPhase == StrictFailed)
pure def observeStrictResult(s: Shutdown, caller: int): Shutdown = { ...s, callers: s.callers.listMap(c => if (c.id == caller) { ...c, resultKind: if (s.strictPhase == StrictSucceeded) SuccessfulCall else FailedCall } else c) }
pure def alwaysStrictSuccessQuiescent(s: Shutdown): bool = s.strictPhase == StrictSucceeded implies s.pending.length() == 0 and not(s.retirementFailed) and s.runtimeStopped
pure def alwaysWaitingCallerHasOwner(s: Shutdown): bool = s.callers.every(c => c.resultKind == WaitingCall and not(c.strict) implies c.attempt > 0 and s.attempts.some(a => a.id == c.attempt))
pure def alwaysStrictCallerAgreement(s: Shutdown): bool = s.callers.every(c => c.strict and c.resultKind == SuccessfulCall implies s.strictPhase == StrictSucceeded) and s.callers.every(c => c.strict and c.resultKind == FailedCall implies s.strictPhase == StrictFailed)
pure def sometimesStrictFailurePersists(s: Shutdown): bool = s.strictPhase == StrictFailed and s.callers.select(c => c.strict and c.resultKind == FailedCall).length() > 1
pure def sometimesStrictSuccess(s: Shutdown): bool = s.strictPhase == StrictSucceeded
```

### Every stop caller returns when owned work and observers progress fairly

The environment eventually finishes every owned operation and stops spawning descendants. Service start/stop deadlines are observed by their owning host.

```quint
pure val fair_completeOwnedWork = "strong"
pure def canFinishActiveRoomDrain(s: Shutdown): bool = canFinishRoomDrain(s, s.activeAttempt)
pure def finishActiveRoomDrain(s: Shutdown): Shutdown = finishRoomDrain(s, s.activeAttempt)
pure def canBeginActiveServiceStop(s: Shutdown, startWaitTimedOut: bool): bool = canBeginServiceStop(s, s.activeAttempt, startWaitTimedOut)
pure def beginActiveServiceStop(s: Shutdown, startWaitTimedOut: bool): Shutdown = beginServiceStop(s, s.activeAttempt, startWaitTimedOut)
pure def canFinishActiveStop(s: Shutdown, serviceWaitTimedOut: bool): bool = canFinishStopAttempt(s, s.activeAttempt, serviceWaitTimedOut)
pure def finishActiveStop(s: Shutdown, serviceWaitTimedOut: bool): Shutdown = finishStopAttempt(s, s.activeAttempt, serviceWaitTimedOut)
pure val fair_finishActiveRoomDrain = "weak"
pure val fair_beginActiveServiceStop = "weak"
pure val fair_finishActiveStop = "weak"
pure val fair_observeStopAttempt = "strong"
pure val fair_observeStrictBase = "weak"
pure val fair_finishStrictDrain = "weak"
pure val fair_observeStrictResult = "strong"
pure def leadsToStopCallersReturn(s: Shutdown, later: Shutdown): bool = s.callers.every(c => c.resultKind == WaitingCall implies later.callers.some(done => done.id == c.id and done.resultKind != WaitingCall))
```

### Every pending shutdown attempt has an enabled owner step

No active attempt, no waiting caller and no pending strict drain is quiescent. A pending owner has an original work completion, attempt transition, deadline observation or result delivery enabled.

```quint
pure def shutdownQuiescent(s: Shutdown): bool = s.activeAttempt == 0 and s.callers.every(c => c.resultKind != WaitingCall) and s.strictPhase != StrictAwaitingAttempt and s.strictPhase != StrictDraining
pure def shutdownProgressEnabled(s: Shutdown): bool = s.pending.some(w => canCompleteOwnedWork(s, w.id, false)) or (s.activeAttempt != 0 and (canFinishRoomDrain(s, s.activeAttempt) or canTimeoutRoomDrain(s, s.activeAttempt) or canBeginServiceStop(s, s.activeAttempt, true) or canFinishStopAttempt(s, s.activeAttempt, true))) or s.callers.some(c => canObserveStopAttempt(s, c.id) or canObserveStrictResult(s, c.id)) or canObserveStrictBase(s) or canFinishStrictDrain(s)
pure def alwaysShutdownDeadlockFree(s: Shutdown): bool = shutdownQuiescent(s) or shutdownProgressEnabled(s)
```
