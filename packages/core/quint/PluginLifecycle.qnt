// src/plugin-lifecycle.ts and runtime/service-lifecycle.ts. The actor lock
// retains synchronous segments across unload, load, registration and stop.
module PluginLifecycleModel {
  const NumClasses: int
  const Unloaders: Set[str]
  const Loaders: Set[str]
  const Registrars: Set[str]
  const Stoppers: Set[str]
  const Rivals: Set[str]
  const StartsInFlight: bool
  const InitMayFail: bool
  const StopMayFail: bool
  const StartMayFail: bool
  pure val Classes = 1.to(NumClasses)
  pure val Actors = Unloaders.union(Loaders).union(Registrars).union(Stoppers).union(Rivals)
  pure val MaxInst = NumClasses * (1 + Loaders.size())
  pure val Insts = 1.to(MaxInst)
  pure val None = "None"
  type Running = NoRunning | Actor(str) | Class(int)
  type State = {
    pc: str -> str, running: Running, cur: str -> int, waitSet: str -> Set[int], queue: str -> Set[int],
    visited: Set[int], joinOf: str -> str, stopFailed: bool,
    owned: bool, pluginsA: bool, tdActive: str, regActive: str, disposeCalls: int,
    types: Set[int], byClass: int -> int, starting: int -> int, failedC: Set[int], services: Set[int], live: Set[int],
    stopCalls: int -> int, stopOps: Set[int], nextInst: int, stopRequested: bool,
    registry: str, ownsA: bool, ownsB: bool, lastReg: str
  }
  var s: State
  def Free(a: str): bool = s.running == NoRunning or s.running == Actor(a)
  action init = {
    val services = if (StartsInFlight) Set() else Classes
    val registry = if (StartsInFlight or NumClasses == 0) "none" else "A"
    s' = {
      pc: Actors.mapBy(_ => "idle"), running: NoRunning, cur: Actors.mapBy(_ => 0),
      waitSet: Unloaders.mapBy(_ => Set()), queue: Unloaders.mapBy(_ => Set()), visited: Set(),
      joinOf: Registrars.union(Unloaders).mapBy(_ => None), stopFailed: false,
      owned: Registrars.size() == 0, pluginsA: Registrars.size() == 0, tdActive: None, regActive: None, disposeCalls: 0,
      types: if (Registrars.size() == 0) Classes else Set(),
      byClass: Classes.mapBy(c => if (StartsInFlight) 0 else c), starting: Classes.mapBy(c => if (StartsInFlight) c else 0),
      failedC: Set(), services: services, live: services, stopCalls: Insts.mapBy(_ => 0), stopOps: Set(), nextInst: NumClasses + 1,
      stopRequested: false, registry: registry, ownsA: registry == "A", ownsB: false, lastReg: registry
    }
  }
  action UCall(u: str): bool = all {
    s.pc.get(u) == "idle", Free(u),
    if (not(s.owned)) s' = { ...s, pc: s.pc.set(u, "done"), running: NoRunning }
    else if (s.tdActive != None) s' = { ...s, pc: s.pc.set(u, "join"), running: NoRunning, joinOf: s.joinOf.set(u, s.tdActive) }
    else s' = { ...s, pc: s.pc.set(u, "dispose"), running: NoRunning, tdActive: u, disposeCalls: s.disposeCalls + 1 }
  }
  action UJoin(u: str): bool = all {
    s.pc.get(u) == "join", Free(u), Set("done", "err").contains(s.pc.get(s.joinOf.get(u))),
    s' = { ...s, pc: s.pc.set(u, s.pc.get(s.joinOf.get(u))) }
  }
  action UDispose(u: str): bool = all {
    s.pc.get(u) == "dispose", Free(u),
    {
      val inflight = Classes.filter(c => s.starting.get(c) != 0)
      val instances = Classes.map(c => s.byClass.get(c)).exclude(Set(0))
      s' = { ...s, registry: if (s.ownsA) "none" else s.registry, types: Set(), byClass: Classes.mapBy(_ => 0),
        services: s.services.exclude(instances), queue: s.queue.set(u, instances), waitSet: s.waitSet.set(u, inflight),
        pc: s.pc.set(u, "inflight"), running: NoRunning }
    }
  }
  action UInflight(u: str): bool = all {
    s.pc.get(u) == "inflight", Free(u), s.waitSet.get(u).forall(c => s.starting.get(c) == 0),
    s' = { ...s, pc: s.pc.set(u, "stop"), running: Actor(u) }
  }
  action UStop(u: str): bool = all {
    s.pc.get(u) == "stop", s.running == Actor(u),
    if (s.queue.get(u).size() == 0) s' = { ...s, failedC: Set(), pc: s.pc.set(u, "finish") }
    else {
      // The source selects an arbitrary member. Exploring every member adds
      // ordering interleavings while preserving each chosen stop operation.
      nondet i = s.queue.get(u).oneOf()
      s' = { ...s, stopCalls: if (s.stopOps.contains(i)) s.stopCalls else s.stopCalls.set(i, s.stopCalls.get(i) + 1),
        stopOps: s.stopOps.union(Set(i)), cur: s.cur.set(u, i), pc: s.pc.set(u, "stopwait"), running: NoRunning }
    }
  }
  action UStopWait(u: str): bool = {
    nondet fails = Set(false, true).oneOf()
    all {
      s.pc.get(u) == "stopwait", Free(u), not(fails) or StopMayFail,
      s' = { ...s, live: s.live.exclude(Set(s.cur.get(u))), queue: s.queue.set(u, s.queue.get(u).exclude(Set(s.cur.get(u)))),
        stopFailed: s.stopFailed or fails, pc: s.pc.set(u, "stop"), running: Actor(u) }
    }
  }
  action UFinish(u: str): bool = all {
    s.pc.get(u) == "finish", s.running == Actor(u),
    s' = { ...s, owned: false, pluginsA: false, tdActive: None, pc: s.pc.set(u, if (s.stopFailed) "err" else "done"), running: NoRunning }
  }
  action LCall(l: str): bool = all {
    s.pc.get(l) == "idle", Free(l), s' = { ...s, pc: s.pc.set(l, if (s.stopRequested) "done" else "init"), running: NoRunning }
  }
  action LBegin(l: str): bool = all {
    s.pc.get(l) == "init", Free(l),
    {
      val spawn = s.types.filter(c => s.byClass.get(c) == 0 and s.starting.get(c) == 0 and
        s.failedC.contains(c).implies(s.types.forall(x => s.byClass.get(x) == 0)))
      val stopped = s.stopRequested or s.types.size() == 0
      s' = { ...s, starting: if (stopped) s.starting else Classes.mapBy(c => if (spawn.contains(c)) s.nextInst + c - 1 else s.starting.get(c)),
        nextInst: if (stopped) s.nextInst else s.nextInst + NumClasses, pc: s.pc.set(l, "done"), running: NoRunning }
    }
  }
  action SDone(c: int): bool = {
    nondet fails = Set(false, true).oneOf()
    val i = s.starting.get(c)
    all {
      i != 0, s.running == NoRunning or s.running == Class(c), not(fails) or StartMayFail,
      if (fails) s' = { ...s, starting: s.starting.set(c, 0), running: NoRunning, failedC: s.failedC.union(Set(c)) }
      else if (s.stopRequested or not(s.types.contains(c))) s' = { ...s, starting: s.starting.set(c, 0), running: NoRunning,
        failedC: s.failedC.union(Set(c)), stopCalls: s.stopCalls.set(i, s.stopCalls.get(i) + 1), stopOps: s.stopOps.union(Set(i)) }
      else {
        val byClass = s.byClass.set(c, i)
        s' = { ...s, starting: s.starting.set(c, 0), running: NoRunning, failedC: s.failedC.exclude(Set(c)), byClass: byClass,
          services: s.types.map(x => byClass.get(x)).exclude(Set(0)), live: s.live.union(Set(i)),
          registry: "A", lastReg: "A", ownsA: s.owned, ownsB: false }
      }
    }
  }
  action TReq(t: str): bool = all {
    s.pc.get(t) == "idle", Free(t), s' = { ...s, stopRequested: true, pc: s.pc.set(t, "drain"), running: NoRunning }
  }
  action TDrain(t: str): bool = all {
    s.pc.get(t) == "drain", Free(t), Classes.forall(c => s.starting.get(c) == 0),
    s' = { ...s, pc: s.pc.set(t, "svc"), running: Actor(t) }
  }
  action TSvc(t: str): bool = all {
    s.pc.get(t) == "svc", s.running == Actor(t),
    if (s.services.exclude(s.visited).size() == 0) s' = { ...s, byClass: Classes.mapBy(_ => 0), pc: s.pc.set(t, "done"), running: NoRunning }
    else {
      nondet i = s.services.exclude(s.visited).oneOf()
      s' = { ...s, visited: s.visited.union(Set(i)), stopCalls: if (s.stopOps.contains(i)) s.stopCalls else s.stopCalls.set(i, s.stopCalls.get(i) + 1),
        stopOps: s.stopOps.union(Set(i)), cur: s.cur.set(t, i), pc: s.pc.set(t, "svcwait"), running: NoRunning }
    }
  }
  action TSvcWait(t: str): bool = all {
    s.pc.get(t) == "svcwait", Free(t),
    s' = { ...s, live: s.live.exclude(Set(s.cur.get(t))), pc: s.pc.set(t, "svc"), running: Actor(t) }
  }
  action BReg(b: str): bool = all {
    s.pc.get(b) == "idle", Free(b),
    s' = { ...s, registry: "B", lastReg: "B", ownsA: false, ownsB: true, pc: s.pc.set(b, "done") }
  }
  action RCall(r: str): bool = all {
    s.pc.get(r) == "idle", Free(r),
    if (s.stopRequested) s' = { ...s, running: NoRunning, pc: s.pc.set(r, "err") }
    else if (s.regActive != None) s' = { ...s, running: NoRunning, pc: s.pc.set(r, "join"), joinOf: s.joinOf.set(r, s.regActive) }
    else if (s.pluginsA) s' = { ...s, running: NoRunning, pc: s.pc.set(r, "ok") }
    else s' = { ...s, running: NoRunning, pc: s.pc.set(r, "init"), pluginsA: true, regActive: r }
  }
  action RInit(r: str): bool = {
    nondet fails = Set(false, true).oneOf()
    all {
      s.pc.get(r) == "init", Free(r), not(fails) or InitMayFail,
      if (fails) s' = { ...s, pluginsA: false, pc: s.pc.set(r, "err"), regActive: None, running: NoRunning }
      else s' = { ...s, owned: true, pc: s.pc.set(r, "ok"), regActive: None, running: NoRunning }
    }
  }
  action RJoin(r: str): bool = all {
    s.pc.get(r) == "join", Free(r), Set("ok", "err").contains(s.pc.get(s.joinOf.get(r))),
    s' = { ...s, pc: s.pc.set(r, s.pc.get(s.joinOf.get(r))) }
  }
  val Rest = Set("idle", "done", "ok", "err")
  val Quiescent = s.running == NoRunning and Actors.forall(a => Rest.contains(s.pc.get(a))) and Classes.forall(c => s.starting.get(c) == 0)
  val Finished = Quiescent and Actors.forall(a => s.pc.get(a) != "idle")
  action Unload(u: str): bool = any { UCall(u), UJoin(u), UDispose(u), UInflight(u), UStop(u), UStopWait(u), UFinish(u) }
  action Load(l: str): bool = any { LCall(l), LBegin(l) }
  action Stop(t: str): bool = any { TReq(t), TDrain(t), TSvc(t), TSvcWait(t) }
  action Register(r: str): bool = any { RCall(r), RInit(r), RJoin(r) }
  action nextStep = any {
    { nondet u = Unloaders.oneOf()
      Unload(u) },
    { nondet l = Loaders.oneOf()
      Load(l) },
    { nondet c = Classes.oneOf()
      SDone(c) },
    { nondet t = Stoppers.oneOf()
      Stop(t) },
    { nondet b = Rivals.oneOf()
      BReg(b) },
    { nondet r = Registrars.oneOf()
      Register(r) },
    all { Finished, s' = s }
  }
  // The original specification permits stuttering at every state. Deadlock
  // freedom checks the transition relation before adding that stutter.
  action step = any { nextStep, s' = s }
  temporal DeadlockFree = always(enabled(nextStep))
  temporal Fairness = and {
    Unloaders.forall(u => Unload(u).weakFair(s)), Loaders.forall(l => Load(l).weakFair(s)),
    Classes.forall(c => SDone(c).weakFair(s)), Stoppers.forall(t => Stop(t).weakFair(s)),
    Rivals.forall(b => BReg(b).weakFair(s)), Registrars.forall(r => Register(r).weakFair(s))
  }
  val TypeOK = and {
    s.types.subseteq(Classes), s.byClass.keys() == Classes, s.starting.keys() == Classes,
    Classes.forall(c => s.byClass.get(c) >= 0 and s.byClass.get(c) <= MaxInst and s.starting.get(c) >= 0 and s.starting.get(c) <= MaxInst),
    s.failedC.subseteq(Classes), s.services.subseteq(Insts), s.live.subseteq(Insts), s.stopOps.subseteq(Insts),
    s.stopCalls.keys() == Insts, Insts.forall(i => s.stopCalls.get(i) >= 0),
    Set("A", "B", "none").contains(s.registry), Set("A", "B", "none").contains(s.lastReg),
    match s.running { NoRunning => true | Actor(a) => Actors.contains(a) | Class(c) => Classes.contains(c) }
  }
  val TeardownStates = Set("dispose", "inflight", "stop", "stopwait", "finish")
  val TeardownExclusive = Unloaders.filter(u => TeardownStates.contains(s.pc.get(u))).size() <= 1 and s.disposeCalls <= 1
  val StopAtMostOnce = Insts.forall(i => s.stopCalls.get(i) <= 1)
  val NoOrphanInstance = Quiescent.implies(s.live.forall(i => s.services.contains(i) and s.types.exists(c => s.byClass.get(c) == i)))
  val StopStopsAll = (Quiescent and Stoppers.exists(t => s.pc.get(t) == "done")).implies(s.live.size() == 0)
  val ConnectorOwnedByLast = and {
    (s.owned and s.ownsA and s.tdActive == None).implies(s.registry == "A"),
    s.ownsB.implies(s.registry == "B"), (s.lastReg == "B").implies(s.registry == "B")
  }
  val NoOrphanConnector = (Quiescent and s.registry == "A").implies(s.owned)
  val RegisterHonest = (Unloaders.size() == 0).implies(Registrars.forall(r => (s.pc.get(r) == "ok").implies(s.pluginsA)))
  temporal GeneralTerminates = Fairness.implies(eventually(Finished))
}
module PluginLifecycle {
  import PluginLifecycleModel(
    NumClasses = 2, Unloaders = Set("u1", "u2"),
    Loaders = Set("l1", "l2"), Registrars = Set(),
    Stoppers = Set("t1"), Rivals = Set("b1"),
    StartsInFlight = false, InitMayFail = true,
    StopMayFail = true, StartMayFail = true).* from "./PluginLifecycle"
  temporal Terminates = GeneralTerminates
}
module PluginLifecycleInflight {
  import PluginLifecycleModel(
    NumClasses = 2, Unloaders = Set("u1", "u2"),
    Loaders = Set("l1"), Registrars = Set(),
    Stoppers = Set("t1"), Rivals = Set("b1"),
    StartsInFlight = true, InitMayFail = true,
    StopMayFail = true, StartMayFail = true).* from "./PluginLifecycle"
  temporal Terminates = GeneralTerminates
}
module PluginLifecycleRegister {
  import PluginLifecycleModel(
    NumClasses = 0, Unloaders = Set(),
    Loaders = Set(), Registrars = Set("r1", "r2"),
    Stoppers = Set(), Rivals = Set(),
    StartsInFlight = false, InitMayFail = true,
    StopMayFail = false, StartMayFail = false).* from "./PluginLifecycle"
  // Every other actor set is empty in this configuration. Eliminate their
  // vacuous quantifiers before TLC temporal normalization.
  temporal Terminates = Registrars.forall(r => Register(r).weakFair(s)).implies(eventually(Finished))
}
