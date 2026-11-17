# Deferred deletion journal

The native journal that keeps each reviewed deletion of a device record (a
calendar event or a reminder occurrence) through its
[deletion window](./deletionWindow.md), imported as `W`: it stages the row,
decides between Undo and the provider write with `W::claimDeletion`, starts
the provider call at most once and keeps the outcome. It models
`DeferredDeletionJournal` and `DeferredDeletionCoordinator` of
`plugins/plugin-native-action-journal/android` and its Quint model
`DeletionOwnerAdmission.qnt`.

The shell holds the journal in one slot whose save commits atomically or
throws, and serializes every event under one lock. It authenticates the
owner before it takes the lock and passes that owner as the sender. An owner
is a stable identity key: the manual installation, or the agent's subject
user, agent, installation, enrollment, account and environment, so a
rotated session keeps the same owner. The target is the shell's canonical
encoding of the reviewed record, so two equal JSON objects in another key
order are one target. The shell checks the operation ID (1 to 128 ASCII
letters, digits, `_` or `-`), the clock, the 3 MiB limit on the encoded
journal and the 1,000 dismissal marks; the reminder store keeps its own
occurrence effects.

## Story: Keep one winner between Undo and the provider

> As an owner, I want Undo and the provider write to race safely, so that a
> deletion I undid never reaches the provider and a deletion that went ahead
> is never reported as kept.

### Only the owner's exact replay of a staged deletion returns its row

Staging needs the owner's current review fence and a usable review clock.
The same ID with the same owner, kind and target returns the existing row
unchanged, whatever its phase; any other staging of a known ID is refused.
A new ID is refused once the journal holds 500 rows.

```quint
import deletionWindow as W from "./deletionWindow"
type DeletionKind = CalendarEvent | ReminderOccurrence
type DeletionHold = NotHeld | HeldOwnerChanged | HeldOwnerUnavailable | HeldProviderDeclined | HeldPermissionRefused
type DeletionRow = { id: str, kind: DeletionKind, target: str, entry: W::PendingDeletion, hold: DeletionHold, providerCalls: int, dismissed: bool }
type DeletionJournal = { rows: List[DeletionRow] }
type FenceRead = FenceCurrent | FenceStale | FenceUnreadable
type StageDecision = StageNew | ReplayRow | RefuseIdentity | RefuseFull
pure val maxRows = 500
pure val initial: DeletionJournal = { rows: List() }
pure val noRow: DeletionRow = { id: "", kind: CalendarEvent, target: "", entry: { owner: "", deadline: W::deletionDeadline({ continuity: "", elapsed: 0, wall: 0 }), deletionPhase: W::Deleted }, hold: NotHeld, providerCalls: 0, dismissed: false }
pure def hasRow(rows: List[DeletionRow], id: str): bool = rows.some(r => r.id == id)
pure def rowOf(rows: List[DeletionRow], id: str): DeletionRow = rows.select(r => r.id == id).nthOr(0, noRow)
pure def replaceRow(rows: List[DeletionRow], row: DeletionRow): List[DeletionRow] = rows.listMap(r => if (r.id == row.id) row else r)
pure def stageDecision(rows: List[DeletionRow], by: str, id: str, kind: DeletionKind, target: str): StageDecision = {
  val prior = rowOf(rows, id)
  if (not(hasRow(rows, id))) (if (rows.length() < maxRows) StageNew else RefuseFull)
  else if (prior.entry.owner == by and prior.kind == kind and prior.target == target) ReplayRow
  else RefuseIdentity
}
pure def canStage(s: DeletionJournal, by: str, id: str, kind: DeletionKind, target: str, clock: W::DeletionClock, fence: FenceRead): bool =
  by != "" and id != "" and target != "" and fence == FenceCurrent and W::clockUsable(clock) and
  (stageDecision(s.rows, by, id, kind, target) == StageNew or stageDecision(s.rows, by, id, kind, target) == ReplayRow)
pure def stage(s: DeletionJournal, by: str, id: str, kind: DeletionKind, target: str, clock: W::DeletionClock, fence: FenceRead): DeletionStep = {
  val row = { id: id, kind: kind, target: target, entry: { owner: by, deadline: W::deletionDeadline(clock), deletionPhase: W::Queued }, hold: NotHeld, providerCalls: 0, dismissed: false }
  { state: if (hasRow(s.rows, id)) s else { rows: s.rows.append(row) }, out: List() }
}
pure def lawReplayNeedsTheExactIdentity(row: DeletionRow, by: str, kind: DeletionKind, target: str): bool =
  (stageDecision(List(row), by, row.id, kind, target) == ReplayRow) iff (by == row.entry.owner and kind == row.kind and target == row.target)
pure def stepStagingNeverChangesAStagedRow(before: DeletionJournal, via: str, after: DeletionJournal): bool =
  via == "stage" implies before.rows.every(r => after.rows.includes(r))
pure def alwaysEachIdNamesOneRow(s: DeletionJournal): bool =
  s.rows.every(r => r.id != "" and s.rows.select(x => x.id == r.id).length() == 1)
pure def sometimesTwoDeletionsStaged(s: DeletionJournal): bool = s.rows.length() >= 2
pure val byValues = Set("owner1", "owner2")
pure val ownerValues = byValues
pure val idValues = Set("op1", "op2")
pure val targetValues = Set("event1", "event2")
pure val clockValues: Set[W::DeletionClock] = List(
  { continuity: "boot1", elapsed: 0, wall: 100 },
  { continuity: "boot1", elapsed: 5000, wall: 5100 },
  { continuity: "boot1", elapsed: 10000, wall: 10100 },
  { continuity: "boot1", elapsed: 86410000, wall: 86410100 },
  { continuity: "boot2", elapsed: 20000, wall: 20100 }
).foldl(Set(), (acc, c) => acc.union(Set(c)))
```

### The provider is called at most once, and only through a won dispatch claim

At expiry the journal decides with the owner the shell read and the
provider's admission of the target. Only a decision to dispatch claims the
row with `W::claimDeletion`; the claim moves it to `Dispatching` and asks the
shell for the one provider call, which the shell starts only after it has
saved that phase. The call's readback settles the row: deleted, conflict,
an explicit permission refusal (the row pauses) or, for a null, unexpected
or failed readback, an unknown outcome. A row left dispatching by a lost
process reads as uncertain and is never claimed or called again.

```quint
type OwnerRead = OwnerAt({ owner: str, fence: FenceRead }) | OwnerUnreadable
type ProviderAdmission = ProviderAdmits | ProviderDeclines
type ExpiryDecision = AwaitOwner | PauseDeletion({ hold: DeletionHold }) | DispatchDeletion
type ProviderOutcome = OutcomeDeleted | OutcomeConflict | OutcomePermissionRefused | OutcomeUncertain
type ProviderRequest = DeleteFromProvider({ id: str })
type DeletionStep = { state: DeletionJournal, out: List[ProviderRequest] }
pure def canExpire(s: DeletionJournal, id: str, clock: W::DeletionClock, authority: OwnerRead, admission: ProviderAdmission): bool = {
  val row = rowOf(s.rows, id)
  hasRow(s.rows, id) and row.entry.deletionPhase == W::Queued and W::deletionWindow(row.entry.deadline, clock) == W::WindowExpired and
  expiryDecision(row, clock, authority, admission) != AwaitOwner
}
pure def expire(s: DeletionJournal, id: str, clock: W::DeletionClock, authority: OwnerRead, admission: ProviderAdmission): DeletionStep = {
  val row = rowOf(s.rows, id)
  val claim = W::claimDeletion(row.entry, row.entry.owner, clock, W::ClaimDispatch)
  val decision = expiryDecision(row, clock, authority, admission)
  match decision {
    | DispatchDeletion => { state: { rows: replaceRow(s.rows, { ...row, entry: claim.claimed, providerCalls: row.providerCalls + 1 }) }, out: List(DeleteFromProvider({ id: id })) }
    | PauseDeletion(p) => { state: { rows: replaceRow(s.rows, { ...row, entry: { ...row.entry, deletionPhase: W::Paused }, hold: p.hold }) }, out: List() }
    | AwaitOwner => { state: s, out: List() }
  }
}
pure def canRecordOutcome(s: DeletionJournal, id: str): bool =
  hasRow(s.rows, id) and rowOf(s.rows, id).entry.deletionPhase == W::Dispatching
pure def recordOutcome(s: DeletionJournal, id: str, readback: ProviderOutcome): DeletionStep = {
  val row = rowOf(s.rows, id)
  val nextRow = match readback {
    | OutcomeDeleted => { ...row, entry: { ...row.entry, deletionPhase: W::Deleted } }
    | OutcomeConflict => { ...row, entry: { ...row.entry, deletionPhase: W::DeletionConflict } }
    | OutcomePermissionRefused => { ...row, entry: { ...row.entry, deletionPhase: W::Paused }, hold: HeldPermissionRefused }
    | OutcomeUncertain => { ...row, entry: { ...row.entry, deletionPhase: W::UnknownOutcome } }
  }
  { state: { rows: replaceRow(s.rows, nextRow) }, out: List() }
}
pure def calledPhase(phase: W::DeletionPhase): bool =
  phase == W::Dispatching or phase == W::Deleted or phase == W::DeletionConflict or phase == W::UnknownOutcome
pure def alwaysProviderCalledAtMostOnceAfterAClaim(s: DeletionJournal): bool =
  s.rows.every(r => r.providerCalls >= 0 and r.providerCalls <= 1 and (calledPhase(r.entry.deletionPhase) implies r.providerCalls == 1) and
    (r.entry.deletionPhase == W::Queued implies (r.providerCalls == 0 and r.hold == NotHeld)) and
    (r.entry.deletionPhase == W::Paused implies r.hold != NotHeld))
pure def requestedId(request: ProviderRequest): str = match request { | DeleteFromProvider(d) => d.id }
pure def stepOnlyAClaimAsksForTheProvider(before: DeletionJournal, via: str, after: DeletionJournal, out: List[ProviderRequest]): bool =
  out.length() > 0 implies (via == "expire" and out.length() == 1 and
    out.every(o => rowOf(before.rows, requestedId(o)).entry.deletionPhase == W::Queued and rowOf(after.rows, requestedId(o)).entry.deletionPhase == W::Dispatching))
pure def sometimesProviderDeleted(s: DeletionJournal): bool = s.rows.some(r => r.entry.deletionPhase == W::Deleted)
pure def sometimesUncertainReadbackKept(s: DeletionJournal): bool = s.rows.some(r => r.entry.deletionPhase == W::UnknownOutcome)
pure val authorityValues = Set(OwnerUnreadable, OwnerAt({ owner: "owner1", fence: FenceCurrent }), OwnerAt({ owner: "owner1", fence: FenceStale }),
  OwnerAt({ owner: "owner1", fence: FenceUnreadable }), OwnerAt({ owner: "owner2", fence: FenceCurrent }))
pure val weight_expire = 4
pure val weight_recordOutcome = 3
```

### A paused or undone row keeps a provider call only after an explicit permission refusal

Undo is the owner's claim through `W::claimDeletion`: a queued row while its
window is open or its clock changed, a paused row at any time. A paused or
undone row keeps a provider call only when that call returned an explicit
permission refusal, which deletes nothing. A repeated Undo of an undone row
reads its receipt and writes nothing.

```quint
pure def canUndo(s: DeletionJournal, by: str, id: str, clock: W::DeletionClock): bool =
  hasRow(s.rows, id) and W::claimDeletion(rowOf(s.rows, id).entry, by, clock, W::ClaimUndo).won
pure def undo(s: DeletionJournal, by: str, id: str, clock: W::DeletionClock): DeletionStep = {
  val row = rowOf(s.rows, id)
  { state: { rows: replaceRow(s.rows, { ...row, entry: W::claimDeletion(row.entry, by, clock, W::ClaimUndo).claimed }) }, out: List() }
}
pure def alwaysKeptRowsHoldOnlyARefusedCall(s: DeletionJournal): bool =
  s.rows.every(r => ((r.entry.deletionPhase == W::Paused or r.entry.deletionPhase == W::Undone) implies (r.providerCalls == 0 or r.hold == HeldPermissionRefused)) and
    (r.hold == HeldPermissionRefused implies (r.providerCalls == 1 and (r.entry.deletionPhase == W::Paused or r.entry.deletionPhase == W::Undone))))
pure def sometimesUndoneBeforeAnyCall(s: DeletionJournal): bool = s.rows.some(r => r.entry.deletionPhase == W::Undone and r.providerCalls == 0)
pure def sometimesUndoneAfterPermissionRefusal(s: DeletionJournal): bool = s.rows.some(r => r.entry.deletionPhase == W::Undone and r.hold == HeldPermissionRefused)
```

## Story: Respect the owner when the session changes

> As an owner, I want a deletion to go ahead only for me, so that a changed
> or unreadable session pauses it instead of deleting, and an uncertain
> result stays on record until I dismiss it.

### Authentication precedes mutation and unreadable authority never dispatches

The shell reads the owner and its review fence before it takes the lock.
Only the row's owner with a current fence and a provider that admits the
target dispatches. A changed owner pauses without reading the old fence; a
stale fence pauses as changed. An unreadable owner waits and is retried for
24 hours after expiry, then pauses as unavailable. An unreadable fence
pauses a calendar row as unavailable and leaves a reminder row queued for a
retry. A declined target pauses. The manual installation is always read,
with a current fence.

```quint
pure val ownerRetryMs = 86400000
pure def expiryDecision(row: DeletionRow, clock: W::DeletionClock, authority: OwnerRead, admission: ProviderAdmission): ExpiryDecision =
  match authority {
    | OwnerUnreadable => if (clock.elapsed - row.entry.deadline.expiresElapsed < ownerRetryMs) AwaitOwner else PauseDeletion({ hold: HeldOwnerUnavailable })
    | OwnerAt(a) =>
      if (a.owner != row.entry.owner or a.fence == FenceStale) PauseDeletion({ hold: HeldOwnerChanged })
      else if (a.fence == FenceUnreadable) (if (row.kind == CalendarEvent) PauseDeletion({ hold: HeldOwnerUnavailable }) else AwaitOwner)
      else if (admission == ProviderDeclines) PauseDeletion({ hold: HeldProviderDeclined })
      else if (W::claimDeletion(row.entry, a.owner, clock, W::ClaimDispatch).won) DispatchDeletion
      else AwaitOwner
  }
pure def lawDispatchNeedsTheCurrentOwnerAndAWonClaim(row: DeletionRow, clock: W::DeletionClock, authority: OwnerRead, admission: ProviderAdmission): bool =
  expiryDecision(row, clock, authority, admission) == DispatchDeletion implies
    (authority == OwnerAt({ owner: row.entry.owner, fence: FenceCurrent }) and admission == ProviderAdmits and
     W::claimDeletion(row.entry, row.entry.owner, clock, W::ClaimDispatch).won)
pure def lawChangedOwnerPausesWithoutItsFence(row: DeletionRow, clock: W::DeletionClock, owner: str, fence: FenceRead, admission: ProviderAdmission): bool =
  owner != row.entry.owner implies expiryDecision(row, clock, OwnerAt({ owner: owner, fence: fence }), admission) == PauseDeletion({ hold: HeldOwnerChanged })
pure def lawUnreadableAuthorityNeverDispatches(row: DeletionRow, clock: W::DeletionClock, admission: ProviderAdmission): bool =
  expiryDecision(row, clock, OwnerUnreadable, admission) != DispatchDeletion and
  expiryDecision(row, clock, OwnerAt({ owner: row.entry.owner, fence: FenceUnreadable }), admission) != DispatchDeletion
pure def sometimesPausedForAChangedOwner(s: DeletionJournal): bool = s.rows.some(r => r.entry.deletionPhase == W::Paused and r.hold == HeldOwnerChanged)
pure def sometimesPausedForAnUnavailableOwner(s: DeletionJournal): bool = s.rows.some(r => r.entry.deletionPhase == W::Paused and r.hold == HeldOwnerUnavailable)
pure val rowValues: Set[DeletionRow] = List(
  { ...noRow, id: "op1", target: "event1", entry: { owner: "owner1", deadline: W::deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: W::Queued } },
  { ...noRow, id: "op1", kind: ReminderOccurrence, target: "event1", entry: { owner: "owner1", deadline: W::deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: W::Queued } },
  { ...noRow, id: "op2", target: "event2", entry: { owner: "owner2", deadline: W::deletionDeadline({ continuity: "boot1", elapsed: 5000, wall: 5100 }), deletionPhase: W::Queued } },
  { ...noRow, id: "op2", target: "event2", hold: HeldOwnerChanged, entry: { owner: "owner1", deadline: W::deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: W::Paused } },
  { ...noRow, id: "op1", target: "event1", providerCalls: 1, entry: { owner: "owner1", deadline: W::deletionDeadline({ continuity: "boot1", elapsed: 0, wall: 100 }), deletionPhase: W::Dispatching } }
).foldl(Set(), (acc, r) => acc.union(Set(r)))
pure val fenceValues = Set(FenceCurrent, FenceStale, FenceUnreadable)
```

### An uncertain outcome is dismissed only by its owner and stays on record

Dismissal hides the notice of a dispatching or unknown row for its owner and
changes nothing else: the row keeps its phase and its one provider call, and
an unknown row is never claimed, called or retired.

```quint
pure def canDismiss(s: DeletionJournal, by: str, id: str): bool = {
  val row = rowOf(s.rows, id)
  hasRow(s.rows, id) and row.entry.owner == by and not(row.dismissed) and
  (row.entry.deletionPhase == W::Dispatching or row.entry.deletionPhase == W::UnknownOutcome)
}
pure def dismiss(s: DeletionJournal, by: str, id: str): DeletionStep =
  { state: { rows: replaceRow(s.rows, { ...rowOf(s.rows, id), dismissed: true }) }, out: List() }
pure def alwaysOnlyACalledRowIsDismissed(s: DeletionJournal): bool = s.rows.every(r => r.dismissed implies r.providerCalls == 1)
pure def stepDismissalKeepsTheReceipt(before: DeletionJournal, via: str, after: DeletionJournal): bool =
  via == "dismiss" implies before.rows.every(r => after.rows.includes(r) or after.rows.includes({ ...r, dismissed: true }))
pure def sometimesUncertainOutcomeDismissed(s: DeletionJournal): bool = s.rows.some(r => r.dismissed and r.entry.deletionPhase == W::UnknownOutcome)
```

### Retention retires only settled rows

When a new review is staged, the shell retires the oldest deleted, undone or
conflict rows (by wall expiry, then review time) beyond the newest 127, and
more while the journal is full or over its byte limit. Queued, paused,
dispatching and unknown rows are never retired, so their identities and
receipts stay.

```quint
pure def settledPhase(phase: W::DeletionPhase): bool = phase == W::Deleted or phase == W::Undone or phase == W::DeletionConflict
pure def canRetire(s: DeletionJournal, id: str): bool = hasRow(s.rows, id) and settledPhase(rowOf(s.rows, id).entry.deletionPhase)
pure def retire(s: DeletionJournal, id: str): DeletionStep = { state: { rows: s.rows.select(r => r.id != id) }, out: List() }
pure def stepRetentionKeepsUnresolvedRows(before: DeletionJournal, after: DeletionJournal): bool =
  before.rows.every(r => settledPhase(r.entry.deletionPhase) or after.rows.some(x => x.id == r.id))
```
