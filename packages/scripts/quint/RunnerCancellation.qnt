// Normal CLI supervision owns both the synchronous worker and its checker.
// The previous successful receipt is retired before a new worker starts.
module RunnerCancellation {
  var s: { phase: str, passed: bool, worker: bool, checker: bool, completed: int,
    cancelledAt: int, cancelled: bool, forwarded: bool }
  action init = s' = { phase: "not-started", passed: true, worker: false, checker: false,
    completed: 0, cancelledAt: 0, cancelled: false, forwarded: false }
  action start = all {
    s.phase == "not-started",
    s' = { ...s, phase: "running", passed: false, worker: true },
  }
  action launch = all {
    s.phase == "running" and not(s.checker) and s.completed < 2,
    s' = { ...s, checker: true },
  }
  action checkFinishes = all {
    s.phase == "running" and s.checker,
    s' = { ...s, checker: false, completed: s.completed + 1 },
  }
  action finish = all {
    s.phase == "running" and not(s.checker) and s.completed == 2,
    s' = { ...s, phase: "done", passed: true, worker: false },
  }
  action cancel = all {
    s.phase == "running",
    s' = { ...s, phase: "cancelling", cancelled: true, cancelledAt: s.completed, passed: false },
  }
  action forward = all {
    s.phase == "cancelling" and not(s.forwarded),
    s' = { ...s, forwarded: true, worker: false },
  }
  action cooperativeExit = all {
    s.phase == "cancelling" and s.forwarded,
    s' = { ...s, checker: false },
  }
  action force = all {
    s.phase == "cancelling" and s.forwarded,
    s' = { ...s, worker: false, checker: false },
  }
  action reap = all {
    s.phase == "cancelling" and not(s.worker) and not(s.checker),
    s' = { ...s, phase: "done" },
  }
  action oldParentOnlyExit = all {
    s.phase == "cancelling",
    s' = { ...s, phase: "done", worker: false },
  }
  action step = any { start, launch, checkFinishes, finish, cancel,
    forward, cooperativeExit, force, reap, s' = s }
  val NoCheckerAfterClose = (s.phase == "done").implies(not(s.worker or s.checker))
  val CancelledNeverPasses = s.cancelled.implies(not(s.passed))
  val NoLaterCaseAfterCancellation = s.cancelled.implies(s.completed == s.cancelledAt)
  val ActiveEvidenceIsIncomplete = Set("running", "cancelling").contains(s.phase).implies(not(s.passed))
  temporal CleanupProgress = (forward.weakFair(s) and force.weakFair(s) and reap.weakFair(s)).implies(
    s.cancelled.leadsTo(s.phase == "done"))
  run parentOnlySignalLeavesCheckerTest = init.then(start).then(launch).then(cancel)
    .then(oldParentOnlyExit).expect(not(NoCheckerAfterClose))
  run ignoredSignalEscalatesTest = init.then(start).then(launch).then(cancel).then(forward)
    .then(force).then(reap).expect(NoCheckerAfterClose and CancelledNeverPasses)
  run laterCaseIsNotStartedTest = init.then(start).then(launch).then(checkFinishes)
    .then(cancel).then(forward).then(reap).expect(NoLaterCaseAfterCancellation)
}
