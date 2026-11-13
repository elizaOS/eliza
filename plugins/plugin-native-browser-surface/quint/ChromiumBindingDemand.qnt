// ChromiumBindingDemand.java, called serially on Android's main thread.
// Two once-acquired holds and one ready callback per hold. Callback effects
// include closing either hold, closing demand and disconnecting during drain.
module ChromiumBindingDemand {
  const RecordEvents: bool
  pure val Ids = Set(0, 1)
  pure val Results = Set("ACCEPTED", "REFUSED", "UNTRUSTED", "DENIED")
  pure val Effects = Set("record", "self", "other", "close", "disconnect")
  type State = {
    pinned: bool, leases: int, bound: bool, ready: bool, closed: bool,
    acquired: Set[int], open: Set[int], registered: Set[int], fired: Set[int],
    waiting: List[int], effects: int -> str,
    retry: bool, idle: bool, backoff: int, verdict: str,
    unsafeCallback: bool,
  }
  var s: State
  // Labels are consumed by the implementation trace replay.
  var event: { name: str, id: int, result: str, effect: str }
  pure def wanted(t: State): bool = t.pinned or t.leases > 0
  pure def retryLater(t: State): State = if (t.closed or not(wanted(t))) t else {
    ...t, retry: true, backoff: if (t.backoff < 5) t.backoff + 1 else 5,
  }
  pure def attempt(t: State, result: str): State =
    if (t.closed or t.bound or not(wanted(t))) t
    else if (result == "ACCEPTED") { ...t, bound: true, verdict: result }
    else if (result == "REFUSED") retryLater({ ...t, verdict: result })
    else { ...t, retry: false, verdict: result }
  pure def closeHold(t: State, id: int): State = if (not(t.open.contains(id))) t else {
    val remaining = if (t.closed) t.leases else t.leases - 1
    {
      ...t, open: t.open.exclude(Set(id)),
      waiting: t.waiting.foldl(List(), (kept, queued) => if (queued == id) kept else kept.append(queued)), leases: remaining,
      idle: t.idle or (not(t.closed) and not(t.pinned) and remaining == 0),
    }
  }
  pure def closeDemand(t: State): State = {
    ...t, closed: true, ready: false, bound: false,
    waiting: List(), retry: false, idle: false,
  }
  pure def fire(t: State, id: int): State =
    if (t.closed or not(t.ready) or not(t.open.contains(id))) t
    else {
      val fired = { ...t, fired: t.fired.union(Set(id)),
        unsafeCallback: t.unsafeCallback or t.fired.contains(id) }
      val effect = t.effects.get(id)
      if (effect == "self") closeHold(fired, id)
      else if (effect == "other") closeHold(fired, 1 - id)
      else if (effect == "close") closeDemand(fired)
      else if (effect == "disconnect") { ...fired, ready: false }
      else fired
    }
  action label(name: str, id: int, result: str, effect: str): bool =
    event' = if (RecordEvents) { name: name, id: id, result: result, effect: effect }
      else { name: "projected", id: -1, result: "ACCEPTED", effect: "record" }
  action init = all {
    s' = {
      pinned: false, leases: 0, bound: false, ready: false, closed: false,
      acquired: Set(), open: Set(), registered: Set(), fired: Set(),
      waiting: List(), effects: Ids.mapBy(_ => "record"),
      retry: false, idle: false, backoff: 0, verdict: "none", unsafeCallback: false,
    },
    event' = { name: if (RecordEvents) "init" else "projected",
      id: -1, result: "ACCEPTED", effect: "record" },
  }
  action acquire(id: int, result: str): bool = all {
    not(s.acquired.contains(id)),
    s' = if (s.closed) { ...s, acquired: s.acquired.union(Set(id)) } else
      attempt({ ...s, acquired: s.acquired.union(Set(id)),
        open: s.open.union(Set(id)), leases: s.leases + 1, idle: false }, result),
    label("acquire", id, result, "record"),
  }
  action pin(result: str): bool = all {
    s' = if (s.closed) s else attempt({ ...s, pinned: true, idle: false }, result),
    label("pin", -1, result, "record"),
  }
  action unpin = all {
    s' = if (s.closed or not(s.pinned)) s else {
      ...s, pinned: false, idle: s.idle or s.leases == 0,
    },
    label("unpin", -1, "ACCEPTED", "record"),
  }
  action release(id: int): bool = all {
    s.acquired.contains(id), s' = closeHold(s, id),
    label("release", id, "ACCEPTED", "record"),
  }
  action register(id: int, effect: str): bool = all {
    s.acquired.contains(id), not(s.registered.contains(id)),
    val marked = { ...s, registered: s.registered.union(Set(id)),
      effects: s.effects.set(id, effect) }
    s' = if (s.closed or not(s.open.contains(id))) marked
      else if (s.ready) fire(marked, id)
      else { ...marked, waiting: s.waiting.append(id) },
    label("register", id, "ACCEPTED", effect),
  }
  action connect = all {
    s' = if (s.closed or not(s.bound)) s else
      s.waiting.foldl({ ...s, ready: true, backoff: 0, waiting: List() },
        (state, id) => fire(state, id)),
    label("connect", -1, "ACCEPTED", "record"),
  }
  action disconnect = all {
    s' = { ...s, ready: false }, label("disconnect", -1, "ACCEPTED", "record"),
  }
  action lost = all {
    s' = retryLater({ ...s, ready: false, bound: false, verdict: "lost" }),
    label("lost", -1, "ACCEPTED", "record"),
  }
  action retry(result: str): bool = all {
    s.retry, s' = attempt({ ...s, retry: false }, result),
    label("retry", -1, result, "record"),
  }
  action idle = all {
    s.idle,
    s' = if (s.closed or wanted(s)) { ...s, idle: false } else {
      ...s, idle: false, retry: false, backoff: 0, bound: false, ready: false,
    },
    label("idle", -1, "ACCEPTED", "record"),
  }
  action close = all {
    s' = closeDemand(s), label("close", -1, "ACCEPTED", "record"),
  }
  action step = {
    nondet id = Ids.oneOf()
    nondet result = Results.oneOf()
    nondet effect = Effects.oneOf()
    any { acquire(id, result), pin(result), unpin, release(id), register(id, effect),
      connect, disconnect, lost, retry(result), idle, close }
  }
  val ClosedReleases = not(s.closed) or
    (not(s.bound) and not(s.ready) and not(s.retry) and not(s.idle) and s.waiting.length() == 0)
  val ReadyHasBinding = not(s.ready) or (s.bound and not(s.closed))
  val HoldAccounting = s.closed or s.leases == s.open.size()
  val CallbackCustody = not(s.unsafeCallback) and s.fired.subseteq(s.registered)
    and s.waiting.foldl(true, (valid, id) => valid and s.open.contains(id))
  val NoRejectedRetry = not(Set("UNTRUSTED", "DENIED").contains(s.verdict)) or not(s.retry)
  val Bounds = s.backoff >= 0 and s.backoff <= 5 and s.leases >= 0 and s.leases <= 2
    and s.open.subseteq(s.acquired) and s.acquired.subseteq(Ids)
    and s.waiting.length() <= 2
  val invariant = ClosedReleases and ReadyHasBinding and HoldAccounting
    and CallbackCustody and NoRejectedRetry and Bounds

  // Holding the request while the environment accepts the retry/connection is
  // necessary for progress. No promise is made after refusal or rejection.
  action acceptedRetry = retry("ACCEPTED")
  temporal ConditionalReady = (acceptedRetry.weakFair(s) and connect.strongFair(s)).implies(
    always((not(s.closed) and wanted(s) and s.retry).implies(
      eventually(s.ready or s.closed or not(wanted(s)) or
        (Set("UNTRUSTED", "DENIED").contains(s.verdict) and not(s.retry))))))
  temporal ConditionalIdleRelease = idle.weakFair(s).implies(
    always((s.idle and not(wanted(s))).implies(eventually(
      not(s.bound) or wanted(s) or s.closed))))
  temporal UnfairRelease = always((s.idle and not(wanted(s))).implies(
    eventually(not(s.bound) or wanted(s) or s.closed)))

  run rejectedRetryIsCancelledTest = init.then(acquire(0, "REFUSED"))
    .then(pin("UNTRUSTED")).expect(invariant and not(s.retry))
  run deniedRetryIsCancelledTest = init.then(acquire(0, "REFUSED"))
    .then(pin("DENIED")).expect(invariant and not(s.retry))
  run reentrantCloseDropsNextCallbackTest = init.then(acquire(0, "ACCEPTED"))
    .then(acquire(1, "ACCEPTED")).then(register(0, "close"))
    .then(register(1, "record")).then(connect)
    .expect(invariant and s.fired == Set(0) and s.closed)
  run reentrantHoldCloseDropsCallbackTest = init.then(acquire(0, "ACCEPTED"))
    .then(acquire(1, "ACCEPTED")).then(register(0, "other"))
    .then(register(1, "record")).then(connect)
    .expect(invariant and s.fired == Set(0) and s.leases == 1)
  run lateConnectAfterIdleIsIgnoredTest = init.then(acquire(0, "ACCEPTED"))
    .then(release(0)).then(idle).then(connect)
    .expect(invariant and not(s.ready))
  run closedHoldsStayInertTest = init.then(acquire(0, "ACCEPTED"))
    .then(close).then(release(0)).then(acquire(1, "ACCEPTED"))
    .expect(invariant and s.leases == 1 and s.open == Set())
}

module ChromiumBindingDemandCheck {
  import ChromiumBindingDemand(RecordEvents = false).*
}
module ChromiumBindingDemandTrace {
  import ChromiumBindingDemand(RecordEvents = true).*
}
