// One durable anonymous quota gate. The SQL mirror is an observer, not an
// admission authority. The retained terminal window identifies both requests.
module anonymous_chat_gate {
  type Active = { window: int, deadline: int }
  type Request = Unseen | Reserved(Active) | Dispatched(Active) | Committed(int) | Refunded
  type Ledger = {
    requests: str -> Request, used: int, hourly: int, window: int,
    revision: int, retryAt: int, blocked: bool, limit: int,
  }
  type Snapshot = { used: int, hourly: int, window: int, revision: int }
  type Gate = Cold | Ready(Ledger) | Invalid
  type Flight = Idle | Writing(Snapshot)
  type State = { now: int, gate: Gate, mirror: Snapshot, queued: Set[Snapshot], flight: Flight }
  var s: State

  pure val Ids = Set("one", "two")
  pure val hourLimit = 1
  pure val expiry = 8
  pure val empty = {
    requests: Map("one" -> Unseen, "two" -> Unseen),
    used: 0, hourly: 0, window: 0, revision: 0, retryAt: -1, blocked: false, limit: 2,
  }
  pure def row(x: State): Ledger = match x.gate {
    | Ready(l) => l
    | _ => empty
  }
  pure def isReady(x: State): bool = match x.gate {
    | Ready(_) => true
    | _ => false
  }
  pure def live(x: State): bool = isReady(x) and x.now < expiry
  pure def request(x: State, id: str): Request = row(x).requests.get(id)
  pure def reserved(r: Request): bool = match r {
    | Reserved(_) => true
    | _ => false
  }
  pure def dispatched(r: Request): bool = match r {
    | Dispatched(_) => true
    | _ => false
  }
  pure def active(r: Request): bool = reserved(r) or dispatched(r)
  pure def committed(r: Request): bool = match r {
    | Committed(_) => true
    | _ => false
  }
  pure def charged(r: Request): bool = r != Unseen and r != Refunded
  pure def windowOf(r: Request): int = match r {
    | Reserved(a) => a.window
    | Dispatched(a) => a.window
    | Committed(w) => w
    | _ => -1
  }
  pure def deadline(r: Request): int = match r {
    | Reserved(a) => a.deadline
    | Dispatched(a) => a.deadline
    | _ => -1
  }
  pure def rotate(l: Ledger, now: int): Ledger =
    if (now > l.window + 4) { ...l, window: now, hourly: 0 } else l
  pure def snap(l: Ledger): Snapshot =
    { used: l.used, hourly: l.hourly, window: l.window, revision: l.revision }
  pure def newer(before: Snapshot, candidate: Snapshot): Snapshot =
    if (candidate.revision > before.revision) candidate else before

  action init = s' = { now: 0, gate: Cold, mirror: snap(empty), queued: Set(), flight: Idle }
  action hydrate(limit: int): bool = all {
    s.gate == Cold, s' = { ...s, gate: Ready({ ...empty, limit: limit }) },
  }
  action invalidate = s' = { ...s, gate: Invalid }
  action expireSession = all { isReady(s), s.now >= expiry, invalidate }
  action tick = all { s.now < 9, s' = { ...s, now: s.now + 1 } }
  action moderation(blocked: bool): bool = all {
    live(s), s' = { ...s, gate: Ready({ ...row(s), blocked: blocked }) }
  }

  action lease(id: str): bool = {
    val l = rotate(row(s), s.now)
    val updated = {
      ...l, used: l.used + 1, hourly: l.hourly + 1, revision: l.revision + 1,
      requests: l.requests.set(id, Reserved({ window: l.window, deadline: s.now + 2 })),
    }
    all {
      live(s), request(s, id) == Unseen,
      not(l.blocked), l.used < l.limit, l.hourly < hourLimit,
      s' = { ...s, gate: Ready(updated), queued: s.queued.union(Set(snap(updated))) },
    }
  }
  action dispatch(id: str): bool = all {
    live(s), reserved(request(s, id)), s.now < deadline(request(s, id)),
    val l = row(s)
    val active = { window: windowOf(request(s, id)), deadline: s.now + 3 }
    s' = { ...s, gate: Ready({ ...l, requests: l.requests.set(id, Dispatched(active)) }) }
  }
  action replayDispatch(id: str): bool = all {
    live(s), dispatched(request(s, id)) or committed(request(s, id)),
    s' = s,
  }
  action commit(id: str): bool = all {
    live(s), active(request(s, id)),
    val l = row(s)
    s' = { ...s, gate: Ready({ ...l, requests: l.requests.set(id, Committed(windowOf(request(s, id)))) }) }
  }
  action refund(id: str): bool = all {
    live(s), active(request(s, id)),
    val l = rotate(row(s), s.now)
    val updated = {
      ...l, used: l.used - 1, revision: l.revision + 1,
      hourly: l.hourly - (if (windowOf(request(s, id)) == l.window) 1 else 0),
      requests: l.requests.set(id, Refunded),
    }
    s' = { ...s, gate: Ready(updated), queued: s.queued.union(Set(snap(updated))) }
  }

  pure def expired(x: State): Set[str] =
    Ids.filter(id => active(request(x, id)) and x.now >= deadline(request(x, id)))
  // A timer can close several due leases in one storage transaction. An
  // unknown dispatched effect is committed, while a reserved lease refunds.
  action claimAlarm = {
    val l = row(s)
    val due = expired(s)
    val refunds = due.filter(id => reserved(request(s, id)))
    val retryDue = l.retryAt >= 0 and l.retryAt <= s.now
    val rotated = if (refunds.size() > 0) rotate(l, s.now) else l
    val updated = {
      ...rotated,
      used: rotated.used - refunds.size(),
      hourly: rotated.hourly -
        refunds.filter(id => windowOf(request(s, id)) == rotated.window).size(),
      revision: rotated.revision + refunds.size(),
      requests: due.fold(rotated.requests, (requests, id) =>
        requests.set(id, if (refunds.contains(id)) Refunded else Committed(windowOf(request(s, id))))),
    }
    val persist = refunds.size() > 0 or retryDue
    all {
      live(s), s.flight == Idle, due.size() > 0 or retryDue,
      s' = {
        ...s, gate: Ready(if (persist) { ...updated, retryAt: s.now + 1 } else updated),
        flight: if (persist) Writing(snap(updated)) else Idle,
      },
    }
  }
  pure def flightSnapshot(flight: Flight): Snapshot = match flight {
    | Writing(snapshot) => snapshot
    | Idle => snap(empty)
  }
  action publishAlarm = all {
    s.flight != Idle,
    val snapshot = flightSnapshot(s.flight)
    val l = row(s)
    val clear = isReady(s) and l.revision == snapshot.revision and l.retryAt >= 0
    s' = {
      ...s, flight: Idle, mirror: newer(s.mirror, snapshot),
      gate: if (clear) Ready({ ...l, retryAt: -1 }) else s.gate,
    },
  }
  action failAlarm = all { s.flight != Idle, s' = { ...s, flight: Idle } }
  action finishAlarm = any { publishAlarm, failAlarm }
  action publishQueued(snapshot: Snapshot): bool = all {
    s.queued.contains(snapshot),
    s' = { ...s, mirror: newer(s.mirror, snapshot), queued: s.queued.exclude(Set(snapshot)) },
  }
  action restart = s' = { ...s, queued: Set(), flight: Idle }
  action idle = s' = s
  action step = any {
    { nondet limit = Set(1, 2).oneOf() hydrate(limit) },
    invalidate, expireSession, tick, moderation(true), moderation(false),
    claimAlarm, finishAlarm, restart, idle,
    {
      nondet id = Ids.oneOf()
      any { lease(id), dispatch(id), replayDispatch(id), refund(id), commit(id) }
    },
    { nondet snapshot = s.queued.oneOf() publishQueued(snapshot) },
  }

  val QuotaConserved = {
    val l = row(s)
    l.used == Ids.filter(id => charged(request(s, id))).size() and
    l.hourly == Ids.filter(id => charged(request(s, id)) and windowOf(request(s, id)) == l.window).size() and
    l.used <= l.limit and l.hourly <= hourLimit
  }
  temporal Authority = always(and {
    (s.gate == Invalid).implies(next(s.gate) == Invalid),
    Ids.forall(id => and {
      (reserved(request(s, id)) and dispatched(next(request(s, id)))).implies(
        s.now < deadline(request(s, id)) and live(s)),
      (dispatched(request(s, id)) and dispatched(next(request(s, id)))).implies(
        next(request(s, id)) == request(s, id)),
      (next(isReady(s)) and not(active(request(s, id))) and request(s, id) != Unseen)
        .implies(next(request(s, id)) == request(s, id)),
    }),
    next(s.mirror.revision) >= s.mirror.revision,
    (next(s.mirror.revision) == s.mirror.revision).implies(next(s.mirror) == s.mirror),
  }.orKeep(s))
  temporal ExpiredLeasesSettle = Ids.forall(id => always(
    (active(request(s, id)) and s.now >= deadline(request(s, id))).implies(
      eventually(not(active(request(s, id)))))))
  temporal FairAlarm = (
    claimAlarm.weakFair(s) and finishAlarm.weakFair(s) and expireSession.weakFair(s)
  ).implies(ExpiredLeasesSettle)

  run undispatchedExpiryRefundsOnceTest = init.then(hydrate(2)).then(lease("one"))
    .then(tick).then(tick).then(claimAlarm).then(publishAlarm)
    .expect(request(s, "one") == Refunded and s.mirror.revision == 2 and s.mirror.used == 0)
  run dispatchedReplayKeepsDeadlineTest = init.then(hydrate(2)).then(lease("one")).then(dispatch("one"))
    .then(tick).then(tick).then(tick).then(replayDispatch("one")).then(claimAlarm)
    .expect(request(s, "one") == Committed(0) and row(s).used == 1 and s.flight == Idle)
  run failedAlarmKeepsTheLatestSnapshotTest = init.then(hydrate(2)).then(lease("one"))
    .then(tick).then(tick).then(claimAlarm).then(failAlarm).then(restart)
    .then(lease("two")).then(tick).then(claimAlarm).then(publishAlarm)
    .expect(s.mirror.revision == 3 and s.mirror.used == 1 and row(s).retryAt == -1)
  run staleMirrorCannotOverwriteRefundTest = init.then(hydrate(2)).then(lease("one"))
    .then(tick).then(tick).then(claimAlarm).then(publishAlarm)
    .then(publishQueued({ used: 1, hourly: 1, window: 0, revision: 1 }))
    .expect(s.mirror.revision == 2 and s.mirror.used == 0)
  run oldWindowRefundKeepsNewWindowQuotaTest = init.then(hydrate(2)).then(lease("one"))
    .then(tick).then(tick).then(tick).then(tick).then(tick)
    .then(lease("two")).then(refund("one"))
    .expect(row(s).hourly == 1 and row(s).used == 1 and QuotaConserved)
  run invalidationIsDurableTest = init.then(hydrate(2)).then(lease("one"))
    .then(invalidate).then(restart).expect(s.gate == Invalid)
}
