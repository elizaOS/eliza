// Observer ownership in services/vast-pyworker/observability.py.
// Two processes race for a single kernel flock. Heartbeat is a thread in the
// owning process. Normal close joins it before releasing the lock; process
// death ends every thread before the kernel releases the process lock.
// Bounds: two bootstrap attempts, one heartbeat thread each, one history bit.
// Kernel flock/process-termination semantics are assumptions. Disk failure, GPU/SDK
// readiness, timing and exact metric bytes are outside this model.
module vast_worker_supervision {
  pure val processes = Set(1, 2)
  type State = {
    phase: int -> str,
    lock: int,
    threads: Set[int],
    threadStarted: Set[int],
    recorded: bool,
    everRecorded: bool,
  }
  var s: State
  action init = s' = {
    phase: Map(1 -> "new", 2 -> "new"), lock: 0,
    threads: Set(), threadStarted: Set(), recorded: false, everRecorded: false,
  }
  action spawn(p) = all {
    s.phase.get(p) == "new",
    s' = s.with("phase", s.phase.set(p, "waiting")),
  }
  action acquire(p) = all {
    s.phase.get(p) == "waiting", s.lock == 0,
    s' = s.with("phase", s.phase.set(p, "active")).with("lock", p),
  }
  action reuse(p) = all {
    s.phase.get(p) == "waiting", s.lock != 0,
    s' = s.with("phase", s.phase.set(p, "exited")),
  }
  action startThread(p) = all {
    s.phase.get(p) == "active", not(s.threadStarted.contains(p)),
    s' = s.with("threads", s.threads.union(Set(p)))
      .with("threadStarted", s.threadStarted.union(Set(p))),
  }
  action sample(p) = all {
    s.phase.get(p) == "active",
    s' = s.with("recorded", true).with("everRecorded", true),
  }
  action stop(p) = all {
    s.phase.get(p) == "active",
    s' = s.with("phase", s.phase.set(p, "closing")),
  }
  action threadExit(p) = all {
    s.threads.contains(p),
    s' = s.with("threads", s.threads.exclude(Set(p))),
  }
  action finish(p) = all {
    s.phase.get(p) == "closing", not(s.threads.contains(p)),
    s' = s.with("phase", s.phase.set(p, "exited")).with("lock", 0),
  }
  action hardKill(p) = all {
    Set("active", "closing").contains(s.phase.get(p)),
    s' = s.with("phase", s.phase.set(p, "crashed"))
      .with("threads", s.threads.exclude(Set(p))).with("lock", 0),
  }
  action idle = s' = s
  action step = {
    nondet p = processes.oneOf()
    any { spawn(p), acquire(p), reuse(p), startThread(p), sample(p), stop(p),
      threadExit(p), finish(p), hardKill(p), idle }
  }
  val writers = processes.filter(p => s.phase.get(p) == "active")
  val safety = all {
    writers.size() <= 1,
    s.threads.size() <= 1,
    writers.forall(p => s.lock == p),
    s.threads.forall(p => s.lock == p),
    s.everRecorded implies s.recorded,
    s.lock == 0 or Set("active", "closing", "crashed").contains(s.phase.get(s.lock)),
  }
  temporal StopCompletes = (processes.forall(p => threadExit(p).weakFair(s) and finish(p).weakFair(s))).implies(
    processes.forall(p => (s.phase.get(p) == "closing").leadsTo(Set("exited", "crashed").contains(s.phase.get(p)))))
  run repeatedBootstrapReusesOwnerTest = init.then(spawn(1)).then(acquire(1))
    .then(startThread(1)).then(sample(1)).then(spawn(2)).then(reuse(2))
    .expect(safety and s.threads == Set(1) and s.phase.get(2) == "exited" and s.recorded)
  run gracefulStopRetainsLockUntilThreadExitsTest = init.then(spawn(1)).then(acquire(1))
    .then(startThread(1)).then(stop(1)).then(threadExit(1)).then(finish(1))
    .expect(safety and s.lock == 0 and s.threads == Set())
  run crashWithoutThreadReleasesLockTest = init.then(spawn(1)).then(acquire(1))
    .then(sample(1)).then(hardKill(1)).then(spawn(2)).then(acquire(2))
    .expect(safety and s.lock == 2 and s.recorded)
  run processDeathStopsAllWritersTest = init.then(spawn(1)).then(acquire(1))
    .then(startThread(1)).then(sample(1)).then(hardKill(1))
    .expect(safety and s.lock == 0 and s.threads == Set() and s.recorded)
  run restartAfterHardDeathTest = init.then(spawn(1)).then(acquire(1))
    .then(startThread(1)).then(sample(1)).then(hardKill(1)).then(spawn(2))
    .then(acquire(2)).then(startThread(2)).then(sample(2))
    .expect(safety and s.lock == 2 and s.threads == Set(2) and s.recorded)

  // Baseline script launched helper loops unconditionally and truncated the
  // shared JSONL at every startup. Retained only as a regression witness.
  action legacyBootstrap(p) = all {
    s.phase.get(p) == "new",
    s' = s.with("phase", s.phase.set(p, "active"))
      .with("threads", s.threads.union(Set(p)))
      .with("recorded", false),
  }
  run legacyDuplicateAndTruncationDetectedTest = init.then(legacyBootstrap(1))
    .then(sample(1)).then(legacyBootstrap(2))
    .expect(not(safety) and not(s.recorded) and s.threads.size() == 2)
}
