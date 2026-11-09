// src/utils/task-scheduling.ts createSerialise. Every call swaps the lock
// synchronously, awaits its predecessor, and resolves its lock in finally.
module SerialiseModel {
  const Calls: Set[str]
  type State = { chain: List[str], pc: str -> str, outcome: str -> str }
  var s: State

  action init = s' = {
    chain: List(), pc: Calls.mapBy(_ => "idle"), outcome: Calls.mapBy(_ => "none")
  }
  action Invoke(c: str): bool = all {
    s.pc.get(c) == "idle",
    s' = { ...s, chain: s.chain.append(c), pc: s.pc.set(c, "queued") }
  }
  action Start(c: str): bool = all {
    s.pc.get(c) == "queued",
    s.chain.indices().forall(i => if (i == 0) true else if (s.chain.nth(i) != c) true else s.pc.get(s.chain.nth(i - 1)) == "done"),
    s' = { ...s, pc: s.pc.set(c, "running") }
  }
  action Finish(c: str): bool = {
    nondet o = Set("ok", "threw").oneOf()
    all {
      s.pc.get(c) == "running",
      s' = { ...s, pc: s.pc.set(c, "done"), outcome: s.outcome.set(c, o) }
    }
  }
  val Finished = Calls.forall(c => s.pc.get(c) == "done")
  action nextStep = any {
    { nondet c = Calls.oneOf()
      any { Invoke(c), Start(c), Finish(c) } },
    all { Finished, s' = s }
  }
  // The original specification permits stuttering at every state. Deadlock
  // freedom checks the transition relation before adding that stutter.
  action step = any { nextStep, s' = s }
  temporal DeadlockFree = always(enabled(nextStep))
  temporal Fairness = Calls.forall(c => Start(c).weakFair(s) and Finish(c).weakFair(s))
  val TypeOK = and {
    s.chain.indices().forall(i => Calls.contains(s.chain.nth(i))),
    s.pc.keys() == Calls, s.outcome.keys() == Calls,
    Calls.forall(c => Set("idle", "queued", "running", "done").contains(s.pc.get(c))),
    Calls.forall(c => Set("none", "ok", "threw").contains(s.outcome.get(c)))
  }
  val MutualExclusion = Calls.filter(c => s.pc.get(c) == "running").size() <= 1
  val CallOrder = s.chain.indices().forall(i => s.chain.indices().forall(j =>
    (i < j and Set("running", "done").contains(s.pc.get(s.chain.nth(j)))).implies(s.pc.get(s.chain.nth(i)) == "done")))
  temporal CallFinishes = Fairness.implies(Calls.forall(c => (s.pc.get(c) == "queued").leadsTo(s.pc.get(c) == "done")))
}
module Serialise {
  import SerialiseModel(Calls = Set("a", "b", "c", "d")).* from "./Serialise"
}
