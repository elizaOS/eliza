# SQL storage

The SQL plugin, folded into the agent, is the agent's database layer:
`plugins/plugin-sql/src/` with its PostgreSQL and [PGlite](./pglite.md)
adapters. This spec owns the one-time carve-out migration that copies rows
into a new table under a receipt, the task wake patch, and the database rules
the plugin installs: row-level isolation, the membership evidence window and
the append-only identity link attestations.

## Story: Move rows into a new table once, without bringing deleted rows back

> As a user, when an upgrade moves my records into a new table, it happens
> once and completely. A record I delete afterwards never comes back, even if
> the upgrade runs again.

### A carve-out copies, verifies and records its receipt in one transaction

`database-utils/carve-out-migration.ts` claims the receipt, locks the source,
copies the missing rows, verifies their projection and completes the receipt
in one transaction held by one caller. Until it commits, the target table is
as it was. A completed receipt makes every later run a skip; a receipt left
by an older run that is still running or completed means this run copies
nothing. A rollback leaves the target unchanged, and before the first attempt
the target holds no carved-out row.

```quint
type CarvePhase = CarveIdle | CarveClaimed | CarveCopying | CarveVerifying | CarveCommitting
type PriorReceipt = PriorAbsent | PriorRunning | PriorCompleted
type CarveOut = { completed: bool, prior: PriorReceipt, priorKnown: bool, holder: str, phase: CarvePhase, target: Set[str], staged: Set[str], before: Set[str], tombstones: Set[str], verified: bool, completionWanted: bool, attempts: int }
pure val rows: Set[str] = Set("rowA", "rowB")
pure val initial: CarveOut = { completed: false, prior: PriorAbsent, priorKnown: false, holder: "", phase: CarveIdle, target: Set(), staged: Set(), before: Set(), tombstones: Set(), verified: false, completionWanted: true, attempts: 0 }
pure val clientValues = Set("first", "second", "")
pure def canRecordPriorReceipt(c: CarveOut, prior: PriorReceipt): bool = not(c.priorKnown) and c.attempts == 0
pure def recordPriorReceipt(c: CarveOut, prior: PriorReceipt): CarveOut = { ...c, prior: prior, priorKnown: true }
pure def canBeginCarveOut(c: CarveOut, client: str, completeReceipt: bool): bool = client != "" and c.holder == "" and not(c.completed)
pure def beginCarveOut(c: CarveOut, client: str, completeReceipt: bool): CarveOut =
  { ...c, holder: client, phase: CarveClaimed, staged: c.target, before: c.target, verified: false, completionWanted: completeReceipt, attempts: c.attempts + 1 }
pure def canCheckPrior(c: CarveOut): bool = c.holder != "" and c.phase == CarveClaimed
pure def checkPrior(c: CarveOut): CarveOut =
  if (c.prior == PriorAbsent) { ...c, phase: CarveCopying } else { ...c, holder: "", phase: CarveIdle, staged: c.target }
pure def canCopyRows(c: CarveOut): bool = c.holder != "" and c.phase == CarveCopying
pure def copyRows(c: CarveOut): CarveOut = { ...c, staged: c.staged.union(rows), phase: CarveVerifying }
pure def canVerifyProjection(c: CarveOut): bool = c.holder != "" and c.phase == CarveVerifying and rows.subseteq(c.staged)
pure def verifyProjection(c: CarveOut): CarveOut = { ...c, verified: true, phase: CarveCommitting }
pure def canCommitCarveOut(c: CarveOut): bool = c.holder != "" and c.phase == CarveCommitting and c.verified
pure def commitCarveOut(c: CarveOut): CarveOut = { ...c, target: c.staged, completed: c.completionWanted, holder: "", phase: CarveIdle }
pure def canRollBack(c: CarveOut): bool = c.holder != ""
pure def rollBack(c: CarveOut): CarveOut = { ...c, staged: c.target, holder: "", phase: CarveIdle }
pure def sameRows(a: Set[str], b: Set[str]): bool = a.subseteq(b) and b.subseteq(a)
pure def alwaysNoUncommittedCopy(c: CarveOut): bool = c.holder != "" implies sameRows(c.target, c.before)
pure def alwaysPriorReceiptIsRespected(c: CarveOut): bool = c.prior != PriorAbsent implies c.target.size() == 0
pure def alwaysCompletedReceiptWasVerified(c: CarveOut): bool = c.completed implies c.verified
pure def alwaysNoCopyBeforeAnAttempt(c: CarveOut): bool = c.attempts == 0 implies c.target.size() == 0
```

### A row deleted after the carve-out stays deleted

After the receipt completes, the owner may delete a carved-out row; it leaves
a tombstone. Because a completed receipt stops every later run, no tombstoned
row reappears in the target.

```quint
pure def canDeleteRow(c: CarveOut, row: str): bool = c.holder == "" and c.completed and c.target.contains(row)
pure def deleteRow(c: CarveOut, row: str): CarveOut = { ...c, target: c.target.exclude(Set(row)), tombstones: c.tombstones.union(Set(row)) }
pure val rowValues = Set("rowA", "rowB")
pure def alwaysDeletedRowsStayDeleted(c: CarveOut): bool = c.tombstones.intersect(c.target).size() == 0
pure def sometimesCarvedThenDeleted(c: CarveOut): bool = c.completed and c.tombstones.size() > 0
pure def sometimesPriorRunBlocksCopy(c: CarveOut): bool = c.prior == PriorRunning and c.attempts > 0 and c.phase == CarveIdle
```

## Story: Wake a task for the earliest request made after I last looked

> As a user, when several parts of the agent ask to wake a task, it wakes at
> the earliest time asked, and a request made while another part was consuming
> the old one is not lost.

### A wake patch keeps the earliest outstanding time and only consumes what was read

`stores/task-wake.ts` patches the task row atomically. A request advances the
row's revision and keeps the earlier of the existing and requested times. A
consume clears the wake only if the row is still at the revision the consumer
read; otherwise a newer request survives it.

```quint
type WakeRow = { revision: int, wakeAt: int }
pure def requestWake(wakeRow: WakeRow, at: int): WakeRow = { revision: wakeRow.revision + 1, wakeAt: if (wakeRow.wakeAt == 0 or at < wakeRow.wakeAt) at else wakeRow.wakeAt }
pure def consumeWake(wakeRow: WakeRow, observedRevision: int): WakeRow = if (observedRevision == wakeRow.revision) { ...wakeRow, wakeAt: 0 } else wakeRow
pure val wakeRowValues = Set({ revision: 0, wakeAt: 0 }, { revision: 1, wakeAt: 2 }, { revision: 2, wakeAt: 3 })
pure val atValues = Set(1, 2, 3)
pure def lawRequestAfterReadSurvivesConsume(wakeRow: WakeRow, at: int): bool =
  consumeWake(requestWake(wakeRow, at), wakeRow.revision).wakeAt == requestWake(wakeRow, at).wakeAt
pure def lawEarliestRequestWins(wakeRow: WakeRow, at: int): bool =
  at > 0 implies (requestWake(wakeRow, at).wakeAt <= at and (wakeRow.wakeAt == 0 or requestWake(wakeRow, at).wakeAt <= wakeRow.wakeAt))
pure def lawConsumeOfTheReadRevisionClears(wakeRow: WakeRow): bool = consumeWake(wakeRow, wakeRow.revision).wakeAt == 0
```

## Story: Keep each server's and each person's rows to themselves

> As a user of a shared database, other servers and other people cannot read
> my rows, stale membership evidence does not count, and a recorded identity
> link cannot be rewritten.

### Row-level security isolates servers and entities

On PostgreSQL, `rls.ts` installs policies on every table: a row is visible
only to the server it belongs to, and, where the table is entity-scoped, only
to that entity. PGlite has no row-level security; the device store holds one
server's data.

```quint
pure def rowVisible(rowServer: str, currentServer: str, rowEntity: str, currentEntity: str, entityScoped: bool): bool =
  rowServer != "" and rowServer == currentServer and (not(entityScoped) or rowEntity == currentEntity)
pure val rowServerValues = Set("server1", "server2", "")
pure val currentServerValues = Set("server1", "server2")
pure val rowEntityValues = Set("entity1", "entity2")
pure val currentEntityValues = Set("entity1", "entity2")
pure def lawAnotherServersRowIsHidden(rowServer: str, currentServer: str, rowEntity: str, currentEntity: str, entityScoped: bool): bool =
  rowServer != currentServer implies not(rowVisible(rowServer, currentServer, rowEntity, currentEntity, entityScoped))
pure def lawAnotherEntitysScopedRowIsHidden(rowServer: str, currentServer: str, rowEntity: str, currentEntity: str): bool =
  rowEntity != currentEntity implies not(rowVisible(rowServer, currentServer, rowEntity, currentEntity, true))
```

### Membership evidence counts for 24 hours from its observation

`membership-authority-ttl-constraints.ts` makes the database refuse membership
authority whose evidence is older than 24 hours relative to its observation,
or observed in the future.

```quint
pure val membershipWindowMs = 86400000
pure def evidenceFresh(observedAt: int, now: int): bool = observedAt <= now and now < observedAt + membershipWindowMs
pure val observedAtValues = Set(0, 1000, 86400000)
pure val nowValues = Set(0, 86399999, 86400000, 172800001)
pure def lawStaleEvidenceIsRefused(observedAt: int, now: int): bool = now >= observedAt + membershipWindowMs implies not(evidenceFresh(observedAt, now))
pure def lawFutureEvidenceIsRefused(observedAt: int, now: int): bool = observedAt > now implies not(evidenceFresh(observedAt, now))
```

### Identity link attestations are append-only

`identity-person-link-attestation-guard.ts` installs a trigger that refuses
updates and deletes of authenticated person-link evidence; only inserts are
allowed.

```quint
type AttestationWrite = InsertAttestation | UpdateAttestation | DeleteAttestation
pure def attestationWriteAllowed(write: AttestationWrite): bool = write == InsertAttestation
pure def lawAttestationsAreNeverRewritten(write: AttestationWrite): bool = write != InsertAttestation implies not(attestationWriteAllowed(write))
```
