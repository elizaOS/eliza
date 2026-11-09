// One cold URL, one version-query completion, one retained App event, and one
// expiry of the existing 15-second replay window. Version 1 has URL delivery;
// version 2 joins all channels by the native capture receipt.
module MobileDeepLinkDiscovery {
  type State = {
    version: int,
    mode: str,
    ready: bool,
    closed: bool,
    launchDelivered: bool,
    peekDelivered: bool,
    appDelivered: bool,
    expired: bool,
    pendingLaunch: bool,
    urlOwner: int,
    receiptOwner: int,
    admitted: int,
    kind: int -> str,
    queued: Set[int],
    inFlight: Set[int],
    completed: Set[int],
    calls: int,
    receiptApplied: bool,
    acknowledgement: bool,
    nativePending: bool,
    lastAction: str,
    lastAttempt: int,
    outcome: str
  }
  var s: State
  pure def initialState(version: int): State = {
    version: version,
    mode: "pending",
    ready: false,
    closed: false,
    launchDelivered: false,
    peekDelivered: false,
    appDelivered: false,
    expired: false,
    pendingLaunch: false,
    urlOwner: 0,
    receiptOwner: 0,
    admitted: 0,
    kind: Map(1 -> "", 2 -> "", 3 -> ""),
    queued: Set(),
    inFlight: Set(),
    completed: Set(),
    calls: 0,
    receiptApplied: false,
    acknowledgement: false,
    nativePending: true,
    lastAction: "init",
    lastAttempt: 0,
    outcome: ""
  }
  action init = {
    nondet version = Set(1, 2).oneOf()
    s' = initialState(version)
  }
  action initVersion(version: int): bool = s' = initialState(version)

  // createMobileLifecycle.applyDeepLink runs immediately once the shell is
  // ready. Before readiness, the same attempt waits in pendingDeepLinks.
  pure def start(x: State, kind: str): State = {
    val id = x.admitted + 1
    {
      ...x,
      admitted: id,
      kind: x.kind.set(id, kind),
      urlOwner: if (kind == "receipt") x.urlOwner else id,
      receiptOwner: if (kind == "receipt") id else x.receiptOwner,
      queued: if (x.ready) x.queued else x.queued.union(Set(id)),
      inFlight: if (x.ready) x.inFlight.union(Set(id)) else x.inFlight,
      calls: x.calls + (if (x.ready) 1 else 0)
    }
  }
  pure def captureUrl(x: State): State =
    if (x.urlOwner != 0) x else start(x, "cold")
  pure def captureReceipt(x: State): State =
    if (x.receiptOwner == 0) start(x, "receipt")
    else if (x.completed.contains(x.receiptOwner)) { ...x, acknowledgement: true }
    else x
  pure def legacy(x: State): State = {
    val changed = { ...x, mode: "legacy", pendingLaunch: false }
    if (x.pendingLaunch) captureUrl(changed) else changed
  }
  pure def receipt(x: State): State = { ...x, mode: "receipt", pendingLaunch: false }

  action ready = all {
    not(s.closed),
    not(s.ready),
    s' = {
      ...s,
      ready: true,
      queued: Set(),
      inFlight: s.inFlight.union(s.queued),
      calls: s.calls + s.queued.size(),
      lastAction: "ready",
      lastAttempt: 0,
      outcome: ""
    }
  }
  action launch = {
    val changed = if (s.mode == "pending") { ...s, pendingLaunch: true }
      else if (s.mode == "legacy") captureUrl(s) else s
    all {
      not(s.closed),
      not(s.launchDelivered),
      s' = {
        ...changed,
        launchDelivered: true,
        lastAction: "launch",
        lastAttempt: 0,
        outcome: ""
      }
    }
  }
  // A failed version query cannot disprove a receipt-bearing App event that
  // is still in flight. Only the existing replay deadline enables fallback.
  action peek(outcome: str): bool = {
    val changed = if (outcome == "failed") s
      else if (s.version == 2) captureReceipt(receipt(s))
      else captureUrl(legacy(s))
    all {
      not(s.closed),
      not(s.peekDelivered),
      s' = {
        ...changed,
        peekDelivered: true,
        lastAction: "peek",
        lastAttempt: 0,
        outcome: outcome
      }
    }
  }
  action app = {
    val changed = if (s.version == 2) captureReceipt(receipt(s))
      else legacy(start(s, "warm"))
    all {
      not(s.closed),
      not(s.appDelivered),
      s' = {
        ...changed,
        appDelivered: true,
        lastAction: "app",
        lastAttempt: 0,
        outcome: ""
      }
    }
  }
  action expire = {
    val changed = if (s.mode == "pending") legacy(s) else s
    all {
      not(s.closed),
      not(s.expired),
      s' = {
        ...changed,
        expired: true,
        lastAction: "expire",
        lastAttempt: 0,
        outcome: ""
      }
    }
  }
  action finish(attempt: int, outcome: str): bool = {
    val applied = outcome == "applied"
    all {
      not(s.closed),
      s.inFlight.contains(attempt),
      s' = {
        ...s,
        inFlight: s.inFlight.exclude(Set(attempt)),
        completed: if (applied) s.completed.union(Set(attempt)) else s.completed.exclude(Set(attempt)),
        urlOwner: if (not(applied) and s.urlOwner == attempt) 0 else s.urlOwner,
        receiptOwner: if (attempt == s.receiptOwner and not(applied)) 0 else s.receiptOwner,
        receiptApplied: s.receiptApplied or (s.kind.get(attempt) == "receipt" and applied),
        acknowledgement: s.acknowledgement or (s.kind.get(attempt) == "receipt" and applied),
        lastAction: "finish",
        lastAttempt: attempt,
        outcome: outcome
      }
    }
  }
  action acknowledge = all {
    not(s.closed),
    s.acknowledgement,
    s' = {
      ...s,
      acknowledgement: false,
      nativePending: false,
      lastAction: "acknowledge",
      lastAttempt: 0,
      outcome: ""
    }
  }
  action close = all {
    not(s.closed),
    s' = {
      ...s,
      closed: true,
      lastAction: "close",
      lastAttempt: 0,
      outcome: ""
    }
  }
  action idle = s' = { ...s, lastAction: "idle", lastAttempt: 0, outcome: "" }
  action step = any {
    ready, launch, app, expire, acknowledge, close, idle,
    {
      nondet outcome = Set("version", "failed").oneOf()
      peek(outcome)
    },
    {
      nondet attempt = Set(1, 2, 3).oneOf()
      nondet outcome = Set("applied", "failed").oneOf()
      finish(attempt, outcome)
    }
  }
  val receiptBeforeFallback =
    s.version == 2 and not(s.expired) implies s.urlOwner == 0 and s.calls <= 2
  val acknowledgementRequiresApplication =
    (s.acknowledgement or not(s.nativePending)) implies s.receiptApplied
  // Progress is conditional on the shell becoming ready and the existing
  // replay timer reaching its deadline. Neither external event is forced here.
  val deadlineReleasesCold =
    s.launchDelivered and s.ready and s.expired implies s.calls > 0
  val finiteBounds = and {
    s.admitted >= 0 and s.admitted <= 3,
    s.calls >= 0 and s.calls <= s.admitted,
    s.queued.intersect(s.inFlight) == Set()
  }
  val invariant = and {
    receiptBeforeFallback,
    acknowledgementRequiresApplication,
    deadlineReleasesCold,
    finiteBounds
  }
  // Closure ends this document's delivery obligation. Readiness and timer
  // fairness are assumed only while their guarded actions remain enabled.
  temporal ColdDeliveryProgress = (ready.weakFair(s) and expire.weakFair(s)) implies
    always(s.launchDelivered implies eventually(s.closed or s.calls > 0))
  temporal UnfairColdDelivery = always(s.launchDelivered implies eventually(s.closed or s.calls > 0))
  run closedHostNeedsNoReadinessTest = initVersion(2).then(launch).then(close)
    .expect(s.closed and s.calls == 0 and invariant)
  run rejectedQueryStillJoinsReceiptTest = initVersion(2).then(ready).then(launch)
    .then(peek("failed")).expect(s.calls == 0).then(app).expect(s.calls == 1)
  run unresolvedQueryFallsBackAtExpiryTest = initVersion(1).then(ready).then(launch)
    .expect(s.calls == 0).then(expire).expect(s.calls == 1 and s.nativePending)
  run oldWarmEventJoinsColdAliasTest = initVersion(1).then(launch).then(app)
    .then(ready).expect(s.calls == 1 and s.kind.get(s.urlOwner) == "warm")
}
