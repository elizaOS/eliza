// src/utils/task-scheduling.ts Semaphore. Aborting a signal and invoking its
// listener are separate steps, retaining the release/abort-listener race.
module SemaphoreModel {
  const Callers: Set[str]
  const N: int
  type State = {
    permits: int, waiters: List[str], pc: str -> str,
    aborted: str -> bool, queuedAbort: str -> bool,
    ticket: str -> int, nextTicket: int
  }
  var s: State
  val Holders = Callers.filter(c => s.pc.get(c) == "holding")
  def Queued(c: str): bool = s.waiters.indices().exists(i => s.waiters.nth(i) == c)
  action init = s' = {
    permits: N, waiters: List(), pc: Callers.mapBy(_ => "idle"),
    aborted: Callers.mapBy(_ => false),
    queuedAbort: Callers.mapBy(_ => false), ticket: Callers.mapBy(_ => 0), nextTicket: 1
  }
  action Acquire(c: str): bool = all {
    s.pc.get(c) == "idle",
    if (s.aborted.get(c)) s' = { ...s, pc: s.pc.set(c, "rejected") }
    else if (s.permits > 0) s' = { ...s, permits: s.permits - 1, pc: s.pc.set(c, "holding") }
    else s' = { ...s, waiters: s.waiters.append(c), pc: s.pc.set(c, "waiting"),
      ticket: s.ticket.set(c, s.nextTicket), nextTicket: s.nextTicket + 1 }
  }
  action Abort(c: str): bool = all {
    not(s.aborted.get(c)),
    s' = { ...s, aborted: s.aborted.set(c, true),
      queuedAbort: s.queuedAbort.set(c, s.pc.get(c) == "waiting") }
  }
  // An aborted caller still in the queue has a pending cancellation listener.
  // Release can skip it before the listener runs.
  action CancelListener(c: str): bool = all {
    s.pc.get(c) == "waiting", s.aborted.get(c),
    s' = { ...s, waiters: s.waiters.select(x => x != c), pc: s.pc.set(c, "rejected") }
  }
  // Prefix count is the first live waiter's index, or the entire queue length.
  val Skipped = s.waiters.indices().fold(s.waiters.length(), (k, i) =>
    if (not(s.aborted.get(s.waiters.nth(i))) and i < k) i else k)
  action Release(c: str): bool = {
    val dead = s.waiters.indices().filter(i => i < Skipped).map(i => s.waiters.nth(i))
    val rest = s.waiters.slice(Skipped, s.waiters.length())
    all {
      s.pc.get(c) == "holding",
      s' = { ...s,
        permits: if (rest.length() == 0) s.permits + 1 else s.permits,
        waiters: if (rest.length() == 0) List() else rest.slice(1, rest.length()),
        pc: Callers.mapBy(x => if (x == c) "done"
          else if (rest.length() > 0 and x == rest.nth(0)) "holding"
          else if (dead.contains(x)) "rejected" else s.pc.get(x))
      }
    }
  }
  val Finished = Callers.forall(c => Set("done", "rejected").contains(s.pc.get(c)))
  action nextStep = any {
    { nondet c = Callers.oneOf()
      any { Acquire(c), Abort(c), CancelListener(c), Release(c) } },
    all { Finished, s' = s }
  }
  // The original specification permits stuttering at every state. Deadlock
  // freedom checks the transition relation before adding that stutter.
  action step = any { nextStep, s' = s }
  temporal DeadlockFree = always(enabled(nextStep))
  temporal Fairness = Callers.forall(c => Release(c).weakFair(s) and CancelListener(c).weakFair(s))
  val TypeOK = and {
    s.permits >= 0 and s.permits <= N,
    s.waiters.indices().forall(i => Callers.contains(s.waiters.nth(i))),
    s.pc.keys() == Callers, s.aborted.keys() == Callers,
    s.queuedAbort.keys() == Callers, s.ticket.keys() == Callers, s.nextTicket >= 0,
    Callers.forall(c => Set("idle", "waiting", "holding", "done", "rejected").contains(s.pc.get(c)) and s.ticket.get(c) >= 0)
  }
  val PermitConservation = s.permits + Holders.size() == N
  val NoIdlePermitWithWaiters = (s.permits > 0).implies(s.waiters.length() == 0)
  val WaitersQueued = Callers.forall(c =>
    (s.pc.get(c) == "waiting").iff(Queued(c)) and s.waiters.select(x => x == c).length() <= 1)
  val FIFOGrants = Callers.forall(w => Callers.forall(h =>
    (s.pc.get(w) == "waiting" and Set("holding", "done").contains(s.pc.get(h)) and s.ticket.get(h) != 0)
      .implies(s.ticket.get(h) < s.ticket.get(w))))
  val CancelledNeverHolds = Callers.forall(c => s.queuedAbort.get(c).implies(not(Set("holding", "done").contains(s.pc.get(c)))))
  temporal WaiterServed = Fairness.implies(Callers.forall(c => (s.pc.get(c) == "waiting").leadsTo(s.pc.get(c) != "waiting")))
}
module Semaphore {
  import SemaphoreModel(Callers = Set("c1", "c2", "c3", "c4"), N = 1).* from "./Semaphore"
}
module SemaphoreTwo {
  import SemaphoreModel(Callers = Set("c1", "c2", "c3", "c4"), N = 2).* from "./Semaphore"
}
