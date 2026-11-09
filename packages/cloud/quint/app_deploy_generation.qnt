// Production projection of app-deployments.ts, app-deploy-job-service.ts,
// app-deploy-runner.ts, and the APP_DEPLOY lane of provisioning-worker.ts.
// One app, two admissions, two insert attempts, three ordinary job attempts.
// The second generation is only a fence for the original generation's job.
// The child-provision handoff is a boundary. Its external effects are not modeled.
module app_deploy_generation {
  type State = {
    generation: int,
    phase: str,
    deleted: bool,
    enqueue: str,
    inserts: int,
    job: str,
    attempts: int,
    claimed: bool,
    handoff: bool,
    outcome: str,
  }
  var s: State

  action init = s' = {
    generation: 0, phase: "idle", deleted: false, enqueue: "none", inserts: 0,
    job: "none", attempts: 0, claimed: false, handoff: false, outcome: "none",
  }
  val originalCurrent = s.generation == 1 and not(s.deleted)
  val jobOutstanding = s.job == "pending" or s.job == "processing"

  // appsRepository.claimDeploymentStart is a primary compare-and-set.
  action admit = all {
    s.generation == 0, not(s.deleted),
    s' = s.with("generation", 1).with("phase", "building").with("enqueue", "inserting"),
  }

  // The first insert and replay both target the immutable generation UUID.
  // Only the first commit can create the job; loss of the response does not undo it.
  action insert(commits, acknowledged) = all {
    s.enqueue == "inserting", s.inserts < 2,
    not(acknowledged) or commits or s.job != "none",
    s' = s.with("inserts", s.inserts + 1)
      .with("enqueue", if (acknowledged) "acknowledged"
        else if (s.inserts == 1) "unknown" else "inserting")
      .with("job", if (commits and s.job == "none") "pending" else s.job),
  }

  // Only the original building generation may be compensated after two unknown writes.
  action compensate = all {
    s.enqueue == "unknown",
    s' = s.with("enqueue", "compensated")
      .with("phase", if (originalCurrent and s.phase == "building") "failed" else s.phase),
  }

  action dispatch = all {
    s.job == "pending",
    s' = s.with("job", "processing"),
  }
  action claimGeneration = all {
    s.job == "processing", originalCurrent, s.phase == "building", not(s.claimed),
    s' = s.with("phase", "deploying").with("claimed", true),
  }
  action publishFailure = all {
    s.job == "processing", originalCurrent, s.claimed, s.phase == "deploying", not(s.handoff),
    s' = s.with("phase", "failed"),
  }
  // A process may disappear after the app failure is durable, before job settlement.
  action recover = all {
    s.job == "processing", s.attempts < 2,
    s' = s.with("job", "pending").with("attempts", s.attempts + 1),
  }
  action resolveKnownFailure = all {
    s.job == "processing", originalCurrent, s.phase == "failed",
    s' = s.with("job", "failed").with("attempts", s.attempts + 1).with("outcome", "failed"),
  }
  // A failure before app claim, or exhaustion of lease recovery, can settle via
  // the worker's generation-scoped writeback instead of a runner failure receipt.
  action exhaust = all {
    s.job == "processing", s.attempts == 2, originalCurrent,
    s.phase == "building" or s.phase == "deploying",
    s' = s.with("job", "failed").with("attempts", 3)
      .with("phase", "failed").with("outcome", "failed"),
  }

  action commitHandoff = all {
    s.job == "processing", originalCurrent, s.claimed, s.phase == "deploying", not(s.handoff),
    s' = s.with("handoff", true),
  }
  action settleHandoff = all {
    s.job == "processing", originalCurrent, s.phase == "deploying", s.handoff,
    s' = s.with("job", "completed").with("outcome", "handedOff"),
  }
  // A recovered deploying generation with no known handoff still uses the
  // current production no-op. The ghost outcome makes that gap explicit.
  action settleUnconfirmed = all {
    s.job == "processing", originalCurrent, s.phase == "deploying", not(s.handoff),
    s.attempts > 0,
    s' = s.with("job", "completed").with("outcome", "unconfirmed"),
  }
  action replaceGeneration = all {
    originalCurrent, s.phase == "failed",
    s' = s.with("generation", 2).with("phase", "building"),
  }
  action deleteApp = all {
    not(s.deleted),
    s' = s.with("deleted", true),
  }
  action settleObsolete = all {
    s.job == "processing", not(originalCurrent),
    s' = s.with("job", "completed").with("outcome", "obsolete"),
  }

  action step = any {
    admit,
    insert(true, true), insert(true, false), insert(false, true), insert(false, false),
    compensate, dispatch, claimGeneration, publishFailure, recover, resolveKnownFailure,
    exhaust, commitHandoff, settleHandoff, settleUnconfirmed, replaceGeneration, deleteApp,
    settleObsolete, s' = s,
  }

  val bounds = s.generation >= 0 and s.generation <= 2 and s.inserts >= 0 and s.inserts <= 2
    and s.attempts >= 0 and s.attempts <= 3
  val jobHasAdmission = s.job != "none" implies (s.generation > 0 and s.inserts > 0)
  val confirmedHandoffHasClaim = s.outcome == "handedOff" implies (s.claimed and s.handoff)
  val knownFailureNeverCompletes = originalCurrent and s.phase == "failed" implies s.job != "completed"
  val oldJobCannotSetNewPhase = s.generation == 2 implies s.phase == "building"
  val safety = bounds and jobHasAdmission and confirmedHandoffHasClaim
    and knownFailureNeverCompletes and oldJobCannotSetNewPhase

  temporal KnownFailureSettles = (dispatch.weakFair(s) and resolveKnownFailure.weakFair(s)) implies
    always((originalCurrent and s.phase == "failed" and jobOutstanding) implies
      eventually(s.job == "failed" or not(originalCurrent)))

  run lostEnqueueResponseKeepsOneJobTest = init.then(admit).then(insert(true, false))
    .then(insert(false, true)).expect(s.inserts == 2 and s.job == "pending" and safety)
  run failedGenerationResolvesTest = init.then(admit).then(insert(true, true)).then(dispatch)
    .then(claimGeneration).then(publishFailure).then(recover).then(dispatch)
    .then(resolveKnownFailure).expect(s.job == "failed" and safety)
  run currentClaimSurvivesLostEnqueueResponsesTest = init.then(admit).then(insert(true, false))
    .then(dispatch).then(claimGeneration).then(insert(false, false)).then(compensate)
    .expect(s.phase == "deploying" and safety)
  run olderJobCannotChangeNewGenerationTest = init.then(admit).then(insert(true, true))
    .then(dispatch).then(claimGeneration).then(publishFailure).then(replaceGeneration)
    .then(settleObsolete).expect(s.phase == "building" and s.outcome == "obsolete" and safety)
  run interruptedHandoffIsUnconfirmedTest = init.then(admit).then(insert(true, true))
    .then(dispatch).then(claimGeneration).then(recover).then(dispatch).then(settleUnconfirmed)
    .expect(s.outcome == "unconfirmed" and not(s.handoff) and safety)
}
