# Workflow approval and device operation receipts

The owner decides a reviewed approval against the workflow engine's
canonical receipt, read under the execution lock. The [run
scope](./runScope.md) owns the exact calendar scope of a reviewed read.

## Story: Decide one reviewed approval once and run its device step only as reviewed

> As the owner, I want my decision to apply once to the run and request I
> reviewed, to be told only what the engine actually recorded, and a device
> step to run only within the scope I reviewed on my enrolled device.

### One caller at a time holds the execution lock, and only the canonical decision is reported

Each caller's request passes the owner gate, then takes the execution row
lock and checks the captured version and approval request digest against
the canonical receipt. A decided receipt resumes a caller that asked for
the same decision and fails one that asked for the other. A pending
approval on a finished or cancelling run, or an approval of an unsupported
review, fails; an unsupported review may still be denied. Otherwise the
caller sends the control command under the lock. The engine may commit it
and lose the reply; the caller then reads the canonical receipt back for
the same decision, digest and actor, and caches it. A failed readback or
cache write releases the lock without undoing the engine's receipt, and no
success is inferred from a submitted command. A caller is answered only
with the canonical decision.

```quint
type ApprovalState = PendingApproval | ApprovedRequest | DeniedRequest
type ApprovalCheck = SendControl | ReadCanonical | ApprovalIdentityChanged | DecisionAlreadyDifferent | ExecutionUnavailable | ReviewUnsupported
type ApprovalFacts = { identitiesMatch: bool, digestMatches: bool, prior: ApprovalState, actorMatches: bool, finished: bool, cancelRequested: bool, supported: bool }
pure def decideApproval(facts: ApprovalFacts, approved: bool): ApprovalCheck =
  if (not(facts.identitiesMatch) or not(facts.digestMatches)) ApprovalIdentityChanged
  else if (facts.prior != PendingApproval) (if (facts.actorMatches and facts.prior == (if (approved) ApprovedRequest else DeniedRequest)) ReadCanonical else DecisionAlreadyDifferent)
  else if (facts.finished or facts.cancelRequested) ExecutionUnavailable
  else if (approved and not(facts.supported)) ReviewUnsupported
  else SendControl
pure def receiptConfirmed(matchingRun: bool, matchingNode: bool, matchingDigest: bool, matchingDecision: bool, matchingActor: bool, controlFailed: bool): bool = matchingRun and matchingNode and matchingDigest and matchingDecision and (not(controlFailed) or matchingActor)
pure def lawFailedControlRequiresExactActor(matchingRun: bool, matchingNode: bool, matchingDigest: bool, matchingDecision: bool, matchingActor: bool): bool = receiptConfirmed(matchingRun, matchingNode, matchingDigest, matchingDecision, matchingActor, true) implies matchingActor and matchingDigest and matchingDecision
type CallerPhase = CallerIdle | CallerQueued | CallerReading | CallerCommanding | CallerReadingBack | CallerPersisting | CallerResuming | CallerDone | CallerFailed
type ApprovalAttempt = { caller: str, phase: CallerPhase, wants: ApprovalState, ownerOk: bool, versionOk: bool, digestOk: bool, responded: bool, response: ApprovalState }
type ApprovalRun = { lock: str, canonical: ApprovalState, cached: ApprovalState, supported: bool, finished: bool, cancelled: bool, effects: int, attempts: List[ApprovalAttempt] }
pure val initial: ApprovalRun = { lock: "", canonical: PendingApproval, cached: PendingApproval, supported: true, finished: false, cancelled: false, effects: 0, attempts: List() }
pure def idleAttempt(caller: str): ApprovalAttempt = { caller: caller, phase: CallerIdle, wants: ApprovedRequest, ownerOk: false, versionOk: false, digestOk: false, responded: false, response: PendingApproval }
pure def attemptOf(r: ApprovalRun, caller: str): ApprovalAttempt = r.attempts.select(a => a.caller == caller).nthOr(0, idleAttempt(caller))
pure def withAttempt(attempt: ApprovalAttempt, r: ApprovalRun): ApprovalRun =
  if (r.attempts.some(a => a.caller == attempt.caller)) { ...r, attempts: r.attempts.listMap(a => if (a.caller == attempt.caller) attempt else a) }
  else { ...r, attempts: r.attempts.append(attempt) }
pure def holdsLock(phase: CallerPhase): bool = phase == CallerReading or phase == CallerCommanding or phase == CallerReadingBack or phase == CallerPersisting
pure def canRequestDecision(r: ApprovalRun, caller: str, decision: ApprovalState): bool =
  caller != "" and decision != PendingApproval and (attemptOf(r, caller).phase == CallerIdle or attemptOf(r, caller).phase == CallerFailed)
pure def requestDecision(r: ApprovalRun, caller: str, decision: ApprovalState, ownerOk: bool, versionOk: bool, digestOk: bool): ApprovalRun =
  withAttempt({ caller: caller, phase: CallerQueued, wants: decision, ownerOk: ownerOk, versionOk: versionOk, digestOk: digestOk, responded: false, response: PendingApproval }, r)
pure def canAcquireRun(r: ApprovalRun, caller: str): bool = caller != "" and r.lock == "" and attemptOf(r, caller).phase == CallerQueued
pure def acquireRun(r: ApprovalRun, caller: str): ApprovalRun = {
  val a = attemptOf(r, caller)
  if (not(a.ownerOk)) withAttempt({ ...a, phase: CallerFailed }, r) else withAttempt({ ...a, phase: CallerReading }, { ...r, lock: caller })
}
pure def reviewFacts(r: ApprovalRun, a: ApprovalAttempt): ApprovalFacts =
  { identitiesMatch: a.versionOk, digestMatches: a.digestOk, prior: r.canonical, actorMatches: a.ownerOk, finished: r.finished, cancelRequested: r.cancelled, supported: r.supported }
pure def canReviewApproval(r: ApprovalRun, caller: str): bool = caller != "" and r.lock == caller and attemptOf(r, caller).phase == CallerReading
pure def reviewApproval(r: ApprovalRun, caller: str): ApprovalRun = {
  val a = attemptOf(r, caller)
  val check = decideApproval(reviewFacts(r, a), a.wants == ApprovedRequest)
  if (check == SendControl) withAttempt({ ...a, phase: CallerCommanding }, r)
  else withAttempt({ ...a, phase: if (check == ReadCanonical) CallerResuming else CallerFailed }, { ...r, lock: "" })
}
pure def canSendControl(r: ApprovalRun, caller: str): bool = caller != "" and r.lock == caller and attemptOf(r, caller).phase == CallerCommanding
pure def sendControl(r: ApprovalRun, caller: str, committed: bool): ApprovalRun = {
  val a = attemptOf(r, caller)
  if (committed) withAttempt({ ...a, phase: CallerReadingBack }, { ...r, canonical: a.wants, effects: r.effects + 1 })
  else withAttempt({ ...a, phase: CallerFailed }, { ...r, lock: "" })
}
pure def canReadBack(r: ApprovalRun, caller: str): bool = caller != "" and r.lock == caller and attemptOf(r, caller).phase == CallerReadingBack
pure def readBack(r: ApprovalRun, caller: str, available: bool): ApprovalRun = {
  val a = attemptOf(r, caller)
  if (available) withAttempt({ ...a, phase: CallerPersisting }, r) else withAttempt({ ...a, phase: CallerFailed }, { ...r, lock: "" })
}
pure def canPersistDecision(r: ApprovalRun, caller: str): bool = caller != "" and r.lock == caller and attemptOf(r, caller).phase == CallerPersisting
pure def persistDecision(r: ApprovalRun, caller: str, committed: bool): ApprovalRun = {
  val a = attemptOf(r, caller)
  if (committed) withAttempt({ ...a, phase: CallerResuming }, { ...r, cached: r.canonical, lock: "" })
  else withAttempt({ ...a, phase: CallerFailed }, { ...r, lock: "" })
}
pure def canResumeRun(r: ApprovalRun, caller: str): bool = attemptOf(r, caller).phase == CallerResuming
pure def resumeRun(r: ApprovalRun, caller: str, resumed: bool): ApprovalRun = {
  val a = attemptOf(r, caller)
  if (resumed) withAttempt({ ...a, phase: CallerDone, responded: true, response: r.canonical }, r) else withAttempt({ ...a, phase: CallerFailed }, r)
}
pure def canStopExecution(r: ApprovalRun): bool = r.lock == "" and not(r.cancelled)
pure def stopExecution(r: ApprovalRun): ApprovalRun = { ...r, cancelled: true }
pure def canFinishExecution(r: ApprovalRun): bool = r.lock == "" and not(r.finished)
pure def finishExecution(r: ApprovalRun): ApprovalRun = { ...r, finished: true }
pure def canMarkUnsupported(r: ApprovalRun): bool = r.supported and r.effects == 0 and r.lock == ""
pure def markUnsupported(r: ApprovalRun): ApprovalRun = { ...r, supported: false }
pure val callerValues = Set("first", "second")
pure val weight_acquireRun = 4
pure val weight_reviewApproval = 4
pure val weight_sendControl = 4
pure val weight_readBack = 4
pure val weight_persistDecision = 4
pure val weight_resumeRun = 4
pure def alwaysOneCanonicalDecision(r: ApprovalRun): bool = r.effects >= 0 and r.effects <= 1 and ((r.canonical == PendingApproval) iff (r.effects == 0))
pure def alwaysUnsupportedNeverApproved(r: ApprovalRun): bool = not(r.supported) implies r.canonical != ApprovedRequest
pure def alwaysHonestResponse(r: ApprovalRun): bool =
  r.attempts.every(a => a.responded implies a.ownerOk and a.versionOk and a.digestOk and a.response == r.canonical and a.response != PendingApproval)
pure def alwaysCachedHasCanonicalReceipt(r: ApprovalRun): bool = r.cached != PendingApproval implies r.cached == r.canonical
pure def sometimesDecisionReported(r: ApprovalRun): bool = r.attempts.some(a => a.phase == CallerDone)
pure def sometimesBothCallersAnsweredOnce(r: ApprovalRun): bool = r.effects == 1 and r.attempts.length() == 2 and r.attempts.every(a => a.phase == CallerDone)
pure def sometimesCommittedReplyLost(r: ApprovalRun): bool = r.effects == 1 and r.cached == PendingApproval and r.lock == "" and r.attempts.some(a => a.phase == CallerFailed)
pure def sometimesUnsupportedDenied(r: ApprovalRun): bool = not(r.supported) and r.canonical == DeniedRequest
```

### Every caller asks to approve or to deny, never for a pending decision

```quint
pure def alwaysAttemptsWantADecision(r: ApprovalRun): bool = r.attempts.every(a => a.wants != PendingApproval)
```

### A caller acts only on the checks it has passed

The lock belongs to exactly the caller that is reading, commanding, reading
back or persisting, and each caller is listed once. A caller past the lock
has passed the owner gate; one past review matched the captured version
and digest. A caller sends a command only for a pending decision on a
running, supported review. A caller reading back, persisting or resuming
wants the canonical decision, and only a finished caller has been answered.

```quint
pure def alwaysLockHeldByWorkingCaller(r: ApprovalRun): bool =
  (r.lock != "" implies r.attempts.some(a => a.caller == r.lock and holdsLock(a.phase))) and
  r.attempts.every(a =>
    a.caller != "" and r.attempts.select(b => b.caller == a.caller).length() == 1 and
    (holdsLock(a.phase) implies r.lock == a.caller) and
    ((holdsLock(a.phase) or a.phase == CallerResuming or a.phase == CallerDone) implies a.ownerOk) and
    ((a.phase == CallerCommanding or a.phase == CallerReadingBack or a.phase == CallerPersisting or a.phase == CallerResuming or a.phase == CallerDone) implies a.versionOk and a.digestOk) and
    (a.phase == CallerCommanding implies r.canonical == PendingApproval and not(r.finished or r.cancelled) and (a.wants == ApprovedRequest implies r.supported)) and
    ((a.phase == CallerReadingBack or a.phase == CallerPersisting or a.phase == CallerResuming) implies r.canonical == a.wants and r.canonical != PendingApproval) and
    (a.responded implies a.phase == CallerDone))
```

### Device steps require the exact reviewed scope and enrolled device

The device read or write command names the still-running run, workflow,
version, spec digest and step. Its installation and enrollment match the
reviewed device, and the requested operation, including its resource or
calendar range, matches that step and kind. Relative dates resolve against
the run's persisted anchor ([run scope](./runScope.md)). The approval
notice is read-only and grants no authority for a device operation.

```quint
type StepFacts = { runMatches: bool, definitionMatches: bool, versionMatches: bool, digestMatches: bool, installationMatches: bool, enrollmentMatches: bool, stepMatches: bool, operationMatches: bool, finished: bool, cancelRequested: bool }
pure def admitsReviewedDeviceStep(scope: StepFacts): bool = scope.runMatches and scope.definitionMatches and scope.versionMatches and scope.digestMatches and scope.installationMatches and scope.enrollmentMatches and scope.stepMatches and scope.operationMatches and not(scope.finished) and not(scope.cancelRequested)
pure val scopeValues = Set(
  { runMatches: true, definitionMatches: true, versionMatches: true, digestMatches: true, installationMatches: true, enrollmentMatches: true, stepMatches: true, operationMatches: true, finished: false, cancelRequested: false },
  { runMatches: true, definitionMatches: true, versionMatches: true, digestMatches: true, installationMatches: true, enrollmentMatches: false, stepMatches: true, operationMatches: true, finished: false, cancelRequested: false })
pure def lawForeignDeviceCannotUseReview(scope: StepFacts): bool = (not(scope.installationMatches) or not(scope.enrollmentMatches)) implies not(admitsReviewedDeviceStep(scope))
pure def lawTerminalRunCannotUseDevice(scope: StepFacts): bool = (scope.finished or scope.cancelRequested) implies not(admitsReviewedDeviceStep(scope))
```
