// Normal CLI supervision owns both the synchronous worker and its checker.
// The previous successful receipt is retired before a new worker starts.
module RunnerCancellation {
  var s: { phase: str, passed: bool, worker: bool, checker: bool, completed: int,
    cancelledAt: int, cancelled: bool, forwarded: bool }
  action init = s' = { phase: "not-started", passed: true, worker: false, checker: false,
    completed: 0, cancelledAt: 0, cancelled: false, forwarded: false }
  action inventory = s' = s
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
    forward, cooperativeExit, force, reap, inventory }
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
  run inventoryPreservesReceiptTest = init.then(inventory).expect(s.passed)
    .then(start).then(launch).then(cancel).then(inventory)
    .expect(CancelledNeverPasses and s.checker)
}

// One enclosing deadline owner and the direct Quint controller. A clock tick
// dispatches each due cleanup before the outer owner's later deadline. External
// suspension beyond that allowance is an explicit operating-system boundary.
module NestedRunnerCancellation {
  var nested: {
    phase: str, controller: bool, worker: bool, checker: bool,
    pendingSpawn: bool, outerRemaining: int, innerRemaining: int,
  }
  action initNested = nested' = {
    phase: "running", controller: true, worker: true, checker: false,
    pendingSpawn: false, outerRemaining: 10, innerRemaining: 3,
  }
  action initEqualGrace = nested' = {
    phase: "running", controller: true, worker: true, checker: false,
    pendingSpawn: false, outerRemaining: 10, innerRemaining: 10,
  }
  action requestLaunch = all {
    nested.phase == "running", not(nested.checker),
    nested' = { ...nested, pendingSpawn: true },
  }
  action launch = all {
    nested.pendingSpawn, nested.worker,
    nested' = { ...nested, pendingSpawn: false, checker: true },
  }
  action cancelNested = all {
    nested.phase == "running", nested' = { ...nested, phase: "cancelling" },
  }
  action workerExitsFirst = all {
    nested.phase == "cancelling", nested.worker,
    nested' = { ...nested, worker: false, pendingSpawn: false },
  }
  action cleanupTick = all {
    nested.phase == "cancelling", nested.outerRemaining > 0,
    val outer = nested.outerRemaining - 1
    val inner = if (nested.innerRemaining > 0) nested.innerRemaining - 1 else 0
    nested' = if (outer == 0) {
      ...nested, outerRemaining: 0, innerRemaining: inner,
      phase: "done", controller: false,
    } else if (inner == 0) {
      ...nested, outerRemaining: outer, innerRemaining: 0,
      worker: false, checker: false, pendingSpawn: false,
    } else { ...nested, outerRemaining: outer, innerRemaining: inner },
  }
  action reapNested = all {
    nested.phase == "cancelling", not(nested.worker or nested.checker),
    nested' = { ...nested, phase: "done", controller: false, pendingSpawn: false },
  }
  action nestedStep = any {
    requestLaunch, launch, cancelNested, workerExitsFirst,
    cleanupTick, reapNested, nested' = nested,
  }
  val NoChildAfterControllerClose = nested.controller or
    not(nested.worker or nested.checker or nested.pendingSpawn)
  val NestedBounds = nested.outerRemaining >= 0 and nested.outerRemaining <= 10
    and nested.innerRemaining >= 0 and nested.innerRemaining <= 3
  temporal NestedCleanup = (cleanupTick.weakFair(nested) and reapNested.weakFair(nested)).implies(
    (nested.phase == "cancelling").leadsTo(nested.phase == "done"))

  run lateSpawnIsStillOwnedTest = initNested.then(requestLaunch).then(cancelNested)
    .then(launch).then(cleanupTick).then(cleanupTick).then(cleanupTick)
    .then(reapNested).expect(NoChildAfterControllerClose)
  run exitedWorkerDoesNotEndCheckerOwnershipTest = initNested.then(requestLaunch)
    .then(launch).then(cancelNested).then(workerExitsFirst)
    .then(cleanupTick).then(cleanupTick).then(cleanupTick).then(reapNested)
    .expect(NoChildAfterControllerClose)
  run equalNestedGraceCanLeaveOrphanTest = initEqualGrace.then(requestLaunch)
    .then(launch).then(cancelNested)
    .then(cleanupTick).then(cleanupTick).then(cleanupTick).then(cleanupTick).then(cleanupTick)
    .then(cleanupTick).then(cleanupTick).then(cleanupTick).then(cleanupTick).then(cleanupTick)
    .expect(not(NoChildAfterControllerClose))
}
