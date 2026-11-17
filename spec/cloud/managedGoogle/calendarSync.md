# Managed calendar sync

The managed Google host keeps a synced copy of a chosen calendar for the
owner's agent. The first run lists the calendar in full; later runs fetch
only what changed since a sync cursor the provider issued with the last page
of the previous run. A run's pages become visible together, with their new
cursor, or not at all. When the provider says the cursor is no longer valid,
the next run lists everything again and replaces the copy. One calendar's
copy and cursor are the state machine. Which calendar may be read, and under
which grant, is [managed calendar reads](./calendarRead.md).

## Story: Keep a synced calendar current with one cursor

> As an owner, I want my agent's copy of a calendar to follow every change
> once and only once, and to start over cleanly when the provider no longer
> accepts where it left off.

### A run starts from the committed cursor, or lists everything when there is none

A run starts only while the owner's grant holds. With no committed cursor it
lists the whole calendar; with one, it fetches only the changes since that
cursor.

```quint
type SyncPhase = SyncIdle | FullSync | IncrementalSync
type CalendarSync = { phase: SyncPhase, grantCurrent: bool, cursor: int, stagedPages: int, copyPresent: bool, copyEpoch: int, needsReplace: bool, commits: int }
pure val initial: CalendarSync = { phase: SyncIdle, grantCurrent: true, cursor: 0, stagedPages: 0, copyPresent: false, copyEpoch: 0, needsReplace: false, commits: 0 }
pure def canStartSync(c: CalendarSync): bool = c.phase == SyncIdle and c.grantCurrent
pure def startSync(c: CalendarSync): CalendarSync = { ...c, phase: if (c.cursor > 0) IncrementalSync else FullSync, stagedPages: 0 }
pure def alwaysIncrementalRunHasACursor(c: CalendarSync): bool = c.phase == IncrementalSync implies c.cursor > 0
pure def alwaysCursorBelongsToACopy(c: CalendarSync): bool = c.cursor > 0 implies c.copyPresent
pure def sometimesIncrementalRun(c: CalendarSync): bool = c.phase == IncrementalSync and c.stagedPages > 0
```

### A run's pages and its new cursor become visible together

Each page of a run is staged under the grant that started it. Only the last
page carries the next cursor, and it commits the run: a full listing
replaces the copy, an incremental run patches it, and the cursor advances in
the same step. A failed run commits nothing and leaves the cursor where it
was, so its changes are fetched again.

```quint
pure def canFetchPage(c: CalendarSync, lastPage: bool, nextCursor: int): bool =
  (c.phase == FullSync or c.phase == IncrementalSync) and c.grantCurrent and (lastPage implies nextCursor > 0)
pure def fetchPage(c: CalendarSync, lastPage: bool, nextCursor: int): CalendarSync =
  if (not(lastPage)) { ...c, stagedPages: c.stagedPages + 1 }
  else { ...c, phase: SyncIdle, stagedPages: 0, cursor: nextCursor, copyPresent: true, copyEpoch: if (c.phase == FullSync) c.copyEpoch + 1 else c.copyEpoch, needsReplace: false, commits: c.commits + 1 }
pure def canFailRun(c: CalendarSync): bool = c.phase == FullSync or c.phase == IncrementalSync
pure def failRun(c: CalendarSync): CalendarSync = { ...c, phase: SyncIdle, stagedPages: 0 }
pure val nextCursorValues = Set(0, 1, 2, 3)
pure def alwaysStagedPagesBelongToARun(c: CalendarSync): bool = c.phase == SyncIdle implies c.stagedPages == 0
pure def stepCursorAdvancesOnlyWithACommit(before: CalendarSync, after: CalendarSync): bool =
  (after.cursor != before.cursor and after.cursor != 0) implies (after.commits == before.commits + 1 and before.phase != SyncIdle)
pure def stepCopyReplacedOnlyByAFullListing(before: CalendarSync, after: CalendarSync): bool = after.copyEpoch != before.copyEpoch implies before.phase == FullSync
pure def sometimesIncrementalCommitAfterFullListing(c: CalendarSync): bool = c.commits == 2 and c.copyEpoch == 1
pure val weight_fetchPage = 3
```

### An expired cursor makes the next run list everything and replace the copy

When the provider refuses the cursor as expired, the run discards its staged
pages and the cursor, and the next run is a full listing whose commit
replaces the copy.

```quint
pure def canCursorExpired(c: CalendarSync): bool = c.phase == IncrementalSync
pure def cursorExpired(c: CalendarSync): CalendarSync = { ...c, phase: SyncIdle, stagedPages: 0, cursor: 0, needsReplace: true }
pure def alwaysExpiredCursorForcesAFullListing(c: CalendarSync): bool = c.needsReplace implies (c.cursor == 0 and c.phase != IncrementalSync)
pure def sometimesCopyReplacedAfterExpiry(c: CalendarSync): bool = c.copyEpoch == 2 and not(c.needsReplace)
```

### A revoked grant clears the copy and its cursor

Revoking the owner's grant stops the run in progress and clears the copy and
its cursor, so nothing synced under the old grant is kept or resumed. A
reconnected grant starts again from a full listing.

```quint
pure def canRevokeSyncGrant(c: CalendarSync): bool = c.grantCurrent
pure def revokeSyncGrant(c: CalendarSync): CalendarSync = { ...c, phase: SyncIdle, grantCurrent: false, stagedPages: 0, cursor: 0, copyPresent: false, needsReplace: false }
pure def canReconnectGrant(c: CalendarSync): bool = not(c.grantCurrent)
pure def reconnectGrant(c: CalendarSync): CalendarSync = { ...c, grantCurrent: true }
pure def alwaysRevokedGrantKeepsNoCopy(c: CalendarSync): bool = not(c.grantCurrent) implies (not(c.copyPresent) and c.cursor == 0 and c.phase == SyncIdle)
pure def sometimesResyncedAfterReconnect(c: CalendarSync): bool = c.grantCurrent and c.copyPresent and c.copyEpoch == 2 and c.commits == 2
```
