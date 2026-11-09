// src/services/task.ts and plugins/plugin-sql/src/stores/task-wake.ts.
// Snapshot reads, claims, one-shot rechecks, worker outcomes, durable writes and
// final release are separate. Wake revisions acknowledge only the observed write.
module TaskService {
  const Mode: str
  const Kind: str
  const Blocking: bool
  const Tm: str
  const DueRunners: Set[str]
  const DaemonRunners: Set[str]
  const ByIdRunners: Set[str]
  const MaxRequests: int
  const MaxPauses: int
  const None: str
  pure val Timers = if (Mode == "local") Set(Tm) else Set()
  pure val Scheduled = Timers.union(DueRunners).union(DaemonRunners)
  pure val Runners = Scheduled.union(ByIdRunners)
  pure val Repeat = Kind == "repeat"
  pure val Guarded = not(Repeat) or Blocking
  pure val MaxRev = MaxRequests + Runners.size()
  type Row = {exists: bool, paused: bool, due: bool, failing: bool, wake: bool, wakeDue: bool, rev: int}
  type Snap = {present: bool, paused: bool, due: bool, wake: bool, rev: int}
  type State = {row: Row, snap: str -> Snap, pc: str -> str, outcome: str -> str,
    activeTick: str, inSet: bool, armed: bool, deferred: bool, unseen: bool,
    starts: int, unserved: Set[int], requests: int, pauses: int}
  pure val NoSnap = {present: false, paused: false, due: false, wake: false, rev: 0}
  pure def dueRow(row: Row): bool = row.due or (row.wake and row.wakeDue and not(row.failing))
  pure def snapOf(row: Row): Snap = {present: true, paused: row.paused, due: dueRow(row), wake: row.wake, rev: row.rev}
  var s: State
  val Executing = Runners.filter(r => Set("exec", "write", "release").contains(s.pc.get(r)))
  action init = s' = {row: {exists: true, paused: false, due: true, failing: false,
    wake: false, wakeDue: false, rev: 0}, snap: Runners.mapBy(r => NoSnap),
    pc: Runners.mapBy(r => "idle"), outcome: Runners.mapBy(r => None), activeTick: None,
    inSet: false, armed: Mode == "local", deferred: false, unseen: false,
    starts: 0, unserved: Set(), requests: 0, pauses: 0}
  pure def endRun(v: State, r: str, rearm: bool): State = {...v,
    activeTick: if (v.activeTick == r) None else v.activeTick,
    deferred: if (v.activeTick == r) false else v.deferred,
    armed: v.armed or (v.activeTick == r and v.deferred) or (Timers.contains(r) and rearm),
    pc: v.pc.set(r, if (Timers.contains(r)) "idle" else "done"), snap: v.snap.set(r, NoSnap)}
  pure def markDirty(v: State): State = {...v, unseen: true, armed: v.armed or Mode == "local"}
  pure def startWorker(v: State, r: str): State = {...v, pc: v.pc.set(r, "exec"),
    starts: if (v.starts < 2) v.starts + 1 else 2,
    unserved: v.unserved.filter(k => k > v.snap.get(r).rev)}
  action Begin(r: str): bool = all {s.pc.get(r) == "idle", any {
    all {Timers.contains(r), s.armed,
      s' = if (s.activeTick != None) {...s, armed: false, deferred: true}
      else {...s, armed: false, activeTick: r, pc: s.pc.set(r, "read")}},
    all {DueRunners.contains(r), s.activeTick == None,
      s' = {...s, activeTick: r, pc: s.pc.set(r, "read")}},
    all {DaemonRunners.union(ByIdRunners).contains(r), s' = {...s, pc: s.pc.set(r, "read")}}
  }}
  action Read(r: str): bool = {
    val v = {...s, unseen: if (Timers.union(DueRunners).contains(r)) false else s.unseen}
    all {s.pc.get(r) == "read", s' = if (s.row.exists)
      {...v, snap: s.snap.set(r, snapOf(s.row)), pc: s.pc.set(r, "select")}
      else endRun(v, r, false)}
  }
  action Select(r: str): bool = {
    val snapshot = s.snap.get(r)
    all {s.pc.get(r) == "select", s' =
      if (Scheduled.contains(r) and (snapshot.paused or (Repeat and not(snapshot.due))
        or (Repeat and Blocking and s.inSet))) endRun(s, r, true)
      else if (Guarded and s.inSet) endRun(s, r, true)
      else if (not(Repeat)) {...s, inSet: true, pc: s.pc.set(r, "recheck")}
      else startWorker({...s, inSet: true}, r)
    }
  }
  action Recheck(r: str): bool = all {s.pc.get(r) == "recheck", any {
    all {s.row.exists, s' = startWorker(s, r)},
    s' = {...s, pc: s.pc.set(r, "release")}
  }}
  action Work(r: str): bool = {
    val outcomes = Set("preserve").union(if (Repeat)
      Set("ok", "fail").union(if (s.requests < MaxRequests) Set("okWake") else Set())
      else Set("ok"))
    nondet o = outcomes.oneOf()
    all {s.pc.get(r) == "exec", s' = {...s, outcome: s.outcome.set(r, o),
      pc: s.pc.set(r, if (o == "preserve") "release" else "write"),
      starts: if (o == "preserve" and not(Repeat)) s.starts - 1 else s.starts}}
  }
  action Write(r: str): bool = {
    val snapshot = s.snap.get(r)
    val o = s.outcome.get(r)
    val consume = snapshot.wake or o == "okWake"
    val retained = s.row.wake and s.row.rev != snapshot.rev
    nondet due = Set(false, true).oneOf()
    val v = if (not(Repeat)) {...s, row: {...s.row, exists: false}}
      else if (o == "fail") {...s, row: {...s.row, due: false, failing: true}}
      else if (o == "okWake") {...s,
        row: {...s.row, due: false, failing: false, wake: true,
          wakeDue: (retained and s.row.wakeDue) or due, rev: s.row.rev + 1},
        unserved: s.unserved.union(Set(s.row.rev + 1)), requests: s.requests + 1}
      else {...s, row: {...s.row, due: false, failing: false,
        wake: if (consume) retained else s.row.wake,
        wakeDue: if (consume) retained and s.row.wakeDue else s.row.wakeDue}}
    all {s.pc.get(r) == "write", s' = markDirty({...v, pc: s.pc.set(r, "release")})}
  }
  action Release(r: str): bool = all {
    s.pc.get(r) == "release", s' = endRun({...s, inSet: false}, r, true)}
  action Elapse = all {Repeat, s.row.exists, not(s.row.due), s' = {...s, row: {...s.row, due: true}}}
  action WakeElapse = all {Repeat, s.row.wake, not(s.row.wakeDue), s' = {...s, row: {...s.row, wakeDue: true}}}
  action Request = all {Repeat, s.row.exists, s.requests < MaxRequests,
    s' = markDirty({...s, row: {...s.row, wake: true, wakeDue: s.row.wake and s.row.wakeDue,
      rev: s.row.rev + 1}, unserved: s.unserved.union(Set(s.row.rev + 1)), requests: s.requests + 1})}
  action TogglePause = all {s.row.exists, s.pauses < MaxPauses,
    s' = markDirty({...s, row: {...s.row, paused: not(s.row.paused)}, pauses: s.pauses + 1})}
  val Finished = Runners.exclude(Timers).forall(r => s.pc.get(r) == "done")
  action RunnerStep(r: str): bool = any {Read(r), Select(r), Recheck(r), Work(r), Write(r), Release(r)}
  action nextStep = {
    nondet r = Runners.oneOf()
    any {Begin(r), RunnerStep(r), Elapse, WakeElapse, Request, TogglePause, all {Finished, s' = s}}
  }
  action step = any {nextStep, s' = s}
  val TypeOK = and {
    s.row.rev >= 0, s.row.rev <= MaxRev, s.snap.keys() == Runners, s.pc.keys() == Runners,
    s.outcome.keys() == Runners, Runners.forall(r =>
      (s.snap.get(r) == NoSnap or (s.snap.get(r).present and s.snap.get(r).rev >= 0 and s.snap.get(r).rev <= MaxRev)) and
      Set("idle", "read", "select", "recheck", "exec", "write", "release", "done").contains(s.pc.get(r)) and
      Set("ok", "fail", "okWake", "preserve", None).contains(s.outcome.get(r))),
    Runners.union(Set(None)).contains(s.activeTick), s.starts >= 0, s.starts <= 2,
    s.unserved.subseteq(1.to(MaxRev)), s.requests >= 0, s.requests <= MaxRev,
    s.pauses >= 0, s.pauses <= MaxPauses
  }
  val OneShotAtMostOnce = not(Repeat) implies s.starts <= 1
  val OneShotDeletedAfterRun = not(Repeat) and not(s.row.exists) implies s.starts == 1
  val BlockingNoOverlap = Guarded implies Executing.size() <= 1
  val ClaimHeld = Guarded and Executing.size() > 0 implies s.inSet
  val NoLostWake = Repeat and s.unserved.size() > 0 implies s.row.wake
  val PausedNotSelected = Scheduled.forall(r =>
    Set("recheck", "exec", "write", "release").contains(s.pc.get(r)) implies not(s.snap.get(r).paused))
  val DirtyArmed = Mode == "local" and s.unseen implies s.armed or s.deferred or s.pc.get(Tm) == "read"
  temporal Fairness = and {
    Runners.forall(r => RunnerStep(r).weakFair(s)),
    Timers.union(DaemonRunners).union(ByIdRunners).forall(r => Begin(r).weakFair(s)),
    DueRunners.forall(r => Begin(r).strongFair(s)),
    Elapse.weakFair(s), WakeElapse.weakFair(s)
  }
  temporal RunnerFinishes = Fairness implies Runners.exclude(Timers).forall(r =>
    s.pc.get(r) != "idle" leadsTo s.pc.get(r) == "done")
  temporal WriteSeen = Fairness implies (Mode == "local" implies (s.unseen leadsTo not(s.unseen)))
  temporal WakeServed = Fairness implies (Mode == "local" and Repeat implies
    1.to(MaxRev).forall(k => s.unserved.contains(k) leadsTo (not(s.unserved.contains(k)) or s.row.paused)))
  temporal DeadlockFree = always(enabled(nextStep))
}
module TaskService_daemonOneshot {
  import TaskService(Mode = "daemon", Kind = "oneshot", Blocking = true, Tm = "Tm",
    DueRunners = Set("d1"), DaemonRunners = Set("k1"), ByIdRunners = Set(),
    MaxRequests = 0, MaxPauses = 1, None = "None").*
}
module TaskService_daemonRepeat {
  import TaskService(Mode = "daemon", Kind = "repeat", Blocking = true, Tm = "Tm",
    DueRunners = Set("d1"), DaemonRunners = Set("k1"), ByIdRunners = Set("b1"),
    MaxRequests = 1, MaxPauses = 1, None = "None").*
}
module TaskService_localOneshot {
  import TaskService(Mode = "local", Kind = "oneshot", Blocking = true, Tm = "Tm",
    DueRunners = Set("d1"), DaemonRunners = Set(), ByIdRunners = Set("b1"),
    MaxRequests = 0, MaxPauses = 2, None = "None").*
}
module TaskService_localRepeat {
  import TaskService(Mode = "local", Kind = "repeat", Blocking = true, Tm = "Tm",
    DueRunners = Set(), DaemonRunners = Set(), ByIdRunners = Set("b1"),
    MaxRequests = 1, MaxPauses = 1, None = "None").*
}
