// Storage projection of api/src/a2a-task-state.ts and
// shared/src/lib/services/cloudflare-a2a-task-store.ts. Two optimistic writers,
// one task, two organizations and bounded expiry. Fresh integer versions model
// collision-free UUIDs. Only initial create/import and append updates are in
// scope; arbitrary unconditional overwrites and A2A task-state policy are not.
module a2a_task_store {
  type Store = {
    present: bool,
    version: int,
    nextVersion: int,
    history: Set[int],
    acknowledged: Set[int],
    clock: int,
    expiresAt: int,
    serving: bool,
    fingerprint: int,
    firstFingerprint: int,
    lastReader: int,
    lastRead: Set[int],
  }
  type Snapshot = { ready: bool, version: int, history: Set[int] }
  pure val clients = Set(1, 2)
  pure val emptySnapshot = { ready: false, version: 0, history: Set() }
  var store: Store
  var snapshots: int -> Snapshot

  action init = all {
    store' = {
      present: false, version: 0, nextVersion: 1,
      history: Set(), acknowledged: Set(), clock: 0, expiresAt: 0,
      serving: false, fingerprint: 0, firstFingerprint: 0,
      lastReader: 0, lastRead: Set(),
    },
    snapshots' = Map(1 -> emptySnapshot, 2 -> emptySnapshot),
  }
  val visible = store.present and store.clock < store.expiresAt
  action unchanged = all { store' = store, snapshots' = snapshots }

  // The object's owner is fixed to organization 1. Requests from organization 2
  // cannot read data, write a task or claim an existing namespace.
  action create(organization) = all {
    organization == 1,
    not(visible),
    store.nextVersion <= 6,
    store' = store
      .with("present", true).with("version", store.nextVersion)
      .with("nextVersion", store.nextVersion + 1)
      .with("history", Set(0)).with("acknowledged", Set(0))
      .with("expiresAt", store.clock + 2).with("serving", true),
    snapshots' = snapshots,
  }
  action read(client, organization) = all {
    store' = store.with("serving", true)
      .with("lastReader", organization)
      .with("lastRead", if (organization == 1 and visible) store.history else Set()),
    snapshots' = snapshots.set(client, if (organization == 1 and visible)
      { ready: true, version: store.version, history: store.history } else emptySnapshot),
  }
  def writable(client) = all {
    snapshots.get(client).ready,
    visible,
    snapshots.get(client).version == store.version,
    store.nextVersion <= 6,
  }
  action commitAppend(client) = all {
    writable(client),
    store' = store
      .with("history", snapshots.get(client).history.union(Set(client)))
      .with("acknowledged", store.acknowledged.union(Set(client)))
      .with("version", store.nextVersion).with("nextVersion", store.nextVersion + 1)
      .with("expiresAt", store.clock + 2),
    snapshots' = snapshots.set(client, emptySnapshot),
  }
  action tryAppend(client) = if (writable(client)) commitAppend(client) else all {
    store' = store,
    snapshots' = snapshots.set(client, emptySnapshot),
  }
  action remove = all {
    store' = store.with("present", false).with("history", Set())
      .with("acknowledged", Set()).with("serving", true),
    snapshots' = snapshots,
  }
  action expire = all {
    store.present,
    not(visible),
    store' = store.with("present", false).with("history", Set()).with("acknowledged", Set()),
    snapshots' = snapshots,
  }

  def importable(fingerprint, organization, quiesced) = all {
    organization == 1,
    quiesced,
    not(store.serving),
    store.fingerprint == 0 or store.fingerprint == fingerprint,
    store.nextVersion <= 6,
  }
  action importSnapshot(fingerprint, organization, quiesced) = all {
    importable(fingerprint, organization, quiesced),
    store' = store
      .with("fingerprint", fingerprint)
      .with("firstFingerprint", if (store.firstFingerprint == 0) fingerprint else store.firstFingerprint)
      .with("present", store.clock < 2)
      .with("version", if (store.present or store.clock >= 2) store.version else store.nextVersion)
      .with("nextVersion", if (store.present or store.clock >= 2) store.nextVersion else store.nextVersion + 1)
      .with("history", if (store.clock < 2) Set(0) else Set())
      .with("acknowledged", if (store.clock < 2) Set(0) else Set())
      .with("expiresAt", 2),
    snapshots' = snapshots,
  }
  action tryImport(fingerprint, organization, quiesced) =
    if (importable(fingerprint, organization, quiesced))
      importSnapshot(fingerprint, organization, quiesced) else unchanged
  // Time and process restart do not alter durable content or CAS versions.
  action tick = all {
    store.clock < 4,
    store' = store.with("clock", store.clock + 1),
    snapshots' = snapshots,
  }
  action restartClient(client) = all { store' = store, snapshots' = snapshots.set(client, emptySnapshot) }
  action step = {
    nondet client = clients.oneOf()
    nondet organization = Set(1, 2).oneOf()
    nondet fingerprint = Set(1, 2).oneOf()
    nondet quiesced = Set(false, true).oneOf()
    any {
      create(organization), read(client, organization), tryAppend(client),
      remove, expire, tryImport(fingerprint, organization, quiesced),
      tick, restartClient(client), unchanged,
    }
  }

  val completeHistory = not(store.present) or store.acknowledged.subseteq(store.history)
  val tenantIsolation = store.lastReader != 2 or store.lastRead == Set()
  val immutableImport = store.firstFingerprint == 0 or store.fingerprint == store.firstFingerprint
  val freshVersion = not(store.present) or all { store.version > 0, store.version < store.nextVersion }
  val safety = completeHistory and tenantIsolation and immutableImport and freshVersion

  run competingAppendRetryTest = init.then(create(1))
    .then(read(1, 1)).then(read(2, 1))
    .then(commitAppend(1)).then(tryAppend(2)).then(read(2, 1)).then(commitAppend(2))
    .expect(safety and store.history == Set(0, 1, 2))
  run expiryCannotReviveFromStaleSnapshotTest = init.then(create(1))
    .then(read(1, 1)).then(tick).then(tick).then(tryAppend(1))
    .expect(safety and not(visible))
  run recreatedTaskRejectsOldVersionTest = init.then(create(1)).then(read(1, 1))
    .then(remove).then(create(1)).then(tryAppend(1))
    .expect(safety and store.history == Set(0))
  run foreignReadsHaveNoContentTest = init.then(create(1)).then(read(1, 2))
    .then(tryAppend(1)).expect(safety and store.history == Set(0) and store.lastRead == Set())
  run importIsIdempotentUntilServingTest = init.then(importSnapshot(1, 1, true))
    .then(importSnapshot(1, 1, true)).then(read(1, 1)).then(tryImport(2, 1, true))
    .expect(safety and store.fingerprint == 1 and store.history == Set(0))
  run expiredImportPreservesReceiptTest = init.then(tick).then(tick)
    .then(importSnapshot(1, 1, true)).then(restartClient(1))
    .expect(safety and not(visible) and store.fingerprint == 1)
}
