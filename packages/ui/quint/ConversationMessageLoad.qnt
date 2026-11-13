// useDataLoaders visible newest/around requests. Full message values, overlay
// reconciliation and cache eviction are separate owners. Reply steps include
// synchronous main-thread writes; a callback may reenter ownership before an
// around request resumes its commit.
module ConversationMessageLoad {
  pure val Rooms = Set("a", "b", "c", "none")
  pure val Requests = Set(1, 2)
  type Request = {
    target: str, kind: str, phase: str, ownerEpoch: int, requestEpoch: int,
    aborted: bool, cached: bool,
  }
  pure val unused: Request = { target: "none", kind: "newest", phase: "unused",
    ownerEpoch: 0, requestEpoch: 0, aborted: false, cached: false }
  type State = {
    active: str, owner: str, ownerEpoch: int, requestEpoch: int,
    fence: int, claims: int, requests: int -> Request,
    visible: str, loaded: str, cache: Set[str], unsafePublication: bool,
  }
  var s: State
  pure def current(t: State, id: int): bool = {
    val request = t.requests.get(id)
    t.fence == id and not(request.aborted) and t.active == request.target
      and t.owner == request.target and t.ownerEpoch == request.ownerEpoch
      and t.requestEpoch == request.requestEpoch
  }
  pure def abortActive(t: State): int -> Request = if (t.fence == 0) t.requests else
    t.requests.set(t.fence, { ...t.requests.get(t.fence), aborted: true })
  pure def claim(t: State, room: str): State = {
    ...t, active: room, owner: room, fence: 0, claims: t.claims + 1,
    requests: abortActive(t), requestEpoch: t.requestEpoch + 1,
    ownerEpoch: t.ownerEpoch + (if (t.owner != room or room == "none") 1 else 0),
  }
  pure def done(t: State, id: int): State = {
    ...t, requests: t.requests.set(id, { ...t.requests.get(id), phase: "done" }),
  }
  pure def publish(t: State, id: int): State = {
    val request = t.requests.get(id)
    {
      ...done(t, id), visible: request.target, loaded: request.target,
      cache: if (request.kind == "newest") t.cache.union(Set(request.target)) else t.cache,
      unsafePublication: t.unsafePublication or not(current(t, id)),
    }
  }
  action init = s' = { active: "a", owner: "a", ownerEpoch: 1, requestEpoch: 0,
    fence: 0, claims: 0, requests: Requests.mapBy(_ => unused),
    visible: "a", loaded: "a", cache: Set(), unsafePublication: false }
  action claimRoom(room: str): bool = all { s.claims < 2, s' = claim(s, room) }
  action admit(id: int, room: str, kind: str): bool = {
    val accepted = s.active == room and room != "none"
      and (kind == "newest" or s.owner == room)
    val generation = s.requestEpoch + (if (kind == "newest") 2 else 1)
    val ownerEpoch = s.ownerEpoch + (if (kind == "newest" and s.owner != room) 1 else 0)
    val request = { target: room, kind: kind, phase: "pending", ownerEpoch: ownerEpoch,
      requestEpoch: generation, aborted: false, cached: s.cache.contains(room) }
    all {
      s.requests.get(id).phase == "unused", accepted,
      s' = { ...s, owner: room, fence: id, ownerEpoch: ownerEpoch, requestEpoch: generation,
        requests: abortActive(s).set(id, request),
        visible: if (kind == "newest") room else s.visible,
        loaded: if (kind == "newest" and s.loaded != room and not(request.cached)) "none" else s.loaded },
    }
  }
  action reply(id: int, outcome: str): bool = {
    val request = s.requests.get(id)
    val owns = current(s, id)
    all {
      request.phase == "pending",
      s' = if (not(owns)) done(s, id)
        else if (outcome == "ok" and request.kind == "around") {
          ...s, requests: s.requests.set(id, { ...request, phase: "callback" }) }
        else if (outcome == "ok") publish(s, id)
        else if (outcome == "missing" and request.kind == "newest") {
          ...s, requests: s.requests.set(id, { ...request, phase: "list" }) }
        else done(s, id),
    }
  }
  action listReply(id: int, fallback: str): bool = all {
    s.requests.get(id).phase == "list",
    s' = if (current(s, id)) {
      ...done(claim(s, fallback), id), visible: "none", loaded: "none",
      cache: s.cache.exclude(Set(s.requests.get(id).target)),
    } else done(s, id),
  }
  action callbackReassign(id: int, room: str): bool = all {
    s.requests.get(id).phase == "callback", s.claims < 2,
    s' = claim(s, room),
  }
  action finishAround(id: int): bool = all {
    s.requests.get(id).phase == "callback",
    s' = if (current(s, id)) publish(s, id) else done(s, id),
  }
  action finalize(id: int): bool = all {
    s.requests.get(id).phase == "done",
    s' = if (s.fence == id) { ...s, fence: 0 } else s,
  }
  action advance(id: int): bool = any {
    reply(id, "ok"), reply(id, "missing"), reply(id, "failed"),
    { nondet fallback = Rooms.oneOf() listReply(id, fallback) },
    finishAround(id), finalize(id),
  }
  action step = any {
    { nondet room = Rooms.oneOf() claimRoom(room) },
    { nondet id = Requests.oneOf()
      nondet room = Rooms.oneOf()
      nondet kind = Set("newest", "around").oneOf()
      admit(id, room, kind) },
    { nondet id = Requests.oneOf()
      nondet room = Rooms.oneOf()
      callbackReassign(id, room) },
    advance(1), advance(2), s' = s,
  }
  val NoStalePublication = not(s.unsafePublication)
  val Finite = s.claims <= 4 and s.ownerEpoch <= 7 and s.requestEpoch <= 10
    and (s.fence == 0 or Requests.contains(s.fence))
  val invariant = NoStalePublication and Finite
  temporal RepliesSettle = (advance(1).weakFair(s) and advance(2).weakFair(s)).implies(
    Requests.forall(id => always((s.requests.get(id).phase != "unused").implies(
      eventually(s.requests.get(id).phase == "done")))))
  action legacyFinishAround(id: int): bool = all {
    s.requests.get(id).phase == "callback", s' = publish(s, id),
  }
  run reentrantCallbackCannotPublishOldRowsTest = init.then(admit(1, "a", "around"))
    .then(reply(1, "ok")).then(callbackReassign(1, "b")).then(finishAround(1))
    .expect(invariant and s.active == "b" and s.visible != "b")
  run legacyCallbackPublishesWrongOwnerTest = init.then(admit(1, "a", "around"))
    .then(reply(1, "ok")).then(callbackReassign(1, "b")).then(legacyFinishAround(1))
    .expect(not(NoStalePublication))
  run newerSameOwnerRequestWinsTest = init.then(admit(1, "a", "newest"))
    .then(admit(2, "a", "newest")).then(reply(2, "ok")).then(reply(1, "ok"))
    .expect(invariant and s.loaded == "a" and s.fence == 2)
  run missingListCannotChangeNewOwnerTest = init.then(admit(1, "a", "newest"))
    .then(reply(1, "missing")).then(claimRoom("c")).then(listReply(1, "b"))
    .expect(invariant and s.active == "c")
}
