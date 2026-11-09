// src/runtime/room-handler-queue.ts. Ordered multi-room acquisition, FIFO
// grants, nested ownership, write tails, reverse release and admission limits.
module RoomHandlerQueueModel {
  const Turns: Set[str]
  const NumRooms: int
  const MaxPerRoom: int
  const MaxTotal: int
  const MaxRooms: int
  const MaxWrites: int
  pure val Rooms = 1.to(NumRooms)
  pure val None = "none"
  pure val States = Set("idle", "acquiring", "waiting", "owner", "releasing", "unwinding", "done", "refused", "cancelled")
  type State = {
    queue: int -> List[str], active: int -> str, want: str -> Set[int],
    held: str -> Set[int], pc: str -> str, accepting: str -> Set[int],
    writes: str -> (int -> int), closed: bool
  }
  var s: State
  def Pending(r: int): int = s.queue.get(r).length() + (if (s.active.get(r) == None) 0 else 1)
  val InUse = Rooms.filter(r => Pending(r) > 0)
  val Total = Rooms.fold(0, (total, r) => total + Pending(r))
  pure def Min(xs: Set[int]): int = xs.fold(NumRooms + 1, (m, x) => if (x < m) x else m)
  pure def Max(xs: Set[int]): int = xs.fold(0, (m, x) => if (x > m) x else m)
  def Waits(t: str, r: int): bool = s.queue.get(r).indices().exists(i => s.queue.get(r).nth(i) == t)
  action init = s' = {
    queue: Rooms.mapBy(_ => List()), active: Rooms.mapBy(_ => None),
    want: Turns.mapBy(_ => Set()), held: Turns.mapBy(_ => Set()),
    pc: Turns.mapBy(_ => "idle"), accepting: Turns.mapBy(_ => Set()),
    writes: Turns.mapBy(_ => Rooms.mapBy(_ => 0)), closed: false
  }
  action Start(t: str, wanted: Set[int]): bool = all {
    s.pc.get(t) == "idle", wanted.size() > 0,
    s' = { ...s, want: s.want.set(t, wanted), pc: s.pc.set(t, "acquiring") }
  }
  action Admit(t: str): bool = {
    val r = Min(s.want.get(t).exclude(s.held.get(t)))
    all {
      s.pc.get(t) == "acquiring",
      if (s.closed or (not(InUse.contains(r)) and InUse.size() >= MaxRooms) or Total >= MaxTotal or Pending(r) >= MaxPerRoom)
        s' = { ...s, pc: s.pc.set(t, if (s.held.get(t).size() == 0) "refused" else "unwinding") }
      else s' = { ...s, queue: s.queue.set(r, s.queue.get(r).append(t)), pc: s.pc.set(t, "waiting") }
    }
  }
  action Grant(r: int): bool = all {
    s.active.get(r) == None, s.queue.get(r).length() > 0,
    { val t = s.queue.get(r).nth(0)
      val held = s.held.get(t).union(Set(r))
      s' = { ...s, active: s.active.set(r, t), queue: s.queue.set(r, s.queue.get(r).tail()),
        held: s.held.set(t, held), accepting: s.accepting.set(t, s.accepting.get(t).union(Set(r))),
        pc: s.pc.set(t, if (held == s.want.get(t)) "owner" else "acquiring") }
    }
  }
  action Cancel(t: str): bool = {
    nondet r = Rooms.oneOf()
    all {
      s.pc.get(t) == "waiting", Waits(t, r),
      s' = { ...s, queue: s.queue.set(r, s.queue.get(r).select(x => x != t)),
        pc: s.pc.set(t, if (s.held.get(t).size() == 0) "cancelled" else "unwinding") }
    }
  }
  action Nest(t: str, r: int): bool = all {
    s.pc.get(t) == "owner", not(s.held.get(t).contains(r)),
    s' = { ...s, pc: s.pc.set(t, "releasing") }
  }
  action BeginWrite(t: str, r: int): bool = all {
    Set("owner", "releasing").contains(s.pc.get(t)), s.accepting.get(t).contains(r), s.writes.get(t).get(r) < MaxWrites,
    s' = { ...s, writes: s.writes.set(t, s.writes.get(t).set(r, s.writes.get(t).get(r) + 1)) }
  }
  action EndWrite(t: str, r: int): bool = all {
    s.writes.get(t).get(r) > 0,
    s' = { ...s, writes: s.writes.set(t, s.writes.get(t).set(r, s.writes.get(t).get(r) - 1)) }
  }
  action StartRelease(t: str): bool = all { s.pc.get(t) == "owner", s' = { ...s, pc: s.pc.set(t, "releasing") } }
  action StopWrites(t: str): bool = all {
    Set("releasing", "unwinding").contains(s.pc.get(t)), s.held.get(t).size() > 0,
    { val r = Max(s.held.get(t))
      all { s.accepting.get(t).contains(r), s' = { ...s, accepting: s.accepting.set(t, s.accepting.get(t).exclude(Set(r))) } }
    }
  }
  action Release(t: str): bool = all {
    Set("releasing", "unwinding").contains(s.pc.get(t)), s.held.get(t).size() > 0,
    { val r = Max(s.held.get(t))
      all {
        not(s.accepting.get(t).contains(r)), s.writes.get(t).get(r) == 0,
        s' = { ...s, active: s.active.set(r, None), held: s.held.set(t, s.held.get(t).exclude(Set(r))),
          pc: s.pc.set(t, if (s.held.get(t) == Set(r)) (if (s.pc.get(t) == "releasing") "done" else "refused") else s.pc.get(t)) }
      }
    }
  }
  action Close = all { not(s.closed), s' = { ...s, closed: true } }
  val Finished = Turns.forall(t => Set("done", "refused", "cancelled").contains(s.pc.get(t)))
  action nextStep = any {
    { nondet t = Turns.oneOf()
      nondet wanted = Rooms.powerset().oneOf()
      Start(t, wanted) },
    { nondet t = Turns.oneOf()
      any { Admit(t), Cancel(t), StartRelease(t), StopWrites(t), Release(t) } },
    { nondet t = Turns.oneOf()
      nondet r = Rooms.oneOf()
      any { Nest(t, r), BeginWrite(t, r), EndWrite(t, r) } },
    { nondet r = Rooms.oneOf()
      Grant(r) },
    Close, all { Finished, s.closed, s' = s }
  }
  // The original specification permits stuttering at every state. Deadlock
  // freedom checks the transition relation before adding that stutter.
  action step = any { nextStep, s' = s }
  temporal DeadlockFree = always(enabled(nextStep))
  temporal Fairness = and {
    Rooms.forall(r => Grant(r).weakFair(s)),
    Turns.forall(t => Admit(t).weakFair(s) and StartRelease(t).weakFair(s) and StopWrites(t).weakFair(s) and Release(t).weakFair(s)),
    Turns.forall(t => Rooms.forall(r => EndWrite(t, r).weakFair(s)))
  }
  val TypeOK = and {
    s.queue.keys() == Rooms, s.active.keys() == Rooms, s.want.keys() == Turns,
    s.held.keys() == Turns, s.pc.keys() == Turns, s.accepting.keys() == Turns, s.writes.keys() == Turns,
    Rooms.forall(r => Turns.union(Set(None)).contains(s.active.get(r)) and s.queue.get(r).indices().forall(i => Turns.contains(s.queue.get(r).nth(i)))),
    Turns.forall(t => and {
      s.want.get(t).subseteq(Rooms), s.held.get(t).subseteq(Rooms),
      States.contains(s.pc.get(t)), s.accepting.get(t).subseteq(Rooms),
      s.writes.get(t).keys() == Rooms,
      Rooms.forall(r => s.writes.get(t).get(r) >= 0 and s.writes.get(t).get(r) <= MaxWrites)
    })
  }
  val MutualExclusion = and {
    Rooms.forall(r => (s.active.get(r) != None).implies(s.held.get(s.active.get(r)).contains(r))),
    Turns.forall(t => s.held.get(t).forall(r => s.active.get(r) == t))
  }
  val WaitersQueued = Turns.forall(t => (s.pc.get(t) == "waiting").iff(Rooms.exists(r => Waits(t, r))) and Rooms.forall(r => s.queue.get(r).select(x => x == t).length() <= 1))
  val OrderedAcquisition = Turns.forall(t => Set("acquiring", "waiting").contains(s.pc.get(t)).implies(s.held.get(t).forall(h => h < Min(s.want.get(t).exclude(s.held.get(t))))))
  val Bounded = Rooms.forall(r => Pending(r) <= MaxPerRoom) and Total <= MaxTotal and InUse.size() <= MaxRooms
  val WritesUnderLease = Turns.forall(t => and {
    s.accepting.get(t).subseteq(s.held.get(t)),
    Rooms.forall(r => (s.writes.get(t).get(r) > 0).implies(s.held.get(t).contains(r))),
    Set("done", "refused", "cancelled", "idle").contains(s.pc.get(t)).implies(Rooms.forall(r => s.writes.get(t).get(r) == 0))
  })
  val NoLeakedOwnership = Turns.forall(t => Set("done", "refused", "cancelled").contains(s.pc.get(t)).implies(s.held.get(t).size() == 0 and Rooms.forall(r => not(Waits(t, r)))))
  temporal NoAdmissionAfterClose = always(s.closed.implies(Rooms.forall(r => next(s.queue).get(r).length() <= s.queue.get(r).length())).orKeep(s))
  temporal FreedByOwner = always(Rooms.forall(r =>
    (s.active.get(r) != None and next(s.active).get(r) != s.active.get(r)).implies(and {
      Set("releasing", "unwinding").contains(s.pc.get(s.active.get(r))),
      not(s.accepting.get(s.active.get(r)).contains(r)), s.writes.get(s.active.get(r)).get(r) == 0
    })).orKeep(s))
  temporal WaiterServed = Fairness.implies(Turns.forall(t => (s.pc.get(t) == "waiting").leadsTo(s.pc.get(t) != "waiting")))
  temporal TurnFinishes = Fairness.implies(Turns.forall(t => (s.pc.get(t) == "acquiring").leadsTo(Set("done", "refused", "cancelled").contains(s.pc.get(t)))))
}
module RoomHandlerQueue {
  import RoomHandlerQueueModel(Turns = Set("t1", "t2", "t3"), NumRooms = 2, MaxPerRoom = 2, MaxTotal = 3, MaxRooms = 2, MaxWrites = 1).* from "./RoomHandlerQueue"
}
module RoomHandlerQueueCycle {
  import RoomHandlerQueueModel(Turns = Set("t1", "t2", "t3"), NumRooms = 2, MaxPerRoom = 2, MaxTotal = 4, MaxRooms = 2, MaxWrites = 1).* from "./RoomHandlerQueue"
}
