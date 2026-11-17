# Device database

The agent's one store on the device and the agent's own identity: open,
identity, lock, migrate, query, close and log retention. The store is PGlite,
in memory unless the launch sets `persistMemory`, then over a data directory
inside the `--state` directory. Every failure here fails boot as
`Storage` (exit 74, `host/launch.md`). SQL, file I/O and the adapter
methods stay in `storage/*.vibe`; this spec holds the decisions. Sources:
`plugins/plugin-sql/src/pglite/manager.ts` (lock, corruption, close),
`pglite/migrated-snapshot.ts` (snapshot), `packages/agent/src/runtime/logs-retention-service.ts`
and `memory-retention.ts` (retention). A store of an older Eliza is never
read or migrated: the v4 store uses a new directory name. There is no export.

## Story: Keep one agent identity for my data across restarts

> As the owner, I want my agent to keep one identity for its data across
> restarts, so that my conversations are never served under another
> identity or to another account.

### An existing identity is reused, and a missing one is created once by atomic publication

On every open, memory store included, the store reads the identity file of
the `--state` directory. A file with a UUID gives the `agentId` unchanged; a
missing file is created with a fresh UUID through core
[atomic publication](../../core/atomicPublication.md), and only a published
identity is used. The launch never carries an `agentId`. A crash during
publication ends the process; the next start reads what the rename left.

```quint
import atomicPublication as AT from "../../core/atomicPublication"
type StorePhase = Unopened | ReadingIdentity | PublishingIdentity | Locking | ReadingDirectory | Migrating | Open | Closing | Closed | Failed
type StoreFault = NoFault | IdentityUnusable | IdentityNotPublished | DirectoryInUse | OtherOwner | Corrupt | NewerSchema | DestructiveMigration | MigrationFailed
type MigrationKind = Additive | Destructive
type Bundle = { migrations: List[MigrationKind], snapshotVersion: int }
type StoreAccount = OwnerAccount({ userId: str, organizationId: str }) | NoAccount
type LogRetention = Prune({ ageMs: int, maxRowsPerRoom: int }) | KeepAll
type StoreLaunch = { persist: bool, account: StoreAccount, embeddingDimensions: int, retention: LogRetention }
type DataOwner = { agentId: str, account: StoreAccount, embeddingDimensions: int }
type IdentityEntry = EntryMissing | EntryUuid({ agentId: str }) | EntryUnusable
type LogRow = { id: int, room: str, at: int }
type Sweep = SweepIdle | SweepRunning({ targets: List[LogRow], now: int })
type Store = { phase: StorePhase, fault: StoreFault, launch: StoreLaunch, bundle: Bundle, agentId: str, candidate: str, publication: AT::Publication, locked: bool, recorded: DataOwner, version: int, seeded: bool, queries: Set[int], logs: List[LogRow], nextLogId: int, sweep: Sweep, swept: int }
pure val noOwner: DataOwner = { agentId: "", account: NoAccount, embeddingDimensions: 0 }
pure val initial: Store = { phase: Unopened, fault: NoFault, launch: { persist: false, account: NoAccount, embeddingDimensions: 0, retention: KeepAll }, bundle: { migrations: List(), snapshotVersion: 0 }, agentId: "", candidate: "", publication: AT::initial, locked: false, recorded: noOwner, version: 0, seeded: false, queries: Set(), logs: List(), nextLogId: 1, sweep: SweepIdle, swept: 0 }
pure val owner1: StoreAccount = OwnerAccount({ userId: "user1", organizationId: "org1" })
pure val prune: LogRetention = Prune({ ageMs: 86400, maxRowsPerRoom: 1 })
pure val launchValues = Set(
  { persist: false, account: NoAccount, embeddingDimensions: 0, retention: prune },
  { persist: false, account: NoAccount, embeddingDimensions: 0, retention: Prune({ ageMs: 86400, maxRowsPerRoom: 0 }) },
  { persist: true, account: owner1, embeddingDimensions: 384, retention: prune },
  { persist: true, account: owner1, embeddingDimensions: 384, retention: KeepAll })
pure val bundleValues = Set({ migrations: List(Additive, Additive), snapshotVersion: 2 }, { migrations: List(Additive, Additive), snapshotVersion: 1 }, { migrations: List(Additive, Destructive), snapshotVersion: 0 })
pure val entryValues = Set(EntryMissing, EntryUuid({ agentId: "agent1" }), EntryUnusable)
pure val freshIdValues = Set("agent1", "agent2")
pure def latest(b: Bundle): int = b.migrations.length()
pure def launchOwner(agentId: str, launch: StoreLaunch): DataOwner = { agentId: agentId, account: launch.account, embeddingDimensions: launch.embeddingDimensions }
pure def failed(fault: StoreFault, s: Store): Store = { ...s, phase: Failed, fault: fault, locked: false }
pure def seedable(b: Bundle): bool = b.snapshotVersion > 0 and b.snapshotVersion == latest(b)
pure def enterSchema(version: int, seeded: bool, owner: DataOwner, s: Store): Store = { ...s, phase: Migrating, version: version, seeded: seeded, recorded: owner }
pure def startEmpty(s: Store): Store = enterSchema(if (seedable(s.bundle)) latest(s.bundle) else 0, seedable(s.bundle), launchOwner(s.agentId, s.launch), s)
pure def identified(agentId: str, s: Store): Store = {
  val known = { ...s, agentId: agentId, candidate: "" }
  if (s.launch.persist) { ...known, phase: Locking } else startEmpty(known)
}
pure def validRetention(r: LogRetention): bool = match r { | Prune(x) => x.ageMs >= 0 and x.maxRowsPerRoom >= 0 and (x.ageMs > 0 or x.maxRowsPerRoom > 0) | KeepAll => true }
pure def canOpen(s: Store, launch: StoreLaunch, bundle: Bundle): bool = s.phase == Unopened and bundle.snapshotVersion >= 0 and validRetention(launch.retention)
pure def open(s: Store, launch: StoreLaunch, bundle: Bundle): Store = { ...s, phase: ReadingIdentity, launch: launch, bundle: bundle }
pure def canReadIdentity(s: Store, entry: IdentityEntry, freshId: str): bool = s.phase == ReadingIdentity and freshId != ""
pure def readIdentity(s: Store, entry: IdentityEntry, freshId: str): Store = match entry {
  | EntryUuid(e) => if (e.agentId == "") failed(IdentityUnusable, s) else identified(e.agentId, s)
  | EntryMissing => { ...s, phase: PublishingIdentity, candidate: freshId, publication: AT::initial }
  | EntryUnusable => failed(IdentityUnusable, s)
}
pure def canPublishCreate(s: Store): bool = s.phase == PublishingIdentity and AT::canCreate(s.publication)
pure def publishCreate(s: Store, ok: bool): Store = { ...s, publication: AT::create(s.publication, ok) }
pure def canPublishWrite(s: Store): bool = s.phase == PublishingIdentity and AT::canWrite(s.publication)
pure def publishWrite(s: Store, ok: bool): Store = { ...s, publication: AT::write(s.publication, ok) }
pure def canPublishRename(s: Store): bool = s.phase == PublishingIdentity and AT::canRename(s.publication)
pure def publishRename(s: Store, ok: bool): Store = { ...s, publication: AT::rename(s.publication, ok) }
pure def canPublishCleanup(s: Store): bool = s.phase == PublishingIdentity and AT::canCleanup(s.publication)
pure def publishCleanup(s: Store, removed: bool): Store = {
  val published = { ...s, publication: AT::cleanup(s.publication, removed) }
  if (published.publication.receipt == AT::SuccessReceipt) identified(s.candidate, published) else failed(IdentityNotPublished, published)
}
pure def alwaysDataPhasesHaveIdentity(s: Store): bool =
  s.phase != Failed implies ((s.phase == Unopened or s.phase == ReadingIdentity or s.phase == PublishingIdentity) iff s.agentId == "")
pure def alwaysCreatedIdentityWasPublished(s: Store): bool =
  (s.phase == PublishingIdentity implies s.candidate != "" and s.publication.receipt == AT::PendingReceipt)
    and ((s.agentId != "" and s.publication.receipt != AT::PendingReceipt) implies s.publication.receipt == AT::SuccessReceipt)
    and ((s.phase == Unopened or s.phase == ReadingIdentity) implies s.candidate == "" and s.publication.receipt == AT::PendingReceipt)
pure def stepIdentityNeverChanges(before: Store, after: Store): bool = before.agentId != "" implies after.agentId == before.agentId
pure def sometimesReusedIdentityServes(s: Store): bool = s.phase == Open and s.publication.receipt == AT::PendingReceipt
pure def sometimesCreatedIdentityServes(s: Store): bool = s.phase == Open and s.publication.receipt == AT::SuccessReceipt
pure def sometimesUnpublishedIdentityFails(s: Store): bool = s.fault == IdentityNotPublished
```

### A damaged or linked identity file fails the open and is left in place

The shell reads the file only when it is a regular, owner-only file with one
hard link that is not a symbolic link and holds one UUID; anything else is
`EntryUnusable`. It is never replaced, so a later start sees the same file.

```quint
pure def alwaysUnusableIdentityKeepsNoId(s: Store): bool = s.fault == IdentityUnusable implies s.agentId == "" and s.candidate == ""
pure def sometimesUnusableIdentityFails(s: Store): bool = s.fault == IdentityUnusable
```

### A data directory serves only the agent, account and embedding size it was created for

A new directory records `{agentId, account, embeddingDimensions}` from this
start, and a memory store holds the same. An existing directory keeps its
record, and one that differs from this start in any field is refused, so a
store never serves another owner's conversations and never mixes vector
sizes. Which `--state` directory a launch uses is the host's choice.

```quint
type Directory = DirEmpty | DirCorrupt | DirStore({ owner: DataOwner, version: int })
pure val foundValues = Set(DirEmpty, DirCorrupt,
  DirStore({ owner: { agentId: "agent1", account: owner1, embeddingDimensions: 384 }, version: 1 }),
  DirStore({ owner: { agentId: "agent1", account: owner1, embeddingDimensions: 384 }, version: 3 }),
  DirStore({ owner: { agentId: "agent1", account: OwnerAccount({ userId: "user2", organizationId: "org1" }), embeddingDimensions: 384 }, version: 1 }))
pure def canReadDirectory(s: Store, found: Directory): bool = s.phase == ReadingDirectory
pure def readDirectory(s: Store, found: Directory): Store = match found {
  | DirEmpty => startEmpty(s)
  | DirCorrupt => failed(Corrupt, s)
  | DirStore(d) => if (d.owner != launchOwner(s.agentId, s.launch)) failed(OtherOwner, s) else if (d.version < 0 or d.version > latest(s.bundle)) failed(NewerSchema, s) else enterSchema(d.version, false, d.owner, s)
}
pure def alwaysStoreBelongsToItsLaunch(s: Store): bool =
  (s.phase == Migrating or s.phase == Open or s.phase == Closing or s.phase == Closed) implies s.recorded == launchOwner(s.agentId, s.launch)
pure def sometimesOtherOwnerRefused(s: Store): bool = s.fault == OtherOwner
```

## Story: Keep the agent's records in one store that never loses a committed write

> As the owner, I want my agent's records kept in one store that only this
> agent opens, so that no committed write is lost to a second writer, a bad
> upgrade or an automatic reset.

### Only one live process holds a data directory

The lock file in the data directory names its holder. A live holder refuses
the open; a lock whose holder is gone is reclaimed. A memory store takes no
lock. The lock is released when the store closes or fails.

```quint
type LockFile = LockFree | LockStale | LockLive
pure def canLock(s: Store, lockFile: LockFile): bool = s.phase == Locking
pure def lock(s: Store, lockFile: LockFile): Store = if (lockFile == LockLive) failed(DirectoryInUse, s) else { ...s, phase: ReadingDirectory, locked: true }
pure def alwaysLockedExactlyWhileTheDirectoryIsUsed(s: Store): bool =
  (s.phase == Locking implies s.launch.persist)
    and (s.locked iff (s.launch.persist and (s.phase == ReadingDirectory or s.phase == Migrating or s.phase == Open or s.phase == Closing)))
pure def sometimesDirectoryInUse(s: Store): bool = s.fault == DirectoryInUse
```

### A corrupt store fails the open and is never reset automatically

A directory PGlite cannot start is `DirCorrupt`; the owner decides what to
do with it. A failed open is final for this process.

```quint
pure def alwaysFaultExactlyWhenFailed(s: Store): bool = (s.phase == Failed) iff (s.fault != NoFault)
pure def stepFailureIsFinal(before: Store, after: Store): bool = before.phase == Failed implies after.phase == Failed and after.fault == before.fault and after.logs == before.logs
pure def sometimesCorruptRefused(s: Store): bool = s.fault == Corrupt
```

### Migrations run in number order, one transaction each, and a destructive or newer schema is refused

The bundle ships numbered SQL migrations; the store's version is the number
of the last one applied. Each runs in its own transaction, so a failed one
leaves the version unchanged and fails the open. A migration that would drop
data is refused before it runs, as is a store newer than the bundle.

```quint
pure def canMigrate(s: Store, ok: bool): bool = s.phase == Migrating and s.version < latest(s.bundle)
pure def migrate(s: Store, ok: bool): Store =
  if (s.bundle.migrations.nthOr(s.version, Additive) == Destructive) failed(DestructiveMigration, s) else if (ok) { ...s, version: s.version + 1 } else failed(MigrationFailed, s)
pure def canFinishOpen(s: Store): bool = s.phase == Migrating and s.version == latest(s.bundle)
pure def finishOpen(s: Store): Store = { ...s, phase: Open }
pure def beforeSchema(phase: StorePhase): bool = phase == Unopened or phase == ReadingIdentity or phase == PublishingIdentity or phase == Locking or phase == ReadingDirectory
pure def alwaysSchemaWithinTheBundle(s: Store): bool =
  (beforeSchema(s.phase) implies s.version == 0 and not(s.seeded)) and (s.version >= 0 and s.version <= latest(s.bundle)) and ((s.phase == Open or s.phase == Closing or s.phase == Closed) implies s.version == latest(s.bundle))
pure def stepSchemaMovesOneMigrationAtATime(before: Store, via: str, after: Store): bool =
  not(beforeSchema(before.phase)) implies (after.version == before.version or (via == "migrate" and after.version == before.version + 1))
pure def sometimesUpgradeInProgress(s: Store): bool = s.phase == Migrating and s.version > 0 and s.version < latest(s.bundle) and not(s.seeded)
pure def sometimesDestructiveRefused(s: Store): bool = s.fault == DestructiveMigration
pure def sometimesMigrationFailed(s: Store): bool = s.fault == MigrationFailed
pure def sometimesNewerSchemaRefused(s: Store): bool = s.fault == NewerSchema
```

### An empty store starts from the bundle's snapshot only at the bundle's schema version

The bundle may carry a pre-migrated empty snapshot. A memory store or an
empty data directory starts from it only when its version equals the
bundle's; otherwise it migrates from nothing. An existing directory is
never seeded.

```quint
pure def alwaysSeedMatchesTheBundle(s: Store): bool = s.seeded implies seedable(s.bundle)
pure def sometimesSeededDirectoryServes(s: Store): bool = s.phase == Open and s.seeded and s.launch.persist
pure def sometimesSeededMemoryServes(s: Store): bool = s.phase == Open and s.seeded and not(s.launch.persist)
```

### Queries run only while the store is open, and close waits for every one in flight

A query or write admitted before close runs to its end; no new one starts
once close begins, and the store closes only when none is left and no sweep
runs. A committed row is removed only by a retention sweep.

```quint
pure val queryIdValues = Set(1, 2)
pure val roomValues = Set("room1", "room2")
pure val atValues = Set(0, 100000)
pure def canBeginQuery(s: Store, queryId: int): bool = s.phase == Open and not(s.queries.contains(queryId))
pure def beginQuery(s: Store, queryId: int): Store = { ...s, queries: s.queries.union(Set(queryId)) }
pure def canEndQuery(s: Store, queryId: int): bool = s.queries.contains(queryId)
pure def endQuery(s: Store, queryId: int): Store = { ...s, queries: s.queries.exclude(Set(queryId)) }
pure def canWriteLog(s: Store, room: str, at: int): bool = s.phase == Open and at >= 0
pure def writeLog(s: Store, room: str, at: int): Store = { ...s, logs: s.logs.append({ id: s.nextLogId, room: room, at: at }), nextLogId: s.nextLogId + 1 }
pure def canBeginClose(s: Store): bool = s.phase == Open
pure def beginClose(s: Store): Store = { ...s, phase: Closing }
pure def canFinishClose(s: Store): bool = s.phase == Closing and s.queries.size() == 0 and s.sweep == SweepIdle
pure def finishClose(s: Store): Store = { ...s, phase: Closed, locked: false }
pure def alwaysWorkOnlyWhileOpenOrClosing(s: Store): bool = (s.queries.size() > 0 or s.sweep != SweepIdle) implies (s.phase == Open or s.phase == Closing)
pure def stepOnlyASweepRemovesARow(before: Store, via: str, after: Store): bool = {
  val sw = before.sweep
  val targets = match sw { | SweepRunning(r) => r.targets | SweepIdle => List() }
  before.logs.every(r => after.logs.includes(r) or (via == "finishSweep" and targets.includes(r)))
}
pure def sometimesCloseWaitsForAQuery(s: Store): bool = s.phase == Closing and s.queries.size() > 0
pure def sometimesClosedWithRecords(s: Store): bool = s.phase == Closed and s.logs.length() > 0
```

## Story: Forget old logs on schedule

> As the owner, I want my agent to forget old log rows on a schedule, in
> memory and on disk alike, so that the store stays small without losing
> anything else.

### A sweep deletes only log rows past the age bound or beyond the newest rows of their room

With `retention` set, a sweep runs every `intervalMinutes` as a core
exclusive scheduled task, so two sweeps never overlap. It deletes every log
row older than `days` and, in each room, every row beyond the newest
`maxRowsPerRoom` (newer means a later time, then a higher id). A bound of 0
is off, and a `Prune` with both off is refused at open. It reads only ids,
rooms and times. Rows written while it runs stay unless already targeted.
The shell turns the launch's `retention` into `Prune` with
`ageMs = days × 86,400,000`; `KeepLogs` becomes `KeepAll`, which never sweeps.

```quint
pure val nowValues = Set(50000, 200000)
pure def ageLimitMs(r: LogRetention): int = match r { | Prune(x) => x.ageMs | KeepAll => 0 }
pure def roomLimit(r: LogRetention): int = match r { | Prune(x) => x.maxRowsPerRoom | KeepAll => 0 }
pure def newerInRoom(logs: List[LogRow], row: LogRow): int = logs.select(o => o.room == row.room and (o.at > row.at or (o.at == row.at and o.id > row.id))).length()
pure def expired(logs: List[LogRow], row: LogRow, r: LogRetention, now: int): bool =
  (ageLimitMs(r) > 0 and row.at < now - ageLimitMs(r)) or (roomLimit(r) > 0 and newerInRoom(logs, row) >= roomLimit(r))
pure def canBeginSweep(s: Store, now: int): bool = s.phase == Open and s.sweep == SweepIdle and s.launch.retention != KeepAll
pure def beginSweep(s: Store, now: int): Store = { ...s, sweep: SweepRunning({ targets: s.logs.select(r => expired(s.logs, r, s.launch.retention, now)), now: now }) }
pure def canFinishSweep(s: Store): bool = s.sweep != SweepIdle
pure def finishSweep(s: Store): Store = {
  val sw = s.sweep
  val targets = match sw { | SweepRunning(r) => r.targets | SweepIdle => List() }
  val kept = s.logs.select(r => not(targets.includes(r)))
  { ...s, logs: kept, swept: s.swept + s.logs.length() - kept.length(), sweep: SweepIdle }
}
pure def alwaysSweepTargetsStayExpired(s: Store): bool = {
  val sw = s.sweep
  match sw { | SweepRunning(r) => r.targets.every(row => expired(s.logs, row, s.launch.retention, r.now)) | SweepIdle => true }
}
pure def sometimesMemoryStoreSwept(s: Store): bool = s.swept > 0 and not(s.launch.persist)
pure def sometimesDirectorySwept(s: Store): bool = s.swept > 0 and s.launch.persist
pure def sometimesSweepTrimsAYoungRow(s: Store): bool = {
  val sw = s.sweep
  match sw { | SweepRunning(r) => r.targets.some(row => row.at >= r.now - ageLimitMs(s.launch.retention)) | SweepIdle => false }
}
```
