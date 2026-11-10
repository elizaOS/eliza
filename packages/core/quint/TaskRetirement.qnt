// Execution admission owns the whole call, including task reads and shouldRun.
// stop closes admission before waiting for every receipt and worker to settle.
module TaskRetirement {
  const Repeat: bool
  val Calls = Set("daemon", "by-id", "resume")
  val Waiting = Set("read", "preflight")
  val Claimed = Set("recheck", "worker", "write", "release")
  var s: { closed: bool, drained: bool, rowExists: bool,
    pc: str -> str, pending: Set[str], exclusive: str -> bool }

  val owners = Calls.filter(c => Claimed.contains(s.pc.get(c)))
  action init = s' = { closed: false, drained: false, rowExists: true,
    pc: Calls.mapBy(_ => "idle"), pending: Set(), exclusive: Calls.mapBy(_ => false) }
  action admit(c: str): bool = all {
    s.pc.get(c) == "idle",
    s' = if (s.closed) { ...s, pc: s.pc.set(c, "rejected") }
      else { ...s, pending: s.pending.union(Set(c)),
        pc: s.pc.set(c, if (c == "daemon") "preflight" else "read") },
  }
  action prepareStop = s' = { ...s, closed: true }
  action readOrPreflightSettles(c: str, succeeded: bool, exclusive: bool): bool = {
    val guarded = not(Repeat) or exclusive
    val accepted = succeeded and not(s.closed) and s.rowExists
      and (not(guarded) or owners.size() == 0)
    all {
      Waiting.contains(s.pc.get(c)),
      s' = { ...s, exclusive: s.exclusive.set(c, guarded),
        pc: s.pc.set(c, if (not(accepted)) "settle"
          else if (Repeat) "worker" else "recheck") },
    }
  }
  action recheck(c: str, succeeded: bool): bool = all {
    s.pc.get(c) == "recheck",
    s' = { ...s, pc: s.pc.set(c, if (succeeded and s.rowExists and not(s.closed))
      "worker" else "release") },
  }
  action work(c: str, preserve: bool): bool = all {
    s.pc.get(c) == "worker",
    s' = { ...s, pc: s.pc.set(c, if (preserve) "release" else "write") },
  }
  action write(c: str): bool = all {
    s.pc.get(c) == "write",
    s' = { ...s, rowExists: Repeat, pc: s.pc.set(c, "release") },
  }
  action release(c: str): bool = all {
    s.pc.get(c) == "release",
    s' = { ...s, pc: s.pc.set(c, "settle") },
  }
  action finalize(c: str): bool = all {
    s.pc.get(c) == "settle",
    s' = { ...s, pc: s.pc.set(c, "done"), pending: s.pending.exclude(Set(c)) },
  }
  action drain = all {
    s.closed, s.pending.size() == 0,
    s' = { ...s, drained: true },
  }
  action complete(c: str): bool = {
    nondet succeeded = Set(true, false).oneOf()
    nondet exclusive = Set(true, false).oneOf()
    nondet preserve = Set(true, false).oneOf()
    any {
      readOrPreflightSettles(c, succeeded, exclusive), recheck(c, succeeded),
      work(c, preserve), write(c), release(c), finalize(c),
    }
  }
  action step = {
    nondet c = Calls.oneOf()
    any { admit(c), complete(c), prepareStop, drain, s' = s }
  }

  val PendingCoversEveryOperation = Calls.forall(c =>
    s.pending.contains(c) == Set("read", "preflight", "recheck", "worker", "write", "release", "settle").contains(s.pc.get(c)))
  val DrainedHasNoWork = s.drained.implies(s.closed and s.pending.size() == 0 and owners.size() == 0)
  val OneShotHasOneOwner = (not(Repeat)).implies(owners.size() <= 1)
  val ClaimsRemainOwned = owners.subseteq(s.pending)
  temporal ExclusiveAdmissionSeesEveryOwner = always(Calls.forall(c =>
    (not(owners.contains(c)) and next(owners).contains(c) and next(s.exclusive).get(c))
      .implies(owners.size() == 0)).orKeep(s))
  temporal NoNewAdmissionAfterClose = always(
    (s.closed.implies(next(s.pending).subseteq(s.pending))).orKeep(s))
  temporal NoWorkerStartsAfterClose = always(
    (s.closed.implies(Calls.forall(c =>
      (next(s.pc).get(c) == "worker").implies(s.pc.get(c) == "worker")))).orKeep(s))
  temporal StopDrains = (Calls.forall(c => complete(c).weakFair(s)) and drain.weakFair(s))
    .implies(s.closed.leadsTo(s.drained))

  run stoppedPreflightMustSettleTest = init.then(admit("daemon")).then(prepareStop)
    .expect(not(s.drained) and s.pending == Set("daemon"))
    .then(readOrPreflightSettles("daemon", true, true)).then(finalize("daemon"))
    .then(drain).expect(DrainedHasNoWork).then(admit("by-id"))
    .expect(s.pc.get("by-id") == "rejected")
}
module TaskRetirementOneShot {
  import TaskRetirement(Repeat = false).*
}
module TaskRetirementRepeat {
  import TaskRetirement(Repeat = true).*
  run overlapRetainsSecondOwnerTest = init.then(admit("by-id"))
    .then(readOrPreflightSettles("by-id", true, false)).then(admit("resume"))
    .then(readOrPreflightSettles("resume", true, false))
    .then(work("by-id", true)).then(release("by-id")).then(finalize("by-id"))
    .then(admit("daemon")).then(readOrPreflightSettles("daemon", true, true))
    .expect(s.pc.get("daemon") == "settle" and owners == Set("resume"))
    .then(prepareStop).then(work("resume", true)).then(release("resume"))
    .then(finalize("resume")).then(finalize("daemon")).then(drain)
    .expect(DrainedHasNoWork)
}
