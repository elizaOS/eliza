# Service stop boundary observations

[RuntimeServiceLifecycle._stopServiceInstance](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/service-lifecycle.ts#L115-L157)
wraps a runtime shutdown or late-start stop attempt. [Service instance
ownership](./serviceInstances.md) supplies the shared object stop operation.
The [retirement tracker](./retirementTracker.md) owns retained failures.
References below denote the original host identities.

## Story: Continue best-effort shutdown with its failures retained

As a runtime owner, I want each stop wrapper to finish after recording why
an invalid instance could not stop or after the shared stop promise settles.
Strict retirement needs the recorded failures to decide its own outcome.

### An invalid stop target records a failure without publishing work

An absent object and an object without a callable stop method are distinct
validation failures. The wrapper records one failure and one warning per
invalid call, then fulfills. The host assigns the error and caller identities.
The stop label identifies the service type even if more than one type
references the same object.

```quint
type Target = NullStopTarget | MissingStopMethod | CallableStopTarget
type StopFailure = NullInstance | MissingMethod | StopRejected
type StopObservationPhase = NoStopRequest | NeedStopJoin | WaitingForStop | WarningDue | StopWrapperReturned
type StopFailureNote = { cause: StopFailure, errorRef: str }
type StopObservation = { phase: StopObservationPhase, serviceType: str, objectId: int, reason: str, workRef: int, recorded: List[StopFailureNote], warningPending: List[StopFailureNote], warnings: List[StopFailureNote] }
pure val initial: StopObservation = { phase: NoStopRequest, serviceType: "", objectId: 0, reason: "", workRef: 0, recorded: List(), warningPending: List(), warnings: List() }
pure val objectIdValues = Set(0, 1)
pure val workRefValues = Set(1, 2)
pure val serviceTypeValues = Set("storage", "messages")
pure val reasonValues = Set("shutdown", "late-start")
pure val errorRefValues = Set("validation-failure", "stop-error")
pure def canObserveStopTarget(s: StopObservation, target: Target, objectId: int, errorRef: str): bool =
  s.phase == NoStopRequest and (if (target == NullStopTarget) objectId == 0 else objectId > 0) and (target == CallableStopTarget or errorRef != "")
pure def observeStopTarget(s: StopObservation, target: Target, serviceType: str, objectId: int, reason: str, errorRef: str): StopObservation = {
  val callable = target == CallableStopTarget
  val note = if (callable) List() else List({ cause: if (target == NullStopTarget) NullInstance else MissingMethod, errorRef: errorRef })
  { ...initial, serviceType: serviceType, objectId: objectId, reason: reason, phase: if (callable) NeedStopJoin else WarningDue,
    recorded: note, warningPending: note }
}
pure def alwaysInvalidStopHasNoWork(s: StopObservation): bool = s.recorded.length() > 0 implies s.workRef == 0
pure def sometimesMissingMethodRecorded(s: StopObservation): bool = s.recorded.some(note => note.cause == MissingMethod) and s.phase == StopWrapperReturned
```

### A callable stop joins the shared promise and reports its original rejection

The wrapper receives a reference to the instance owner's stop promise. A
rejected shared promise already has its error retained by that owner. Each
joining wrapper observes the rejection and issues its own warning, then
fulfills. A successful stop fulfills the wrapper directly. The host routes
each warning and retirement record before returning the wrapper result.

```quint
pure def canJoinStopWork(s: StopObservation, workRef: int): bool = s.phase == NeedStopJoin and workRef > 0
pure def joinStopWork(s: StopObservation, workRef: int): StopObservation = { ...s, workRef: workRef, phase: WaitingForStop }
pure def canObserveStopSettlement(s: StopObservation, workRef: int): bool = s.phase == WaitingForStop and s.workRef == workRef
pure def observeStopSettlement(s: StopObservation, workRef: int, succeeded: bool, errorRef: str): StopObservation =
  { ...s, phase: if (succeeded) StopWrapperReturned else WarningDue,
    warningPending: if (succeeded) List() else List({ cause: StopRejected, errorRef: errorRef }), warnings: List() }
pure def canFinishStopWarning(s: StopObservation): bool = s.phase == WarningDue
pure def finishStopWarning(s: StopObservation): StopObservation =
  { ...s, phase: StopWrapperReturned, warnings: s.warningPending, warningPending: List() }
pure def alwaysBoundStopHasTargetAndNoLocalFailure(s: StopObservation): bool =
  s.workRef != 0 implies s.workRef > 0 and s.objectId > 0 and s.recorded.length() == 0
pure def alwaysWaitingStopHasWork(s: StopObservation): bool = s.phase == WaitingForStop implies s.workRef > 0
pure def alwaysJoinIsFreshAndCallable(s: StopObservation): bool =
  s.phase == NeedStopJoin implies s.objectId > 0 and s.workRef == 0 and s.recorded.length() == 0
pure def alwaysWaitingWarningsHaveOrigin(s: StopObservation): bool =
  s.phase == WarningDue implies (if (s.workRef == 0) s.warningPending == s.recorded else s.warningPending.every(note => note.cause == StopRejected))
pure def alwaysReturnedWarningsHaveOrigin(s: StopObservation): bool =
  s.phase == StopWrapperReturned implies (if (s.workRef == 0) s.recorded == s.warnings else s.warnings.every(note => note.cause == StopRejected))
pure def stepReturnedStopStaysFixed(before: StopObservation, after: StopObservation): bool =
  before.phase == StopWrapperReturned implies after == before
pure def sometimesRejectedStopReturns(s: StopObservation): bool =
  s.phase == StopWrapperReturned and s.workRef > 0 and s.warnings.some(note => note.cause == StopRejected)
```
