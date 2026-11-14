# Service acquisition results and rejection causes

[Service instances](./serviceInstances.md) owns class attempts, type aggregate
identities and the live service array. This model follows one acquisition's
public result and the retained startup error from
[service-lifecycle.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/service-lifecycle.ts#L225-L280).
The shell supplies the slot-ordered results of that exact aggregate and the
service array's first instance when the acquiring caller resumes.
The caller enters this model once it has captured an aggregate. Earlier
absence and the initialization fast path belong to service admission.

## Story: Explain a service acquisition failure with every original cause

As a service consumer, I want the first currently published instance on a
successful acquisition. If no instance is published, I want the startup
error to retain every implementation rejection in declaration order.

### Captured results and the live publication supply distinct observations

The aggregate's first result is the first fulfilled slot in the captured
list. A caller can resume after the live publication has changed. Its
success uses the current first instance. A missing first instance produces
a typed startup failure, even when a captured slot fulfilled. Error context
uses the observed length of the declaration array held by that call. A
registration may append a declaration to that array after the promise
slots were captured.

```quint
type StartSlot = StartedService({ instance: int }) | RejectedStart({ reason: str })
type AcquirePhase = WaitingForStarts | StartsObserved | AcquisitionReturned
type FailureEvidence = { errorRef: str, causes: List[str], declaredCount: int }
type AcquisitionResult = AcquisitionPending | AcquisitionSucceeded({ instance: int }) | AcquisitionFailed(FailureEvidence)
type ServiceAcquisitionResult = { phase: AcquirePhase, slots: List[StartSlot], liveAtReturn: int, handlerAtReturn: int, declaredAtReturn: int, result: AcquisitionResult }
pure val initial: ServiceAcquisitionResult = { phase: WaitingForStarts, slots: List(), liveAtReturn: 0, handlerAtReturn: 0, declaredAtReturn: 0, result: AcquisitionPending }
pure val slotsValues = Set(List(StartedService({instance: 1})), List(RejectedStart({reason: "first"})), List(RejectedStart({reason: "first"}), StartedService({instance: 2}), RejectedStart({reason: "second"})))
pure val liveInstanceValues = Set(0, 1, 2)
pure val handlerValues = Set(0, 1)
pure val declaredCountValues = Set(1, 2, 3, 4)
pure val errorRefValues = Set("startup-failed")
pure def fulfilledSlot(slot: StartSlot): bool = match slot { | StartedService(_) => true | _ => false }
pure def fulfilledInstance(slot: StartSlot): int = match slot { | StartedService(found) => found.instance | _ => 0 }
pure def rejectedReason(slot: StartSlot): str = match slot { | RejectedStart(failure) => failure.reason | _ => "" }
pure def firstCapturedInstance(s: ServiceAcquisitionResult): int =
  s.slots.select(fulfilledSlot).listMap(fulfilledInstance).nthOr(0, 0)
pure def rejectionCauses(s: ServiceAcquisitionResult): List[str] =
  s.slots.select(slot => not(fulfilledSlot(slot))).listMap(rejectedReason)
pure def canObserveClassResults(s: ServiceAcquisitionResult, slots: List[StartSlot]): bool =
  s.phase == WaitingForStarts and slots.length() > 0 and slots.every(slot => not(fulfilledSlot(slot)) or fulfilledInstance(slot) > 0)
pure def observeClassResults(s: ServiceAcquisitionResult, slots: List[StartSlot]): ServiceAcquisitionResult =
  { ...initial, slots: slots, phase: StartsObserved }
pure def canReturnAcquisition(s: ServiceAcquisitionResult, liveInstance: int, handler: int, declaredCount: int, errorRef: str): bool =
  s.phase == StartsObserved and liveInstance >= 0 and handler >= 0 and declaredCount >= 0 and (liveInstance > 0 or errorRef != "")
pure def returnAcquisition(s: ServiceAcquisitionResult, liveInstance: int, handler: int, declaredCount: int, errorRef: str): ServiceAcquisitionResult =
  { ...s, phase: AcquisitionReturned, liveAtReturn: liveInstance, handlerAtReturn: handler, declaredAtReturn: declaredCount,
    result: if (liveInstance > 0) AcquisitionSucceeded({ instance: liveInstance })
      else AcquisitionFailed({ errorRef: errorRef, causes: rejectionCauses(s), declaredCount: declaredCount }) }
pure def exactResult(result: AcquisitionResult, s: ServiceAcquisitionResult): bool = match result {
  | AcquisitionPending => s.phase != AcquisitionReturned
  | AcquisitionSucceeded(found) => s.phase == AcquisitionReturned and s.liveAtReturn > 0 and found.instance == s.liveAtReturn
  | AcquisitionFailed(failure) => s.phase == AcquisitionReturned and s.liveAtReturn == 0 and failure.errorRef != "" and failure.causes == rejectionCauses(s) and failure.declaredCount == s.declaredAtReturn
}
pure def alwaysReturnUsesExactEvidence(s: ServiceAcquisitionResult): bool = exactResult(s.result, s)
pure def stepReturnedEvidenceStaysFixed(before: ServiceAcquisitionResult, after: ServiceAcquisitionResult): bool =
  before.phase == AcquisitionReturned implies after == before
pure def sometimesPublishedInstanceDiffersFromCapture(s: ServiceAcquisitionResult): bool =
  s.phase == AcquisitionReturned and s.liveAtReturn > 0 and s.liveAtReturn != firstCapturedInstance(s)
pure def sometimesCapturedSuccessWithNoPublication(s: ServiceAcquisitionResult): bool =
  s.phase == AcquisitionReturned and s.liveAtReturn == 0 and firstCapturedInstance(s) > 0
```

### The caller and the pending load handler observe the same error

On failure the acquiring caller rejects with the outer startup error.
If the service type has a pending load handler, it rejects with that same
error object. On success both use the same instance. The service instance
owner clears the corresponding handler and retains or removes its promise
reference according to the outcome.

```quint
type HandlerObservation = NoHandlerObservation | HandlerResolved({ instance: int }) | HandlerRejected({ errorRef: str })
pure def handlerObservation(s: ServiceAcquisitionResult): HandlerObservation = {
  val result = s.result
  if (s.handlerAtReturn == 0) NoHandlerObservation
  else match result {
    | AcquisitionPending => NoHandlerObservation
    | AcquisitionSucceeded(found) => HandlerResolved({ instance: found.instance })
    | AcquisitionFailed(failure) => HandlerRejected({ errorRef: failure.errorRef })
  }
}
pure def outputsAgree(s: ServiceAcquisitionResult, maybeHandler: HandlerObservation): bool = {
  val result = s.result
  match maybeHandler {
    | NoHandlerObservation => s.handlerAtReturn == 0 or s.phase != AcquisitionReturned
    | HandlerResolved(found) => match result { | AcquisitionSucceeded(value) => found.instance == value.instance | _ => false }
    | HandlerRejected(observed) => match result { | AcquisitionFailed(failure) => observed.errorRef == failure.errorRef | _ => false }
  }
}
pure def alwaysLoadHandlerMatchesCaller(s: ServiceAcquisitionResult): bool = outputsAgree(s, handlerObservation(s))
```
