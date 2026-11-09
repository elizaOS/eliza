// src/runtime/provider-execution.ts and ProviderStateComposer. Separate
// creator cleanup, waiter settlement and composer-stop steps retain races.
module ProviderExecutionModel {
  const Callers: Set[str]
  const Signalled: Set[str]
  const Keyed: Set[str]
  const MaxExec: int
  pure val Execs = 1.to(MaxExec)
  type WorkPhase = Pending | Settled | Cleaned
  type State = {
    map: int, active: Set[int], created: Set[int], waiters: int -> int,
    cause: int -> str, phase: int -> WorkPhase,
    exec: str -> int, pc: str -> str, sigAborted: str -> bool,
    stopping: bool, stopped: bool
  }
  var s: State
  def Attached(e: int): Set[str] = Callers.filter(c => s.pc.get(c) == "attached" and s.exec.get(c) == e)
  action init = s' = {
    map: 0, active: Set(), created: Set(), waiters: Execs.mapBy(_ => 0),
    cause: Execs.mapBy(_ => "none"), phase: Execs.mapBy(_ => Pending),
    exec: Callers.mapBy(_ => 0),
    pc: Callers.mapBy(_ => "idle"), sigAborted: Callers.mapBy(_ => false),
    stopping: false, stopped: false
  }
  action Attach(c: str): bool = {
    val coalesced = Keyed.contains(c) and s.map != 0
    val e = if (coalesced) s.map else s.created.size() + 1
    val map1 = if (not(coalesced) and Keyed.contains(c)) e else s.map
    val cause1 = if (not(coalesced) and s.stopping) "stop" else s.cause.get(e)
    val leaves = Signalled.contains(c) and s.sigAborted.get(c)
    val w = if (leaves) s.waiters.get(e) else s.waiters.get(e) + 1
    val last = leaves and w == 0
    all {
      s.pc.get(c) == "idle",
      s.created.size() < MaxExec or coalesced,
      s' = { ...s,
        created: s.created.union(Set(e)),
        active: if (coalesced) s.active else s.active.union(Set(e)),
        waiters: s.waiters.set(e, w),
        cause: s.cause.set(e, if (last and cause1 == "none") "waiters" else cause1),
        map: if (last and map1 == e) 0 else map1,
        exec: s.exec.set(c, e), pc: s.pc.set(c, if (leaves) "done" else "attached")
      }
    }
  }
  action AbortSignal(c: str): bool = all {
    Signalled.contains(c), not(s.sigAborted.get(c)),
    if (s.pc.get(c) == "attached") {
      val e = s.exec.get(c)
      s' = { ...s,
        sigAborted: s.sigAborted.set(c, true),
        waiters: s.waiters.set(e, s.waiters.get(e) - 1), pc: s.pc.set(c, "done"),
        map: if (s.waiters.get(e) == 1 and s.map == e) 0 else s.map,
        cause: if (s.waiters.get(e) == 1) s.cause.set(e, if (s.cause.get(e) == "none") "waiters" else s.cause.get(e)) else s.cause
      }
    } else s' = { ...s, sigAborted: s.sigAborted.set(c, true) }
  }
  action SettleWork(e: int): bool = all {
    s.created.contains(e), s.phase.get(e) == Pending,
    s' = { ...s, phase: s.phase.set(e, Settled) }
  }
  action SettleAborted(e: int): bool = all { s.cause.get(e) != "none", SettleWork(e) }
  action Cleanup(e: int): bool = all {
    s.phase.get(e) == Settled,
    s' = { ...s, phase: s.phase.set(e, Cleaned), active: s.active.exclude(Set(e)), map: if (s.map == e) 0 else s.map }
  }
  action CallerSettle(c: str): bool = all {
    s.pc.get(c) == "attached", s.phase.get(s.exec.get(c)) == Cleaned,
    s' = { ...s, waiters: s.waiters.set(s.exec.get(c), s.waiters.get(s.exec.get(c)) - 1), pc: s.pc.set(c, "done") }
  }
  action RequestStop = all { not(s.stopping), s' = { ...s, stopping: true } }
  action StopComposer = all {
    s.stopping, not(s.stopped),
    s' = { ...s, stopped: true, active: Set(), map: 0,
      cause: Execs.mapBy(e => if (s.active.contains(e) and s.cause.get(e) == "none") "stop" else s.cause.get(e)) }
  }
  val Finished = Callers.forall(c => s.pc.get(c) == "done") and s.created.forall(e => s.phase.get(e) == Cleaned) and s.stopped
  action nextStep = any {
    { nondet c = Callers.oneOf()
      any { Attach(c), AbortSignal(c), CallerSettle(c) } },
    { nondet e = Execs.oneOf()
      any { SettleWork(e), SettleAborted(e), Cleanup(e) } },
    RequestStop, StopComposer, all { Finished, s' = s }
  }
  // The original specification permits stuttering at every state. Deadlock
  // freedom checks the transition relation before adding that stutter.
  action step = any { nextStep, s' = s }
  temporal DeadlockFree = always(enabled(nextStep))
  temporal Fairness = and {
    Execs.forall(e => SettleAborted(e).weakFair(s) and Cleanup(e).weakFair(s)),
    Callers.forall(c => CallerSettle(c).weakFair(s)), StopComposer.weakFair(s)
  }
  val TypeOK = and {
    Execs.union(Set(0)).contains(s.map), s.active.subseteq(Execs), s.created.subseteq(Execs),
    s.waiters.keys() == Execs, s.cause.keys() == Execs, s.phase.keys() == Execs,
    Execs.forall(e => s.waiters.get(e) >= 0 and Set("none", "waiters", "stop").contains(s.cause.get(e))),
    s.exec.keys() == Callers, s.pc.keys() == Callers, s.sigAborted.keys() == Callers,
    Callers.forall(c => Execs.union(Set(0)).contains(s.exec.get(c)) and Set("idle", "attached", "done").contains(s.pc.get(c)))
  }
  val WaiterCount = s.created.forall(e => s.waiters.get(e) == Attached(e).size())
  val AbortOnlyWhenUnwanted = s.created.forall(e =>
    (s.cause.get(e) == "waiters").implies(Attached(e).size() == 0) and (s.cause.get(e) == "stop").implies(s.stopping))
  val UnwantedWorkAborted = s.created.forall(e => (s.phase.get(e) == Pending and s.waiters.get(e) == 0).implies(s.cause.get(e) != "none"))
  val NoJoinAborting = (s.map != 0).implies(s.cause.get(s.map) == "none" or (s.cause.get(s.map) == "stop" and s.stopping))
  val StopReachesAll = s.stopped.implies(s.created.forall(e => (s.phase.get(e) == Pending).implies(s.cause.get(e) != "none")))
  val MapActive = (s.map != 0).implies(s.active.contains(s.map))
  val ExecutionPhaseConsistent = s.active.subseteq(s.created) and Execs.forall(e =>
    (not(s.created.contains(e))).implies(s.phase.get(e) == Pending) and
    s.active.contains(e).implies(s.phase.get(e) != Cleaned))
  temporal AbortedCallerLeaves = Fairness.implies(Callers.forall(c =>
    (s.pc.get(c) == "attached" and s.cause.get(s.exec.get(c)) != "none").leadsTo(s.pc.get(c) == "done")))
  temporal StopReleasesCallers = Fairness.implies(Callers.forall(c =>
    (s.pc.get(c) == "attached" and s.stopped).leadsTo(s.pc.get(c) == "done")))
  // Once the work settles, callbacks must finish regardless of its outcome.
  // This property does not assume that non-aborted provider work settles.
  temporal SettledCallerLeaves = and {
    Execs.forall(e => Cleanup(e).weakFair(s)),
    Callers.forall(c => CallerSettle(c).weakFair(s))
  }.implies(Callers.forall(c =>
    (s.pc.get(c) == "attached" and s.phase.get(s.exec.get(c)) != Pending).leadsTo(s.pc.get(c) == "done")))
}
module ProviderExecution {
  import ProviderExecutionModel(Callers = Set("a", "b", "c"), Signalled = Set("a", "b"), Keyed = Set("a", "b", "c"), MaxExec = 3).* from "./ProviderExecution"
}
module ProviderExecutionOneoff {
  import ProviderExecutionModel(Callers = Set("a", "b", "c"), Signalled = Set("a", "c"), Keyed = Set("a", "b"), MaxExec = 3).* from "./ProviderExecution"
}
