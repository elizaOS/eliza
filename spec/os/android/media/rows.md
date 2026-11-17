# Media tokens and guarded row writes

The two pieces every media machine shares. The native media library hands
out opaque one-shot tokens (a delete confirmation from `prepareDeleteTrash`,
a catalog page cursor, a review ticket) that expire on Android's monotonic
clock, and it changes a MediaStore row only through one ladder: check the
row is still at the revision the person saw listed, write with a predicate
on that revision, read the effect back, and classify the row. Sources:
`OwnedMediaLibrary.java` (`prepareDeleteTrash`, `deletePreparedTrash`,
`changeFlag`, `changeMany`), `PermittedMediaCatalog.java` (page cursors),
`PermittedMediaReview.java` (`apply`) in `plugins/plugin-native-media`.

The media catalog, review, trash, albums, edit-copy and photo-replace
specs in this directory import this library. The shell keeps
the provider calls; the importing machines hold the token tables and feed
the ladder the evidence each provider step returned.

## Expiring one-shot tokens

A token is the only authority a later call carries, so it must work once,
for a bounded time, and the table that holds them must stay small.

### Taking a token removes it whether or not it is still live

`takeToken` is how every use of a token begins: the entry is removed from
the table before any check or provider work, so a second use of the same
token, even one racing the first, is refused. Cancelling a token
(`cancelDeleteTrash`, a discarded view) is `dropToken`. A missing or empty
token id matches nothing.

```quint
type OneShotToken = { id: int, until: int }
type TokenTake = { left: List[OneShotToken], live: bool }
pure def dropToken(table: List[OneShotToken], tokenId: int): List[OneShotToken] = table.select(t => t.id != tokenId)
pure def takeToken(table: List[OneShotToken], tokenId: int, at: int): TokenTake =
  { left: dropToken(table, tokenId), live: table.some(t => t.id == tokenId and at <= t.until) }
pure val tableValues = Set(List(), List({ id: 1, until: 5 }), List({ id: 1, until: 0 }, { id: 2, until: 120000 }),
  List({ id: 2, until: 5 }, { id: 2, until: 6 }))
pure val tokenIdValues = Set(0, 1, 2, 3)
pure val atValues = Set(0, 5, 6, 120001)
pure val laterValues = Set(0, 6, 120001)
pure def lawTakenTokenCannotBeTakenAgain(table: List[OneShotToken], tokenId: int, at: int, later: int): bool =
  not(takeToken(takeToken(table, tokenId, at).left, tokenId, later).live)
```

### An issued token is live through its deadline and never after

Every media token lives `tokenLifetimeMs` (two minutes) on the monotonic
elapsed clock; the deadline is inclusive (`at <= until`), as in the native
code's `until < now` expiry test. A new id is positive and not already held.

```quint
pure val tokenLifetimeMs = 120000
pure def freshTokenId(table: List[OneShotToken], tokenId: int): bool = tokenId > 0 and not(table.some(t => t.id == tokenId))
pure def issueToken(table: List[OneShotToken], at: int, capacity: int, tokenId: int, ttl: int): List[OneShotToken] = {
  val live = table.select(t => at <= t.until)
  val room = if (live.length() >= capacity) live.removeAt(0) else live
  room.append({ id: tokenId, until: at + ttl })
}
pure val ttlValues = Set(0, 120000)
pure val capacityValues = Set(1, 2, 4)
pure def lawIssuedTokenLivesThroughItsDeadline(table: List[OneShotToken], tokenId: int, at: int, ttl: int, capacity: int): bool =
  (freshTokenId(table, tokenId) and ttl >= 0 and capacity >= 1) implies
    (takeToken(issueToken(table, at, capacity, tokenId, ttl), tokenId, at + ttl).live and
      not(takeToken(issueToken(table, at, capacity, tokenId, ttl), tokenId, at + ttl + 1).live))
```

### Issuing keeps only live tokens with distinct ids and evicts the oldest at capacity

Issuing first drops expired entries, then evicts the oldest live entry when
the table is full (4 delete confirmations, 32 catalog cursors: the importer
names its capacity), then appends. No entry is ever added except the new
one, so a token that was taken or evicted never comes back.

```quint
pure def distinctTokenIds(table: List[OneShotToken]): bool =
  table.every(t => table.select(other => other.id == t.id).length() == 1)
pure def lawIssueKeepsBoundedLiveDistinctTable(table: List[OneShotToken], tokenId: int, at: int, ttl: int, capacity: int): bool = {
  val issued = issueToken(table, at, capacity, tokenId, ttl)
  (table.length() <= capacity and distinctTokenIds(table) and freshTokenId(table, tokenId) and ttl >= 0 and capacity >= 1) implies
    (issued.length() <= capacity and distinctTokenIds(issued) and issued.every(t => at <= t.until) and
      issued.every(t => t.id == tokenId or table.includes(t)))
}
```

## Guarded row writes

A row the person saw listed is changed only if it is still that row, and
the reply says honestly whether the change happened.

### A row is written only when it is still at its listed revision and not already as desired

The shell first reads the row with the listed key and revision (owner,
published state, type, mutation revision, MediaStore generation). A row it
cannot read, or that has changed since listing, is not written. A row
already in the desired state is reported unchanged without a write.
`rowNeedsWrite` is the shell's decision to issue the predicated write. A
row is verified only when it was found at its listed revision; a batch is
complete only when every row is verified (an empty delete snapshot is
complete).

```quint
type RowInspection = RowNotInspected | RowInspectFailed | RowChangedSinceListing | RowAtListing({ alreadyDesired: bool })
type RowWrite = RowNotWritten | RowWriteFailed | RowWriteCounted({ rows: int })
type RowLadder = { inspection: RowInspection, write: RowWrite, readbackConfirmed: bool }
type RowOutcome = RowUnchanged | RowApplied | RowStale | RowUnverified
pure def rowAtListing(inspection: RowInspection): bool = match inspection { | RowAtListing(_) => true | _ => false }
pure def rowNeedsWrite(inspection: RowInspection): bool = match inspection { | RowAtListing(r) => not(r.alreadyDesired) | _ => false }
pure def writeOutcome(write: RowWrite, readbackConfirmed: bool): RowOutcome = match write {
  | RowWriteCounted(w) => if (w.rows == 0) RowStale else if (w.rows == 1 and readbackConfirmed) RowApplied else RowUnverified
  | _ => RowUnverified
}
pure def rowOutcome(ladder: RowLadder): RowOutcome = {
  val inspection = ladder.inspection
  match inspection {
    | RowNotInspected => RowUnverified
    | RowInspectFailed => RowUnverified
    | RowChangedSinceListing => RowStale
    | RowAtListing(r) => if (r.alreadyDesired) RowUnchanged else writeOutcome(ladder.write, ladder.readbackConfirmed)
  }
}
pure def rowVerified(reply: RowOutcome): bool = reply == RowUnchanged or reply == RowApplied
pure def rowsComplete(outcomes: List[RowOutcome]): bool = outcomes.every(o => rowVerified(o))
pure val exactRowWrite: RowLadder = { inspection: RowAtListing({ alreadyDesired: false }), write: RowWriteCounted({ rows: 1 }), readbackConfirmed: true }
pure val ladderValues = Set(exactRowWrite, { ...exactRowWrite, readbackConfirmed: false },
  { ...exactRowWrite, write: RowWriteCounted({ rows: 0 }) }, { ...exactRowWrite, write: RowWriteCounted({ rows: 2 }) },
  { ...exactRowWrite, write: RowWriteFailed }, { ...exactRowWrite, write: RowNotWritten },
  { ...exactRowWrite, inspection: RowAtListing({ alreadyDesired: true }), write: RowNotWritten },
  { ...exactRowWrite, inspection: RowChangedSinceListing }, { ...exactRowWrite, inspection: RowInspectFailed },
  { ...exactRowWrite, inspection: RowNotInspected })
pure def lawVerifiedRowWasAtItsListedRevision(ladder: RowLadder): bool =
  rowVerified(rowOutcome(ladder)) implies rowAtListing(ladder.inspection)
```

### A row is applied only after one counted write and a confirmed readback

The write predicates on the listed generation and the opposite state, so it
counts one row or none. Applied needs the write to count exactly one row and
the desired effect (flag set, row absent) to be read back with its new
version committed.

```quint
pure def lawAppliedRowHasOneCountedWriteAndReadback(ladder: RowLadder): bool =
  rowOutcome(ladder) == RowApplied implies
    (rowNeedsWrite(ladder.inspection) and ladder.write == RowWriteCounted({ rows: 1 }) and ladder.readbackConfirmed)
```

### A write whose effect is unknown is unverified, never stale

Stale tells the caller nothing changed, so it may list again and retry.
It is given only when the row changed before the write or the predicated
write counted no row. A write that threw, counted an impossible number of
rows, or was not confirmed by readback may have changed the row, so it is
unverified and carries no positive receipt.

The native code reports any count other than one as
stale; a count above one cannot occur under the id predicate, and here it
is unverified so that stale never covers a possible change.

```quint
pure def writeMayHaveApplied(write: RowWrite): bool = match write {
  | RowWriteCounted(w) => w.rows != 0
  | RowWriteFailed => true
  | _ => false
}
pure def lawUnknownEffectIsNeverStale(ladder: RowLadder): bool =
  (rowNeedsWrite(ladder.inspection) and writeMayHaveApplied(ladder.write)) implies
    (rowOutcome(ladder) == RowApplied or rowOutcome(ladder) == RowUnverified)
```
