// src/services/task-scheduler.ts. Generation and registration identity are
// checked after each query await. Detached ticks retain their service ownership.
module TaskScheduler {
  const Services: Set[str]
  const Adapters: Set[str]
  const Ticks: Set[str]
  const MaxRestarts: int
  const MaxRegs: int
  const QueryCanFail: bool
  const None: str
  pure val MaxGen = MaxRestarts + 1
  type Entry = {svc: str, id: int}
  type TickState = {pc: str, gen: int, id: int, svc: str}
  type State = {registry: Entry, nextId: int, dirty: bool, timer: bool, adapter: str,
    activeTick: str, gen: int, tk: str -> TickState, inRun: str -> int,
    stopped: str -> bool, busy: Set[str], stale: bool, restarts: int, regs: int, taken: str}
  pure val NoEntry = {svc: None, id: 0}
  pure val FreeTick = {pc: "free", gen: 0, id: 0, svc: None}
  var s: State
  action init = s' = {registry: NoEntry, nextId: 0, dirty: false, timer: false,
    adapter: None, activeTick: None, gen: 0, tk: Ticks.mapBy(k => FreeTick),
    inRun: Services.mapBy(svc => 0), stopped: Services.mapBy(svc => false),
    busy: Set(), stale: false, restarts: 0, regs: 0, taken: None}
  pure def marks(v: State): State = {...v, taken: if (v.dirty) None else v.taken}
  pure def current(v: State, k: str): bool = v.tk.get(k).gen == v.gen and
    v.registry != NoEntry and v.registry.id == v.tk.get(k).id
  pure def settle(v: State, k: str): State = {...v, tk: v.tk.set(k, FreeTick),
    activeTick: if (v.activeTick == k) None else v.activeTick}
  action Fire(k: str): bool = {
    val take = s.dirty and s.registry != NoEntry and not(s.busy.contains(s.registry.svc))
    all {
      s.timer, s.adapter != None, s.activeTick == None, s.tk.get(k).pc == "free",
      s' = if (take) {...s, dirty: false,
        tk: s.tk.set(k, {pc: "query", gen: s.gen, id: s.registry.id, svc: s.registry.svc}),
        activeTick: k, taken: s.registry.svc}
      else {...s, dirty: if (s.registry != NoEntry) s.dirty else false}
    }
  }
  action Query(k: str): bool = {
    val svc = s.tk.get(k).svc
    all {s.tk.get(k).pc == "query", any {
      all {QueryCanFail, s' = marks(settle({...s, dirty: s.dirty or current(s, k)}, k))},
      all {not(current(s, k)), s' = marks(settle(s, k))},
      all {current(s, k), s' = marks(settle(s, k))},
      all {current(s, k), s' = marks({...s,
        stale: s.stale or s.tk.get(k).gen != s.gen or s.registry.id != s.tk.get(k).id,
        tk: s.tk.set(k, {...s.tk.get(k), pc: if (s.stopped.get(svc)) "after" else "run"}),
        inRun: if (s.stopped.get(svc)) s.inRun else s.inRun.set(svc, s.inRun.get(svc) + 1),
        busy: s.busy.union(Set(svc))})}
    }}
  }
  action RunDone(k: str): bool = {
    val svc = s.tk.get(k).svc
    all {Set("run", "after").contains(s.tk.get(k).pc),
      s' = marks(settle({...s,
        inRun: if (s.tk.get(k).pc == "run") s.inRun.set(svc, s.inRun.get(svc) - 1) else s.inRun,
        busy: s.busy.exclude(Set(svc)), dirty: s.dirty or current(s, k)}, k))
    }
  }
  action Start(a: str): bool = all {
    s.restarts < MaxRestarts, not(s.timer and s.adapter == a),
    s' = marks({...s, gen: s.gen + 1, adapter: a, activeTick: None,
      dirty: if (s.timer) s.dirty or s.registry != NoEntry else s.dirty,
      timer: true, restarts: s.restarts + 1})
  }
  action Stop = all {s.restarts < MaxRestarts,
    s' = {...s, gen: s.gen + 1, timer: false, registry: NoEntry, dirty: false,
      adapter: None, activeTick: None, restarts: s.restarts + 1}}
  action Register(svc: str): bool = all {
    not(s.stopped.get(svc)), s.adapter != None, s.regs < MaxRegs,
    s' = {...s, nextId: s.nextId + 1, registry: {svc: svc, id: s.nextId + 1},
      dirty: true, regs: s.regs + 1, taken: None}
  }
  action StopService(svc: str): bool = all {not(s.stopped.get(svc)),
    s' = {...s, stopped: s.stopped.set(svc, true),
      registry: if (s.registry != NoEntry and s.registry.svc == svc) NoEntry else s.registry,
      dirty: if (s.registry != NoEntry and s.registry.svc == svc) false else s.dirty}}
  action MarkDirty = all {not(s.dirty), s' = {...s, dirty: true, taken: None}}
  val Finished = Ticks.forall(k => s.tk.get(k).pc == "free")
  action AnyFire = {nondet k = Ticks.oneOf(); Fire(k)}
  action nextStep = {
    nondet k = Ticks.oneOf()
    nondet a = Adapters.oneOf()
    nondet svc = Services.oneOf()
    any {Fire(k), Query(k), RunDone(k), Start(a), Stop, Register(svc), StopService(svc),
      MarkDirty, all {Finished, s' = s}}
  }
  action step = any {nextStep, s' = s}
  val TypeOK = and {
    s.registry == NoEntry or (Services.contains(s.registry.svc) and s.registry.id >= 1 and s.registry.id <= MaxRegs),
    s.nextId >= 0, s.nextId <= MaxRegs, Adapters.union(Set(None)).contains(s.adapter),
    Ticks.union(Set(None)).contains(s.activeTick), s.gen >= 0, s.gen <= MaxGen,
    s.tk.keys() == Ticks, Ticks.forall(k => {
      val tick = s.tk.get(k)
      Set("free", "query", "run", "after").contains(tick.pc) and tick.gen >= 0 and tick.gen <= MaxGen and
        tick.id >= 0 and tick.id <= MaxRegs and Services.union(Set(None)).contains(tick.svc)
    }),
    s.inRun.keys() == Services, s.stopped.keys() == Services,
    Services.forall(svc => s.inRun.get(svc) >= 0 and s.inRun.get(svc) <= Ticks.size()),
    s.busy.subseteq(Services), s.restarts >= 0, s.restarts <= MaxRestarts,
    s.regs >= 0, s.regs <= MaxRegs, Services.union(Set(None)).contains(s.taken)
  }
  val NoStaleDispatch = not(s.stale)
  val OneRunTickPerService = Services.forall(svc => s.inRun.get(svc) <= 1)
  val AttachedTickCurrent = s.activeTick != None implies s.tk.get(s.activeTick).gen == s.gen
  val TakenClearsDirty = s.taken != None implies not(s.dirty)
  temporal Fairness = AnyFire.weakFair(s) and Ticks.forall(k => Query(k).weakFair(s) and RunDone(k).weakFair(s))
  temporal DirtyServed = Fairness implies Services.forall(svc =>
    (s.dirty and s.timer and s.adapter != None and s.registry != NoEntry and
      s.registry.svc == svc and not(s.stopped.get(svc))) leadsTo
    (s.taken == svc or s.registry == NoEntry or s.registry.svc != svc or
      s.adapter == None or s.stopped.get(svc)))
  temporal TickSettles = Fairness implies Ticks.forall(k => s.tk.get(k).pc == "query" leadsTo s.tk.get(k).pc == "free")
  temporal DeadlockFree = always(enabled(nextStep))
}
module TaskScheduler_live {
  import TaskScheduler(Services = Set("s1", "s2"), Adapters = Set("a1", "a2"),
    Ticks = Set("k1", "k2", "k3"), MaxRestarts = 2, MaxRegs = 2,
    QueryCanFail = false, None = "None").*
}
module TaskScheduler_restart {
  import TaskScheduler(Services = Set("s1", "s2"), Adapters = Set("a1", "a2"),
    Ticks = Set("k1", "k2", "k3"), MaxRestarts = 2, MaxRegs = 2,
    QueryCanFail = true, None = "None").*
}
