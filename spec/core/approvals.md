# Approval ownership and durable choices

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/services/approval.ts`, `messaging/interactive-task.ts`, and the ApprovalService, ApprovalRetirement, ApprovalPersisted and InteractionSession models. Approval callbacks are process-owned capabilities. A durable task row alone cannot recreate them after restart. This machine follows one approval and separates publication, claim, callback settlement, deletion acknowledgement and service retirement.

## Story: Resolve an approval exactly once

As a user, I can select, time out or cancel an approval while competing handlers observe one terminal outcome. Admission and permission checks happen before publishing the choice. Callback failure remains a failure. A result cannot imply that a missing callback executed.

### Persisting a request precedes publishing its in-memory callback

```quint
type ApprovalPhase = New | Writing | Pending | Claimed | Cancelling | Deleting | LateCleanup | Terminal
type Resolution = Unresolved | Selected | TimedOut | Cancelled | Rejected
type Approval = { phase: ApprovalPhase, resolution: Resolution, desired: Resolution, durable: bool, callbackPresent: bool, callbackRequired: bool, callbackRan: bool, callbackSucceeded: bool, callbackCount: int, cleanupFailed: bool, legacyCancellation: bool, stopping: bool, retired: bool }
pure val initial: Approval = { phase: New, resolution: Unresolved, desired: Unresolved, durable: false, callbackPresent: false, callbackRequired: true, callbackRan: false, callbackSucceeded: false, callbackCount: 0, cleanupFailed: false, legacyCancellation: false, stopping: false, retired: false }
pure def canWrite(s: Approval, callbackRequired: bool): bool = s.phase == New and not(s.stopping)
pure def write(s: Approval, callbackRequired: bool): Approval = { ...s, phase: Writing, callbackRequired: callbackRequired }
pure def canPublish(s: Approval): bool = s.phase == Writing and not(s.stopping)
pure def publish(s: Approval): Approval = { ...s, phase: Pending, durable: true, callbackPresent: s.callbackRequired }
pure def canFinishLateWrite(s: Approval): bool = s.phase == Writing and s.stopping
pure def finishLateWrite(s: Approval): Approval = { ...s, phase: LateCleanup, durable: true }
pure def canWriteFailed(s: Approval): bool = s.phase == Writing
pure def writeFailed(s: Approval): Approval = { ...s, phase: Terminal, resolution: Rejected }
```

### Claiming removes pending ownership before a callback starts

The first selector, timeout or cancellation claims the request. Competing claims are rejected by the guard. Receipt-bearing cancellation retains its pending owner until acknowledged deletion. A failed deletion restores that owner and deadline unless the service stopped. Selection and timeout resolve their caller after the callback, before cleanup deletion; cleanup failure remains separately visible. The legacy cancel path also resolves before deletion.

```quint
pure def canClaim(s: Approval, desired: Resolution): bool = s.phase == Pending and not(s.stopping) and desired != Unresolved and desired != Rejected and (not(s.callbackRequired) or s.callbackPresent)
pure def claim(s: Approval, desired: Resolution): Approval = { ...s, phase: if (desired == Cancelled) Cancelling else Claimed, desired: desired, callbackPresent: desired == Cancelled and s.callbackPresent }
pure val desiredValues = Set(Selected, TimedOut, Cancelled)
pure def canCallback(s: Approval, succeeded: bool): bool = s.phase == Claimed and not(s.callbackRan)
pure def callback(s: Approval, succeeded: bool): Approval =
  { ...s, phase: if (succeeded) Deleting else Terminal, callbackRan: s.callbackRequired, callbackSucceeded: s.callbackRequired and succeeded, callbackCount: if (s.callbackRequired) s.callbackCount + 1 else s.callbackCount, resolution: if (succeeded) s.desired else Rejected }
pure def canDeleted(s: Approval): bool = s.phase == Deleting or s.phase == LateCleanup or s.phase == Cancelling
pure def deleted(s: Approval): Approval = { ...s, phase: Terminal, durable: false, callbackPresent: false, resolution: if (s.phase == LateCleanup) Rejected else s.desired }
pure def canDeleteFailed(s: Approval): bool = s.phase == Deleting or s.phase == LateCleanup or s.phase == Cancelling
pure def deleteFailed(s: Approval): Approval =
  if (s.phase == Cancelling and not(s.stopping)) { ...s, phase: Pending, desired: Unresolved, cleanupFailed: true }
  else { ...s, phase: Terminal, callbackPresent: false, cleanupFailed: true, resolution: if (s.phase == Deleting) s.resolution else Rejected }
pure def canLegacyCancel(s: Approval): bool = (s.phase == Pending or (s.phase == Terminal and s.durable)) and not(s.stopping)
pure def legacyCancel(s: Approval): Approval = if (s.phase == Terminal) { ...s, phase: LateCleanup, callbackPresent: false, legacyCancellation: true } else { ...s, phase: Deleting, desired: Cancelled, resolution: Cancelled, callbackPresent: false, legacyCancellation: true }
pure def alwaysClaimHasChosenResolution(s: Approval): bool = (s.phase == Claimed or s.phase == Deleting or s.phase == Cancelling) implies (s.desired != Unresolved and s.desired != Rejected)
pure def alwaysDeletingHasSuccessfulClaim(s: Approval): bool = s.phase != Deleting or (s.desired != Unresolved and s.desired != Rejected and (s.legacyCancellation or not(s.callbackRequired) or (s.callbackRan and s.callbackSucceeded)))
pure def alwaysAtMostOneCallback(s: Approval): bool = s.callbackCount >= 0 and s.callbackCount <= 1
pure def alwaysAcknowledgedSelectionHasEffect(s: Approval): bool = (s.resolution == Selected and s.callbackRequired) implies (s.callbackRan and s.callbackSucceeded)
pure def alwaysCallbackFreeDoesNotInventEffects(s: Approval): bool = not(s.callbackRequired) implies (not(s.callbackRan) and s.callbackCount == 0)
pure def sometimesSelected(s: Approval): bool = s.resolution == Selected and not(s.durable)
pure def sometimesFailureRetainsTask(s: Approval): bool = s.resolution == Rejected and s.durable
pure def sometimesCancellationCanRetry(s: Approval): bool = s.phase == Pending and s.cleanupFailed
pure def sometimesAcknowledgedSelectionNeedsCleanup(s: Approval): bool = s.phase == Deleting and s.resolution == Selected and s.durable
```

### New requests, callback counts and cancellation phases retain their ownership facts

Discovered by the proof: a fabricated new request could carry an earlier successful resolution into a changed callback requirement; an unrun callback could already have consumed the callback count; a cancellation phase could name selection; and a terminal request could still own a callback. The source begins with empty request state, records the callback count together with invocation, reserves cancellation phases for cancellation, and releases callback ownership before becoming terminal. A legacy cleanup stays in deletion, late cleanup or terminal state; it cannot reenter a live callback claim.

```quint
pure def alwaysFreshRequestIsEmpty(s: Approval): bool = s.phase == New implies (s.resolution == Unresolved and s.desired == Unresolved and not(s.durable) and not(s.callbackPresent) and not(s.callbackRan) and not(s.callbackSucceeded) and s.callbackCount == 0 and not(s.cleanupFailed) and not(s.legacyCancellation) and not(s.stopping))
pure def alwaysCallbackAccounting(s: Approval): bool = s.callbackCount == (if (s.callbackRan) 1 else 0) and (s.callbackSucceeded implies s.callbackRan)
pure def alwaysCancellationNamesCancellation(s: Approval): bool = (s.phase == Cancelling or (s.phase == Deleting and s.legacyCancellation)) implies s.desired == Cancelled
pure def alwaysCallbackHasPendingOwner(s: Approval): bool = s.callbackPresent implies s.phase == Pending or s.phase == Cancelling
pure def alwaysLegacyCleanupRetainsItsPhase(s: Approval): bool = s.legacyCancellation implies s.phase == Deleting or s.phase == LateCleanup or s.phase == Terminal
pure def validApproval(s: Approval): bool = alwaysClaimHasChosenResolution(s) and alwaysDeletingHasSuccessfulClaim(s) and alwaysAtMostOneCallback(s) and alwaysAcknowledgedSelectionHasEffect(s) and alwaysCallbackFreeDoesNotInventEffects(s) and alwaysFreshRequestIsEmpty(s) and alwaysCallbackAccounting(s) and alwaysCancellationNamesCancellation(s) and alwaysCallbackHasPendingOwner(s) and alwaysLegacyCleanupRetainsItsPhase(s) and alwaysRetiredIsDrained(s)
```

### Restart drops process-owned callbacks and service retirement drains a claimed callback

A task write settling after stop enters late cleanup; the task deletion must settle before its creating caller receives the stopped rejection. Failed late deletion retains the durable row and reports failure. Callback-requiring durable requests become orphaned failures after restart. Callback-free requests may remain selectable. Stop removes unclaimed in-memory ownership, retains the durable pending task, and waits for already claimed work to settle before returning.

```quint
pure def canRestart(s: Approval): bool = s.phase == Pending and s.durable and not(s.stopping)
pure def restart(s: Approval): Approval = { ...s, phase: if (s.callbackRequired) Terminal else Pending, callbackPresent: false, resolution: if (s.callbackRequired) Rejected else Unresolved }
pure def canStop(s: Approval): bool = not(s.stopping)
pure def stop(s: Approval): Approval = { ...s, stopping: true, callbackPresent: false, phase: if (s.phase == Pending or s.phase == New) Terminal else s.phase, resolution: if (s.phase == Pending or s.phase == New) Cancelled else s.resolution }
pure def canRetire(s: Approval): bool = s.stopping and s.phase == Terminal and not(s.retired)
pure def retire(s: Approval): Approval = { ...s, retired: true }
pure def alwaysRetiredIsDrained(s: Approval): bool = s.retired implies (s.stopping and s.phase == Terminal and not(s.callbackPresent))
pure def stepTerminalOutcomeIsStable(before: Approval, after: Approval): bool = before.phase != Terminal or before.resolution == after.resolution
pure def sometimesRestartRejectsLostCallback(s: Approval): bool = s.phase == Terminal and s.resolution == Rejected and s.durable and s.callbackCount == 0
pure def sometimesRetirementCompletes(s: Approval): bool = s.retired
pure def sometimesLateWriteNeedsCleanup(s: Approval): bool = s.stopping and s.phase == LateCleanup and s.durable
```

### Fair storage and callback settlement drains a stopping service

Accepted callbacks and storage writes eventually settle. Once they settle, retirement runs. An unresponsive callback retains its owner instead of manufacturing completed cleanup.

```quint
pure val fair_finishLateWrite = "weak"
pure val fair_callback = "weak"
pure val fair_deleted = "weak"
pure val fair_retire = "weak"
pure def leadsToRetired(s: Approval, later: Approval): bool = s.stopping implies later.retired
```
