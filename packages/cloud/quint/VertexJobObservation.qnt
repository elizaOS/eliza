// vertex-model-registry.ts: provider reads and immutable payload preparation
// precede the locked applyObservation transaction; strict hydration follows it.
// Versions are exact provider update timestamp ranks, including sub-millisecond order.
// completion identifies the first terminal observation, not provider endTime.
// Resource tokens denote the exact provider-associated names. Their association
// with the requested job is trusted, not inferred from project ID/number spelling.
module VertexJobObservation {
  const ForeignModel: bool
  type Observation = { version: int, state: str, resource: int }
  type Worker = { phase: str, body: int, receipt: int, returned: int }
  type State = {
    exists: bool, version: int, body: int, state: str, resource: int,
    revision: int, completion: int, modelReceipt: int,
    objects: int -> int, present: Set[int], workers: int -> Worker,
    backward: bool, changedTerminal: bool, faultUsed: bool,
    publishedAfterDelete: bool, wrongRelease: bool
  }
  pure val Workers = Set(0, 1)
  pure val Bodies = Set(1, 2, 3, 4, 5, 6, 7, 8)
  pure val Observations = Map(
    0 -> { version: 0, state: "running", resource: 0 },
    1 -> { version: 1, state: "running", resource: 0 },
    2 -> { version: 2, state: "succeeded", resource: 1 },
    3 -> { version: 2, state: "running", resource: 0 },
    4 -> { version: 3, state: "succeeded", resource: 1 },
    5 -> { version: 3, state: "succeeded", resource: 2 },
    6 -> { version: 3, state: "failed", resource: 0 },
    7 -> { version: 1, state: "cancelling", resource: 0 },
    8 -> { version: 1, state: "partial", resource: 0 }
  )
  var s: State
  action init = s' = {
    exists: true, version: 0, body: 0, state: "running", resource: 0,
    revision: 0, completion: 0, modelReceipt: 0,
    objects: Set(0, 1, 2, 3, 4, 5, 6, 7, 8).mapBy(_ => 0), present: Set(0),
    workers: Workers.mapBy(_ => { phase: "idle", body: 0, receipt: 0, returned: -1 }),
    backward: false, changedTerminal: false, faultUsed: false,
    publishedAfterDelete: false, wrongRelease: false
  }
  def terminal(state: str): bool = Set("succeeded", "failed").contains(state)
  def worker(w: int, phase: str, body: int, receipt: int, returned: int): int -> Worker =
    s.workers.set(w, { phase: phase, body: body, receipt: receipt, returned: returned })
  action Begin(w: int, authorized: bool): bool = all {
    s.workers.get(w).phase == "idle",
    s' = {...s, workers: worker(w, if (authorized and s.exists) "fetching" else "done", 0, 0, -1)}
  }
  action Fetch(w: int): bool = {
    nondet body = Bodies.oneOf()
    all { s.workers.get(w).phase == "fetching",
      s' = {...s, workers: worker(w, "preparing", body, 0, -1)} }
  }
  action FetchBody(w: int, body: int): bool = all {
    s.workers.get(w).phase == "fetching",
    s' = {...s, workers: worker(w, "preparing", body, 0, -1)}
  }
  action InvalidProvider(w: int): bool = all {
    s.workers.get(w).phase == "fetching",
    s' = {...s, workers: worker(w, "done", 0, 0, -1)}
  }
  action Prepare(w: int): bool = {
    val b = s.workers.get(w).body
    all { s.workers.get(w).phase == "preparing",
      s' = if (s.present.contains(b) and s.objects.get(b) != b) {
        ...s, workers: worker(w, "done", b, 0, -1)
      } else {
        ...s, objects: s.objects.set(b, b), present: s.present.union(Set(b)),
        workers: worker(w, "ready", b, 0, -1)
      }
    }
  }
  // One committed SQL action includes both the accepted observation and the
  // model receipt. Storage/SQL failures may leave an unreferenced object only.
  action Commit(w: int): bool = {
    val b = s.workers.get(w).body
    val o = Observations.get(b)
    val newer = o.version > s.version
    val conflict = (o.version == s.version and b != s.body) or
      (newer and terminal(s.state) and (o.state != s.state or o.resource != s.resource)) or
      (newer and s.state == "cancelling" and not(Set("cancelling", "succeeded", "failed").contains(o.state)))
    all { s.workers.get(w).phase == "ready",
      s' = if (not(s.exists) or conflict or (newer and o.state == "succeeded" and ForeignModel)) {
        ...s, workers: worker(w, "done", b, 0, -1)
      } else if (not(newer)) {
        ...s, workers: worker(w, "committed", b, s.body, -1)
      } else {
        ...s, version: o.version, body: b, state: o.state, resource: o.resource,
        revision: s.revision + 1,
        completion: if (s.completion != 0) s.completion else if (terminal(o.state)) o.version else 0,
        modelReceipt: if (s.modelReceipt != 0) s.modelReceipt else if (o.state == "succeeded") b else 0,
        workers: worker(w, "committed", b, b, -1),
        backward: s.backward or o.version < s.version,
        changedTerminal: s.changedTerminal or (terminal(s.state) and (o.state != s.state or o.resource != s.resource)),
        publishedAfterDelete: s.publishedAfterDelete or not(s.exists)
      }
    }
  }
  action Rollback(w: int): bool = all {
    Set("preparing", "ready").contains(s.workers.get(w).phase),
    s' = {...s, workers: worker(w, "done", s.workers.get(w).body, 0, -1)}
  }
  action Hydrate(w: int): bool = {
    val r = s.workers.get(w).receipt
    all { s.workers.get(w).phase == "committed",
      s' = if (s.present.contains(r) and s.objects.get(r) == r) {
        ...s, workers: worker(w, "done", s.workers.get(w).body, r, s.objects.get(r)),
        wrongRelease: s.wrongRelease or s.objects.get(r) != r
      } else {...s, workers: worker(w, "done", s.workers.get(w).body, r, -1)}
    }
  }
  action Delete = s' = {...s, exists: false}
  action LoseObject(b: int): bool = all { not(s.faultUsed), s.present.contains(b), s' = {...s, present: s.present.exclude(Set(b)), faultUsed: true} }
  action CorruptObject(b: int): bool = all { not(s.faultUsed), s.present.contains(b), s' = {...s, objects: s.objects.set(b, 9), faultUsed: true} }
  action step = {
    nondet w = Workers.oneOf()
    nondet b = Bodies.oneOf()
    nondet authorized = Set(false, true).oneOf()
    any { Begin(w, authorized), Fetch(w), InvalidProvider(w), Prepare(w), Commit(w),
      Rollback(w), Hydrate(w), Delete, LoseObject(b), CorruptObject(b), s' = s }
  }
  val safety = all {
    not(s.backward), not(s.changedTerminal),
    not(s.publishedAfterDelete), not(s.wrongRelease),
    not(ForeignModel) or s.modelReceipt == 0,
    s.modelReceipt == 0 or (Observations.get(s.modelReceipt).state == "succeeded" and s.completion == Observations.get(s.modelReceipt).version),
    Workers.forall(w => s.workers.get(w).returned == -1 or s.workers.get(w).returned == s.workers.get(w).receipt)
  }
  temporal RequestsSettle = Workers.forall(w => Fetch(w).weakFair(s) and Prepare(w).weakFair(s) and Commit(w).weakFair(s) and Hydrate(w).weakFair(s)) implies
    eventually(always(Workers.forall(w => Set("idle", "done").contains(s.workers.get(w).phase))))
  action UnsafeStaleCommit(w: int): bool = {
    val o = Observations.get(s.workers.get(w).body)
    s' = {...s, version: o.version, state: o.state, body: s.workers.get(w).body,
      backward: o.version < s.version}
  }
  action UnsafeHydrate(w: int): bool = {
    val r = s.workers.get(w).receipt
    s' = {...s, workers: worker(w, "done", s.workers.get(w).body, r, s.objects.get(r)),
      wrongRelease: s.objects.get(r) != r}
  }
  action UnsafePublishAfterDelete = s' = {...s, modelReceipt: 2, completion: 2, publishedAfterDelete: not(s.exists)}
}

module VertexJobObservation_owned {
  import VertexJobObservation(ForeignModel = false).*
  run invalidScopeNeverFetchesTest = init.then(Begin(0, false)).expect(safety and s.workers.get(0).phase == "done" and s.revision == 0)
  run cancellingCannotResumeRunningTest = init.then(Begin(0, true)).then(FetchBody(0, 7)).then(Prepare(0)).then(Commit(0))
    .then(Begin(1, true)).then(FetchBody(1, 3)).then(Prepare(1)).then(Commit(1)).expect(safety and s.state == "cancelling" and s.body == 7)
  run partialSuccessCanReachDefinitiveSuccessTest = init.then(Begin(0, true)).then(FetchBody(0, 8)).then(Prepare(0)).then(Commit(0))
    .then(Begin(1, true)).then(FetchBody(1, 2)).then(Prepare(1)).then(Commit(1)).expect(safety and s.state == "succeeded" and s.completion == 2)
  run delayedPartialCannotRegressDefinitiveSuccessTest = init.then(Begin(0, true)).then(FetchBody(0, 8)).then(Prepare(0))
    .then(Begin(1, true)).then(FetchBody(1, 2)).then(Prepare(1)).then(Commit(1)).then(Commit(0)).expect(safety and s.state == "succeeded" and s.version == 2)
  run outOfOrderReadReturnsWinningReceiptTest = init.then(Begin(0, true)).then(FetchBody(0, 1)).then(Prepare(0))
    .then(Begin(1, true)).then(FetchBody(1, 2)).then(Prepare(1)).then(Commit(1)).then(Commit(0)).then(Hydrate(0))
    .expect(safety and s.version == 2 and s.workers.get(0).returned == 2)
  run sameTerminalMetadataPreservesOriginalCompletionTest = init.then(Begin(0, true)).then(FetchBody(0, 2)).then(Prepare(0)).then(Commit(0))
    .then(Begin(1, true)).then(FetchBody(1, 4)).then(Prepare(1)).then(Commit(1))
    .expect(safety and s.version == 3 and s.body == 4 and s.modelReceipt == 2 and s.completion == 2)
  run rollbackRetryReusesImmutableGenerationTest = init.then(Begin(0, true)).then(FetchBody(0, 2)).then(Prepare(0)).then(Rollback(0))
    .then(Begin(1, true)).then(FetchBody(1, 2)).then(Prepare(1)).then(Commit(1)).then(Hydrate(1))
    .expect(safety and s.modelReceipt == 2 and s.workers.get(1).returned == 2)
  run deletionBeforePublicationLeavesNoModelTest = init.then(Begin(0, true)).then(FetchBody(0, 2)).then(Prepare(0)).then(Delete).then(Commit(0))
    .expect(safety and s.modelReceipt == 0 and s.workers.get(0).returned == -1)
  run changedTerminalResourceRefusedTest = init.then(Begin(0, true)).then(FetchBody(0, 2)).then(Prepare(0)).then(Commit(0))
    .then(Begin(1, true)).then(FetchBody(1, 5)).then(Prepare(1)).then(Commit(1)).expect(safety and s.body == 2)
  run sameVersionConflictingBodyRefusedTest = init.then(Begin(0, true)).then(FetchBody(0, 2)).then(Prepare(0)).then(Commit(0))
    .then(Begin(1, true)).then(FetchBody(1, 3)).then(Prepare(1)).then(Commit(1)).expect(safety and s.body == 2)
  run corruptStoredPayloadFailsClosedTest = init.then(Begin(0, true)).then(FetchBody(0, 2)).then(Prepare(0)).then(Commit(0))
    .then(CorruptObject(2)).then(Hydrate(0)).expect(safety and s.workers.get(0).returned == -1)
  run staleWriteNegativeWitnessTest = init.then(Begin(0, true)).then(FetchBody(0, 1)).then(Prepare(0))
    .then(Begin(1, true)).then(FetchBody(1, 2)).then(Prepare(1)).then(Commit(1)).then(UnsafeStaleCommit(0)).expect(not(safety))
  run mutablePayloadFallbackNegativeWitnessTest = init.then(Begin(0, true)).then(FetchBody(0, 2)).then(Prepare(0)).then(Commit(0))
    .then(CorruptObject(2)).then(UnsafeHydrate(0)).expect(not(safety))
  run deletedRowPublicationNegativeWitnessTest = init.then(Delete).then(UnsafePublishAfterDelete).expect(not(safety))
}
module VertexJobObservation_collision {
  import VertexJobObservation(ForeignModel = true).*
  run modelCollisionRollsBackObservationTest = init.then(Begin(0, true)).then(FetchBody(0, 2)).then(Prepare(0)).then(Commit(0))
    .expect(safety and s.version == 0 and s.modelReceipt == 0)
}
