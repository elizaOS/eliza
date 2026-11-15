// src/runtime/service-lifecycle.ts, runtime.ts and plugin-lifecycle.ts.
// Sibling class starts, eager retries, publication, unload and runtime stop
// retain the separate promise boundaries and per-instance stop operation.
module ServiceLifecycleModel {
  const Classes: Set[str]
  const LateClasses: Set[str]
  const Owned: Set[str]
  const Callers: Set[str]
  const MaxInst: int
  const MaxRetries: int
  pure val Inst = 1.to(MaxInst)
  pure val None = "none"
  pure val OwnedClass = Owned.fold(None, (_, c) => c)
  pure val InFlight = Set("awaitStart", "event", "lateStop")
  type State = {
    types: Set[str], byClass: str -> int, starting: str -> bool, failed: str -> bool,
    sc: str -> str, att: str -> int, scInst: str -> int, published: Set[int], status: str,
    nextInst: int, cls: int -> str, late: int -> bool, stopCalls: int -> int,
    stopOp: int -> str, epc: str -> str, tries: str -> int, ewait: str -> (str -> int),
    stopReq: bool, stopped: bool, rpc: str, rcur: int, rvisited: Set[int], lastEnsure: str,
    upc: str, ucur: int, uwait: str -> int
  }
  // 0 is the explicit missing-instance sentinel. Actor/class sentinels stay strings.
  var s: State
  val Created = 1.to(s.nextInst - 1)
  pure def Rebuild(bc: str -> int, ts: Set[str]): Set[int] = ts.filter(c => bc.get(c) != 0).map(c => bc.get(c))
  pure def StopOnce(st: State, i: int): State = if (st.stopOp.get(i) == "none")
    { ...st, stopOp: st.stopOp.set(i, "running"), stopCalls: st.stopCalls.set(i, st.stopCalls.get(i) + 1) } else st
  action init = all {
    Owned.size() == 1, Owned.subseteq(Classes.exclude(LateClasses)),
    s' = {
      types: Classes.exclude(LateClasses), byClass: Classes.mapBy(_ => 0),
      starting: Classes.mapBy(_ => false), failed: Classes.mapBy(_ => false), sc: Classes.mapBy(_ => "idle"),
      att: Classes.mapBy(_ => 0), scInst: Classes.mapBy(_ => 0), published: Set(), status: "pending", nextInst: 1,
      cls: Inst.mapBy(_ => None), late: Inst.mapBy(_ => false), stopCalls: Inst.mapBy(_ => 0), stopOp: Inst.mapBy(_ => "none"),
      epc: Callers.mapBy(_ => "idle"), tries: Callers.mapBy(_ => 0), ewait: Callers.mapBy(_ => Classes.mapBy(_ => 0)),
      stopReq: false, stopped: false, rpc: "idle", rcur: 0, rvisited: Set(), lastEnsure: None,
      upc: "idle", ucur: 0, uwait: Classes.mapBy(_ => 0)
    }
  }
  action EBegin(e: str): bool = all { s.epc.get(e) == "idle", not(s.stopReq), s' = { ...s, epc: s.epc.set(e, "ensure") } }
  action EEnsure(e: str): bool = all {
    s.epc.get(e) == "ensure",
    if (s.stopReq or s.types.size() == 0) s' = { ...s, epc: s.epc.set(e, "done") }
    else {
      val startedImpl = s.types.exists(c => s.byClass.get(c) != 0)
      val spawn = s.types.filter(c => s.byClass.get(c) == 0 and not(s.starting.get(c)) and not(startedImpl and s.failed.get(c)))
      val join = s.types.filter(c => s.byClass.get(c) == 0 and s.starting.get(c))
      s' = { ...s,
        starting: Classes.mapBy(c => s.starting.get(c) or spawn.contains(c)),
        sc: Classes.mapBy(c => if (spawn.contains(c)) "awaitStart" else s.sc.get(c)),
        att: Classes.mapBy(c => if (spawn.contains(c)) s.att.get(c) + 1 else s.att.get(c)),
        ewait: s.ewait.set(e, Classes.mapBy(c => if (spawn.contains(c)) s.att.get(c) + 1 else if (join.contains(c)) s.att.get(c) else 0)),
        status: if (spawn.size() > 0 and s.published.size() == 0) "registering" else s.status,
        lastEnsure: e, epc: s.epc.set(e, "wait") }
    }
  }
  def Settled(e: str): bool = Classes.forall(c => (s.ewait.get(e).get(c) > 0).implies(s.att.get(c) > s.ewait.get(e).get(c) or s.sc.get(c) == "idle"))
  action ESettle(e: str): bool = all {
    s.epc.get(e) == "wait", Settled(e),
    if (s.published.size() > 0) s' = { ...s, ewait: s.ewait.set(e, Classes.mapBy(_ => 0)), status: "registered", epc: s.epc.set(e, "done") }
    else {
      val retry = s.tries.get(e) < MaxRetries and not(s.stopReq) and not(s.stopped)
      s' = { ...s, ewait: s.ewait.set(e, Classes.mapBy(_ => 0)), status: if (s.types.size() == 0) "unknown" else "failed",
        epc: s.epc.set(e, if (retry) "delay" else "done"), tries: if (retry) s.tries.set(e, s.tries.get(e) + 1) else s.tries }
    }
  }
  action EDelay(e: str): bool = all {
    s.epc.get(e) == "delay", s' = { ...s, epc: s.epc.set(e, if (s.stopReq or s.stopped) "done" else "ensure") }
  }
  action StartFail(c: str): bool = all {
    s.sc.get(c) == "awaitStart", s' = { ...s, sc: s.sc.set(c, "idle"), starting: s.starting.set(c, false), failed: s.failed.set(c, true) }
  }
  action StartOk(c: str): bool = all {
    s.sc.get(c) == "awaitStart", s.nextInst <= MaxInst,
    {
      val i = s.nextInst
      val base = { ...s, nextInst: i + 1, cls: s.cls.set(i, c) }
      if (s.stopped or s.stopReq or not(s.types.contains(c))) {
        val stopped = StopOnce(base, i)
        s' = { ...stopped, late: s.late.set(i, s.stopped or s.stopReq), scInst: s.scInst.set(c, i), sc: s.sc.set(c, "lateStop") }
      } else {
        val bc = s.byClass.set(c, i)
        s' = { ...base, byClass: bc, published: Rebuild(bc, s.types), status: "registered", sc: s.sc.set(c, "event") }
      }
    }
  }
  action StartEvent(c: str): bool = all {
    s.sc.get(c) == "event", s' = { ...s, sc: s.sc.set(c, "idle"), starting: s.starting.set(c, false), failed: s.failed.set(c, false) }
  }
  action StartLateStopped(c: str): bool = all {
    s.sc.get(c) == "lateStop", s.stopOp.get(s.scInst.get(c)) == "done",
    s' = { ...s, sc: s.sc.set(c, "idle"), scInst: s.scInst.set(c, 0), starting: s.starting.set(c, false), failed: s.failed.set(c, true) }
  }
  action StartSettles(c: str): bool = any { StartFail(c), StartOk(c) }
  action StopOpDone(i: int): bool = all { s.stopOp.get(i) == "running", s' = { ...s, stopOp: s.stopOp.set(i, "done") } }
  action RegisterLate(c: str): bool = all {
    LateClasses.exclude(s.types).contains(c), not(s.stopReq), s' = { ...s, types: s.types.union(Set(c)), status: "pending" }
  }
  action RRequest = all { s.rpc == "idle", s' = { ...s, stopReq: true, rpc: "services" } }
  action RServices = all { s.rpc == "services", s' = { ...s, stopped: true, rpc: "stopping" } }
  action RStopNext = {
    nondet i = s.published.exclude(s.rvisited).oneOf()
    all { s.rpc == "stopping", s' = { ...StopOnce(s, i), rcur: i, rvisited: s.rvisited.union(Set(i)), rpc: "stopInst" } }
  }
  action RStopWait = all {
    s.rpc == "stopInst", s.stopOp.get(s.rcur) == "done", s' = { ...s, rpc: "stopping", rcur: 0 }
  }
  action RClear = all {
    s.rpc == "stopping", s.published.subseteq(s.rvisited),
    s' = { ...s, rpc: "done", byClass: Classes.mapBy(_ => 0), starting: Classes.mapBy(_ => false), failed: Classes.mapBy(_ => false), published: Set() }
  }
  action UStart = all {
    s.upc == "idle",
    if (s.types.size() == 0) s' = { ...s, upc: "done" }
    else {
      val entry = s.lastEnsure != None and s.epc.get(s.lastEnsure) == "wait"
      val inflight = entry or s.starting.get(OwnedClass)
      val awaited = Classes.mapBy(c => if (c == OwnedClass and s.starting.get(c)) s.att.get(c) else if (entry) s.ewait.get(s.lastEnsure).get(c) else 0)
      val i = s.byClass.get(OwnedClass)
      s' = { ...s, types: s.types.exclude(Owned), byClass: s.byClass.set(OwnedClass, 0), published: s.published.exclude(Set(i)), ucur: i,
        uwait: if (inflight) awaited else s.uwait, upc: if (inflight) "wait" else "drain" }
    }
  }
  action UAwaited = all {
    s.upc == "wait", Classes.forall(c => (s.uwait.get(c) > 0).implies(s.att.get(c) > s.uwait.get(c) or s.sc.get(c) == "idle")),
    s' = { ...s, upc: "drain" }
  }
  action UDrain = all {
    s.upc == "drain",
    {
      val base = { ...s, status: if (s.published.size() > 0) "registered" else if (s.types.size() > 0) "pending" else "unknown" }
      if (s.ucur != 0) s' = { ...StopOnce(base, s.ucur), upc: "stop" }
      else s' = { ...base, failed: s.failed.set(OwnedClass, false), upc: "done" }
    }
  }
  action UStopped = all {
    s.upc == "stop", s.stopOp.get(s.ucur) == "done", s' = { ...s, failed: s.failed.set(OwnedClass, false), upc: "done" }
  }
  val Finished = Callers.forall(e => Set("idle", "done").contains(s.epc.get(e))) and Set("idle", "done").contains(s.rpc)
    and Set("idle", "done").contains(s.upc) and Classes.forall(c => s.sc.get(c) == "idle") and Inst.forall(i => s.stopOp.get(i) != "running")
  action nextStep = any {
    { nondet e = Callers.oneOf()
      any { EBegin(e), EEnsure(e), ESettle(e), EDelay(e) } },
    { nondet c = Classes.oneOf()
      any { RegisterLate(c), StartFail(c), StartOk(c), StartEvent(c), StartLateStopped(c) } },
    { nondet i = Inst.oneOf()
      StopOpDone(i) },
    RRequest, RServices, RStopNext, RStopWait, RClear, UStart, UAwaited, UDrain, UStopped, all { Finished, s' = s }
  }
  // The original specification permits stuttering at every state. Deadlock
  // freedom checks the transition relation before adding that stutter.
  action step = any { nextStep, s' = s }
  temporal DeadlockFree = always(enabled(nextStep))
  temporal Fairness = and {
    Callers.forall(e => EEnsure(e).weakFair(s) and ESettle(e).weakFair(s) and EDelay(e).weakFair(s)),
    Classes.forall(c => StartSettles(c).weakFair(s) and StartEvent(c).weakFair(s) and StartLateStopped(c).weakFair(s)),
    Inst.forall(i => StopOpDone(i).weakFair(s)), RServices.weakFair(s), RStopNext.weakFair(s), RStopWait.weakFair(s), RClear.weakFair(s),
    UAwaited.weakFair(s), UDrain.weakFair(s), UStopped.weakFair(s)
  }
  val TypeOK = and {
    s.types.subseteq(Classes), s.byClass.keys() == Classes, s.starting.keys() == Classes, s.failed.keys() == Classes,
    s.sc.keys() == Classes, s.att.keys() == Classes, s.scInst.keys() == Classes,
    Classes.forall(c => and {
      Inst.union(Set(0)).contains(s.byClass.get(c)),
      InFlight.union(Set("idle")).contains(s.sc.get(c)),
      s.att.get(c) >= 0, Inst.union(Set(0)).contains(s.scInst.get(c))
    }),
    s.published.subseteq(Inst), Set("pending", "registering", "registered", "failed", "unknown").contains(s.status), s.nextInst >= 1 and s.nextInst <= MaxInst + 1,
    s.cls.keys() == Inst, s.late.keys() == Inst, s.stopCalls.keys() == Inst, s.stopOp.keys() == Inst,
    Inst.forall(i => Classes.union(Set(None)).contains(s.cls.get(i)) and s.stopCalls.get(i) >= 0 and Set("none", "running", "done").contains(s.stopOp.get(i))),
    s.epc.keys() == Callers, s.ewait.keys() == Callers,
    Callers.forall(e => and {
      Set("idle", "ensure", "wait", "delay", "done").contains(s.epc.get(e)),
      s.ewait.get(e).keys() == Classes, Classes.forall(c => s.ewait.get(e).get(c) >= 0)
    }),
    Set("idle", "services", "stopping", "stopInst", "done").contains(s.rpc), Callers.union(Set(None)).contains(s.lastEnsure),
    Set("idle", "wait", "drain", "stop", "done").contains(s.upc), s.uwait.keys() == Classes, Classes.forall(c => s.uwait.get(c) >= 0)
  }
  val OneLivePerClass = Classes.forall(c => Created.filter(i => s.cls.get(i) == c and s.stopCalls.get(i) == 0).size() <= 1)
  val StopAtMostOnce = Inst.forall(i => s.stopCalls.get(i) <= 1)
  val NoLatePublish = s.published.forall(i => not(s.late.get(i)))
  val NoOrphan = Created.forall(i => (s.stopCalls.get(i) == 0).implies(s.published.contains(i) or (Set("wait", "drain").contains(s.upc) and i == s.ucur)))
  val StatusConsistent = (s.status == "failed").implies(s.published.size() == 0)
  val NoStatusWithoutClasses = (s.upc == "done" and s.types.size() == 0 and not(s.stopped)).implies(s.status == "unknown")
  val StoppedNotReachable = (s.rpc == "done").implies(s.published.size() == 0)
  temporal StopReachesAll = Fairness.implies(s.stopReq.leadsTo(Classes.forall(c => s.sc.get(c) == "idle") and Created.forall(i => s.stopCalls.get(i) >= 1)))
  temporal CallersReturn = Fairness.implies(Callers.forall(e => (s.epc.get(e) == "ensure").leadsTo(s.epc.get(e) == "done")))
}
module ServiceLifecycle {
  import ServiceLifecycleModel(
    Classes = Set("A", "B"), LateClasses = Set("B"), Owned = Set("A"),
    Callers = Set("e1", "e2"), MaxInst = 4, MaxRetries = 1).* from "./ServiceLifecycle"
}
module ServiceLifecycleLiveness {
  import ServiceLifecycleModel(
    Classes = Set("A", "B"), LateClasses = Set("B"), Owned = Set("A"),
    Callers = Set("e1", "e2"), MaxInst = 3, MaxRetries = 0).* from "./ServiceLifecycle"
}
