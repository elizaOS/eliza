// One normalized output-lock key. Two threads share a process-local mutex.
// A second process contends at the same OS file-lock boundary.
module BenchmarkOutputLock {
  pure val callers = Set("owner", "thread", "process")
  pure val localPhases = Set("waiting-platform", "held", "release-success", "release-failure")
  pure val waitingPhases = Set("waiting-local", "waiting-platform")
  pure val donePhases = Set("returned", "failed")
  pure def sameProcess(a: str, b: str): bool = (a == "process") == (b == "process")

  var s: { pc: str -> str, nested: str, nestedRefused: bool }
  action init = s' = { pc: callers.mapBy(_ => "idle"), nested: "idle", nestedRefused: false }

  def localOwners(c: str): Set[str] = callers.filter(other =>
    sameProcess(c, other) and localPhases.contains(s.pc.get(other)))
  val platformOwners = callers.filter(c => s.pc.get(c) == "held")

  action request(c: str): bool = all {
    s.pc.get(c) == "idle", s' = s.with("pc", s.pc.set(c, "waiting-local"))
  }
  action acquireLocal(c: str): bool = all {
    s.pc.get(c) == "waiting-local", localOwners(c) == Set(),
    s' = s.with("pc", s.pc.set(c, "waiting-platform"))
  }
  action acquirePlatform(c: str): bool = all {
    s.pc.get(c) == "waiting-platform", platformOwners == Set(),
    s' = s.with("pc", s.pc.set(c, "held"))
  }
  action releasePlatform(c: str, failed: bool): bool = all {
    s.pc.get(c) == "held", c != "owner" or s.nested != "held",
    s' = s.with("pc", s.pc.set(c, if (failed) "release-failure" else "release-success"))
  }
  action releaseLocal(c: str): bool = all {
    s.pc.get(c).in(Set("release-success", "release-failure")),
    s' = s.with("pc", s.pc.set(c, if (s.pc.get(c) == "release-failure") "failed" else "returned"))
  }

  // The same thread refuses the same key before entering either lock.
  action refuseNested = all {
    s.pc.get("owner") == "held", not(s.nestedRefused),
    s' = s.with("nestedRefused", true)
  }
  action acquireOtherKey = all {
    s.pc.get("owner") == "held", s.nested == "idle", s' = s.with("nested", "held")
  }
  action releaseOtherKey = all { s.nested == "held", s' = s.with("nested", "returned") }
  action advance(c: str): bool = any {
    acquireLocal(c), acquirePlatform(c), releasePlatform(c, true),
    releasePlatform(c, false), releaseLocal(c)
  }
  action step = {
    nondet c = callers.oneOf()
    any { request(c), advance(c), refuseNested, acquireOtherKey, releaseOtherKey, s' = s }
  }

  val OnePlatformOwner = platformOwners.size() <= 1
  val OneLocalOwnerPerProcess = callers.forall(c => localOwners(c).size() <= 1)
  val NestedKeyKeepsOuterOwner = s.nested == "held" implies platformOwners.contains("owner")
  temporal RefusalPreservesOwners = always((
    (not(s.nestedRefused) and next(s.nestedRefused)) implies next(s.pc) == s.pc
  ).orKeep(s))
  temporal WaitingSettles = callers.forall(c =>
    waitingPhases.contains(s.pc.get(c)).leadsTo(donePhases.contains(s.pc.get(c))))
  temporal FairWaitingSettles = (
    callers.forall(c => advance(c).weakFair(s)) and releaseOtherKey.weakFair(s)
  ).implies(WaitingSettles)

  action hold(c: str): bool = request(c).then(acquireLocal(c)).then(acquirePlatform(c))
  run sameKeyRefusesWithoutPoisoningOwnerTest = init.then(hold("owner"))
    .then(refuseNested).expect(s.nestedRefused and platformOwners == Set("owner"))
    .then(acquireOtherKey).expect(NestedKeyKeepsOuterOwner and s.nested == "held")
    .then(releaseOtherKey).then(releasePlatform("owner", false)).then(releaseLocal("owner"))
    .expect(platformOwners == Set() and localOwners("owner") == Set())
  run failedBodyReleasesWaitingThreadTest = init.then(hold("owner")).then(request("thread"))
    .then(releasePlatform("owner", true))
    .expect(platformOwners == Set() and localOwners("owner") == Set("owner"))
    .then(releaseLocal("owner")).then(acquireLocal("thread")).then(acquirePlatform("thread"))
    .expect(s.pc.get("owner") == "failed" and platformOwners == Set("thread"))
  run separateProcessWaitsForFileReleaseTest = init.then(hold("owner"))
    .then(request("process")).then(acquireLocal("process"))
    .expect(platformOwners == Set("owner") and s.pc.get("process") == "waiting-platform")
    .then(releasePlatform("owner", false)).then(acquirePlatform("process"))
    .expect(platformOwners == Set("process") and localOwners("owner") == Set("owner"))
}
