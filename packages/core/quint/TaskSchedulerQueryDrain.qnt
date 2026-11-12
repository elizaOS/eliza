// External query ownership outlives scheduler attachment. Registration identity
// controls dispatch, while service retirement waits for its actual adapter use.
module TaskSchedulerQueryDrain {
  val Services = Set("old", "replacement")
  val Queries = Set("first", "second")
  val Adapters = Set("storage-old", "storage-new")
  type Query = { phase: str, owner: str, registration: int, generation: int, adapter: str }
  var s: { active: bool, adapter: str, retiredAdapters: Set[str], closedAdapters: Set[str], generation: int, registry: str, registration: int,
    queries: str -> Query, retired: Set[str], closed: Set[str],
    stopRequested: bool, stopReturned: bool, restarted: bool,
    stopQueries: Set[str] }

  val dispatched = Queries.filter(q => s.queries.get(q).phase == "dispatched")
  val pendingQueries = Queries.filter(q => s.queries.get(q).phase == "query")
  def adapterPending(owner: str): Set[str] =
    pendingQueries.filter(q => s.queries.get(q).adapter == owner)
  def ownedPending(owner: str): Set[str] =
    pendingQueries.filter(q => s.queries.get(q).owner == owner)
  action init = s' = { active: true, adapter: "storage-old", retiredAdapters: Set(), closedAdapters: Set(), generation: 0, registry: "none", registration: 0,
    queries: Queries.mapBy(_ => { phase: "idle", owner: "none", registration: 0, generation: 0, adapter: "none" }),
    retired: Set(), closed: Set(), stopRequested: false, stopReturned: false,
    restarted: false, stopQueries: Set() }
  action register(owner: str): bool = all {
    s.active, not(s.retired.contains(owner)), s.registration < 2,
    s' = { ...s, registry: owner, registration: s.registration + 1 },
  }
  action begin(q: str): bool = all {
    s.active, s.registry != "none", s.queries.get(q).phase == "idle",
    s' = { ...s, queries: s.queries.set(q, { phase: "query", owner: s.registry,
      registration: s.registration, generation: s.generation, adapter: s.adapter }) },
  }
  action unregister(owner: str): bool = s' = { ...s,
    retired: s.retired.union(Set(owner)),
    registry: if (s.registry == owner) "none" else s.registry }
  action closeStorage(owner: str): bool = all {
    s.retired.contains(owner), ownedPending(owner).size() == 0,
    s' = { ...s, closed: s.closed.union(Set(owner)) },
  }
  action retireAdapter(owner: str): bool = s' = { ...s,
    retiredAdapters: s.retiredAdapters.union(Set(owner)),
    active: if (s.adapter == owner) false else s.active,
    registry: if (s.adapter == owner) "none" else s.registry,
    generation: if (s.adapter == owner and not(s.retiredAdapters.contains(owner))) s.generation + 1 else s.generation }
  action closeAdapter(owner: str): bool = all {
    s.retiredAdapters.contains(owner), adapterPending(owner).size() == 0,
    s' = { ...s, closedAdapters: s.closedAdapters.union(Set(owner)) },
  }
  action settle(q: str, succeeded: bool): bool = all {
    s.queries.get(q).phase == "query",
    s' = { ...s, queries: s.queries.set(q, { ...s.queries.get(q),
      phase: if (succeeded) "result" else "failed" }) },
  }
  action dispatch(q: str): bool = {
    val query = s.queries.get(q)
    all {
      query.phase == "result", s.active, query.generation == s.generation,
      query.registration == s.registration, query.owner == s.registry,
      s' = { ...s, queries: s.queries.set(q, { ...query, phase: "dispatched" }) },
    }
  }
  action stopScheduler = all {
    not(s.stopRequested),
    s' = { ...s, active: false, generation: s.generation + 1, registry: "none",
      stopRequested: true, stopQueries: pendingQueries },
  }
  action returnSchedulerStop = all {
    s.stopRequested, s.stopQueries.intersect(pendingQueries).size() == 0,
    s' = { ...s, stopReturned: true },
  }
  action restart = all {
    s.stopRequested, not(s.restarted), not(s.retiredAdapters.contains("storage-new")),
    s' = { ...s, active: true, adapter: "storage-new", generation: s.generation + 1, restarted: true },
  }
  action step = any {
    {
      nondet owner = Services.oneOf()
      any { register(owner), unregister(owner), closeStorage(owner) }
    },
    {
      nondet q = Queries.oneOf()
      any { begin(q), settle(q, true), settle(q, false), dispatch(q) }
    },
    {
      nondet owner = Adapters.oneOf()
      any { retireAdapter(owner), closeAdapter(owner) }
    },
    stopScheduler, returnSchedulerStop, restart, s' = s,
  }

  val ClosedStorageHasNoQueries = s.closed.forall(owner => ownedPending(owner).size() == 0)
  val ClosedAdapterHasNoQueries = s.closedAdapters.forall(owner => adapterPending(owner).size() == 0)
  val SchedulerStopDrainsCapturedQueries = s.stopReturned.implies(
    s.stopQueries.intersect(pendingQueries).size() == 0)
  temporal RetiredServicesReceiveNoNewDispatch = always(Services.forall(owner =>
    s.retired.contains(owner).implies(Queries.forall(q =>
      (not(dispatched.contains(q)) and next(dispatched).contains(q))
        .implies(s.queries.get(q).owner != owner)))).orKeep(s))
  temporal NoNewQueriesForClosedStorage = always(Queries.forall(q =>
    (not(pendingQueries.contains(q)) and next(pendingQueries).contains(q))
      .implies(not(s.closed.contains(next(s.queries.get(q).owner))))).orKeep(s))
  temporal DrainFairness = Queries.forall(q => (settle(q, true) or settle(q, false)).weakFair(s))
    and Services.forall(owner => closeStorage(owner).weakFair(s))
    and Adapters.forall(owner => closeAdapter(owner).weakFair(s))
    and returnSchedulerStop.weakFair(s)
  temporal RetiredStorageCloses = DrainFairness.implies(
    Services.forall(owner => s.retired.contains(owner).leadsTo(s.closed.contains(owner))))
  temporal RetiredAdaptersClose = DrainFairness.implies(
    Adapters.forall(owner => s.retiredAdapters.contains(owner).leadsTo(s.closedAdapters.contains(owner))))
  temporal SchedulerStopReturns = DrainFairness.implies(s.stopRequested.leadsTo(s.stopReturned))

  run stoppedServiceRetainsPendingQueryTest = init.then(register("old")).then(begin("first"))
    .then(unregister("old")).expect(ownedPending("old") == Set("first"))
    .then(settle("first", true)).then(closeStorage("old")).expect(ClosedStorageHasNoQueries)
  run replacementRunsWhileOldQueryDrainsTest = init.then(register("old")).then(begin("first"))
    .then(stopScheduler).then(restart).then(register("replacement")).then(unregister("old"))
    .expect(s.registry == "replacement" and not(s.stopReturned))
    .then(begin("second")).then(settle("second", true)).then(dispatch("second"))
    .then(settle("first", false)).then(returnSchedulerStop).then(closeStorage("old"))
    .expect(s.stopReturned and dispatched == Set("second") and ClosedStorageHasNoQueries)
  run adapterOwnerOutsideQuerySnapshotTest = init.then(register("replacement")).then(begin("first"))
    .then(stopScheduler).then(restart).then(register("replacement"))
    .then(retireAdapter("storage-old")).expect(adapterPending("storage-old") == Set("first"))
    .then(begin("second")).then(settle("second", true)).then(dispatch("second"))
    .then(settle("first", true)).then(closeAdapter("storage-old"))
    .expect(s.active and s.adapter == "storage-new" and ClosedAdapterHasNoQueries)

}

// task-scheduler.ts checks each group again before dispatch because an earlier
// service can await inside runTick. The first and peer roles follow the query's
// result order. One existing batch and one fresh peer query bound the projection.
module TaskSchedulerBatchDispatch {
  var s: {
    phase: str, includesFirst: bool, groupedPeer: bool, peerTaskPending: bool,
    peerRegistration: int, capturedPeer: int, replacementRegistered: bool,
    oldPeerUnregistered: bool, peerDirty: bool, peerDispatches: int,
    dispatchedRegistration: int, currentAtDispatch: int
  }
  action init = s' = {
    phase: "query", includesFirst: true, groupedPeer: false, peerTaskPending: true,
    peerRegistration: 1, capturedPeer: 1, replacementRegistered: false,
    oldPeerUnregistered: false, peerDirty: false, peerDispatches: 0,
    dispatchedRegistration: 0, currentAtDispatch: 0
  }
  action registerReplacement = all {
    not(s.replacementRegistered),
    s' = { ...s, replacementRegistered: true, peerRegistration: 2, peerDirty: true }
  }
  action unregisterOldPeer = all {
    not(s.oldPeerUnregistered),
    s' = { ...s, oldPeerUnregistered: true,
      peerRegistration: if (s.peerRegistration == 1) 0 else s.peerRegistration,
      peerDirty: s.peerRegistration != 1 and s.peerDirty }
  }
  action receiveQuery = all {
    s.phase == "query",
    s' = { ...s, phase: if (s.includesFirst) "first-ready" else "peer-ready",
      groupedPeer: s.peerTaskPending and s.peerRegistration == s.capturedPeer }
  }
  action dispatchFirst = all {
    s.phase == "first-ready", s' = { ...s, phase: "first-running" }
  }
  action settleFirst = all {
    s.phase == "first-running", s' = { ...s, phase: "peer-ready" }
  }
  val peerIsCurrent = s.groupedPeer and s.capturedPeer == s.peerRegistration
  action deliverPeer = s' = { ...s, phase: "peer-running", peerDispatches: s.peerDispatches + 1,
    dispatchedRegistration: s.capturedPeer, currentAtDispatch: s.peerRegistration }
  action dispatchPeer = all { s.phase == "peer-ready", peerIsCurrent, deliverPeer }
  action skipPeer = all {
    s.phase == "peer-ready", not(peerIsCurrent), s' = { ...s, phase: "done" }
  }
  action settlePeer = all {
    s.phase == "peer-running", s' = { ...s, phase: "done", peerTaskPending: false }
  }
  action queryReplacement = all {
    s.phase == "done", s.peerDirty, s.peerTaskPending, s.peerRegistration == 2,
    s' = { ...s, phase: "query", includesFirst: false, groupedPeer: false,
      capturedPeer: s.peerRegistration, peerDirty: false }
  }
  action advance = any { receiveQuery, dispatchFirst, settleFirst, dispatchPeer,
    skipPeer, settlePeer, queryReplacement }
  action step = any { registerReplacement, unregisterOldPeer, advance, s' = s }

  val DispatchUsesCurrentRegistration = s.peerDispatches > 0 implies
    s.dispatchedRegistration == s.currentAtDispatch
  val OldUnregisterKeepsReplacement = s.replacementRegistered implies s.peerRegistration == 2
  val PeerTaskHasOneDispatch = s.peerDispatches <= 1 and
    (not(s.peerTaskPending) implies s.peerDispatches == 1)
  temporal PeerTaskWithoutFairness = (s.replacementRegistered and s.peerTaskPending)
    .leadsTo(not(s.peerTaskPending))
  temporal PeerTaskCompletes = advance.weakFair(s).implies(PeerTaskWithoutFairness)

  // Omitting the second identity check lets a previously grouped result cross
  // a registration change that occurred during the first service's await.
  action legacyDispatchPeer = all { s.phase == "peer-ready", s.groupedPeer, deliverPeer }
  run replacementQueriesAfterPrecedingDispatchTest = init.then(receiveQuery).then(dispatchFirst)
    .then(registerReplacement).then(unregisterOldPeer).then(settleFirst).then(skipPeer)
    .expect(s.peerTaskPending and s.peerDispatches == 0 and OldUnregisterKeepsReplacement)
    .then(queryReplacement).then(receiveQuery).then(dispatchPeer).then(settlePeer)
    .expect(DispatchUsesCurrentRegistration and PeerTaskHasOneDispatch and s.dispatchedRegistration == 2)
  run missingPreDispatchCheckWitnessTest = init.then(receiveQuery).then(dispatchFirst)
    .then(registerReplacement).then(settleFirst).then(legacyDispatchPeer)
    .expect(not(DispatchUsesCurrentRegistration))
}
