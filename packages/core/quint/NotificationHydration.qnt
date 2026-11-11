// Startup observes one atomic cache value. Readiness follows complete coordinate
// validation or an acknowledged migration write. A failed attempt may be retried.
module NotificationHydration {
  type Snapshot = { headerOK: bool, epoch: str, watermark: int, rows: List[str],
    coordinates: str -> int, unsafe: Set[str] }
  type Store = { format: str, snapshot: Snapshot }
  pure val empty: Snapshot = { headerOK: true, epoch: "fresh", watermark: 0,
    rows: [], coordinates: Map(), unsafe: Set() }
  pure val valid: Snapshot = { headerOK: true, epoch: "old", watermark: 3,
    rows: ["a", "b"], coordinates: Map("a" -> 1, "b" -> 3), unsafe: Set() }
  // Representative semantic failures, selected one at a time.
  pure val snapshots = Set(
    valid, { ...valid, rows: [], coordinates: Map() },
    { ...valid, headerOK: false }, { ...valid, watermark: -1 },
    { ...valid, coordinates: Map("a" -> 1) },
    { ...valid, coordinates: Map("a" -> 1, "b" -> 3, "extra" -> 2) },
    { ...valid, coordinates: Map("a" -> 1, "extra" -> 3) },
    { ...valid, rows: ["a", "a"] },
    { ...valid, coordinates: Map("a" -> 3, "b" -> 1) },
    { ...valid, coordinates: Map("a" -> 1, "b" -> 1) },
    { ...valid, coordinates: Map("a" -> 0, "b" -> 3) },
    { ...valid, coordinates: Map("a" -> 1, "b" -> 4) },
    { ...valid, unsafe: Set("a") })
  pure def completeCoordinates(snapshot: Snapshot): bool = and {
    snapshot.headerOK, snapshot.watermark >= 0,
    snapshot.coordinates.keys().size() == snapshot.rows.length(),
    snapshot.rows.indices().forall(i => {
      val row = snapshot.rows.nth(i)
      if (not(snapshot.coordinates.keys().contains(row)) or snapshot.unsafe.contains(row)) false
      else snapshot.coordinates.get(row) > 0 and snapshot.coordinates.get(row) <= snapshot.watermark
        and (if (i == 0) true
          else if (not(snapshot.coordinates.keys().contains(snapshot.rows.nth(i - 1)))) false
          else snapshot.coordinates.get(row) > snapshot.coordinates.get(snapshot.rows.nth(i - 1)))
    }),
  }
  pure def migrate(rows: List[str]): Snapshot = { ...empty, rows: rows, watermark: rows.length(),
    coordinates: rows.indices().map(i => (rows.nth(i), i + 1)).setToMap() }

  var s: { store: Store, candidate: Snapshot, phase: str, index: int, previous: int }
  action start(store: Store): bool =
    s' = { store: store, candidate: empty, phase: "read", index: 0, previous: 0 }
  action init = {
    nondet store = snapshots.map(snapshot => { format: "v2", snapshot: snapshot }).union(Set(
      { format: "missing", snapshot: empty },
      { format: "legacy", snapshot: { ...empty, rows: ["a", "b"] } },
      { format: "legacy", snapshot: { ...empty, rows: ["a", "a"] } })).oneOf()
    start(store)
  }
  action read(succeeded: bool): bool = {
    val stored = s.store.snapshot
    val uniqueLegacy = stored.rows.indices().map(i => stored.rows.nth(i)).size() == stored.rows.length()
    all {
      s.phase == "read",
      s' = if (not(succeeded)) { ...s, phase: "failed" }
        else if (s.store.format == "missing")
          { ...s, candidate: empty, phase: "persist" }
        else if (s.store.format == "legacy")
          if (uniqueLegacy) { ...s, candidate: migrate(stored.rows), phase: "persist" }
          else { ...s, phase: "failed" }
        else if (not(stored.headerOK) or stored.watermark < 0
          or stored.coordinates.keys().size() != stored.rows.length())
          { ...s, phase: "failed" }
        else { ...s, candidate: stored, phase: "validate", index: 0, previous: 0 },
    }
  }
  action validate = all {
    s.phase == "validate",
    s' = if (s.index == s.candidate.rows.length()) { ...s, phase: "ready" }
      else {
        val row = s.candidate.rows.nth(s.index)
        if (not(s.candidate.coordinates.keys().contains(row)) or s.candidate.unsafe.contains(row))
          { ...s, phase: "failed" }
        else {
          val coordinate = s.candidate.coordinates.get(row)
          if (coordinate <= s.previous or coordinate > s.candidate.watermark) { ...s, phase: "failed" }
          else { ...s, index: s.index + 1, previous: coordinate }
        }
      },
  }
  action persist(outcome: str): bool = all {
    s.phase == "persist",
    s' = { ...s, store: if (outcome == "before-failure") s.store
      else { format: "v2", snapshot: s.candidate },
      phase: if (outcome == "ack") "ready" else "failed" },
  }
  action retry = all {
    s.phase == "failed",
    s' = { ...s, phase: "read", candidate: empty, index: 0, previous: 0 },
  }
  action repair = all {
    s.phase == "failed", s' = { ...s, store: { format: "v2", snapshot: valid } },
  }
  action step = {
    nondet success = Set(true, false).oneOf()
    nondet outcome = Set("ack", "before-failure", "after-failure").oneOf()
    any { read(success), validate, persist(outcome), retry, repair, s' = s }
  }

  val ReadyHasDurableCoordinates = (s.phase == "ready").implies(
    s.store.format == "v2" and s.store.snapshot == s.candidate and completeCoordinates(s.candidate))
  val MigrationPreservesInsertionOrder = (Set("persist", "ready").contains(s.phase) and s.candidate.epoch == "fresh")
    .implies(s.candidate.rows.indices().forall(i =>
      s.candidate.coordinates.get(s.candidate.rows.nth(i)) == i + 1))
  temporal InvalidV2IsNeverOverwritten = always(
    (s.store.format == "v2" and not(completeCoordinates(s.store.snapshot)) and s.phase != "failed")
      .implies(next(s.store) == s.store).orKeep(s))
  temporal AttemptsSettle = ((read(true) or read(false)).weakFair(s) and validate.weakFair(s)
    and (persist("ack") or persist("before-failure") or persist("after-failure")).weakFair(s))
    .implies(Set("read", "validate", "persist").contains(s.phase).leadsTo(Set("ready", "failed").contains(s.phase)))
  temporal RepairedStoreBecomesReady = (retry.weakFair(s) and read(true).strongFair(s) and validate.weakFair(s))
    .implies((s.store.format == "v2" and completeCoordinates(s.store.snapshot)).leadsTo(s.phase == "ready"))
  temporal StartupFinishesWithoutFairness =
    Set("read", "validate", "persist").contains(s.phase).leadsTo(Set("ready", "failed").contains(s.phase))

  run lostMigrationAckUsesCommittedCoordinatesTest =
    start({ format: "legacy", snapshot: { ...empty, rows: ["a", "b"] } })
      .then(read(true)).then(persist("after-failure")).expect(s.phase == "failed" and s.store.format == "v2")
      .then(retry).then(read(true)).then(validate).then(validate).then(validate)
      .expect(ReadyHasDurableCoordinates and s.candidate.epoch == "fresh")
  run invalidCoordinatesWaitForRepairTest =
    start({ format: "v2", snapshot: { ...valid, unsafe: Set("a") } })
      .then(read(true)).then(validate).expect(s.phase == "failed")
      .then(repair).then(retry).then(read(true)).then(validate).then(validate).then(validate)
      .expect(ReadyHasDurableCoordinates)
}
