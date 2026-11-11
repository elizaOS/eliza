// One API key on a Worker, or the same key on a host with no revocation
// boundary. On a Worker a matching cache entry is the whole decision; the
// gate is read only by a cold primary decision and by the refresh.
module InferenceCredentialCache {
  type State = {
    cache: str, originAllows: bool, expired: bool, fences: Set[str],
    refresh: str, worker: bool, phase: str, source: str, aged: bool,
    gateResult: str, result: str
  }
  pure val CacheValues = Set("empty", "foreign", "fresh_allow", "stale_allow", "fresh_deny", "stale_deny")
  pure val ReversibleFences = Set("account", "moderation", "organization")
  pure val Pending = Set("read_primary", "read_gate", "reply_gate")
  var s: State

  action initialize(cacheValue: str, originAllows: bool): bool = s' = {
    cache: cacheValue, originAllows: originAllows, expired: false, fences: Set(),
    refresh: "idle", worker: false, phase: "idle", source: "none", aged: false,
    gateResult: "none", result: "none"
  }
  action init = {
    nondet cacheValue = CacheValues.oneOf()
    nondet originAllows = Set(true, false).oneOf()
    initialize(cacheValue, originAllows)
  }

  pure def cacheAllows(value: str): bool = Set("fresh_allow", "stale_allow").contains(value)
  pure def cacheDenies(value: str): bool = Set("fresh_deny", "stale_deny").contains(value)
  pure def cacheAged(value: str): bool = Set("stale_allow", "stale_deny").contains(value)
  pure def gateAllows(state: State): bool = state.fences == Set()
  pure def enqueueRefresh(state: State, refresh: str): State =
    if (state.refresh == "idle") state.with("refresh", refresh) else state

  action begin(worker: bool): bool = all {
    s.phase == "idle",
    s' = {
      val request = s.with("worker", worker).with("aged", worker and cacheAged(s.cache))
      if (worker and cacheAllows(s.cache)) {
        if (s.expired)
          enqueueRefresh(request, "read_primary").with("phase", "terminal")
            .with("source", "cache").with("result", "denied")
        else {
          val refreshed = if (request.aged) enqueueRefresh(request, "read_primary") else request
          refreshed.with("phase", "terminal").with("source", "cache").with("result", "allowed")
        }
      } else if (worker and cacheDenies(s.cache)) {
        val refreshed = if (request.aged) enqueueRefresh(request, "read_primary") else request
        refreshed.with("phase", "terminal").with("source", "cache").with("result", "denied")
      } else request.with("phase", "read_primary").with("source", "primary")
    }
  }

  action readPrimary = all {
    s.phase == "read_primary",
    s' = if (s.originAllows and not(s.expired)) {
      if (s.worker) enqueueRefresh(s, "read_gate").with("phase", "read_gate")
      else s.with("phase", "terminal").with("result", "allowed")
    } else {
      val refreshed = if (s.worker) enqueueRefresh(s, "publish_deny") else s
      refreshed.with("phase", "terminal").with("result", "denied")
    }
  }

  // The result reflects the gate's state when it evaluates the request.
  // A subsequent fence can precede delivery of that exact reply.
  action evaluateGate = all {
    s.phase == "read_gate",
    s' = s.with("phase", "reply_gate").with("gateResult", if (gateAllows(s)) "allowed" else "denied")
  }

  action deliverGateReply = all {
    s.phase == "reply_gate",
    s' = s.with("phase", "terminal").with("result", s.gateResult)
  }

  action failRequest = all {
    Pending.contains(s.phase),
    s' = s.with("phase", "terminal").with("result", "unavailable")
  }

  action finish = all {
    s.phase == "terminal",
    s' = s.with("worker", false).with("phase", "idle").with("source", "none")
      .with("aged", false).with("gateResult", "none").with("result", "none")
  }

  action ageCache = all {
    Set("fresh_allow", "fresh_deny").contains(s.cache),
    s' = s.with("cache", if (s.cache == "fresh_allow") "stale_allow" else "stale_deny")
  }
  action evictCache = all {
    s.cache != "empty",
    s' = s.with("cache", "empty")
  }

  action readRefreshPrimary = all {
    s.refresh == "read_primary",
    s' = s.with("refresh", if (s.originAllows and not(s.expired)) "read_gate" else "publish_deny")
  }
  action checkRefreshGate = all {
    s.refresh == "read_gate",
    s' = s.with("refresh", if (gateAllows(s)) "publish_allow" else "idle")
  }
  action publishRefresh = all {
    Set("publish_allow", "publish_deny").contains(s.refresh),
    s' = s.with("cache", if (s.refresh == "publish_allow") "fresh_allow" else "fresh_deny")
      .with("refresh", "idle")
  }
  action failRefresh = all {
    s.refresh != "idle",
    s' = s.with("refresh", "idle")
  }

  action setFence(reason: str, active: bool): bool =
    s' = s.with("fences", if (active) s.fences.union(Set(reason)) else s.fences.exclude(Set(reason)))
  action setPrimary(active: bool): bool = s' = s.with("originAllows", active)
  action expireKey = s' = s.with("expired", true)

  action requestWork = any { readPrimary, evaluateGate, deliverGateReply, failRequest }
  action refreshWork = any { readRefreshPrimary, checkRefreshGate, publishRefresh, failRefresh }
  action wait = s' = s
  action step = any {
    begin(true), begin(false), requestWork, finish, ageCache, evictCache, refreshWork,
    setPrimary(true), setPrimary(false), expireKey, setFence("key", true), wait,
    {
      nondet reason = ReversibleFences.oneOf()
      nondet active = Set(true, false).oneOf()
      setFence(reason, active)
    }
  }

  val Safety = and {
    s.result == "allowed" implies and {
      s.phase == "terminal",
      if (s.worker) (s.source == "cache" or s.gateResult == "allowed") else s.source == "primary"
    },
    (s.result == "allowed" and s.source == "cache") implies s.gateResult == "none",
    Set("read_gate", "reply_gate").contains(s.phase) implies s.worker,
    s.gateResult != "none" implies s.worker,
    not(s.worker) implies s.source != "cache"
  }

  temporal ExactAuthority = always((all {
    (s.phase == "idle" and next(s.source) == "cache") implies
      (cacheAllows(s.cache) or cacheDenies(s.cache)),
    (s.phase == "idle" and next(s.result) == "allowed") implies
      (cacheAllows(s.cache) and not(s.expired)),
    (s.phase == "idle") implies next(s.phase) != "read_gate",
    (s.phase == "read_gate" and next(s.phase) == "reply_gate") implies
      (next(s.gateResult) == (if (gateAllows(s)) "allowed" else "denied")),
    (s.phase == "reply_gate" and next(s.result) == "allowed") implies s.gateResult == "allowed",
    (Set("read_gate", "reply_gate").contains(s.phase)) implies next(s.source) == s.source,
    s.fences.contains("key") implies next(s.fences).contains("key")
  }).orKeep(s))

  temporal RequestReturns = Pending.contains(s.phase).leadsTo(s.phase == "terminal")
  temporal FairRequest = requestWork.weakFair(s) implies RequestReturns
  temporal FairRefresh = refreshWork.weakFair(s) implies
    (s.refresh != "idle").leadsTo(s.refresh == "idle")

  run foreignEntryGoesToPrimaryTest = initialize("foreign", false).then(begin(true))
    .expect(s.phase == "read_primary" and s.source == "primary")
    .then(readPrimary).then(publishRefresh)
    .expect(s.result == "denied" and s.cache == "fresh_deny")

  run warmEntryDecidesWithoutGateTest = initialize("fresh_allow", true).then(begin(true))
    .expect(s.phase == "terminal" and s.result == "allowed" and s.source == "cache")
    .expect(s.gateResult == "none" and s.refresh == "idle")

  run staleAllowRefreshesAfterResponseTest = initialize("stale_allow", false).then(begin(true))
    .expect(s.result == "allowed" and s.gateResult == "none")
    .then(readRefreshPrimary).then(publishRefresh).then(finish).then(begin(true))
    .expect(s.result == "denied" and s.source == "cache")

  run staleDenialRefreshesWithoutGateForCurrentRequestTest = initialize("stale_deny", true)
    .then(begin(true)).expect(s.result == "denied" and s.gateResult == "none")
    .then(readRefreshPrimary).then(checkRefreshGate).then(publishRefresh)
    .expect(s.cache == "fresh_allow" and s.result == "denied")

  run expiredCachedKeyRejectsLocallyTest = initialize("fresh_allow", true).then(expireKey)
    .then(begin(true)).expect(s.result == "denied" and s.gateResult == "none")

  run noBoundaryUsesPrimaryTest = initialize("fresh_allow", false).then(begin(false))
    .then(readPrimary).expect(s.result == "denied" and s.source == "primary" and s.refresh == "idle")

  run absentGateReplyFailsClosedTest = initialize("empty", true).then(begin(true))
    .then(readPrimary).then(evaluateGate).then(failRequest)
    .expect(s.result == "unavailable" and s.source == "primary")

  // A fenced key keeps its retained positive entry until the refresh rewrites it.
  run retainedPositiveAllowsUntilRefreshTest = initialize("stale_allow", true)
    .then(setFence("key", true)).then(setPrimary(false)).then(begin(true))
    .expect(s.result == "allowed" and s.source == "cache")
    .then(readRefreshPrimary).then(publishRefresh).then(finish).then(begin(true))
    .expect(s.result == "denied" and s.cache == "fresh_deny")

  run fencedKeyIsNeverRepublishedTest = initialize("stale_deny", true).then(setFence("key", true))
    .then(begin(true)).then(readRefreshPrimary).then(checkRefreshGate)
    .expect(s.refresh == "idle" and s.cache == "stale_deny")

  run clearingOneFenceCannotClearAnotherTest = initialize("empty", true)
    .then(setFence("account", true)).then(setFence("moderation", true))
    .then(setFence("moderation", false)).then(begin(true)).then(readPrimary)
    .then(evaluateGate).then(deliverGateReply)
    .expect(s.result == "denied" and s.fences == Set("account"))
    .then(finish).then(setFence("account", false)).then(begin(true)).then(readPrimary)
    .then(evaluateGate).then(deliverGateReply)
    .expect(s.result == "allowed")

  run earlierGateReplyRetainsItsOwnDecisionTest = initialize("empty", true)
    .then(begin(true)).then(readPrimary).then(evaluateGate)
    .then(setFence("organization", true)).then(deliverGateReply)
    .expect(s.result == "allowed")
    .then(finish).then(begin(true)).then(readPrimary).then(evaluateGate).then(deliverGateReply)
    .expect(s.result == "denied")

  run failedRefreshLeavesSlotRetryableTest = initialize("stale_allow", false)
    .then(begin(true)).then(failRefresh)
    .expect(s.cache == "stale_allow" and s.refresh == "idle")
    .then(finish).then(begin(true))
    .then(readRefreshPrimary).then(publishRefresh).expect(s.cache == "fresh_deny")
}
