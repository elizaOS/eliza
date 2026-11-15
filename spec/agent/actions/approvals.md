# Choice cancellation

When the person answers a choice with ABORT, the agent cancels it: it asks
the [approval service](../../core/approvals.md) to cancel the pending
approval behind the choice and deletes the choice's task. Who answered and
whether the option was valid were checked before this; here the question
is who owns the approval. A pending owner keeps its callback and original
deadline until the deletion is acknowledged, and gets them back if the
deletion fails. A plain choice with no approval behind it is cancelled the
same way. An approval already claimed by someone else, or one whose owner
is unknown, is refused before any task or callback is touched. The
research baseline is `plugins/plugin-assistant` `CHOOSE_OPTION`,
`ApprovalService.cancelPendingApproval` and the `ChoiceApprovalCancellation`
model.

## Story: Cancel a choice with ABORT

> As the person asked to approve something, answering ABORT cancels it and
> I am told so only once it is really gone; if it cannot be cancelled, it is
> still waiting for me as before.

### Cancelling deletes the task first and settles a pending owner only after the deletion

```quint
type ApprovalOwner = NotOpened | OwnerPending | OwnerClaimed | OwnerUnknown | NoApproval
type CancelPhase = Closed | Ready | Deleting | Retained | RefusedCancel | Confirming | Done | DeliveryFailed
type CallerState = CallerNone | CallerPending | CallerCancelled | CallerClaimed | CallerUnknown
type Deadline = NoDeadline | DeadlineActive | DeadlinePaused | DeadlineCleared
type Cancellation = { owner: ApprovalOwner, phase: CancelPhase, caller: CallerState, deadline: Deadline }
pure val initial: Cancellation = { owner: NotOpened, phase: Closed, caller: CallerNone, deadline: NoDeadline }
pure def owned(c: Cancellation): bool = c.owner == OwnerPending
pure def cancellable(c: Cancellation): bool = c.owner == OwnerPending or c.owner == NoApproval
pure def taskPresent(c: Cancellation): bool = c.phase == Ready or c.phase == Deleting or c.phase == Retained or c.phase == RefusedCancel
pure def callerFor(owner: ApprovalOwner): CallerState =
  if (owner == OwnerPending) CallerPending else if (owner == OwnerClaimed) CallerClaimed else if (owner == OwnerUnknown) CallerUnknown else CallerNone
pure def ownerDeadline(owner: ApprovalOwner): Deadline = if (owner == OwnerPending) DeadlineActive else NoDeadline
pure val ownerValues = Set(OwnerPending, OwnerClaimed, OwnerUnknown, NoApproval)
pure def canOpenChoice(c: Cancellation, owner: ApprovalOwner): bool = c.phase == Closed and owner != NotOpened
pure def openChoice(c: Cancellation, owner: ApprovalOwner): Cancellation = { owner: owner, phase: Ready, caller: callerFor(owner), deadline: ownerDeadline(owner) }
pure def canAbortChoice(c: Cancellation): bool = c.phase == Ready or c.phase == Retained
pure def abortChoice(c: Cancellation): Cancellation =
  if (cancellable(c)) { ...c, phase: Deleting, deadline: if (owned(c)) DeadlinePaused else NoDeadline } else { ...c, phase: RefusedCancel }
pure def canDeleteDone(c: Cancellation): bool = c.phase == Deleting
pure def deleteDone(c: Cancellation): Cancellation =
  { ...c, phase: Confirming, caller: if (owned(c)) CallerCancelled else c.caller, deadline: if (owned(c)) DeadlineCleared else NoDeadline }
pure def alwaysOwnerSettlesAfterDeletion(c: Cancellation): bool = c.caller == CallerCancelled implies not(taskPresent(c))
```

### A failed deletion keeps the pending owner and its original deadline

```quint
pure def canDeleteFailed(c: Cancellation): bool = c.phase == Deleting
pure def deleteFailed(c: Cancellation): Cancellation = { ...c, phase: Retained, deadline: ownerDeadline(c.owner) }
pure def alwaysFailedDeletionKeepsOwner(c: Cancellation): bool = (owned(c) and taskPresent(c)) implies c.caller == CallerPending
pure def alwaysDeadlineFollowsTask(c: Cancellation): bool =
  owned(c) implies c.deadline == (if (c.phase == Deleting) DeadlinePaused else if (taskPresent(c)) DeadlineActive else DeadlineCleared)
pure def sometimesRetriedAfterFailedDeletion(c: Cancellation): bool = owned(c) and c.phase == Retained and c.deadline == DeadlineActive
```

### The cancellation is confirmed only after the task is gone and its owner settled

```quint
pure def canConfirmCancel(c: Cancellation): bool = c.phase == Confirming
pure def confirmCancel(c: Cancellation): Cancellation = { ...c, phase: Done }
pure def canConfirmationFailed(c: Cancellation): bool = c.phase == Confirming
pure def confirmationFailed(c: Cancellation): Cancellation = { ...c, phase: DeliveryFailed }
pure def alwaysConfirmationMeansDeleted(c: Cancellation): bool =
  c.phase == Done implies not(taskPresent(c)) and (owned(c) implies c.caller == CallerCancelled)
pure def sometimesOwnedCancellationConfirmed(c: Cancellation): bool = c.phase == Done and owned(c)
pure def sometimesPlainChoiceCancelled(c: Cancellation): bool = c.phase == Done and c.owner == NoApproval and c.caller == CallerNone
```

### A claimed or unknown owner is refused before any effect

```quint
pure def alwaysRefusedHasNoEffects(c: Cancellation): bool =
  (c.owner == OwnerClaimed or c.owner == OwnerUnknown) implies
    (c.phase == Ready or c.phase == RefusedCancel) and c.caller == callerFor(c.owner) and c.deadline == NoDeadline
pure def sometimesClaimedOwnerRefused(c: Cancellation): bool = c.phase == RefusedCancel and c.owner == OwnerClaimed
```

### A cancelled owner stays cancelled, and a deleted task never comes back

```quint
pure def stepCancellationStays(before: Cancellation, after: Cancellation): bool =
  (before.caller == CallerCancelled implies after.caller == CallerCancelled) and
  ((before.phase != Closed and not(taskPresent(before))) implies not(taskPresent(after)))
```

### A cancellation in flight always ends in a final outcome

```quint
pure val fair_deleteDone = "weak"
pure val fair_deleteFailed = "weak"
pure val fair_confirmCancel = "weak"
pure val fair_confirmationFailed = "weak"
pure def inFlight(c: Cancellation): bool = c.phase == Deleting or c.phase == Confirming
pure def finalOutcome(c: Cancellation): bool = c.phase == Retained or c.phase == RefusedCancel or c.phase == Done or c.phase == DeliveryFailed
pure def leadsToCancellationSettles(c: Cancellation, later: Cancellation): bool = inFlight(c) implies finalOutcome(later)
```
