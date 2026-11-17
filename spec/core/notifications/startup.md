# Notification startup

A service becomes available only after its stored inbox has loaded,
validated and, when it is missing or in the legacy format, been migrated
with an acknowledged write. [Recovery](./recovery.md) owns runtime
registration, deduplication and retry cooldown.

## Story: Publish a notification service only after durable hydration

> As a host, I want the notification service published only after its
> stored inbox has fully loaded and validated, so a malformed or
> half-migrated store never becomes the live inbox.

I await the complete load and any migration write before making
the service available. Read failure, malformed current snapshots, duplicate
legacy IDs and failed migration writes reject startup explicitly. A lost
acknowledgement may still commit the migration. A fresh attempt then loads
that committed snapshot with its original epoch and coordinates.

### Hydration validates every row and the complete coordinate map

The coordinate keys equal the row IDs, are strictly increasing in insertion
order, remain positive and do not exceed the watermark. Header validity
includes version, epoch syntax, safe integer coordinates and container and
row eligibility at the untrusted cache boundary. Invalid snapshots require
repair.

```quint
type Coordinate = { id: str, value: int }
type Snapshot = { rowIds: List[str], coordinates: List[Coordinate], watermark: int, headerValid: bool }
type CoordinateCheck = { valid: bool, previous: int }
pure def checkCoordinate(snapshot: Snapshot, checked: CoordinateCheck, id: str): CoordinateCheck = {
  val entries = snapshot.coordinates.select(entry => entry.id == id)
  val coordinate = entries.nthOr(0, { id: "", value: 0 }).value
  { valid: checked.valid and entries.length() == 1 and coordinate > checked.previous and coordinate <= snapshot.watermark, previous: coordinate }
}
pure def validSnapshot(snapshot: Snapshot): bool =
  snapshot.headerValid and snapshot.watermark >= 0 and snapshot.coordinates.length() == snapshot.rowIds.length() and snapshot.rowIds.foldl({ valid: true, previous: 0 }, (checked, id) => checkCoordinate(snapshot, checked, id)).valid
```

### Current snapshots validate without writes; legacy snapshots migrate in order

A constructor obtains a fresh epoch from the UUID boundary. It is used
only for missing or legacy storage; a current snapshot retains its stored
epoch. The environment may repair the cache after a failed attempt. This
is a serial startup owner; independent external writers during a pending
read or write are outside its contract. Retry creates a fresh startup
attempt. Legacy rows have already passed the eligibility filter, and
migration assigns successive coordinates in original insertion order
before publishing readiness.

```quint
type HydrationFormat = MissingInbox | LegacyInbox | CurrentInbox
type HydrationPhase = UnstartedHydration | ReadingInbox | PersistingMigration | HydrationReady | HydrationFailed
type HydrationWrite = MigrationAcknowledged | MigrationRejectedBefore | MigrationLostAcknowledgement
type StoredInbox = { format: HydrationFormat, epoch: str, snapshot: Snapshot }
type MigrationBuild = { coordinates: List[Coordinate], watermark: int }
type Hydration = { phase: HydrationPhase, store: StoredInbox, freshEpoch: str, candidateEpoch: str, candidate: Snapshot, migrated: bool, retained: List[str], attempted: bool, writes: int, readyPublished: bool }
pure val emptySnapshot: Snapshot = { rowIds: List(), coordinates: List(), watermark: 0, headerValid: true }
pure val emptyStore: StoredInbox = { format: MissingInbox, epoch: "", snapshot: emptySnapshot }
pure val initial: Hydration = { phase: UnstartedHydration, store: emptyStore, freshEpoch: "", candidateEpoch: "", candidate: emptySnapshot, migrated: false, retained: List(), attempted: false, writes: 0, readyPublished: false }
pure def uniqueLegacy(rows: List[str]): bool = rows.every(id => rows.select(other => other == id).length() == 1)
pure def migrateLegacy(rows: List[str]): Snapshot = {
  val built = rows.foldl({ coordinates: List(), watermark: 0 }, (accumulated, id) => { coordinates: accumulated.coordinates.append({ id: id, value: accumulated.watermark + 1 }), watermark: accumulated.watermark + 1 })
  { rowIds: rows, coordinates: built.coordinates, watermark: built.watermark, headerValid: true }
}
pure def canSeedStore(s: Hydration, stored: StoredInbox): bool = s.phase == UnstartedHydration or s.phase == HydrationFailed
pure def seedStore(s: Hydration, stored: StoredInbox): Hydration = { ...s, store: stored }
pure def canBeginLoad(s: Hydration, freshEpoch: str): bool = (s.phase == UnstartedHydration or s.phase == HydrationFailed) and freshEpoch != "" and freshEpoch != s.store.epoch
pure def beginLoad(s: Hydration, freshEpoch: str): Hydration = { ...s, phase: ReadingInbox, freshEpoch: freshEpoch, candidateEpoch: freshEpoch, candidate: emptySnapshot, migrated: false, retained: List(), attempted: true, writes: 0, readyPublished: false }
pure def canReadFailed(s: Hydration): bool = s.phase == ReadingInbox
pure def readFailed(s: Hydration): Hydration = { ...s, phase: HydrationFailed }
pure def canReadLoaded(s: Hydration): bool = s.phase == ReadingInbox
pure def readLoaded(s: Hydration): Hydration =
  if (s.store.format == MissingInbox) { ...s, phase: PersistingMigration, migrated: true, candidate: emptySnapshot, candidateEpoch: s.freshEpoch, retained: List() }
  else if (s.store.format == LegacyInbox) {
    if (uniqueLegacy(s.store.snapshot.rowIds)) { ...s, phase: PersistingMigration, migrated: true, candidate: migrateLegacy(s.store.snapshot.rowIds), candidateEpoch: s.freshEpoch, retained: s.store.snapshot.rowIds }
    else { ...s, phase: HydrationFailed }
  } else if (validSnapshot(s.store.snapshot)) { ...s, phase: HydrationReady, candidate: s.store.snapshot, candidateEpoch: s.store.epoch, readyPublished: true }
  else { ...s, phase: HydrationFailed }
pure def canPersistMigration(s: Hydration, write: HydrationWrite): bool = s.phase == PersistingMigration
pure def persistMigration(s: Hydration, write: HydrationWrite): Hydration = {
  ...s,
  store: if (write == MigrationRejectedBefore) s.store else { format: CurrentInbox, epoch: s.candidateEpoch, snapshot: s.candidate },
  phase: if (write == MigrationAcknowledged) HydrationReady else HydrationFailed,
  readyPublished: write == MigrationAcknowledged,
  writes: s.writes + 1
}
pure val storedValues = Set(
  emptyStore,
  { format: LegacyInbox, epoch: "", snapshot: { rowIds: List("a", "b"), coordinates: List(), watermark: 0, headerValid: false } },
  { format: LegacyInbox, epoch: "", snapshot: { rowIds: List("a", "a"), coordinates: List(), watermark: 0, headerValid: false } },
  { format: CurrentInbox, epoch: "stored-epoch", snapshot: { rowIds: List("a", "b"), coordinates: List({ id: "a", value: 1 }, { id: "b", value: 3 }), watermark: 3, headerValid: true } },
  { format: CurrentInbox, epoch: "stored-epoch", snapshot: { rowIds: List("a", "b"), coordinates: List({ id: "a", value: 3 }, { id: "b", value: 1 }), watermark: 3, headerValid: true } }
)
pure val freshEpochValues = Set("fresh-one", "fresh-two")
pure def alwaysReadyHasDurableCoordinates(s: Hydration): bool = s.phase == HydrationReady implies s.readyPublished and s.store.format == CurrentInbox and s.store.snapshot == s.candidate and s.store.epoch == s.candidateEpoch and validSnapshot(s.candidate)
pure def alwaysReadinessMatchesPhase(s: Hydration): bool = s.readyPublished == (s.phase == HydrationReady)
pure def alwaysMigrationKeepsInsertionOrder(s: Hydration): bool = s.migrated implies s.candidate == migrateLegacy(s.retained) and uniqueLegacy(s.retained)
pure def alwaysPendingMigrationIsValid(s: Hydration): bool = s.phase == PersistingMigration implies s.migrated and validSnapshot(s.candidate) and s.candidateEpoch == s.freshEpoch and s.freshEpoch != "" and s.store.format != CurrentInbox and s.writes == 0
pure def alwaysReadingStartsFresh(s: Hydration): bool = s.phase == ReadingInbox implies not(s.migrated) and s.freshEpoch != "" and s.candidateEpoch == s.freshEpoch and s.candidate == emptySnapshot and s.retained.length() == 0 and s.writes == 0
pure def alwaysStartupAccounting(s: Hydration): bool = s.writes >= 0 and s.writes <= 1 and (s.phase == UnstartedHydration implies not(s.attempted)) and (s.phase != UnstartedHydration implies s.attempted)
pure def stepInvalidCurrentSnapshotNeverWrites(before: Hydration, via: str, after: Hydration): bool = before.store.format == CurrentInbox and not(validSnapshot(before.store.snapshot)) and before.phase != HydrationFailed and before.phase != UnstartedHydration implies after.store == before.store
pure def stepCurrentSnapshotLoadRetainsEpoch(before: Hydration, via: str, after: Hydration): bool = via == "readLoaded" and before.store.format == CurrentInbox and after.phase == HydrationReady implies after.candidateEpoch == before.store.epoch and after.writes == before.writes
pure def sometimesMigrationCommitsWithoutReady(s: Hydration): bool = s.phase == HydrationFailed and s.migrated and s.writes == 1 and s.store.format == CurrentInbox and s.store.snapshot == s.candidate
pure def sometimesCurrentSnapshotReady(s: Hydration): bool = s.phase == HydrationReady and not(s.migrated)
pure def sometimesDuplicateLegacyRejected(s: Hydration): bool = s.phase == HydrationFailed and s.store.format == LegacyInbox and not(uniqueLegacy(s.store.snapshot.rowIds))
```

### Startup settles only when its admitted cache calls return

The successful-read action may instead take the explicit failure outcome.
Weak fairness of the cache completion and migration completion actions
states that an admitted call eventually returns or throws. It does not
assume that storage succeeds or that a broken adapter returns without this
assumption. Further retries and repairs are host decisions.

```quint
pure val fair_readLoaded = "weak"
pure val fair_persistMigration = "weak"
pure def leadsToHydrationAttemptSettles(s: Hydration, later: Hydration): bool = (s.phase == ReadingInbox or s.phase == PersistingMigration) implies later.phase == HydrationReady or later.phase == HydrationFailed
```
