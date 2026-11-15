// One service generation, its replacement, and the actual per-room queue.
// Topic labels are symbolic and distinct; this projection stays below capacity.
module ChannelTopicRetirement {
  pure val Rooms = Set(0, 1)
  pure val Calls = Set(0, 1, 2, 3)
  pure val OldCalls = Set(0, 1, 2)
  pure def room(id: int): int = if (id == 2) 1 else 0
  type Call = { phase: str, readOnly: bool }
  type Topics = { queue: List[int], hydrated: bool, local: List[int], durable: List[int] }
  var s: { owner: str, rooms: int -> Topics, calls: int -> Call, stopOwned: Set[int] }

  action init = s' = {
    owner: "original", stopOwned: Set(),
    rooms: Rooms.mapBy(_ => { queue: List(), hydrated: false, local: List(), durable: List() }),
    calls: Calls.mapBy(_ => { phase: "idle", readOnly: false })
  }
  def entry(id: int): Call = s.calls.get(id)
  def topics(id: int): Topics = s.rooms.get(room(id))
  def inProgress(id: int): bool = entry(id).phase.in(Set("hydrating", "ready", "writing"))
  def accepted(id: int): bool = not(entry(id).phase.in(Set("idle", "refused")))
  def pending(id: int): bool = entry(id).phase == "queued" or inProgress(id)
  def permitted(id: int): bool =
    if (OldCalls.contains(id)) s.owner == "original" else s.owner == "replacement"
  action update(id: int, call: Call, updated: Topics): bool = s' = { ...s,
    calls: s.calls.set(id, call), rooms: s.rooms.set(room(id), updated)
  }

  action invoke(id: int, readOnly: bool): bool = all {
    entry(id).phase == "idle",
    // Only original call 0 can be a cold read. Call 3 is invoked after reload.
    not(readOnly) or id == 0,
    id != 3 or s.owner == "replacement",
    if (permitted(id)) update(id, { phase: "queued", readOnly: readOnly },
      { ...topics(id), queue: topics(id).queue.append(id) })
    else update(id, { phase: "refused", readOnly: readOnly }, topics(id))
  }
  action start(id: int): bool = all {
    entry(id).phase == "queued", topics(id).queue.length() > 0,
    topics(id).queue.head() == id,
    update(id, { ...entry(id), phase: if (topics(id).hydrated) "ready" else "hydrating" }, topics(id))
  }
  action hydrate(id: int, ok: bool): bool = all {
    entry(id).phase == "hydrating",
    if (ok) update(id, { ...entry(id), phase: "ready" },
      { ...topics(id), hydrated: true, local: topics(id).durable })
    else update(id, { ...entry(id), phase: "failed" },
      { ...topics(id), queue: topics(id).queue.tail() })
  }
  action apply(id: int): bool = all {
    entry(id).phase == "ready",
    if (entry(id).readOnly) update(id, { ...entry(id), phase: "done" },
      { ...topics(id), queue: topics(id).queue.tail() })
    else update(id, { ...entry(id), phase: "writing" },
      { ...topics(id), local: topics(id).local.append(id) })
  }
  action persist(id: int, ok: bool): bool = all {
    entry(id).phase == "writing",
    update(id, { ...entry(id), phase: if (ok) "done" else "failed" }, {
      ...topics(id), queue: topics(id).queue.tail(),
      durable: if (ok) topics(id).local else topics(id).durable
    })
  }
  action beginStop = all {
    s.owner == "original",
    s' = { ...s, owner: "stopping", stopOwned: OldCalls.filter(accepted) }
  }
  action finishStop = all {
    s.owner == "stopping", OldCalls.forall(id => not(pending(id))),
    s' = { ...s, owner: "retired", rooms: Rooms.mapBy(r =>
      { ...s.rooms.get(r), hydrated: false, local: List() }) }
  }
  action replace = all {
    s.owner == "retired", s' = { ...s, owner: "replacement" }
  }
  action advance(id: int): bool = any {
    start(id), apply(id), { nondet ok = Bool.oneOf(); any { hydrate(id, ok), persist(id, ok) } }
  }
  action step = any {
    { nondet id = Calls.oneOf(); nondet readOnly = Bool.oneOf(); invoke(id, readOnly) },
    { nondet id = Calls.oneOf(); advance(id) },
    beginStop, finishStop, replace, s' = s
  }

  val RoomOrder = Rooms.forall(r => {
    val q = s.rooms.get(r).queue
    Calls.filter(id => room(id) == r and inProgress(id)).forall(id =>
      q.length() > 0 and q.head() == id)
  })
  val NoLateOriginalAdmission = s.owner != "original" implies OldCalls.filter(accepted) == s.stopOwned
  val RetirementJoinsOriginal = s.owner.in(Set("retired", "replacement")) implies
    OldCalls.forall(id => not(pending(id)))
  val RetirementClearsLocal = s.owner == "retired" implies Rooms.forall(r =>
    not(s.rooms.get(r).hydrated) and s.rooms.get(r).local == List())
  val RoomIsolation = Rooms.forall(r => {
    val row = s.rooms.get(r)
    row.local.indices().forall(i => room(row.local.nth(i)) == r) and
      row.durable.indices().forall(i => room(row.durable.nth(i)) == r)
  })
  temporal StopSettles = (s.owner == "stopping").leadsTo(s.owner.in(Set("retired", "replacement")))
  temporal FairStopSettles = (finishStop.weakFair(s) and Calls.forall(id => advance(id).weakFair(s)))
    .implies(StopSettles)
  temporal FairAcceptedCallsSettle = Calls.forall(id => advance(id).weakFair(s)).implies(
    Calls.forall(id => pending(id).leadsTo(not(pending(id)))))

  run replacementHydratesAndRetiredRefusesTest = init.then(invoke(0, false)).then(start(0))
    .then(hydrate(0, true)).then(apply(0)).then(beginStop).then(invoke(1, false))
    .expect(NoLateOriginalAdmission and entry(1).phase == "refused")
    .then(persist(0, true)).then(finishStop).then(replace).then(invoke(2, false))
    .then(invoke(3, false)).then(start(3)).then(hydrate(3, true)).then(apply(3))
    .then(persist(3, true)).expect(s.rooms.get(0).durable == List(0, 3)
      and entry(2).phase == "refused" and RetirementJoinsOriginal)
  run failedWriteStillReleasesOrderedRoomTest = init.then(invoke(0, false)).then(invoke(1, false))
    .then(start(0)).then(hydrate(0, true)).then(apply(0)).then(persist(0, false))
    .expect(s.rooms.get(0).durable == List() and entry(0).phase == "failed")
    .then(start(1)).then(apply(1)).then(persist(1, true))
    .expect(s.rooms.get(0).durable == List(0, 1))
  run coldReadOrdersSameRoomWhileOtherRoomAdvancesTest = init.then(invoke(0, true))
    .then(invoke(1, false)).then(invoke(2, false)).then(start(0)).then(start(2))
    .then(hydrate(2, true)).then(apply(2)).then(persist(2, true)).then(hydrate(0, true))
    .then(apply(0)).then(start(1)).then(apply(1)).then(persist(1, true))
    .expect(RoomOrder and RoomIsolation and s.rooms.get(0).durable == List(1)
      and s.rooms.get(1).durable == List(2))
}
