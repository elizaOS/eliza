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
    store' = store.with("serving", store.serving or organization == 1)
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
  run rejectedForeignReadKeepsImportOpenTest = init.then(importSnapshot(1, 1, true))
    .then(read(1, 2)).then(importSnapshot(1, 1, true))
    .expect(safety and not(store.serving) and store.fingerprint == 1)
  run importIsIdempotentUntilServingTest = init.then(importSnapshot(1, 1, true))
    .then(importSnapshot(1, 1, true)).then(read(1, 1)).then(tryImport(2, 1, true))
    .expect(safety and store.fingerprint == 1 and store.history == Set(0))
  run expiredImportPreservesReceiptTest = init.then(tick).then(tick)
    .then(importSnapshot(1, 1, true)).then(restartClient(1))
    .expect(safety and not(visible) and store.fingerprint == 1)
}

// Platform cancellation reads an update snapshot. It can publish only against
// that version. A conflict re-reads before applying the terminal-state guard.
// The other terminal publisher is one message/send completed receipt.
module a2a_task_terminal {
  type Task = { status: str, version: int, history: List[str], artifacts: List[str] }
  type Request = { status: str, version: int }
  pure val callers = Set(1, 2)
  pure val reading = { status: "reading", version: 0 }
  pure val submittedHistory = List("original request")
  pure val completedHistory = List("new request", "completed response")
  pure val completedArtifacts = List("complete artifact")

  var s: { task: Task, requests: int -> Request }

  action init = s' = {
    task: { status: "working", version: 1, history: submittedHistory, artifacts: List() },
    requests: Map(1 -> reading, 2 -> reading),
  }

  action readRequest(caller: int): bool = all {
    s.requests.get(caller).status == "reading",
    s' = s.with("requests", s.requests.set(caller,
      if (s.task.status == "working") { status: "writing", version: s.task.version }
      else { status: "refused", version: 0 })),
  }

  action writeRequest(caller: int): bool = {
    val claim = s.requests.get(caller)
    all {
      claim.status == "writing",
      s' = if (claim.version != s.task.version)
        s.with("requests", s.requests.set(caller, reading))
      else
        s.with("task", s.task.with("status", "canceled").with("version", s.task.version + 1))
          .with("requests", s.requests.set(caller,
            { status: "acknowledged", version: s.task.version + 1 })),
    }
  }

  action publishCompletion = all {
    s.task.status == "working",
    s' = s.with("task", {
      status: "completed", version: s.task.version + 1,
      history: completedHistory, artifacts: completedArtifacts,
    }),
  }

  action step = {
    nondet caller = callers.oneOf()
    any { readRequest(caller), writeRequest(caller), publishCompletion, s' = s }
  }

  val receipts = callers.filter(caller => s.requests.get(caller).status == "acknowledged")
  val CancellationAcknowledgesStoredVersion =
    if (s.task.status == "canceled")
      receipts.size() == 1 and receipts.forall(caller => s.requests.get(caller).version == s.task.version)
    else receipts == Set()
  val CompletedOutputRetained = s.task.status == "completed" implies
    (s.task.history == completedHistory and s.task.artifacts == completedArtifacts)

  temporal TerminalReceiptStable =
    always((s.task.status != "working" implies next(s.task) == s.task).orKeep(s))
  temporal RequestsSettle = eventually(callers.forall(caller =>
    Set("acknowledged", "refused").contains(s.requests.get(caller).status)))
  temporal FairRequestsSettle =
    (readRequest(1).weakFair(s) and writeRequest(1).weakFair(s)
      and readRequest(2).weakFair(s) and writeRequest(2).weakFair(s)) implies RequestsSettle

  run StaleCancelPreservesCompletedReceiptTest = init.then(readRequest(1))
    .then(publishCompletion).then(writeRequest(1)).then(readRequest(1))
    .expect(s.requests.get(1).status == "refused" and s.task.status == "completed"
      and CompletedOutputRetained and CancellationAcknowledgesStoredVersion)

  run CompetingCancelsAcknowledgeOneReceiptTest = init.then(readRequest(1))
    .then(readRequest(2)).then(writeRequest(2)).then(writeRequest(1)).then(readRequest(1))
    .expect(s.requests.get(1).status == "refused" and receipts == Set(2)
      and CancellationAcknowledgesStoredVersion and s.task.history == submittedHistory)
}
