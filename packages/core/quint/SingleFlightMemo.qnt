// src/runtime/single-flight-memo.ts and the runtime data mutation wrappers.
// Each adapter read, write completion and invalidation remains a separate step.
module SingleFlightMemoModel {
  const Readers: Set[str]
  const Writers: Set[str]
  pure val Fetches = 1.to(Readers.size())
  type State = {
    db: int, entry: int, nfetch: int, fval: int -> int, fstate: int -> str,
    rpc: str -> str, rf: str -> int, floor: str -> int,
    wpc: str -> str, wver: str -> int, completed: int
  }
  var s: State
  action init = s' = {
    db: 0, entry: 0, nfetch: 0, fval: Fetches.mapBy(_ => -1),
    fstate: Fetches.mapBy(_ => "pending"), rpc: Readers.mapBy(_ => "idle"),
    rf: Readers.mapBy(_ => 0), floor: Readers.mapBy(_ => 0),
    wpc: Writers.mapBy(_ => "idle"), wver: Writers.mapBy(_ => 0), completed: 0
  }
  action ReadShared(r: str): bool = all {
    s.rpc.get(r) == "idle", s.entry != 0,
    s' = { ...s, rpc: s.rpc.set(r, "waiting"), rf: s.rf.set(r, s.entry), floor: s.floor.set(r, s.completed) }
  }
  action ReadFetch(r: str): bool = all {
    s.rpc.get(r) == "idle",
    s' = { ...s, entry: s.nfetch + 1, nfetch: s.nfetch + 1,
      rpc: s.rpc.set(r, "waiting"), rf: s.rf.set(r, s.nfetch + 1), floor: s.floor.set(r, s.completed) }
  }
  action FetchRead(f: int): bool = all {
    f <= s.nfetch, s.fval.get(f) == -1,
    s' = { ...s, fval: s.fval.set(f, s.db) }
  }
  action FetchResolve(f: int): bool = all {
    s.fstate.get(f) == "pending", s.fval.get(f) != -1,
    s' = { ...s, fstate: s.fstate.set(f, "resolved") }
  }
  action FetchReject(f: int): bool = all {
    f <= s.nfetch, s.fstate.get(f) == "pending",
    s' = { ...s, fstate: s.fstate.set(f, "rejected"), entry: if (s.entry == f) 0 else s.entry }
  }
  action Serve(r: str): bool = all {
    s.rpc.get(r) == "waiting",
    s.fstate.get(s.rf.get(r)) != "pending",
    s' = { ...s, rpc: s.rpc.set(r, if (s.fstate.get(s.rf.get(r)) == "resolved") "served" else "failed") }
  }
  action Expire = all { s.entry != 0, s' = { ...s, entry: 0 } }
  action Commit(w: str): bool = all {
    s.wpc.get(w) == "idle",
    s' = { ...s, db: s.db + 1, wver: s.wver.set(w, s.db + 1), wpc: s.wpc.set(w, "committed") }
  }
  action Invalidate(w: str): bool = all {
    s.wpc.get(w) == "committed",
    s' = { ...s, entry: 0, completed: if (s.completed > s.wver.get(w)) s.completed else s.wver.get(w), wpc: s.wpc.set(w, "done") }
  }
  val Finished = Readers.forall(r => Set("served", "failed").contains(s.rpc.get(r))) and Writers.forall(w => s.wpc.get(w) == "done")
  action nextStep = any {
    { nondet r = Readers.oneOf()
      any { ReadShared(r), ReadFetch(r), Serve(r) } },
    { nondet f = Fetches.oneOf()
      any { FetchRead(f), FetchResolve(f), FetchReject(f) } },
    { nondet w = Writers.oneOf()
      any { Commit(w), Invalidate(w) } },
    Expire, all { Finished, s' = s }
  }
  // The original specification permits stuttering at every state. Deadlock
  // freedom checks the transition relation before adding that stutter.
  action step = any { nextStep, s' = s }
  temporal DeadlockFree = always(enabled(nextStep))
  temporal Fairness = and {
    Fetches.forall(f => FetchRead(f).weakFair(s) and FetchResolve(f).weakFair(s)),
    Readers.forall(r => Serve(r).weakFair(s)),
    Writers.forall(w => Invalidate(w).weakFair(s))
  }
  val TypeOK = and {
    s.db >= 0, Fetches.union(Set(0)).contains(s.entry), s.nfetch >= 0 and s.nfetch <= Readers.size(),
    s.fval.keys() == Fetches, s.fstate.keys() == Fetches,
    Fetches.forall(f => s.fval.get(f) >= -1 and Set("pending", "resolved", "rejected").contains(s.fstate.get(f))),
    s.rpc.keys() == Readers, s.rf.keys() == Readers, s.floor.keys() == Readers,
    Readers.forall(r => Set("idle", "waiting", "served", "failed").contains(s.rpc.get(r)) and Fetches.union(Set(0)).contains(s.rf.get(r)) and s.floor.get(r) >= 0),
    s.wpc.keys() == Writers, s.wver.keys() == Writers,
    Writers.forall(w => Set("idle", "committed", "done").contains(s.wpc.get(w)) and s.wver.get(w) >= 0), s.completed >= 0
  }
  val NoStaleAfterInvalidate = Readers.forall(r => (s.rpc.get(r) == "served").implies(s.fval.get(s.rf.get(r)) >= s.floor.get(r)))
  val RejectedNotCached = (s.entry != 0).implies(s.fstate.get(s.entry) != "rejected")
  temporal ReaderFinishes = Fairness.implies(Readers.forall(r => (s.rpc.get(r) == "waiting").leadsTo(Set("served", "failed").contains(s.rpc.get(r)))))
}
module SingleFlightMemo {
  // The prior safety configuration used reader/writer permutations solely as
  // a search reduction. The same labeled state space is checked here in full.
  import SingleFlightMemoModel(Readers = Set("r1", "r2", "r3"), Writers = Set("w1", "w2")).* from "./SingleFlightMemo"
}
module SingleFlightMemoLiveness {
  import SingleFlightMemoModel(Readers = Set("r1", "r2"), Writers = Set("w1", "w2")).* from "./SingleFlightMemo"
}
