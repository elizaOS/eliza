// UpdateJournal.java and its 37-state/313-event portable conformance table.
// The serialized journal is one atomic transition. Plan identities, install
// readback, durable reports, release budgets and generation fences are retained.
// Timing is the existing reference abstraction: below threshold, timeout, or
// clock regression. Revision, channel names, byte durability and probation
// sampling are outside this projection and remain covered by JVM tests.
module UpdateJournal {
  type Journal = {
    phase: str,
    reason: str,
    plan: int,
    base: int,
    session: int,
    attempts: int,
    gen: int,
    q: Set[int],
    reported: str,
    released: int,
    releases: int
  }
  type Event = {
    kind: str,
    plan: int,
    base: int,
    installed: int,
    generation: int,
    session: int,
    pending: bool,
    blocked: str,
    outcome: str,
    failure: str
  }
  pure val budget = 3
  pure val plans = Set(1, 2)
  pure val identities = Set(1, 2, 3, 4, 5, 9)
  pure val sessions = Set(1, 2, 5, 6, 7)
  pure val maxGeneration = 2
  pure val active = Set(
    "STAGING", "VERIFIED", "COMMITTING", "PROBATION", "RECOVERY_READY",
    "RECOVERING", "RECOVERY_PROBATION", "SUPPORT"
  )
  pure val awaitingReasons = Set(
    "user_action_required", "policy_blocked", "install_timeout",
    "install_clock_invalid", "install_outcome_unknown"
  )
  pure val empty: Journal = {
    phase: "IDLE", reason: "", plan: 0, base: 0, session: 0,
    attempts: 0, gen: 0, q: Set(), reported: "none", released: 0, releases: 0
  }
  pure val refused = {...empty, phase: "REFUSED"}
  pure def candidate(plan: int): int = 2 * plan
  pure def recovery(plan: int): int = 2 * plan + 1
  pure def awaiting(j: Journal): bool =
    Set("COMMITTING", "RECOVERING").contains(j.phase)
      or (j.phase == "SUPPORT" and awaitingReasons.contains(j.reason))
  pure def event(kind: str): Event = {
    kind: kind, plan: 0, base: 0, installed: 0, generation: 0,
    session: 0, pending: false, blocked: "none", outcome: "", failure: "none"
  }
  pure def cleared(j: Journal, phase: str, reason: str): Journal = {
    ...j, phase: phase, reason: reason, plan: 0, base: 0, session: 0,
    reported: "none"
  }
  pure def stronger(first: str, second: str): str =
    if (first == "CANDIDATE_REJECTED" or second == "CANDIDATE_REJECTED")
      "CANDIDATE_REJECTED"
    else if (first != "none") first
    else second

  pure def release(j: Journal): Journal = {
    val identity = candidate(j.plan)
    val count = if (j.released == identity) j.releases + 1 else 1
    val updated = if (count >= budget) j else cleared(j, "IDLE", "install_not_completed")
    val recorded = {...updated, released: identity, releases: count, reported: "none"}
    if (count >= budget) {
      ...recorded,
      phase: "QUARANTINED",
      q: j.q.union(Set(identity)),
      reason: "install_retry_budget_spent"
    } else recorded
  }

  pure def admit(j: Journal, e: Event, target: str): Journal = {
    val resume = target == "VERIFIED" and j.phase == "STAGING"
      and j.plan == e.plan and j.base == e.base
    if (e.base >= candidate(e.plan)
      or (active.contains(j.phase) and not(resume))
      or j.gen != e.generation
      or e.base != e.installed
      or j.q.contains(candidate(e.plan))
      or j.q.contains(recovery(e.plan))) refused
    else {
      ...j,
      phase: target,
      plan: e.plan,
      base: e.base,
      session: 0,
      attempts: 0,
      reason: "",
      reported: "none"
    }
  }

  pure def reconcile(j: Journal, e: Event): Journal = {
    val matching = awaiting(j) and j.plan != 0
      and j.plan == e.plan and j.session == e.session
    val wasBlocked = j.phase == "SUPPORT"
    val recovering = j.phase == "RECOVERING" or (wasBlocked and j.attempts == 1)
    val expected = if (recovering) recovery(j.plan) else candidate(j.plan)
    val previous = if (recovering) candidate(j.plan) else j.base
    val evidence = stronger(j.reported, e.failure)
    if (not(matching)) j
    else if (e.installed == expected) {
      ...j,
      phase: if (recovering) "RECOVERY_PROBATION" else "PROBATION",
      reason: "",
      reported: "none",
      released: if (recovering) j.released else 0,
      releases: if (recovering) j.releases else 0
    }
    else if (e.installed != previous) {
      ...j, phase: "SUPPORT", reason: "unexpected_installed_identity"
    }
    else if (e.blocked != "none") {...j, phase: "SUPPORT", reason: e.blocked}
    else if (e.pending) {
      ...j, reported: if (recovering) j.reported else evidence
    }
    else if (recovering) {
      if (wasBlocked) j
      else {
        ...j,
        phase: "SUPPORT",
        q: j.q.union(Set(candidate(j.plan))),
        reason: "recovery_install_failed"
      }
    }
    else if (evidence == "CANDIDATE_REJECTED") {
      ...j,
      phase: "QUARANTINED",
      q: j.q.union(Set(candidate(j.plan))),
      reason: "candidate_install_failed",
      reported: "none"
    }
    else if (evidence == "RETRYABLE") release(j)
    else if (wasBlocked and j.reason == "install_outcome_unknown") j
    else {...j, phase: "SUPPORT", reason: "install_outcome_unknown"}
  }

  pure def health(j: Journal, e: Event): Journal = {
    val recovering = j.phase == "RECOVERY_PROBATION"
    val expected = if (recovering) recovery(j.plan) else candidate(j.plan)
    val allowed = if (e.kind == "healthy")
      Set("PROBATION", "RECOVERY_PROBATION").contains(j.phase)
      else Set("PROBATION", "HEALTHY", "RECOVERY_PROBATION").contains(j.phase)
    if (not(allowed) or j.plan == 0 or e.installed != expected) refused
    else if (e.kind == "healthy") {
      ...j, phase: if (recovering) "RECOVERED" else "HEALTHY", reason: ""
    }
    else {
      ...j,
      phase: if (j.attempts == 0) "RECOVERY_READY" else "SUPPORT",
      reason: "local_health_failed",
      q: j.q.union(if (recovering)
        Set(candidate(j.plan), recovery(j.plan)) else Set(candidate(j.plan)))
    }
  }

  // Refused operations represent typed Java exceptions and leave persistent
  // state unchanged. The conformance hook retains the refusal as an observation.
  pure def stepJournal(j: Journal, e: Event): Journal = {
    val matching = j.plan != 0 and j.plan == e.plan
    if (e.kind == "setChannel") {
      val updated = {...j, gen: j.gen + 1}
      if (Set("VERIFIED", "STAGING").contains(j.phase))
        cleared(updated, "IDLE", "channel_changed")
      else updated
    }
    else if (e.kind == "stage") admit(j, e, "STAGING")
    else if (e.kind == "begin") admit(j, e, "VERIFIED")
    else if (e.kind == "discard") {
      if (matching and j.phase == "STAGING" and j.gen == e.generation)
        cleared(j, "IDLE", "staging_invalidated")
      else refused
    }
    else if (e.kind == "committing") {
      if (matching and j.phase == "VERIFIED" and j.gen == e.generation)
        {...j, session: e.session, phase: "COMMITTING"}
      else refused
    }
    else if (e.kind == "staleCommit") refused
    else if (e.kind == "discardVerified") {
      if (matching and j.phase == "VERIFIED" and j.gen == e.generation)
        cleared(j, "IDLE", "verified_invalidated:revoked-artifact")
      else refused
    }
    else if (e.kind == "recoveryUnavailable") {
      if (matching and j.phase == "RECOVERY_READY" and j.attempts == 0) {
        ...j,
        q: j.q.union(Set(candidate(j.plan), recovery(j.plan))),
        phase: "QUARANTINED",
        reason: "recovery_unavailable:revoked-artifact"
      } else refused
    }
    else if (e.kind == "recovering") {
      if (matching and j.phase == "RECOVERY_READY" and j.attempts == 0)
        {...j, session: e.session, attempts: j.attempts + 1, phase: "RECOVERING"}
      else refused
    }
    else if (e.kind == "reconcile") reconcile(j, e)
    else if (e.kind == "observe") {
      if (Set("COMMITTING", "RECOVERING").contains(j.phase)
        and matching and j.session == e.session and e.outcome != "below") {
        ...j,
        phase: "SUPPORT",
        reason: if (e.outcome == "timeout") "install_timeout" else "install_clock_invalid"
      } else j
    }
    else if (e.kind == "observeUnknown") {
      if (j.phase == "SUPPORT" and j.reason == "install_outcome_unknown"
        and matching and j.session == e.session and e.outcome == "timeout")
        release(j)
      else j
    }
    else health(j, e)
  }

  var s: Journal
  action init = s' = empty
  action applyEvent(e: Event): bool = {
    val updated = stepJournal(s, e)
    s' = if (updated.phase == "REFUSED") s else updated
  }
  action changeChannel = all {
    s.gen < maxGeneration,
    applyEvent(event("setChannel"))
  }
  action prepare = {
    nondet kind = Set("stage", "begin").oneOf()
    nondet plan = plans.oneOf()
    nondet baseline = Set(1, 2).oneOf()
    nondet installed = identities.oneOf()
    applyEvent({
      ...event(kind), plan: plan, base: baseline,
      installed: installed, generation: s.gen
    })
  }
  action changePlan = {
    nondet kind = Set("discard", "committing", "staleCommit", "discardVerified").oneOf()
    nondet session = sessions.oneOf()
    applyEvent({...event(kind), plan: s.plan, generation: s.gen, session: session})
  }
  action recover = {
    nondet kind = Set("recovering", "recoveryUnavailable").oneOf()
    nondet session = sessions.oneOf()
    applyEvent({...event(kind), plan: s.plan, session: session})
  }
  action readback = {
    nondet installed = identities.oneOf()
    nondet pending = Set(false, true).oneOf()
    nondet blocked = Set("none", "policy_blocked", "user_action_required").oneOf()
    nondet failure = Set("none", "CANDIDATE_REJECTED", "RETRYABLE").oneOf()
    applyEvent({
      ...event("reconcile"), plan: s.plan, session: s.session,
      installed: installed, pending: pending, blocked: blocked, failure: failure
    })
  }
  action observe = {
    nondet kind = Set("observe", "observeUnknown").oneOf()
    nondet outcome = Set("below", "timeout", "regress").oneOf()
    applyEvent({...event(kind), plan: s.plan, session: s.session, outcome: outcome})
  }
  action observeHealth = {
    nondet kind = Set("healthy", "healthFailed").oneOf()
    nondet installed = identities.oneOf()
    applyEvent({...event(kind), installed: installed})
  }
  // Invalid plan/session/generation events are self loops in stepJournal.
  // The explicit stutter represents those calls; the conformance hook checks
  // their exact refusal results as well as every successful table transition.
  action step = any {
    changeChannel, prepare, changePlan, recover, readback, observe, observeHealth,
    s' = s
  }

  val TypeInvariant = all {
    active.union(Set("IDLE", "HEALTHY", "RECOVERED", "QUARANTINED")).contains(s.phase),
    plans.union(Set(0)).contains(s.plan),
    Set(0, 1, 2).contains(s.base),
    sessions.union(Set(0)).contains(s.session),
    Set(0, 1).contains(s.attempts),
    s.gen >= 0,
    s.gen <= maxGeneration,
    s.q.subseteq(Set(2, 3, 4, 5)),
    Set("none", "RETRYABLE", "CANDIDATE_REJECTED").contains(s.reported),
    Set(0, 2, 4).contains(s.released),
    s.releases >= 0,
    s.releases <= budget
  }
  val ActivePlan = active.contains(s.phase) implies s.plan != 0
  val ReleasedCandidate = (s.releases == 0) == (s.released == 0)
  val RetryBudget = s.releases >= budget implies s.q.contains(s.released)
  val RecoveryOwnership = Set("RECOVERING", "RECOVERY_PROBATION", "RECOVERED").contains(s.phase)
    implies s.attempts == 1
  val QuarantineAuthority = s.phase == "QUARANTINED" implies s.q.contains(candidate(s.plan))
  temporal QuarantineMonotone = always(s.q.subseteq(next(s.q)).orKeep(s))
  temporal GenerationMonotone = always((next(s.gen) >= s.gen).orKeep(s))
  temporal RejectionDurable = always((
    s.reported == "CANDIDATE_REJECTED"
      and Set("COMMITTING", "SUPPORT").contains(next(s.phase))
      implies next(s.reported) == "CANDIDATE_REJECTED"
  ).orKeep(s))

  run candidateReportPersistsTest = init
    .then(applyEvent({...event("begin"), plan: 1, base: 1, installed: 1}))
    .then(applyEvent({...event("committing"), plan: 1, session: 1}))
    .then(applyEvent({...event("reconcile"), plan: 1, session: 1, installed: 1,
      pending: true, failure: "CANDIDATE_REJECTED"}))
    .then(applyEvent({...event("reconcile"), plan: 1, session: 1, installed: 1,
      pending: true}))
    .expect(s.reported == "CANDIDATE_REJECTED" and s.phase == "COMMITTING")
  run unreportedExitWaitsTest = init
    .then(applyEvent({...event("begin"), plan: 1, base: 1, installed: 1}))
    .then(applyEvent({...event("committing"), plan: 1, session: 1}))
    .then(applyEvent({...event("reconcile"), plan: 1, session: 1, installed: 1}))
    .then(applyEvent({...event("observeUnknown"), plan: 1, session: 1, outcome: "regress"}))
    .expect(s.reason == "install_outcome_unknown" and s.releases == 0)
}
