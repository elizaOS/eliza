# PGlite device store

On the device the agent's database is PGlite, opened over one data
directory and evolved by the runtime migrator. The
rules the [SQL storage](./sql.md) installs apply to it, except row-level
security, which PGlite lacks. This spec owns the store's lifecycle while an
export archive is taken and the store is closed, and how the migrator evolves
its schema.

## Story: Export my data without racing a write or a shutdown

> As a user, an export of my on-device data is taken while nothing else uses
> the database, and the store does not close or give up its data directory
> while the archive is still being read.

### One lifecycle lock orders exports and closing, and queries run inside it

An exporter takes the export lease and joins the lifecycle queue; a second
exporter, or any exporter once shutdown began, is refused. The lifecycle lock
is handed out in queue order. A dump runs only when the store is ready, as the
only query, inside the lock. A successful dump keeps the lease while the
archive is consumed; releasing the archive returns it. The closer is never
an exporter. The lease is held exactly while an export is under way, by its
exporter, and the queue holds only that waiting exporter and, behind it, the
waiting close.

```quint
type ExportPhase = ExportIdle | ExportQueued | ExportWaitingReady | ExportDumping | ExportRetained | ExportFailed | ExportReleased
type ClosePhase = CloseIdle | CloseQueued | CloseWaitingLease | Closing | CloseDone
type PgliteStore = { shuttingDown: bool, ready: bool, closed: bool, dataDirOwned: bool, lease: str, mutex: str, queryOwner: str, queue: List[str], exporter: str, exportPhase: ExportPhase, closePhase: ClosePhase }
pure val closer = "close"
pure val initial: PgliteStore = { shuttingDown: false, ready: false, closed: false, dataDirOwned: true, lease: "", mutex: "", queryOwner: "", queue: List(), exporter: "", exportPhase: ExportIdle, closePhase: CloseIdle }
pure val exporterValues = Set("first", "second")
pure def canMarkReady(p: PgliteStore): bool = not(p.ready)
pure def markReady(p: PgliteStore): PgliteStore = { ...p, ready: true }
pure def canRequestExport(p: PgliteStore, exporter: str): bool =
  exporter != "" and exporter != closer and not(p.shuttingDown) and p.lease == "" and (p.exportPhase == ExportIdle or p.exportPhase == ExportFailed or p.exportPhase == ExportReleased)
pure def requestExport(p: PgliteStore, exporter: str): PgliteStore = { ...p, lease: exporter, exporter: exporter, queue: p.queue.append(exporter), exportPhase: ExportQueued }
pure def canAcquireLock(p: PgliteStore): bool = p.mutex == "" and p.queue.length() > 0
pure def acquireLock(p: PgliteStore): PgliteStore = {
  val lockHolder = p.queue.nthOr(0, "")
  { ...p, mutex: lockHolder, queue: p.queue.removeAt(0),
    exportPhase: if (lockHolder == p.exporter and lockHolder != closer) ExportWaitingReady else p.exportPhase,
    closePhase: if (lockHolder == closer) CloseWaitingLease else p.closePhase }
}
pure def canBeginDump(p: PgliteStore): bool = p.mutex == p.exporter and p.exportPhase == ExportWaitingReady and p.ready
pure def beginDump(p: PgliteStore): PgliteStore = { ...p, queryOwner: p.exporter, exportPhase: ExportDumping }
pure def canEndDump(p: PgliteStore, success: bool): bool = p.mutex == p.exporter and p.exportPhase == ExportDumping
pure def endDump(p: PgliteStore, success: bool): PgliteStore =
  { ...p, mutex: "", queryOwner: "", lease: if (success) p.exporter else "", exportPhase: if (success) ExportRetained else ExportFailed }
pure def canReleaseArchive(p: PgliteStore): bool = p.exportPhase == ExportRetained
pure def releaseArchive(p: PgliteStore): PgliteStore = { ...p, lease: "", exportPhase: ExportReleased }
pure def alwaysQueryRunsInsideTheLifecycleLock(p: PgliteStore): bool = p.queryOwner != "" implies p.mutex == p.queryOwner
pure def exportUnderWay(phase: ExportPhase): bool =
  phase == ExportQueued or phase == ExportWaitingReady or phase == ExportDumping or phase == ExportRetained
pure def alwaysOneExportHoldsTheLease(p: PgliteStore): bool = p.lease != "" implies (p.lease == p.exporter and exportUnderWay(p.exportPhase))
pure def alwaysExportUnderWayHoldsTheLease(p: PgliteStore): bool =
  p.exporter != closer and (exportUnderWay(p.exportPhase) implies (p.lease == p.exporter and p.exporter != ""))
pure def alwaysQueueHoldsTheWaitersInOrder(p: PgliteStore): bool =
  p.queue == (if (p.exportPhase == ExportQueued) List(p.exporter) else List()).concat(if (p.closePhase == CloseQueued) List(closer) else List())
pure def sometimesArchiveRetained(p: PgliteStore): bool = p.exportPhase == ExportRetained and p.shuttingDown
```

### Closing waits for the export lease and keeps the data directory until then

Closing joins the same queue. Once it holds the lock it waits until no export
lease is held and the store is ready, then closes, gives up the data
directory and runs no query afterwards. While an archive holds the lease the
store stays open with its data directory. The close is idle
exactly while shutdown has not begun, and the store is closed, without its
data directory, exactly when the close is done.

```quint
pure def canRequestClose(p: PgliteStore): bool = p.closePhase == CloseIdle
pure def requestClose(p: PgliteStore): PgliteStore = { ...p, shuttingDown: true, queue: p.queue.append(closer), closePhase: CloseQueued }
pure def canBeginClose(p: PgliteStore): bool = p.mutex == closer and p.closePhase == CloseWaitingLease and p.lease == "" and p.ready
pure def beginClose(p: PgliteStore): PgliteStore = { ...p, queryOwner: closer, closePhase: Closing }
pure def canEndClose(p: PgliteStore): bool = p.closePhase == Closing
pure def endClose(p: PgliteStore): PgliteStore = { ...p, closed: true, dataDirOwned: false, mutex: "", queryOwner: "", closePhase: CloseDone }
pure def alwaysLeaseKeepsTheStoreOpen(p: PgliteStore): bool = p.lease != "" implies (p.dataDirOwned and not(p.closed))
pure def alwaysClosingRespectsTheExport(p: PgliteStore): bool = (p.closePhase == Closing or p.closePhase == CloseDone) implies p.lease == ""
pure def alwaysNoQueryAfterClose(p: PgliteStore): bool = p.closed implies (p.queryOwner == "" and p.mutex == "")
pure def alwaysCloseTracksShutdown(p: PgliteStore): bool =
  (p.closePhase == CloseIdle) == not(p.shuttingDown) and p.closed == (p.closePhase == CloseDone) and p.dataDirOwned == not(p.closed)
pure val fair_markReady = "weak"
pure val fair_acquireLock = "weak"
pure val fair_beginDump = "weak"
pure val fair_endDump = "weak"
pure val fair_releaseArchive = "weak"
pure val fair_beginClose = "weak"
pure val fair_endClose = "weak"
pure def leadsToCloseCompletes(p: PgliteStore, later: PgliteStore): bool = p.shuttingDown implies later.closed
pure def sometimesClosedAfterExport(p: PgliteStore): bool = p.closed and p.exportPhase == ExportReleased
```

## Story: Upgrade the device store's schema without losing data

> As a user, when the agent is updated the database on my device is evolved
> to the new schema once, and an update that would drop my data is refused.

### The migrator applies a changed, non-destructive schema and skips an unchanged one

For each plugin, the migrator compares the code's schema snapshot with the
one recorded in the store, after taking that plugin's migration lock and
reading the record again. An unchanged snapshot is skipped. A changed one is
applied, unless its diff would lose data, which is refused on the device
store.

```quint
type MigrationDecision = SkipUnchanged | ApplyMigration | RefuseDataLoss
type MigrationPlan = { recordedHash: str, schemaHash: str, dataLoss: bool }
pure def migrationDecision(plan: MigrationPlan): MigrationDecision =
  if (plan.recordedHash == plan.schemaHash) SkipUnchanged else if (plan.dataLoss) RefuseDataLoss else ApplyMigration
pure val planValues = Set({ recordedHash: "h1", schemaHash: "h1", dataLoss: false }, { recordedHash: "h1", schemaHash: "h2", dataLoss: false },
  { recordedHash: "h1", schemaHash: "h2", dataLoss: true }, { recordedHash: "", schemaHash: "h2", dataLoss: false })
pure def lawUnchangedSchemaIsNotMigrated(plan: MigrationPlan): bool = plan.recordedHash == plan.schemaHash implies migrationDecision(plan) == SkipUnchanged
pure def lawDataLossIsNeverApplied(plan: MigrationPlan): bool = plan.dataLoss implies migrationDecision(plan) != ApplyMigration
pure def lawAppliedMigrationChangesTheSchema(plan: MigrationPlan): bool = migrationDecision(plan) == ApplyMigration implies plan.recordedHash != plan.schemaHash
```
