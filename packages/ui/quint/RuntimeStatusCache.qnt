// createRuntimeJsonClient's outer cache, request and account-refresh protocol.
// The host keeps one bridge identity per generation. Provider readiness is an
// abstract completion of ensure(), not a proof of its polling implementation.
// Terminal failures are grouped. Exact error selection stays in the real suite.
module RuntimeStatusCache {
  type Request = {
    epoch: int,
    phase: str,
    retried: bool,
    available: bool,
    needsStartup: bool,
    probes: int,
    sends: int,
  }
  type State = {
    generation: int,
    maxGeneration: int,
    allowed: Set[int],
    reuse: bool,
    running: int,
    refreshing: int,
    refreshFailure: bool,
    refreshes: int -> str,
    requests: int -> Request,
    staleDispatch: bool,
    stalePublication: bool,
    unsafeReplay: bool,
    unsafeFallback: bool
  }
  var s: State
  pure val unused: Request = {
    epoch: -1,
    phase: "unused",
    retried: false,
    available: false,
    needsStartup: false,
    probes: 0,
    sends: 0,
  }
  pure def initial(reuse: bool, allowed: Set[int], limit: int): State = {
    generation: 0,
    maxGeneration: limit,
    allowed: allowed,
    reuse: reuse,
    running: -1,
    refreshing: -1,
    refreshFailure: false,
    refreshes: Map(1 -> "unused", 2 -> "unused"),
    requests: Map(1 -> unused, 2 -> unused),
    staleDispatch: false,
    stalePublication: false,
    unsafeReplay: false,
    unsafeFallback: false
  }
  action init = s' = initial(true, Set(1, 2), 1)
  action initDefault = s' = initial(false, Set(1, 2), 1)
  action initOverlap = s' = initial(true, Set(1, 2), 2)

  // The cached path calls bridge.request synchronously from request(). The
  // uncached path starts a status promise. This helper performs no await.
  pure def admitCurrent(x: State, request: Request): Request =
    if (x.refreshFailure) { ...request, phase: "failed" }
    else if (x.running == request.epoch) {
      ...request,
      phase: "native",
      available: true,
      sends: request.sends + 1
    } else { ...request, phase: "status", probes: request.probes + 1 }

  action admit(id: int): bool = {
    val request = { ...unused, epoch: s.generation }
    val admitted = if (s.refreshing == s.generation)
      { ...request, phase: "refresh" }
      else admitCurrent(s, request)
    all {
      s.allowed.contains(id),
      s.requests.get(id).phase == "unused",
      s' = {
        ...s,
        requests: s.requests.set(id, admitted)
      }
    }
  }

  // A refresh increments generation before scheduling status/restart work.
  action refresh = all {
    s.generation < s.maxGeneration,
    s' = {
      ...s,
      generation: s.generation + 1,
      refreshing: s.generation + 1,
      refreshFailure: false,
      refreshes: s.refreshes.set(s.generation + 1, "pending")
    }
  }

  // Late completion of a superseded refresh cannot warm, poison or retire
  // the current refresh. Failed includes the bounded startup deadline.
  action finishRefresh(epoch: int, outcome: str): bool = all {
    s.refreshes.get(epoch) == "pending",
    s' = {
      ...s,
      running: if (epoch == s.generation and outcome == "ready" and s.reuse)
        epoch else s.running,
      refreshing: if (s.refreshing == epoch) -1 else s.refreshing,
      refreshFailure: if (epoch == s.generation) outcome == "failed"
        else s.refreshFailure,
      refreshes: s.refreshes.set(epoch,
        if (epoch != s.generation) "stale" else outcome)
    }
  }

  action resume(id: int): bool = {
    val request = s.requests.get(id)
    val resumed = if (request.epoch != s.generation)
      { ...request, phase: "failed" }
      else admitCurrent(s, request)
    all {
      request.phase == "refresh",
      s.refreshes.get(request.epoch) != "pending",
      s' = {
        ...s,
        requests: s.requests.set(id, resumed)
      }
    }
  }

  // Only the first unavailable probe may select nativeFallback. Once a native
  // request has received NOT_READY, unavailability preserves that rejection.
  action statusReply(id: int, outcome: str): bool = {
    val request = s.requests.get(id)
    val updated = if (outcome == "error")
      { ...request, phase: "failed" }
      else if (request.epoch != s.generation)
        { ...request, phase: "failed" }
      else if (outcome == "unavailable") {
        ...request,
        phase: if (request.retried) "failed" else "fallback"
      } else {
        ...request,
        available: true,
        needsStartup: outcome == "stopped",
        phase: "ready"
      }
    all {
      request.phase == "status",
      s' = {
        ...s,
        requests: s.requests.set(id, updated),
        unsafeFallback: s.unsafeFallback or (updated.phase == "fallback" and request.available)
      }
    }
  }

  // ensure() completes before ready() publishes the generation-tagged cache.
  // Awaiting ready() leaves another microtask boundary before send().
  action ready(id: int, outcome: str): bool = {
    val request = s.requests.get(id)
    val succeeds = request.epoch == s.generation and outcome == "ready"
    val updated = {
      ...request,
      phase: if (succeeds) "dispatch" else "failed"
    }
    all {
      request.phase == "ready",
      outcome == "ready" or request.needsStartup,
      s' = {
        ...s,
        running: if (succeeds and s.reuse) request.epoch else s.running,
        requests: s.requests.set(id, updated)
      }
    }
  }

  // This is the final invocation boundary, including the NOT_READY retry.
  action dispatch(id: int): bool = {
    val request = s.requests.get(id)
    val ownsGeneration = request.epoch == s.generation
    val updated = if (ownsGeneration) {
      ...request,
      phase: "native",
      sends: request.sends + 1
    } else {
      ...request,
      phase: "failed"
    }
    all {
      request.phase == "dispatch",
      s' = {
        ...s,
        requests: s.requests.set(id, updated),
        staleDispatch: s.staleDispatch or (updated.phase == "native" and not(ownsGeneration)),
        unsafeReplay: s.unsafeReplay or (ownsGeneration and request.sends > 0 and not(request.retried))
      }
    }
  }

  // NOT_READY is a bridge rejection before dispatch, not a response body. All
  // other outcomes may have effects and cannot authorize automatic replay.
  action nativeReply(id: int, outcome: str): bool = {
    val request = s.requests.get(id)
    val retry = outcome == "notReady" and s.reuse and not(request.retried)
      and request.epoch == s.generation
    val updated = {
      ...request,
      phase: if (retry) "status" else if (outcome == "ok" and request.epoch == s.generation)
        "done" else "failed",
      retried: request.retried or retry,
      probes: request.probes + (if (retry) 1 else 0),
    }
    all {
      request.phase == "native",
      s' = {
        ...s,
        running: if (s.running == request.epoch and Set("notReady", "error", "503").contains(outcome))
          -1 else s.running,
        requests: s.requests.set(id, updated),
        stalePublication: s.stalePublication or (updated.phase == "done" and request.epoch != s.generation)
      }
    }
  }

  action fallbackReply(id: int, outcome: str): bool = {
    val request = s.requests.get(id)
    val succeeds = request.epoch == s.generation and outcome == "ok"
    all {
      request.phase == "fallback",
      s' = {
        ...s,
        requests: s.requests.set(id, {
          ...request,
          phase: if (succeeds) "done" else "failed"
        })
      }
    }
  }

  action advance(id: int): bool = any {
    resume(id),
    dispatch(id),
    { nondet outcome = Set("running", "stopped", "unavailable", "error").oneOf()
      statusReply(id, outcome) },
    { nondet outcome = Set("ready", "failed").oneOf()
      ready(id, outcome) },
    { nondet outcome = Set("ok", "notReady", "error", "503", "otherHttp").oneOf()
      nativeReply(id, outcome) },
    { nondet outcome = Set("ok", "failed").oneOf()
      fallbackReply(id, outcome) }
  }
  action advanceOne = advance(1)
  action advanceTwo = advance(2)
  action advanceRefresh = {
    nondet epoch = Set(1, 2).oneOf()
    nondet outcome = Set("ready", "unavailable", "failed").oneOf()
    finishRefresh(epoch, outcome)
  }
  action idle = s' = s
  action step = any {
    {
      nondet id = s.allowed.oneOf()
      admit(id)
    },
    refresh,
    advanceOne,
    advanceTwo,
    advanceRefresh,
    idle
  }
  val dispatchFence = not(s.staleDispatch)
  val publicationFence = not(s.stalePublication)
  val noUnsafeReplay = not(s.unsafeReplay)
  val nativeOwnsAvailableRequests = not(s.unsafeFallback)
  val finiteBounds = and {
    s.generation >= 0 and s.generation <= s.maxGeneration,
    s.running >= -1 and s.running <= s.generation,
    Set(1, 2).forall(id => s.requests.get(id).sends >= 0 and s.requests.get(id).sends <= 2),
    Set(1, 2).forall(id => s.requests.get(id).probes >= 0 and s.requests.get(id).probes <= 2)
  }
  val invariant = dispatchFence and publicationFence and noUnsafeReplay
    and nativeOwnsAvailableRequests and finiteBounds
  pure def terminal(request: Request): bool = Set("unused", "done", "failed").contains(request.phase)
  temporal CompletionUnderFairCompletions =
    (advanceOne.weakFair(s) and advanceTwo.weakFair(s) and advanceRefresh.weakFair(s)) implies
      and {
        always(not(terminal(s.requests.get(1))) implies eventually(terminal(s.requests.get(1)))),
        always(not(terminal(s.requests.get(2))) implies eventually(terminal(s.requests.get(2))))
      }

  run readyRefreshDispatchTest = init.then(admit(1)).then(statusReply(1, "running"))
    .then(ready(1, "ready")).then(refresh).then(dispatch(1))
    .expect(dispatchFence and s.requests.get(1).sends == 0 and invariant)
  run defaultNeverRetriesTest = initDefault.then(admit(1)).then(statusReply(1, "running"))
    .then(ready(1, "ready")).then(dispatch(1)).then(nativeReply(1, "notReady"))
    .expect(s.requests.get(1).phase == "failed" and s.requests.get(1).sends == 1 and invariant)
  run undispatchedRetryIsBoundedTest = init.then(admit(1)).then(statusReply(1, "running"))
    .then(ready(1, "ready")).then(dispatch(1)).then(nativeReply(1, "notReady"))
    .then(statusReply(1, "running")).then(ready(1, "ready")).then(dispatch(1))
    .then(nativeReply(1, "notReady"))
    .expect(s.requests.get(1).sends == 2 and s.requests.get(1).phase == "failed" and invariant)
  run oldResponseKeepsNewCacheTest = init.then(admit(1)).then(statusReply(1, "running"))
    .then(ready(1, "ready")).then(dispatch(1)).then(refresh).then(finishRefresh(1, "ready"))
    .then(nativeReply(1, "503")).then(admit(2))
    .expect(s.running == 1 and s.requests.get(2).probes == 0 and invariant)
  run oldRefreshKeepsNewCacheTest = initOverlap.then(refresh).then(refresh)
    .then(finishRefresh(2, "ready")).then(finishRefresh(1, "failed"))
    .expect(s.running == 2 and not(s.refreshFailure) and s.refreshing == -1 and invariant)
  run failedRefreshStopsAdmissionTest = init.then(refresh).then(finishRefresh(1, "failed"))
    .then(admit(1)).expect(s.requests.get(1).phase == "failed" and s.requests.get(1).sends == 0 and invariant)
  run explicitRefreshRecoversAfterFailureTest = initOverlap.then(refresh).then(finishRefresh(1, "failed"))
    .then(admit(1)).then(refresh).then(finishRefresh(2, "ready")).then(admit(2))
    .then(nativeReply(2, "ok"))
    .expect(s.requests.get(1).phase == "failed" and s.requests.get(2).phase == "done" and invariant)
  run unavailableUsesFallbackTest = init.then(admit(1)).then(statusReply(1, "unavailable"))
    .then(fallbackReply(1, "ok"))
    .expect(s.requests.get(1).phase == "done" and s.requests.get(1).sends == 0 and invariant)
  run availableStartupFailureDoesNotFallbackTest = init.then(admit(1)).then(statusReply(1, "stopped"))
    .then(ready(1, "failed"))
    .expect(s.requests.get(1).phase == "failed" and s.requests.get(1).available and invariant)
}
