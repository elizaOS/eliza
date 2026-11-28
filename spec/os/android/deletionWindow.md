# Deletion window

A deletion the owner reviewed on the device (a calendar event, a reminder, a
text message, a conversation, a voicemail, a contact or another device record
whose deletion is delayed after review) waits ten seconds before the provider
write, so that the owner can undo it. This
library holds the deadline, the window, the claim that decides between Undo
and the provider write, and what the Undo notice offers. The renderer and
every native journal that keeps such a deletion use it. Nothing here performs
a deletion: the journal keeps the durable row and the shell makes the
provider write.

Expiry is measured on a monotonic clock that names its continuity: one boot,
or one renderer lifetime. Wall time is shown to the owner and never decides
expiry. The shell refuses to stage a deletion when the review clock is not
usable.

## Story: Undo a reviewed deletion before it is sent

> As an owner, I want ten seconds to undo a deletion I approved, so that a
> mistake costs nothing, and I want the truth when it is too late or when
> nobody can know whether the deletion went ahead.

### A reviewed deletion expires ten seconds after review on the clock it was reviewed on

The deadline records the continuity and elapsed time of the review clock and
expires ten seconds of elapsed time later. A clock is usable only with a
named continuity and elapsed and wall times from zero up to the last safe
integer that still leaves room for the window. A deadline taken on an
unusable clock never opens and never expires.

```quint
import numbers as Num from "../../core/numbers"
pure val deleteUndoMs = 10000
pure val latestClockMs = Num::maxSafeInteger - deleteUndoMs
type DeletionClock = { continuity: str, elapsed: int, wall: int }
type DeletionDeadline = { deadlineContinuity: str, createdElapsed: int, expiresElapsed: int, expiresAt: int }
pure def clockUsable(clock: DeletionClock): bool =
  clock.continuity != "" and clock.elapsed >= 0 and clock.elapsed <= latestClockMs and clock.wall >= 0 and clock.wall <= latestClockMs
pure def deletionDeadline(clock: DeletionClock): DeletionDeadline =
  if (clockUsable(clock))
    { deadlineContinuity: clock.continuity, createdElapsed: clock.elapsed, expiresElapsed: clock.elapsed + deleteUndoMs, expiresAt: clock.wall + deleteUndoMs }
  else { deadlineContinuity: "", createdElapsed: 0, expiresElapsed: 0, expiresAt: 0 }
pure def lawExpiresTenSecondsAfterReview(clock: DeletionClock, later: DeletionClock): bool =
  (clockUsable(clock) and clockUsable(later) and later.continuity == clock.continuity and later.elapsed >= clock.elapsed) implies
    ((deletionWindow(deletionDeadline(clock), later) == WindowExpired) iff (later.elapsed >= clock.elapsed + deleteUndoMs))
pure def lawUnusableReviewClockNeverOpensOrExpires(clock: DeletionClock, later: DeletionClock): bool =
  not(clockUsable(clock)) implies deletionWindow(deletionDeadline(clock), later) == ClockChanged
pure val clockValues: Set[DeletionClock] = List(
  { continuity: "boot1", elapsed: 0, wall: 100 },
  { continuity: "boot1", elapsed: 5000, wall: 5100 },
  { continuity: "boot1", elapsed: 9999, wall: 0 },
  { continuity: "boot1", elapsed: 10000, wall: 10100 },
  { continuity: "boot1", elapsed: 25000, wall: 25100 },
  { continuity: "boot2", elapsed: 5000, wall: 5100 },
  { continuity: "", elapsed: 5000, wall: 5100 },
  { continuity: "boot1", elapsed: -1, wall: 100 }
).foldl(Set(), (acc, c) => acc.union(Set(c)))
pure val laterValues = clockValues
pure val afterValues = clockValues
```

### The window is open only on the review clock, from review until expiry

A later clock that is unusable, has another continuity or runs behind the
review, or a deadline that is not exactly ten seconds long, means the clock
changed: the deletion is neither open nor expired. Wall time never decides
the window.

```quint
type WindowState = WindowOpen | WindowExpired | ClockChanged
pure def deletionWindow(deadline: DeletionDeadline, later: DeletionClock): WindowState =
  if (not(clockUsable(later)) or later.continuity != deadline.deadlineContinuity or deadline.createdElapsed < 0 or
      deadline.createdElapsed > latestClockMs or deadline.expiresElapsed != deadline.createdElapsed + deleteUndoMs or
      later.elapsed < deadline.createdElapsed) ClockChanged
  else if (later.elapsed < deadline.expiresElapsed) WindowOpen
  else WindowExpired
pure def lawWindowOpenForTenSeconds(clock: DeletionClock, later: DeletionClock): bool =
  (clockUsable(clock) and clockUsable(later) and later.continuity == clock.continuity) implies
    ((deletionWindow(deletionDeadline(clock), later) == WindowOpen) iff (later.elapsed >= clock.elapsed and later.elapsed < clock.elapsed + deleteUndoMs))
pure def lawOtherClockIsAChangedClock(clock: DeletionClock, later: DeletionClock): bool =
  later.continuity != clock.continuity implies deletionWindow(deletionDeadline(clock), later) == ClockChanged
pure def lawWallTimeNeverDecidesExpiry(clock: DeletionClock, later: DeletionClock, wall: int): bool =
  (later.wall >= 0 and later.wall <= latestClockMs and wall >= 0 and wall <= latestClockMs) implies
    deletionWindow(deletionDeadline(clock), later) == deletionWindow(deletionDeadline(clock), { ...later, wall: wall })
pure val wallValues = Set(0, 1, 99999)
```

### Undo and the provider write have exactly one winner

The journal makes the claim while it holds its durable transaction. Only the
owner of the deletion claims it, and only while it is queued; Undo may also
claim a paused deletion. Undo wins while the window is open or the clock
changed, never once a queued window has expired. The provider write wins
only once the window has expired, so a changed clock never authorizes it:
the deletion stays unsent until the owner undoes it or reviews it again.
The winning claim moves the deletion out of the queue, so no later claim
wins. A deletion that is being sent, whose outcome is uncertain or that has
settled is never claimed again.

```quint
type DeletionPhase = Queued | Paused | Dispatching | Undone | Deleted | DeletionConflict | UnknownOutcome
type DeletionClaimAction = ClaimUndo | ClaimDispatch
type PendingDeletion = { owner: str, deadline: DeletionDeadline, deletionPhase: DeletionPhase }
type DeletionClaim = { won: bool, claimed: PendingDeletion }
pure def claimDeletion(entry: PendingDeletion, owner: str, later: DeletionClock, claimAction: DeletionClaimAction): DeletionClaim = {
  val windowState = deletionWindow(entry.deadline, later)
  val lose = { won: false, claimed: entry }
  if (entry.owner != owner or not(entry.deletionPhase == Queued or (claimAction == ClaimUndo and entry.deletionPhase == Paused))) lose
  else if (claimAction == ClaimUndo)
    (if (entry.deletionPhase == Queued and windowState == WindowExpired) lose else { won: true, claimed: { ...entry, deletionPhase: Undone } })
  else if (windowState != WindowExpired) lose
  else { won: true, claimed: { ...entry, deletionPhase: Dispatching } }
}
pure def lawUndoAndDispatchHaveOneWinner(entry: PendingDeletion, owner: str, later: DeletionClock, after: DeletionClock,
    firstAction: DeletionClaimAction, secondAction: DeletionClaimAction): bool = {
  val first = claimDeletion(entry, owner, later, firstAction)
  first.won implies not(claimDeletion(first.claimed, owner, after, secondAction).won)
}
pure def lawOnlyTheOwnerClaims(entry: PendingDeletion, owner: str, later: DeletionClock, claimAction: DeletionClaimAction): bool =
  entry.owner != owner implies not(claimDeletion(entry, owner, later, claimAction).won)
pure def lawExpiredWindowRefusesUndo(entry: PendingDeletion, owner: str, later: DeletionClock): bool =
  (entry.deletionPhase == Queued and deletionWindow(entry.deadline, later) == WindowExpired) implies not(claimDeletion(entry, owner, later, ClaimUndo).won)
pure def lawDispatchOnlyAfterExpiry(entry: PendingDeletion, owner: str, later: DeletionClock): bool =
  claimDeletion(entry, owner, later, ClaimDispatch).won implies deletionWindow(entry.deadline, later) == WindowExpired
pure def lawChangedClockStillAllowsUndo(entry: PendingDeletion, later: DeletionClock): bool =
  ((entry.deletionPhase == Queued or entry.deletionPhase == Paused) and deletionWindow(entry.deadline, later) == ClockChanged) implies
    claimDeletion(entry, entry.owner, later, ClaimUndo).won
pure def lawSentOrSettledIsNeverClaimed(entry: PendingDeletion, owner: str, later: DeletionClock, claimAction: DeletionClaimAction): bool =
  not(entry.deletionPhase == Queued or entry.deletionPhase == Paused) implies not(claimDeletion(entry, owner, later, claimAction).won)
pure val ownerValues = Set("owner1", "owner2")
pure val entryValues: Set[PendingDeletion] = List(
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: Queued },
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 5000, wall: 100 }), deletionPhase: Queued },
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: Paused },
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: Dispatching },
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: UnknownOutcome },
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: Undone },
  { owner: "owner1", deadline: deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: Deleted },
  { owner: "owner1", deadline: { deadlineContinuity: "boot1", createdElapsed: 0, expiresElapsed: 5000, expiresAt: 100 }, deletionPhase: Queued },
  { owner: "owner2", deadline: deletionDeadline({ continuity: "boot2", elapsed: 5000, wall: 100 }), deletionPhase: Queued }
).foldl(Set(), (acc, e) => acc.union(Set(e)))
```

### The notice offers Undo only while Undo can still win, and never for an uncertain outcome

The notice shows queued, paused and uncertain deletions; settled ones are
history. A queued deletion whose clock changed is shown as paused. A queued
deletion whose window has expired waits for the provider receipt without
Undo. An uncertain outcome offers a refresh of its receipt and a dismissal,
never Undo and never a repeat. Undo is confirmed only by a receipt that says
the deletion was undone, so a deletion that went ahead is never reported as
kept.

```quint
type DeletionNotice = NoticeHidden | NoticeQueued | NoticePaused | NoticeVerifying | NoticeUncertain
pure def deletionNotice(phase: DeletionPhase, windowState: WindowState): DeletionNotice =
  if (phase == Paused or (phase == Queued and windowState == ClockChanged)) NoticePaused
  else if (phase == Queued and windowState == WindowOpen) NoticeQueued
  else if (phase == Queued) NoticeVerifying
  else if (phase == Dispatching or phase == UnknownOutcome) NoticeUncertain
  else NoticeHidden
pure def offersUndo(notice: DeletionNotice): bool = notice == NoticeQueued or notice == NoticePaused
pure def undoConfirmed(receipt: DeletionPhase): bool = receipt == Undone
pure def lawNoticeOffersUndoExactlyWhenUndoCanWin(entry: PendingDeletion, later: DeletionClock): bool =
  offersUndo(deletionNotice(entry.deletionPhase, deletionWindow(entry.deadline, later))) iff claimDeletion(entry, entry.owner, later, ClaimUndo).won
pure def lawOnlyAnUndoIsConfirmedAsKept(entry: PendingDeletion, owner: str, later: DeletionClock, claimAction: DeletionClaimAction): bool = {
  val claim = claimDeletion(entry, owner, later, claimAction)
  claim.won implies (undoConfirmed(claim.claimed.deletionPhase) iff claimAction == ClaimUndo)
}
```

### A queued deletion on its review clock hides the record from its list

The list that shows a message, a conversation, a voicemail or a contact
leaves it out while its deletion is queued on its review clock, so that it
leaves the screen when the owner confirms and comes back at once on Undo. A
paused, undone, conflicting or uncertain deletion, or a queued one whose
clock changed, hides nothing: the list shows what the provider holds.

```quint
pure def hiddenFromList(phase: DeletionPhase, windowState: WindowState): bool = phase == Queued and windowState != ClockChanged
pure def lawOnlyAPendingClaimHidesItsRecord(entry: PendingDeletion, later: DeletionClock): bool =
  hiddenFromList(entry.deletionPhase, deletionWindow(entry.deadline, later)) implies
    (entry.deletionPhase == Queued and (claimDeletion(entry, entry.owner, later, ClaimUndo).won or claimDeletion(entry, entry.owner, later, ClaimDispatch).won))
pure def lawUndoShowsTheRecordAgain(entry: PendingDeletion, later: DeletionClock, after: DeletionClock): bool = {
  val undone = claimDeletion(entry, entry.owner, later, ClaimUndo)
  undone.won implies not(hiddenFromList(undone.claimed.deletionPhase, deletionWindow(entry.deadline, after)))
}
```
