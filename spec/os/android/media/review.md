# Android permitted media review

The native media bridge changes a photo or video it does not own (a
favorite, a move to or from Recently deleted, a permanent deletion of a
trashed item, or the replacement of an edited original) only after two
approvals: a native dialog that names every selected item, then Android's
own MediaStore write request. The Photos flag and batch calls, the
selected permanent deletion, the agent's reviewed change request and the
editor's Replace control all share this one launcher
(`PermittedMediaReview.java` in `plugins/plugin-native-media`). The
dialog, the activity launcher, the lifecycle observers and the provider
calls stay in the shell; this spec owns the decisions. Tokens and the
guarded row ladder come from [media rows](./rows.md). The agent's view
receipts in [device actions](../../../agent/deviceActions/index.md) hand a
selection to this review; where they differ on the deadline, this spec's
inclusive rule is the native one and wins. [Photo replacement](./photoReplace.md)
owns what happens after a Replace grant.

## Story: Change a photo only after I approve it

> As the person, I want to see exactly which items a change will touch
> before Android asks me to allow it, so that I never approve more than I
> reviewed.

### A review admits only one valid selection at a time

A selection names one change and 1 to its entry's limit of distinct items,
each with a nonempty key and the revision the person saw listed, each fit
for the change: favoriting and unfavoriting need an item not in Recently
deleted, a permanent deletion needs one that is, and Replace needs one
untrashed still photo. A single Photos flag call and the editor's Replace
take one item; the agent's request takes up to 20 and may only favorite,
unfavorite or move to Recently deleted; a Photos batch takes up to 500, or
20 for a permanent deletion. No entry takes an empty selection as
authority over the whole trash. A second review while one is open, or any
review after the launcher closed, is refused as busy or closed. The shell
then reads every row at its listed revision (`rowsCurrent`); a changed or
unreadable row ends the review as stale. Each admitted review gets a fresh
id and lives `tokenLifetimeMs` (two minutes) on the monotonic clock.

```quint
import rows.* from "./rows"
type MediaChange = Favorite | Unfavorite | MoveToTrash | Restore | DeleteForever | ReplaceOriginal
type ReviewEntry = SinglePhoto | PhotoBatch | AgentRequest | EditorReplace
type ReviewItem = { key: str, revision: str, trashed: bool, video: bool }
type Selection = { change: MediaChange, entry: ReviewEntry, items: List[ReviewItem] }
type ReviewTicket = { token: OneShotToken, selection: Selection }
type ReviewPhase = Idle | OwnerConfirming(ReviewTicket) | AndroidConfirming(ReviewTicket)
type ReviewReply = ReplyNone | ReplyStale | ReplyDeclined | ReplyLaunchFailed | ReplyClosed | ReplyDispatched
type PermittedReview = { now: int, nextId: int, closed: bool, phase: ReviewPhase,
  awaitingResume: List[ReviewTicket], workQueue: List[ReviewTicket], reply: ReviewReply }
pure val initial: PermittedReview = { now: 0, nextId: 1, closed: false, phase: Idle,
  awaitingResume: List(), workQueue: List(), reply: ReplyNone }
pure def isFlagChange(change: MediaChange): bool =
  change == Favorite or change == Unfavorite or change == MoveToTrash or change == Restore
pure def entryAllows(entry: ReviewEntry, change: MediaChange): bool =
  if (entry == EditorReplace) change == ReplaceOriginal
  else if (entry == AgentRequest) change == Favorite or change == Unfavorite or change == MoveToTrash
  else if (entry == SinglePhoto) isFlagChange(change)
  else isFlagChange(change) or change == DeleteForever
pure def entryLimit(entry: ReviewEntry, change: MediaChange): int =
  if (entry == SinglePhoto or entry == EditorReplace) 1
  else if (entry == AgentRequest or change == DeleteForever) 20 else 500
pure def itemFits(change: MediaChange, candidate: ReviewItem): bool =
  candidate.key != "" and candidate.revision != "" and
    (if (change == Favorite or change == Unfavorite) not(candidate.trashed)
     else if (change == DeleteForever) candidate.trashed
     else if (change == ReplaceOriginal) not(candidate.trashed or candidate.video) else true)
pure def validSelection(selection: Selection): bool =
  entryAllows(selection.entry, selection.change) and selection.items.length() >= 1 and
    selection.items.length() <= entryLimit(selection.entry, selection.change) and
    selection.items.every(i => itemFits(selection.change, i)) and
    selection.items.every(i => selection.items.select(o => o.key == i.key).length() == 1)
pure def canBeginReview(s: PermittedReview, selection: Selection): bool =
  not(s.closed) and s.phase == Idle and validSelection(selection)
pure val gardenPhoto: ReviewItem = { key: "m:external_primary:i:7", revision: "r1", trashed: false, video: false }
pure val porchPhoto: ReviewItem = { ...gardenPhoto, key: "m:external_primary:i:8", revision: "r2" }
pure val favoritePair: Selection = { change: Favorite, entry: PhotoBatch, items: List(gardenPhoto, porchPhoto) }
pure val selectionValues = Set(favoritePair, { ...favoritePair, change: MoveToTrash, entry: SinglePhoto, items: List(gardenPhoto) },
  { ...favoritePair, change: DeleteForever, items: List({ ...gardenPhoto, trashed: true }) },
  { ...favoritePair, change: ReplaceOriginal, entry: EditorReplace, items: List(porchPhoto) },
  { ...favoritePair, change: Restore, entry: AgentRequest }, { ...favoritePair, items: List() },
  { ...favoritePair, items: List(gardenPhoto, gardenPhoto) })
```

### The owner confirms the named items before Android is asked, except for an editor Replace

The first presentation needs the window to have focus, or the review is
declined. The native dialog then names every item; Continue launches
Android's write request, Cancel or dismissal declines. The editor's
Replace control is already the owner's review, so a Replace goes straight
to Android's request. A launch Android refuses (the activity closed) ends
the review without a grant.

```quint
pure def beginReview(s: PermittedReview, selection: Selection, rowsCurrent: bool, focused: bool, launched: bool): PermittedReview = {
  val token: OneShotToken = { id: s.nextId, until: s.now + tokenLifetimeMs }
  val issued = { ...s, nextId: s.nextId + 1 }
  if (not(rowsCurrent)) { ...issued, reply: ReplyStale }
  else if (not(focused)) { ...issued, reply: ReplyDeclined }
  else if (selection.change != ReplaceOriginal) { ...issued, phase: OwnerConfirming({ token: token, selection: selection }), reply: ReplyNone }
  else if (launched) { ...issued, phase: AndroidConfirming({ token: token, selection: selection }), reply: ReplyNone }
  else { ...issued, reply: ReplyLaunchFailed }
}
pure def ownerConfirming(phase: ReviewPhase): bool = match phase { | OwnerConfirming(_) => true | _ => false }
pure def askingAndroid(phase: ReviewPhase): bool = match phase { | AndroidConfirming(_) => true | _ => false }
pure def androidChange(phase: ReviewPhase): MediaChange = match phase { | AndroidConfirming(t) => t.selection.change | _ => Favorite }
pure def canAnswerOwner(s: PermittedReview): bool = ownerConfirming(s.phase)
pure def answerOwner(s: PermittedReview, allowed: bool, launched: bool): PermittedReview = {
  val phase = s.phase
  match phase {
  | OwnerConfirming(t) =>
    if (not(allowed) or s.now > t.token.until) { ...s, phase: Idle, reply: ReplyDeclined }
    else if (launched) { ...s, phase: AndroidConfirming({ token: t.token, selection: t.selection }) }
    else { ...s, phase: Idle, reply: ReplyLaunchFailed }
  | _ => s
  }
}
pure def stepAndroidIsAskedOnlyAfterLocalConfirmation(before: PermittedReview, via: str, after: PermittedReview): bool =
  (askingAndroid(after.phase) and not(askingAndroid(before.phase))) implies
    (via == "answerOwner" or (via == "beginReview" and androidChange(after.phase) == ReplaceOriginal))
pure def sometimesOwnerReviewsTheItems(s: PermittedReview): bool = ownerConfirming(s.phase)
pure def sometimesReplaceAsksAndroidDirectly(s: PermittedReview): bool =
  askingAndroid(s.phase) and androidChange(s.phase) == ReplaceOriginal
```

### Work is queued only for an Android grant that arrives while the review is live

The deadline is inclusive: a review is live while `now <= until`, as the
native `until < now` expiry test reads. Android's result frees the launcher
slot at once. A refusal, a closed launcher or an expired review dispatches
nothing. A grant reaches the worker at once if the activity is resumed;
otherwise its ticket waits for that activity's resume. A resume checks the
deadline and closure again; a destroy before resume ends it as closed.
Every queued ticket carries the selection the owner approved, unchanged.

```quint
pure def ticketLive(t: ReviewTicket, now: int): bool = now <= t.token.until
pure val unusedTicket: ReviewTicket = { token: { id: 0, until: 0 }, selection: { ...favoritePair, items: List() } }
pure def canReceiveAndroidResult(s: PermittedReview): bool = askingAndroid(s.phase)
pure def receiveAndroidResult(s: PermittedReview, granted: bool, resumed: bool): PermittedReview = {
  val phase = s.phase
  match phase {
  | AndroidConfirming(t) =>
    if (not(granted) or s.now > t.token.until) { ...s, phase: Idle, reply: ReplyDeclined }
    else if (resumed) { ...s, phase: Idle, reply: ReplyDispatched,
      workQueue: s.workQueue.append({ token: t.token, selection: t.selection }) }
    else { ...s, phase: Idle, reply: ReplyNone, awaitingResume: s.awaitingResume.append({ token: t.token, selection: t.selection }) }
  | _ => s
  }
}
pure def canSettleResume(s: PermittedReview, reviewId: int): bool = s.awaitingResume.some(t => t.token.id == reviewId)
pure def settleResume(s: PermittedReview, reviewId: int, destroyed: bool): PermittedReview = {
  val ticket = s.awaitingResume.select(t => t.token.id == reviewId).nthOr(0, unusedTicket)
  val released = { ...s, awaitingResume: s.awaitingResume.select(t => t.token.id != reviewId) }
  if (destroyed) { ...released, reply: ReplyClosed }
  else if (s.closed or not(ticketLive(ticket, s.now))) { ...released, reply: ReplyDeclined }
  else { ...released, reply: ReplyDispatched, workQueue: s.workQueue.append(ticket) }
}
pure def canTakeWork(s: PermittedReview): bool = s.workQueue.length() > 0
pure def takeWork(s: PermittedReview): PermittedReview = { ...s, workQueue: s.workQueue.removeAt(0) }
pure def canAdvanceClock(s: PermittedReview, observedClock: int): bool = observedClock > s.now
pure def advanceClock(s: PermittedReview, observedClock: int): PermittedReview = { ...s, now: observedClock }
pure def stepWorkIsQueuedOnlyForALiveGrant(before: PermittedReview, via: str, after: PermittedReview): bool =
  after.workQueue.length() > before.workQueue.length() implies
    ((via == "receiveAndroidResult" or via == "settleResume") and not(before.closed) and
      ticketLive(after.workQueue.nthOr(after.workQueue.length() - 1, unusedTicket), before.now))
pure def phaseSelectionValid(phase: ReviewPhase): bool = match phase {
  | OwnerConfirming(t) => validSelection(t.selection)
  | AndroidConfirming(t) => validSelection(t.selection)
  | _ => true
}
pure def alwaysHeldSelectionsWereAdmitted(s: PermittedReview): bool =
  phaseSelectionValid(s.phase) and s.awaitingResume.every(t => validSelection(t.selection)) and
    s.workQueue.every(t => validSelection(t.selection))
pure val reviewIdValues = Set(1, 2, 3)
pure val observedClockValues = Set(1, 120000, 120001, 240002)
pure val weight_beginReview = 8
pure val weight_answerOwner = 8
pure val weight_receiveAndroidResult = 8
pure val weight_settleResume = 6
pure def sometimesGrantDispatched(s: PermittedReview): bool = s.reply == ReplyDispatched and s.workQueue.length() > 0
pure def sometimesTwoApprovalsWaitForResume(s: PermittedReview): bool = s.awaitingResume.length() >= 2
```

### A resume leaves the newer review that holds the launcher alone

A later review may occupy the freed slot while earlier approvals still
wait for resume; each settles on its own observer's callback.

```quint
pure def stepResumeKeepsTheNewerReview(before: PermittedReview, via: str, after: PermittedReview): bool =
  via == "settleResume" implies (after.phase == before.phase and after.nextId == before.nextId)
pure def sometimesApprovalWaitsBesideANewerReview(s: PermittedReview): bool =
  s.awaitingResume.length() > 0 and s.phase != Idle
```

### Closing the launcher ends the open review and opens no other

Closing declines the review that holds the slot and unregisters the
launcher. Approvals already waiting still settle on their own resume or
destroy, and are then declined.

```quint
pure def canCloseReview(s: PermittedReview): bool = not(s.closed)
pure def closeReview(s: PermittedReview): PermittedReview =
  { ...s, closed: true, phase: Idle, reply: if (s.phase == Idle) s.reply else ReplyClosed }
pure def alwaysClosedReviewShowsNoDialog(s: PermittedReview): bool = s.closed implies s.phase == Idle
```

## Story: Report only the rows that still match what I approved

> As the person, I want a change to touch, and report changed, only the
> items that still match what I approved, so that a reply never claims
> more than happened.

### A row is reported changed only by a live review through the guarded row ladder

The worker takes the queued ticket and walks its rows in the selection's
order. Before each row it checks closure and the deadline again; a stopped
review marks the row unverified. Otherwise the row goes through the
[row ladder](./rows.md): read at its listed revision, a predicated write,
a readback. A Replace ticket runs its continuation instead
([photo replacement](./photoReplace.md)).

```quint
pure def reviewStopped(closed: bool, now: int, t: ReviewTicket): bool = closed or not(ticketLive(t, now))
pure def itemOutcome(stopped: bool, ladder: RowLadder): RowOutcome = if (stopped) RowUnverified else rowOutcome(ladder)
pure def lawVerifiedRowWasLiveAtItsRevision(stopped: bool, ladder: RowLadder): bool =
  rowVerified(itemOutcome(stopped, ladder)) implies (not(stopped) and rowAtListing(ladder.inspection))
```

### A reply claims success only when every row is verified

A single Photos call resolves with its item only when that one row is
verified, and is rejected otherwise. A batch is `complete` only when every
row is verified and `partial` otherwise, with each row's own outcome. So a
review that stopped before its rows reports nothing changed.

```quint
type ReviewResult = SingleChanged | SingleRejected | BatchComplete | BatchPartial
pure def reviewResult(entry: ReviewEntry, outcomes: List[RowOutcome]): ReviewResult =
  if (entry == SinglePhoto) { if (outcomes.length() == 1 and rowsComplete(outcomes)) SingleChanged else SingleRejected }
  else if (rowsComplete(outcomes)) BatchComplete else BatchPartial
pure val laddersValues = Set(List(exactRowWrite), List(exactRowWrite, { ...exactRowWrite, inspection: RowChangedSinceListing }),
  List({ ...exactRowWrite, readbackConfirmed: false }))
pure def lawStoppedReviewReportsNothingChanged(entry: ReviewEntry, ladders: List[RowLadder]): bool =
  ladders.length() > 0 implies
    (reviewResult(entry, ladders.listMap(l => itemOutcome(true, l))) == SingleRejected or
      reviewResult(entry, ladders.listMap(l => itemOutcome(true, l))) == BatchPartial)
```
