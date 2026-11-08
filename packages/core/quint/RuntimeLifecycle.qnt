// src/runtime.ts, runtime/service-lifecycle.ts, room-handler-queue.ts and
// turn-controller.ts. Every await boundary in initialize/stop is retained.
module RuntimeLifecycleModel {
  const Turns: Set[str]
  const Stoppers: Set[str]
  const MaxAttempts: int
  pure val None = "none"
  pure val Attempts = 1.to(MaxAttempts)
  type State = {
    ipc: str, initResolved: bool, initFailed: bool, svc: str, svcLate: bool,
    queue: List[str], owner: str, tpc: str -> str, aborted: str -> bool,
    stopReq: bool, stopped: bool, stopPromise: bool, prepareCalls: int,
    closed: bool, turnsClosed: bool, failures: bool,
    apc: str, aid: int, afast: bool, outcome: int -> str,
    spc: str -> str, sfast: str -> bool, sstrict: str -> bool,
    sjoined: str -> int, strictP: str
  }
  var s: State
  val Pending = Turns.filter(t => Set("queued", "lease", "turn").contains(s.tpc.get(t)))
  action init = s' = {
    ipc: "idle", initResolved: false, initFailed: false, svc: "none", svcLate: false,
    queue: List(), owner: None, tpc: Turns.mapBy(_ => "idle"), aborted: Turns.mapBy(_ => false),
    stopReq: false, stopped: false, stopPromise: false, prepareCalls: 0, closed: false, turnsClosed: false, failures: false,
    apc: "none", aid: 0, afast: false, outcome: Attempts.mapBy(_ => "pending"),
    spc: Stoppers.mapBy(_ => "idle"), sfast: Stoppers.mapBy(_ => false), sstrict: Stoppers.mapBy(_ => false), sjoined: Stoppers.mapBy(_ => 0), strictP: "none"
  }
  action IRegister = all {
    s.ipc == "idle",
    if (s.stopReq) s' = { ...s, ipc: "failed", initResolved: true, initFailed: true }
    else s' = { ...s, ipc: "core", svc: "waitInit" }
  }
  action ICore = {
    nondet ok = Set(false, true).oneOf()
    all { s.ipc == "core", s' = { ...s, ipc: if (ok) "ok" else "failed", initFailed: not(ok), initResolved: true } }
  }
  action SvcResume = all {
    s.svc == "waitInit", s.initResolved,
    s' = { ...s, svc: if (s.stopReq or s.initFailed) "skipped" else "starting" }
  }
  action SvcStarted = all {
    s.svc == "starting",
    if (s.stopped or s.stopReq) s' = { ...s, svc: "stopping", svcLate: true }
    else s' = { ...s, svc: "live" }
  }
  action SvcStopDone = all { s.svc == "stopping", s' = { ...s, svc: "stopped" } }
  action TAdmit(t: str): bool = all {
    s.tpc.get(t) == "idle",
    if (s.closed) s' = { ...s, tpc: s.tpc.set(t, "refused") }
    else s' = { ...s, queue: s.queue.append(t), tpc: s.tpc.set(t, "queued") }
  }
  action TGrant = all {
    s.owner == None, s.queue.length() > 0,
    s' = { ...s, owner: s.queue.head(), queue: s.queue.tail(), tpc: s.tpc.set(s.queue.head(), "lease") }
  }
  action TRun(t: str): bool = all {
    s.tpc.get(t) == "lease",
    s' = { ...s, tpc: s.tpc.set(t, "turn"), aborted: s.aborted.set(t, s.turnsClosed) }
  }
  action TFinish(t: str): bool = all {
    s.tpc.get(t) == "turn", s' = { ...s, tpc: s.tpc.set(t, "done"), owner: None }
  }
  action SCall(caller: str): bool = {
    nondet fast = Set(false, true).oneOf()
    nondet strict = Set(false, true).oneOf()
    val base = { ...s, sfast: s.sfast.set(caller, fast), sstrict: s.sstrict.set(caller, strict) }
    val entering = { ...base, strictP: if (strict) "running" else s.strictP }
    all {
      s.spc.get(caller) == "idle", s.aid < MaxAttempts or s.stopPromise or s.stopped,
      if (strict and s.strictP != "none") s' = { ...base, spc: s.spc.set(caller, "awaitStrict") }
      else if (s.stopPromise) s' = { ...entering, sjoined: s.sjoined.set(caller, s.aid), spc: s.spc.set(caller, "be") }
      else if (s.stopped) s' = { ...entering, spc: s.spc.set(caller, if (strict) "drain" else "done") }
      else s' = { ...entering,
        stopPromise: true, aid: s.aid + 1, afast: fast, apc: "drain", sjoined: s.sjoined.set(caller, s.aid + 1),
        prepareCalls: if (s.stopReq) s.prepareCalls else s.prepareCalls + 1,
        stopReq: true, closed: true, turnsClosed: true,
        aborted: Turns.mapBy(t => s.aborted.get(t) or s.tpc.get(t) == "turn"), spc: s.spc.set(caller, "be") }
    }
  }
  action ADrained = all { s.apc == "drain", Pending.size() == 0, s' = { ...s, apc: "services" } }
  action ATimeout = all {
    s.apc == "drain", s.afast, Pending.size() > 0,
    s' = { ...s, apc: "none", outcome: s.outcome.set(s.aid, "err"), failures: true, stopPromise: false }
  }
  action AServices = all {
    s.apc == "services",
    s' = { ...s, stopped: true, svc: if (s.svc == "live") "stopping" else s.svc, apc: "svcwait" }
  }
  action ASvcDone = all {
    s.apc == "svcwait", s.svc != "stopping" or s.svcLate or s.afast,
    s' = { ...s, apc: "none", outcome: s.outcome.set(s.aid, "ok"), stopPromise: false }
  }
  action SBestEffortDone(caller: str): bool = all {
    s.spc.get(caller) == "be", s.outcome.get(s.sjoined.get(caller)) != "pending",
    if (s.outcome.get(s.sjoined.get(caller)) == "err") s' = { ...s, spc: s.spc.set(caller, "done"), strictP: if (s.sstrict.get(caller)) "err" else s.strictP }
    else s' = { ...s, spc: s.spc.set(caller, if (s.sstrict.get(caller)) "drain" else "done") }
  }
  action SStrictDrain(caller: str): bool = all {
    s.spc.get(caller) == "drain", Pending.size() == 0, not(Set("starting", "stopping").contains(s.svc)),
    s' = { ...s, spc: s.spc.set(caller, "done"), strictP: if (s.failures) "err" else "ok" }
  }
  action SAwaitStrict(caller: str): bool = all {
    s.spc.get(caller) == "awaitStrict", Set("ok", "err").contains(s.strictP),
    s' = { ...s, spc: s.spc.set(caller, "done") }
  }
  val Finished = and {
    Set("idle", "ok", "failed").contains(s.ipc), not(Set("waitInit", "starting", "stopping").contains(s.svc)),
    Pending.size() == 0, s.apc == "none", Stoppers.forall(caller => Set("idle", "done").contains(s.spc.get(caller)))
  }
  action nextStep = any {
    IRegister, ICore, SvcResume, SvcStarted, SvcStopDone,
    { nondet t = Turns.oneOf()
      any { TAdmit(t), TRun(t), TFinish(t) } }, TGrant,
    { nondet caller = Stoppers.oneOf()
      any { SCall(caller), SBestEffortDone(caller), SStrictDrain(caller), SAwaitStrict(caller) } },
    ADrained, ATimeout, AServices, ASvcDone, all { Finished, s' = s }
  }
  // The original specification permits stuttering at every state. Deadlock
  // freedom checks the transition relation before adding that stutter.
  action step = any { nextStep, s' = s }
  temporal DeadlockFree = always(enabled(nextStep))
  temporal Fairness = and {
    ICore.weakFair(s), SvcResume.weakFair(s), SvcStarted.weakFair(s), SvcStopDone.weakFair(s), TGrant.weakFair(s),
    Turns.forall(t => TRun(t).weakFair(s) and TFinish(t).weakFair(s)),
    ADrained.weakFair(s), AServices.weakFair(s), ASvcDone.weakFair(s),
    Stoppers.forall(caller => SBestEffortDone(caller).weakFair(s) and SStrictDrain(caller).weakFair(s) and SAwaitStrict(caller).weakFair(s))
  }
  val LifecycleState = if (s.stopReq) (if (s.stopped and not(s.stopPromise)) "stopped" else "stopping")
    else if (s.initFailed) "failed" else if (not(s.initResolved)) "initializing" else "running"
  val TypeOK = and {
    Set("idle", "core", "ok", "failed").contains(s.ipc), Set("none", "waitInit", "skipped", "starting", "live", "stopping", "stopped").contains(s.svc),
    s.tpc.keys() == Turns, Turns.forall(t => Set("idle", "queued", "lease", "turn", "done", "refused").contains(s.tpc.get(t))),
    Turns.union(Set(None)).contains(s.owner), Set("none", "drain", "services", "svcwait").contains(s.apc), s.aid >= 0 and s.aid <= MaxAttempts,
    s.outcome.keys() == Attempts, Attempts.forall(a => Set("pending", "ok", "err").contains(s.outcome.get(a))),
    s.spc.keys() == Stoppers, Stoppers.forall(caller => Set("idle", "be", "drain", "awaitStrict", "done").contains(s.spc.get(caller))),
    Set("none", "running", "ok", "err").contains(s.strictP)
  }
  val PrepareStopOnce = s.prepareCalls <= 1 and s.stopReq.implies(s.prepareCalls == 1)
  val SingleAttempt = s.stopPromise.iff(s.apc != "none")
  val TurnsAbortedAfterStop = Turns.forall(t => (s.tpc.get(t) == "turn" and s.stopReq).implies(s.aborted.get(t)))
  val NoStartOnFailedInit = Set("starting", "live").contains(s.svc).implies(not(s.initFailed))
  val NoLiveAfterStopped = s.stopped.implies(s.svc != "live" or s.apc == "services")
  val StoppedIsQuiet = (LifecycleState == "stopped").implies(s.closed and s.svc != "live" and (s.svc == "stopping").implies(s.svcLate or s.afast))
  val StrictMeansQuiescent = (s.strictP == "ok").implies(Pending.size() == 0 and not(s.failures) and not(Set("starting", "live", "stopping").contains(s.svc)))
  temporal NoAdmissionAfterClose = always(s.closed.implies(next(s.queue).length() <= s.queue.length()).orKeep(s))
  temporal StopperReturns = Fairness.implies(Stoppers.forall(caller => Set("be", "drain", "awaitStrict").contains(s.spc.get(caller)).leadsTo(s.spc.get(caller) == "done")))
  temporal TurnsFinish = Fairness.implies(Turns.forall(t => Set("queued", "lease", "turn").contains(s.tpc.get(t)).leadsTo(s.tpc.get(t) == "done")))
  temporal EagerStartSettles = Fairness.implies((s.svc == "waitInit").leadsTo(Set("skipped", "live", "stopped").contains(s.svc)))
}
module RuntimeLifecycle {
  import RuntimeLifecycleModel(Turns = Set("t1", "t2"), Stoppers = Set("s1", "s2"), MaxAttempts = 2).* from "./RuntimeLifecycle"
}
