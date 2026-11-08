// workflow-service.ts owner gate and embedded-workflow-service.ts
// decideReviewedApproval. The execution row lock is held across canonical
// receipt reads and the engine command. Engine decisions survive SQL rollback.
module ReviewedApproval {
  pure val Callers = Set("first", "second")
  pure val None = "none"
  type State = {
    lock: str, canonical: str, cached: str, supported: bool, finished: bool, cancelled: bool,
    effects: int, phase: str -> str, wants: str -> str, ownerOK: str -> bool,
    versionOK: str -> bool, digestOK: str -> bool, attempts: str -> int,
    response: str -> str
  }
  var s: State
  action init = {
    nondet supported = Set(true, false).oneOf()
    s' = {
      lock: None, canonical: "pending", cached: "pending", supported: supported, finished: false, cancelled: false,
      effects: 0, phase: Callers.mapBy(_ => "idle"), wants: Callers.mapBy(_ => "approved"),
      ownerOK: Callers.mapBy(_ => true), versionOK: Callers.mapBy(_ => true), digestOK: Callers.mapBy(_ => true),
      attempts: Callers.mapBy(_ => 0), response: Callers.mapBy(_ => "none")
    }
  }
  action Request(c: str): bool = {
    nondet decision = Set("approved", "denied").oneOf()
    nondet authorized = Set(true, false).oneOf()
    nondet version = Set(true, false).oneOf()
    nondet digest = Set(true, false).oneOf()
    all {
      Set("idle", "failed").contains(s.phase.get(c)), s.attempts.get(c) < 2,
      s' = { ...s, phase: s.phase.set(c, "queued"), wants: s.wants.set(c, decision),
        ownerOK: s.ownerOK.set(c, authorized), versionOK: s.versionOK.set(c, version), digestOK: s.digestOK.set(c, digest),
        attempts: s.attempts.set(c, s.attempts.get(c) + 1), response: s.response.set(c, "none") }
    }
  }
  action Acquire(c: str): bool = all {
    s.phase.get(c) == "queued", s.lock == None,
    if (not(s.ownerOK.get(c))) s' = { ...s, phase: s.phase.set(c, "failed") }
    else s' = { ...s, lock: c, phase: s.phase.set(c, "read") }
  }
  action Review(c: str): bool = all {
    s.lock == c, s.phase.get(c) == "read",
    if (not(s.versionOK.get(c)) or not(s.digestOK.get(c)))
      s' = { ...s, lock: None, phase: s.phase.set(c, "failed") }
    else if (s.canonical != "pending") {
      if (s.canonical == s.wants.get(c))
        s' = { ...s, lock: None, phase: s.phase.set(c, "resuming") }
      else s' = { ...s, lock: None, phase: s.phase.set(c, "failed") }
    } else if (s.finished or s.cancelled or (s.wants.get(c) == "approved" and not(s.supported)))
      s' = { ...s, lock: None, phase: s.phase.set(c, "failed") }
    else s' = { ...s, phase: s.phase.set(c, "command") }
  }
  action Control(c: str): bool = {
    nondet committed = Set(true, false).oneOf()
    all {
      s.lock == c, s.phase.get(c) == "command",
      if (committed) s' = { ...s, canonical: s.wants.get(c), effects: s.effects + 1, phase: s.phase.set(c, "readback") }
      else s' = { ...s, lock: None, phase: s.phase.set(c, "failed") }
    }
  }
  // A lost control response still goes through canonical readback. A failed
  // readback or SQL write releases the lock without undoing the engine receipt.
  action Readback(c: str): bool = {
    nondet available = Set(true, false).oneOf()
    all {
      s.lock == c, s.phase.get(c) == "readback",
      if (available) s' = { ...s, phase: s.phase.set(c, "persist") }
      else s' = { ...s, lock: None, phase: s.phase.set(c, "failed") }
    }
  }
  action Persist(c: str): bool = {
    nondet committed = Set(true, false).oneOf()
    all {
      s.lock == c, s.phase.get(c) == "persist",
      if (committed) s' = { ...s, cached: s.canonical, lock: None, phase: s.phase.set(c, "resuming") }
      else s' = { ...s, lock: None, phase: s.phase.set(c, "failed") }
    }
  }
  action Resume(c: str): bool = {
    nondet resumed = Set(true, false).oneOf()
    all {
      s.phase.get(c) == "resuming",
      s' = { ...s, phase: s.phase.set(c, if (resumed) "done" else "failed"),
        response: s.response.set(c, if (resumed) s.canonical else "none") }
    }
  }
  action StopExecution = all { s.lock == None, not(s.cancelled), s' = { ...s, cancelled: true } }
  action FinishExecution = all { s.lock == None, not(s.finished), s' = { ...s, finished: true } }
  action step = any {
    { nondet c = Callers.oneOf()
      any { Request(c), Acquire(c), Review(c), Control(c), Readback(c), Persist(c), Resume(c) } },
    StopExecution, FinishExecution, s' = s
  }
  // Every admitted local step returns under fair scheduling. External control
  // and readback failures are terminal outcomes rather than hidden success.
  temporal Fairness = Callers.forall(c => and {
    Acquire(c).weakFair(s), Review(c).weakFair(s), Control(c).weakFair(s),
    Readback(c).weakFair(s), Persist(c).weakFair(s), Resume(c).weakFair(s)
  })
  temporal DecisionReturns = Fairness.implies(Callers.forall(c =>
    (s.phase.get(c) == "queued").leadsTo(Set("done", "failed").contains(s.phase.get(c)))))
  val OneCanonicalDecision = s.effects <= 1 and (s.canonical == "pending").iff(s.effects == 0)
  val UnsupportedNeverApproved = not(s.supported).implies(s.canonical != "approved")
  val HonestResponse = Callers.forall(c => (s.response.get(c) != "none").implies(
    s.ownerOK.get(c) and s.versionOK.get(c) and s.digestOK.get(c) and s.response.get(c) == s.canonical))
  val CachedHasCanonicalReceipt = (s.cached != "pending").implies(s.cached == s.canonical)
  val LockOwnership = s.lock == None or Callers.contains(s.lock)
}
