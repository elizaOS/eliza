// Platform command persistence in subscription-billing-operations.ts:
// enqueueCommand, markCommandOutcomeUnknown, resolveCommandOutcome,
// supersedePreparedCommand and applyCheckoutResult. Each action is one committed
// organization -> subscription authority -> command transaction; rollback stutters.
// This is NOT the app worker lease or dedicated cancel/resume dispatch protocol.
module PlatformSubscriptionCommand {
  const Kind: str
  type State = {
    phase: str, revision: int, generation: int, attempts: int, started: bool,
    providerKey: int, requestDigest: int, responseDigest: int, error: int,
    history: Set[int], currentPlan: int, applied: int, result: int,
    acceptedScope: int, staleWrite: bool, unsafeApplication: bool
  }
  var s: State
  pure val scopes = Set(1, 2, 3) // own platform, foreign tenant, app scope
  pure val revisions = Set(0, 1, 2, 3, 4)
  pure val generations = Set(0, 1, 2)
  pure val digests = Set(1, 2)

  action init = s' = {
    phase: "ABSENT", revision: 0, generation: 0, attempts: 0, started: false,
    providerKey: 0, requestDigest: 0, responseDigest: 0, error: 0,
    history: Set(), currentPlan: 1, applied: 0, result: 0,
    acceptedScope: 1, staleWrite: false, unsafeApplication: false
  }

  // One original intent; request bytes, actor and checkout contract comparison
  // collapse to matchesIntent. A different key/command is outside this instance.
  action Enqueue(scope: int, matchesIntent: bool): bool = all {
    scope == 1, matchesIntent,
    s' = if (s.phase == "ABSENT") {
      ...s, phase: "PREPARED", revision: 1, providerKey: 1, requestDigest: 1
    } else s
  }
  action RefuseEnqueue(scope: int, matchesIntent: bool): bool = all {
    scope != 1 or not(matchesIntent), s' = s
  }

  def genericKind = not(Set("cancel", "resume").contains(Kind))
  def dispatchAllowed(scope: int, revision: int, generation: int): bool = all {
    scope == 1, genericKind, s.phase == "PREPARED",
    s.revision == revision, s.generation == generation
  }
  def dispatchReplay(scope: int, revision: int, generation: int): bool = all {
    scope == 1, genericKind, s.phase == "OUTCOME_UNKNOWN",
    s.revision == revision + 1, s.generation == generation + 1
  }
  action Dispatch(scope: int, revision: int, generation: int): bool = all {
    dispatchAllowed(scope, revision, generation),
    s' = {...s, phase: "OUTCOME_UNKNOWN", revision: s.revision + 1,
      generation: s.generation + 1, attempts: s.attempts + 1, started: true,
      acceptedScope: scope,
      staleWrite: s.staleWrite or revision != s.revision or generation != s.generation}
  }
  action ReplayDispatch(scope: int, revision: int, generation: int): bool = all {
    dispatchReplay(scope, revision, generation), s' = s
  }
  action RefuseDispatch(scope: int, revision: int, generation: int): bool = all {
    not(dispatchAllowed(scope, revision, generation)),
    not(dispatchReplay(scope, revision, generation)), s' = s
  }

  def validResolution(outcome: str, digest: int, error: int): bool =
    (outcome == "SUCCEEDED" and digests.contains(digest) and error == 0) or
    (outcome == "FAILED" and digest == 0 and digests.contains(error))
  def resolutionAllowed(scope: int, revision: int, generation: int): bool = all {
    scope == 1, genericKind, s.phase == "OUTCOME_UNKNOWN",
    s.revision == revision, s.generation == generation
  }
  def resolutionReplay(scope: int, revision: int, generation: int,
      outcome: str, digest: int, error: int): bool = all {
    scope == 1, genericKind, s.phase == outcome, s.revision == revision + 1,
    s.generation == generation, s.responseDigest == digest, s.error == error
  }
  action Resolve(scope: int, revision: int, generation: int,
      outcome: str, digest: int, error: int): bool = all {
    validResolution(outcome, digest, error),
    resolutionAllowed(scope, revision, generation),
    s' = {...s, phase: outcome, revision: s.revision + 1,
      responseDigest: digest, error: error, acceptedScope: scope,
      staleWrite: s.staleWrite or revision != s.revision or generation != s.generation}
  }
  action ReplayResolution(scope: int, revision: int, generation: int,
      outcome: str, digest: int, error: int): bool = all {
    validResolution(outcome, digest, error),
    resolutionReplay(scope, revision, generation, outcome, digest, error), s' = s
  }
  action RefuseResolution(scope: int, revision: int, generation: int,
      outcome: str, digest: int, error: int): bool = all {
    not(validResolution(outcome, digest, error)) or all {
      not(resolutionAllowed(scope, revision, generation)),
      not(resolutionReplay(scope, revision, generation, outcome, digest, error))
    }, s' = s
  }

  action Supersede(scope: int, revision: int, error: int): bool = all {
    scope == 1, s.phase == "PREPARED", s.revision == revision,
    s' = {...s, phase: "SUPERSEDED", revision: s.revision + 1, error: error,
      acceptedScope: scope, staleWrite: s.staleWrite or revision != s.revision}
  }
  action ReplaySupersede(scope: int, revision: int, error: int): bool = all {
    scope == 1, s.phase == "SUPERSEDED", s.revision == revision + 1, s.error == error,
    s' = s
  }
  action RefuseSupersede(scope: int, revision: int, error: int): bool = all {
    not(scope == 1 and s.phase == "PREPARED" and s.revision == revision),
    not(scope == 1 and s.phase == "SUPERSEDED" and s.revision == revision + 1 and s.error == error),
    s' = s
  }

  // Retained history codes: 1/2 are matching own checkout plan/subscription
  // with response digest 1/2. Code 3 stands for another tenant, source or plan.
  // These append-only facts can arrive before or after command resolution.
  action RetainRevision(code: int): bool = s' = {...s, history: s.history.union(Set(code))}
  action ChangeCurrentPlan = s' = {...s, currentPlan: 2}
  def applyAllowed(scope: int, revision: int, result: int): bool = all {
    scope == 1, Kind == "checkout", s.phase == "SUCCEEDED",
    s.revision == revision, result == 1, s.history.contains(s.responseDigest)
  }
  def applyReplay(scope: int, revision: int, result: int): bool = all {
    scope == 1, Kind == "checkout", s.phase == "APPLIED",
    s.revision == revision + 1, result == s.result
  }
  action Apply(scope: int, revision: int, result: int): bool = all {
    applyAllowed(scope, revision, result),
    s' = {...s, phase: "APPLIED", revision: s.revision + 1,
      result: result, applied: s.applied + 1, acceptedScope: scope,
      unsafeApplication: s.unsafeApplication or not(s.history.contains(s.responseDigest)),
      staleWrite: s.staleWrite or revision != s.revision}
  }
  action ReplayApply(scope: int, revision: int, result: int): bool = all {
    applyReplay(scope, revision, result), s' = s
  }
  action RefuseApply(scope: int, revision: int, result: int): bool = all {
    not(applyAllowed(scope, revision, result)), not(applyReplay(scope, revision, result)), s' = s
  }
  action Idle = s' = s
  action step = {
    nondet scope = scopes.oneOf()
    nondet revision = revisions.oneOf()
    nondet generation = generations.oneOf()
    nondet digest = digests.oneOf()
    nondet matchesIntent = Set(false, true).oneOf()
    nondet outcome = Set("SUCCEEDED", "FAILED").oneOf()
    val response = if (outcome == "SUCCEEDED") digest else 0
    val error = if (outcome == "FAILED") digest else 0
    any {
      Enqueue(scope, matchesIntent), RefuseEnqueue(scope, matchesIntent),
      Dispatch(scope, revision, generation), ReplayDispatch(scope, revision, generation),
      RefuseDispatch(scope, revision, generation),
      Resolve(scope, revision, generation, outcome, response, error),
      ReplayResolution(scope, revision, generation, outcome, response, error),
      RefuseResolution(scope, revision, generation, outcome, response, error),
      Supersede(scope, revision, digest), ReplaySupersede(scope, revision, digest),
      RefuseSupersede(scope, revision, digest),
      RetainRevision(digest), RetainRevision(3), ChangeCurrentPlan,
      Apply(scope, revision, digest), ReplayApply(scope, revision, digest),
      RefuseApply(scope, revision, digest), Idle
    }
  }

  val ExactAuthority = s.acceptedScope == 1 and not(s.staleWrite)
  val ImmutableIntent = s.phase == "ABSENT" or (s.providerKey == 1 and s.requestDigest == 1)
  val OneDispatchFence = s.attempts <= 1 and s.generation == s.attempts
  val SafeSupersession = s.phase != "SUPERSEDED" or (not(s.started) and s.generation == 0)
  val OriginalCheckoutOnly = not(s.unsafeApplication) and s.applied <= 1 and
    (s.phase != "APPLIED" or (Kind == "checkout" and s.result == 1 and
      s.history.contains(s.responseDigest) and s.responseDigest > 0))
  val OutcomeShape = all {
    s.phase != "PREPARED" or (s.revision == 1 and not(s.started)),
    s.phase != "OUTCOME_UNKNOWN" or (s.revision == 2 and s.started and s.responseDigest == 0),
    s.phase != "SUCCEEDED" or (s.revision == 3 and s.started and s.responseDigest > 0 and s.error == 0),
    s.phase != "FAILED" or (s.revision == 3 and s.started and s.responseDigest == 0 and s.error > 0),
    s.phase != "SUPERSEDED" or (s.revision == 2 and s.error > 0),
    s.phase != "APPLIED" or (s.revision == 4 and s.started and s.applied == 1)
  }
  val safety = ExactAuthority and ImmutableIntent and OneDispatchFence and
    SafeSupersession and OriginalCheckoutOnly and OutcomeShape
  val Ready = Kind == "checkout" and s.phase == "SUCCEEDED" and s.history.contains(s.responseDigest)
  // This assumes only fair local Apply after a proven result. No provider
  // response, verification, request initiation or unconditional recovery promise.
  temporal VerifiedCheckoutApplies = Apply(1, 3, 1).weakFair(s) implies
    always(Ready implies eventually(s.phase == "APPLIED"))
  temporal StartedCommandsTerminate = always(s.started implies
    eventually(Set("APPLIED", "FAILED", "SUPERSEDED").contains(s.phase)))

  // Excluded mutants show the invariants reject weakened runtime guards.
  action UnsafeResolveGeneration(expectedGeneration: int): bool = all {
    s.phase == "OUTCOME_UNKNOWN",
    s' = {...s, phase: "SUCCEEDED", revision: 3, responseDigest: 1, error: 0,
      staleWrite: s.staleWrite or expectedGeneration != s.generation}
  }
  action UnsafeSupersedeStarted = s' = {...s, phase: "SUPERSEDED", revision: s.revision + 1, error: 1}
  action UnsafeApplyWithoutHistory = s' = {...s, phase: "APPLIED", revision: 4,
    applied: s.applied + 1, result: 1, unsafeApplication: not(s.history.contains(s.responseDigest))}
  action UnsafeRewriteIntent = s' = {...s, providerKey: 2}
}

module PlatformSubscriptionCommand_checkout {
  import PlatformSubscriptionCommand(Kind = "checkout").*
  run exactRetryKeepsOriginalFenceTest = init.then(Enqueue(1, true)).then(Dispatch(1, 1, 0))
    .then(ReplayDispatch(1, 1, 0)).then(RefuseDispatch(1, 2, 1))
    .expect(safety and s.attempts == 1 and s.revision == 2)
  run historicalCheckoutSurvivesNewCurrentPlanTest = init.then(Enqueue(1, true))
    .then(Dispatch(1, 1, 0)).then(Resolve(1, 2, 1, "SUCCEEDED", 2, 0))
    .then(RetainRevision(3)).then(RefuseApply(1, 3, 1))
    .then(RetainRevision(2)).then(ChangeCurrentPlan).then(Apply(1, 3, 1))
    .then(ReplayApply(1, 3, 1)).then(RefuseApply(1, 3, 2))
    .expect(safety and s.applied == 1 and s.currentPlan == 2)
  run staleAndForeignWritesRefusedTest = init.then(Enqueue(1, true))
    .then(RefuseEnqueue(1, false)).then(RefuseDispatch(2, 1, 0)).then(RefuseDispatch(3, 1, 0))
    .then(Dispatch(1, 1, 0)).then(RefuseResolution(1, 2, 0, "SUCCEEDED", 1, 0))
    .then(RefuseResolution(1, 1, 1, "SUCCEEDED", 1, 0))
    .then(Resolve(1, 2, 1, "SUCCEEDED", 1, 0))
    .then(ReplayResolution(1, 2, 1, "SUCCEEDED", 1, 0))
    .then(RefuseResolution(1, 2, 1, "SUCCEEDED", 2, 0)).expect(safety and s.responseDigest == 1)
  run failureHasExactReplayTest = init.then(Enqueue(1, true)).then(Dispatch(1, 1, 0))
    .then(Resolve(1, 2, 1, "FAILED", 0, 1)).then(ReplayResolution(1, 2, 1, "FAILED", 0, 1))
    .then(RefuseResolution(1, 2, 1, "FAILED", 0, 2)).then(RefuseApply(1, 3, 1))
    .expect(safety and s.phase == "FAILED")
  run onlyUnstartedCommandsSupersedeTest = init.then(Enqueue(1, true)).then(Supersede(1, 1, 1))
    .then(ReplaySupersede(1, 1, 1)).then(RefuseSupersede(1, 1, 2))
    .then(RefuseDispatch(1, 1, 0)).expect(safety and not(s.started))
  run generationGuardNegativeWitnessTest = init.then(Enqueue(1, true)).then(Dispatch(1, 1, 0))
    .then(UnsafeResolveGeneration(0)).expect(not(safety))
  run supersedeGuardNegativeWitnessTest = init.then(Enqueue(1, true)).then(Dispatch(1, 1, 0))
    .then(UnsafeSupersedeStarted).expect(not(safety))
  run historyGuardNegativeWitnessTest = init.then(Enqueue(1, true)).then(Dispatch(1, 1, 0))
    .then(Resolve(1, 2, 1, "SUCCEEDED", 1, 0)).then(UnsafeApplyWithoutHistory).expect(not(safety))
  run intentGuardNegativeWitnessTest = init.then(Enqueue(1, true)).then(UnsafeRewriteIntent).expect(not(safety))
}
module PlatformSubscriptionCommand_upgrade { import PlatformSubscriptionCommand(Kind = "upgrade").* }
module PlatformSubscriptionCommand_cancel {
  import PlatformSubscriptionCommand(Kind = "cancel").*
  run dedicatedDispatcherRequiredTest = init.then(Enqueue(1, true))
    .then(RefuseDispatch(1, 1, 0)).then(RefuseResolution(1, 1, 0, "SUCCEEDED", 1, 0))
    .then(Supersede(1, 1, 1)).expect(safety and not(s.started))
}
module PlatformSubscriptionCommand_resume { import PlatformSubscriptionCommand(Kind = "resume").* }
