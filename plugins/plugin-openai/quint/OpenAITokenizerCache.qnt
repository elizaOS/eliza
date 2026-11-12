// loadEncoder in plugins/plugin-openai/utils/tokenization.ts.
// Each encoding has its own permanent successful cache slot. The rejection
// handler is registered before the promise is returned to any caller.
module OpenAITokenizerCache {
  pure val Encodings = Set(0, 1)
  pure val Loads = Set(0, 1, 2, 3)
  pure val Callers = Set(0, 1, 2, 3)
  pure val Retained = Set("pending", "rejecting", "ready")
  pure def encoding(load: int): int = if (load < 2) 0 else 1
  var s: {
    cache: int -> int,
    allocated: int -> int,
    phase: int -> str,
    requested: int -> int,
    captured: int -> int,
    callerPhase: int -> str,
  }

  action init = s' = {
    cache: Encodings.mapBy(_ => -1),
    allocated: Encodings.mapBy(_ => 0),
    phase: Loads.mapBy(_ => "unused"),
    requested: Callers.mapBy(_ => -1),
    captured: Callers.mapBy(_ => -1),
    callerPhase: Callers.mapBy(_ => "idle"),
  }

  // Map publication and capturing the returned promise occur in one turn.
  action request(caller: int, kind: int): bool = all {
    s.callerPhase.get(caller) == "idle",
    s.cache.get(kind) >= 0 or s.allocated.get(kind) < 2,
    {
      val hit = s.cache.get(kind) >= 0
      val load = if (hit) s.cache.get(kind) else 2 * kind + s.allocated.get(kind)
      s' = {
        ...s,
        cache: s.cache.set(kind, load),
        allocated: if (hit) s.allocated else s.allocated.set(kind, s.allocated.get(kind) + 1),
        phase: if (hit) s.phase else s.phase.set(load, "pending"),
        requested: s.requested.set(caller, kind),
        captured: s.captured.set(caller, load),
        callerPhase: s.callerPhase.set(caller, "waiting"),
      }
    },
  }

  action settle(load: int, succeeds: bool): bool = all {
    s.phase.get(load) == "pending",
    s' = { ...s, phase: s.phase.set(load, if (succeeds) "ready" else "rejecting") },
  }

  // No action can replace a map entry before its registered rejection
  // handler runs. Another caller may still join the rejected promise.
  action clearRejection(load: int): bool = all {
    s.phase.get(load) == "rejecting",
    s' = {
      ...s,
      cache: s.cache.set(encoding(load), -1),
      phase: s.phase.set(load, "rejected"),
    },
  }

  action observe(caller: int): bool = all {
    s.callerPhase.get(caller) == "waiting",
    {
      val result = s.phase.get(s.captured.get(caller))
      all {
        Set("ready", "rejected").contains(result),
        s' = {
          ...s,
          callerPhase: s.callerPhase.set(caller, if (result == "ready") "resolved" else "failed"),
        },
      }
    },
  }

  action finish(load: int): bool = any { settle(load, true), settle(load, false) }
  action step = any {
    {
      nondet caller = Callers.oneOf()
      nondet kind = Encodings.oneOf()
      request(caller, kind)
    },
    {
      nondet load = Loads.oneOf()
      any { finish(load), clearRejection(load) }
    },
    {
      nondet caller = Callers.oneOf()
      observe(caller)
    },
    s' = s,
  }

  val CacheCoherent = and {
    Encodings.forall(kind =>
      s.cache.get(kind) == -1 or (
        Loads.contains(s.cache.get(kind)) and encoding(s.cache.get(kind)) == kind and
        Retained.contains(s.phase.get(s.cache.get(kind)))
      )),
    Loads.forall(load =>
      Retained.contains(s.phase.get(load)) implies s.cache.get(encoding(load)) == load),
  }
  val CallersOwnTheirPromise = Callers.forall(caller =>
    s.callerPhase.get(caller) != "idle" implies (
      Loads.contains(s.captured.get(caller)) and
      encoding(s.captured.get(caller)) == s.requested.get(caller) and
      s.phase.get(s.captured.get(caller)) != "unused"
    ))
  val ReceiptsMatchLoad = Callers.forall(caller => and {
    s.callerPhase.get(caller) == "resolved" implies s.phase.get(s.captured.get(caller)) == "ready",
    s.callerPhase.get(caller) == "failed" implies s.phase.get(s.captured.get(caller)) == "rejected",
  })
  val safety = CacheCoherent and CallersOwnTheirPromise and ReceiptsMatchLoad

  temporal CallersSettle = (
    Loads.forall(load => finish(load).weakFair(s) and clearRejection(load).weakFair(s)) and
    Callers.forall(caller => observe(caller).weakFair(s))
  ).implies(Callers.forall(caller =>
    (s.callerPhase.get(caller) == "waiting").leadsTo(
      Set("resolved", "failed").contains(s.callerPhase.get(caller))
    )))
  temporal UnfairCallersSettle = Callers.forall(caller =>
    (s.callerPhase.get(caller) == "waiting").leadsTo(
      Set("resolved", "failed").contains(s.callerPhase.get(caller))
    ))

  run pendingCallersShareOnePromiseTest = init
    .then(request(0, 0)).then(request(1, 0))
    .expect(safety and s.allocated.get(0) == 1 and s.captured.get(0) == s.captured.get(1))

  run differentEncodingsRetainIndependentPromisesTest = init
    .then(request(0, 0)).then(request(1, 1))
    .then(settle(0, true)).then(settle(2, true)).then(request(2, 0))
    .expect(safety and s.captured.get(2) == 0 and s.cache.get(1) == 2)

  run failureEvictsOnlyItsOwnSlotAndAllowsRetryTest = init
    .then(request(0, 0)).then(request(1, 1)).then(settle(2, true))
    .then(settle(0, false)).then(request(2, 0)).then(clearRejection(0)).then(request(3, 0))
    .then(settle(1, true)).then(observe(3)).then(observe(2)).then(observe(0))
    .expect(
      safety and s.cache.get(0) == 1 and s.cache.get(1) == 2 and
      s.callerPhase.get(0) == "failed" and s.callerPhase.get(2) == "failed" and
      s.callerPhase.get(3) == "resolved"
    )
}
