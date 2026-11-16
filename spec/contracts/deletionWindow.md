# Deletion window

A deletion the owner reviewed on a device (a calendar event, a reminder or
any other device record whose deletion is delayed after review) waits ten
seconds before the provider write, so the owner can undo it. This contract
is shared by the renderer and every native host that keeps such a
deletion: the deadline, the window, the claim that decides between Undo and
the provider write, and what the Undo notice offers. Nothing here performs
a deletion; the host keeps the durable row and the provider write.

Expiry is measured on a monotonic clock that names its continuity: one
boot, or one renderer lifetime. Wall time is shown to the owner and never
decides expiry.

## Story: Undo a reviewed deletion before it is sent

> As an owner, I want ten seconds to undo a deletion I approved, and I want
> to be told the truth when it is too late or when nobody can know whether
> it went ahead.

### A reviewed deletion expires ten seconds after review on the clock it was reviewed on

The deadline records the continuity and elapsed time of the clock at
review, and expires ten seconds of elapsed time later. A clock is usable
only with a named continuity and elapsed and wall times that are not
negative.

```quint
pure val deleteUndoMs = 10000
type DeletionClock = { continuity: str, elapsed: int, wall: int }
type DeletionDeadline = { deadlineContinuity: str, createdElapsed: int, expiresElapsed: int, expiresAt: int }
pure def clockUsable(clock: DeletionClock): bool = clock.continuity != "" and clock.elapsed >= 0 and clock.wall >= 0
pure def deletionDeadline(clock: DeletionClock): DeletionDeadline =
  { deadlineContinuity: clock.continuity, createdElapsed: clock.elapsed, expiresElapsed: clock.elapsed + deleteUndoMs, expiresAt: clock.wall + deleteUndoMs }
pure def lawDeadlineIsTenSecondsAfterReview(clock: DeletionClock): bool =
  deletionDeadline(clock).expiresElapsed == clock.elapsed + deleteUndoMs and deletionDeadline(clock).deadlineContinuity == clock.continuity
pure val clockValues: Set[DeletionClock] = List(
  { continuity: "boot1", elapsed: 0, wall: 100 },
  { continuity: "boot1", elapsed: 5000, wall: 5100 },
  { continuity: "boot1", elapsed: 9999, wall: 0 },
  { continuity: "boot1", elapsed: 10000, wall: 10100 },
  { continuity: "boot1", elapsed: 25000, wall: 25100 },
  { continuity: "boot2", elapsed: 5000, wall: 5100 },
  { continuity: "", elapsed: 5000, wall: 5100 }
).foldl(Set(), (acc, c) => acc.union(Set(c)))
pure val laterValues = clockValues
```

### The window is open only on the same clock, from review until expiry

A clock whose continuity differs from the deadline's, that runs behind the
review, or a deadline that is not exactly ten seconds long, means the clock
changed: the deletion is neither open nor expired. Wall time never decides
the window.

```quint
type WindowState = WindowOpen | WindowExpired | ClockChanged
pure def deletionWindow(deadline: DeletionDeadline, later: DeletionClock): WindowState =
  if (not(clockUsable(later)) or later.continuity != deadline.deadlineContinuity or deadline.createdElapsed < 0 or
      deadline.expiresElapsed != deadline.createdElapsed + deleteUndoMs or later.elapsed < deadline.createdElapsed) ClockChanged
  else if (later.elapsed < deadline.expiresElapsed) WindowOpen
  else WindowExpired
pure def lawWindowOpenForTenSeconds(clock: DeletionClock, later: DeletionClock): bool =
  (clockUsable(clock) and clockUsable(later) and later.continuity == clock.continuity) implies
    ((deletionWindow(deletionDeadline(clock), later) == WindowOpen) iff (later.elapsed >= clock.elapsed and later.elapsed < clock.elapsed + deleteUndoMs))
pure def lawWallTimeNeverDecidesExpiry(clock: DeletionClock, later: DeletionClock, wall: int): bool =
  (later.wall >= 0 and wall >= 0) implies deletionWindow(deletionDeadline(clock), later) == deletionWindow(deletionDeadline(clock), { ...later, wall: wall })
pure val wallValues = Set(0, 1, 99999)
```

### Undo and the provider write have exactly one winner

The claim is made while holding the durable store's transaction. Only the
owner of the deletion can claim it, and only while it is queued; an Undo
may also claim a paused deletion. Undo wins while the window is open or
the clock changed, but not once it has expired. The provider write wins
only once the window has expired. Whichever claims first moves the
deletion out of the queue, so the other cannot claim it after. A changed
clock never authorizes the provider write: the deletion pauses for review
again, and undoing a deletion that was never sent stays safe. A deletion that is being sent, or whose outcome is unknown, cannot
be claimed by Undo or by another provider write.

```quint
type DeletionPhase = Queued | Paused | Dispatching | Undone | Deleted | DeletionConflict | UnknownOutcome
type DeletionClaimAction = ClaimUndo | ClaimDispatch
type PendingDeletion = { owner: str, deadline: DeletionDeadline, deletionPhase: DeletionPhase }
type DeletionClaim = { won: bool, claimed: PendingDeletion }
pure def claimDeletion(entry: PendingDeletion, owner: str, later: DeletionClock, claimAction: DeletionClaimAction): DeletionClaim = {
  val windowState = deletionWindow(entry.deadline, later)
  val lose = { won: false, claimed: entry }
  if (entry.owner != owner or not(entry.deletionPhase == Queued or (claimAction == ClaimUndo and entry.deletionPhase == Paused))) lose
  else if (claimAction == ClaimUndo) (if (entry.deletionPhase != Paused and windowState == WindowExpired) lose else { won: true, claimed: { ...entry, deletionPhase: Undone } })
  else if (windowState != WindowExpired) lose
  else { won: true, claimed: { ...entry, deletionPhase: Dispatching } }
}
pure def lawUndoAndDispatchHaveOneWinner(entry: PendingDeletion, owner: str, later: DeletionClock, firstAction: DeletionClaimAction, secondAction: DeletionClaimAction): bool = {
  val first = claimDeletion(entry, owner, later, firstAction)
  first.won implies not(claimDeletion(first.claimed, owner, later, secondAction).won)
}
pure def lawOnlyTheOwnerClaims(entry: PendingDeletion, owner: str, later: DeletionClock, claimAction: DeletionClaimAction): bool =
  entry.owner != owner implies not(claimDeletion(entry, owner, later, claimAction).won)
pure def lawExpiredWindowRefusesUndo(entry: PendingDeletion, owner: str, later: DeletionClock): bool =
  (entry.deletionPhase == Queued and deletionWindow(entry.deadline, later) == WindowExpired) implies not(claimDeletion(entry, owner, later, ClaimUndo).won)
pure val ownerValues = Set("owner1", "owner2")
pure val entryValues: Set[PendingDeletion] = List(
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: Queued },
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: Paused },
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: Dispatching },
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: UnknownOutcome },
  { owner: "owner2", deadline: deletionDeadline({ continuity: "boot2", elapsed: 5000, wall: 100 }), deletionPhase: Queued }
).foldl(Set(), (acc, e) => acc.union(Set(e)))
pure def lawLostClockNeverDispatches(entry: PendingDeletion, owner: str, later: DeletionClock): bool =
  deletionWindow(entry.deadline, later) == ClockChanged implies not(claimDeletion(entry, owner, later, ClaimDispatch).won)
pure def lawLostClockStillAllowsUndo(entry: PendingDeletion, owner: str, later: DeletionClock): bool =
  (entry.owner == owner and (entry.deletionPhase == Queued or entry.deletionPhase == Paused) and deletionWindow(entry.deadline, later) == ClockChanged) implies claimDeletion(entry, owner, later, ClaimUndo).won
pure def lawUncertainOutcomeIsNeverReplayed(entry: PendingDeletion, owner: str, later: DeletionClock, claimAction: DeletionClaimAction): bool =
  (entry.deletionPhase == Dispatching or entry.deletionPhase == UnknownOutcome) implies not(claimDeletion(entry, owner, later, claimAction).won)
```

### The notice offers Undo only while Undo can still win, and never for an uncertain outcome

The notice shows queued, paused and uncertain deletions; finished ones are
history. It offers Undo for a paused deletion, for a queued one whose clock
changed, and for a queued one whose window is open. An uncertain outcome
offers a refresh of its receipt and a dismissal, never Undo and never a
repeat. Undo is confirmed only by a receipt that says the deletion was
undone: a deletion that went ahead is never reported as kept.

```quint
type DeletionNotice = { shown: bool, canUndo: bool, uncertain: bool }
pure def deletionNotice(phase: DeletionPhase, windowState: WindowState): DeletionNotice = {
  val uncertain = phase == Dispatching or phase == UnknownOutcome
  val paused = phase == Paused or (phase == Queued and windowState == ClockChanged)
  { shown: phase == Queued or phase == Paused or uncertain, canUndo: paused or (phase == Queued and windowState == WindowOpen), uncertain: uncertain }
}
pure def undoConfirmed(receipt: DeletionPhase): bool = receipt == Undone
pure def lawUncertainNoticeNeverOffersUndo(phase: DeletionPhase, windowState: WindowState): bool =
  deletionNotice(phase, windowState).uncertain implies not(deletionNotice(phase, windowState).canUndo)
pure def lawNoticeOffersUndoOnlyWhenClaimable(phase: DeletionPhase, windowState: WindowState): bool =
  deletionNotice(phase, windowState).canUndo implies ((phase == Queued and windowState != WindowExpired) or phase == Paused)
pure def lawDeletedIsNeverReportedKept(receipt: DeletionPhase): bool = receipt != Undone implies not(undoConfirmed(receipt))
```
