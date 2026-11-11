// Production projection of app-deployments.ts, app-deploy-job-service.ts,
// app-deploy-runner.ts, and the APP_DEPLOY lane of provisioning-worker.ts.
// One app, two admissions, two insert attempts, three ordinary job attempts.
// The second generation is only a fence for the original generation's job.
// The child-provision handoff is a boundary. Child readiness is abstracted only
// to check the race with the parent app link.
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
    ownerHasAppClaim: bool,
    provisionStarted: bool,
    handoff: bool,
    readyChild: bool,
    currentReadyChild: bool,
    linked: bool,
    quiesced: bool,
    outcome: str,
  }
  var s: State

  action init = s' = {
    generation: 0, phase: "idle", deleted: false, enqueue: "none", inserts: 0,
    job: "none", attempts: 0, claimed: false, ownerHasAppClaim: false,
    provisionStarted: false, handoff: false, readyChild: false, currentReadyChild: false,
    linked: false,
    quiesced: false, outcome: "none",
  }
  val originalPersisted = s.generation == 1
  val originalCurrent = originalPersisted and not(s.deleted)
  val originalHandingOff = originalPersisted and (s.phase == "deploying" or s.phase == "deployed")
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
    s' = s.with("phase", "deploying").with("claimed", true).with("ownerHasAppClaim", true),
  }
  action publishFailure = all {
    s.job == "processing", originalCurrent, s.claimed, s.phase == "deploying",
    not(s.provisionStarted), s.ownerHasAppClaim,
    s' = s.with("phase", "failed"),
  }
  // A process may disappear after the app failure is durable, before job settlement.
  action recover = all {
    s.job == "processing", s.attempts < 2,
    s' = s.with("job", "pending").with("attempts", s.attempts + 1)
      .with("ownerHasAppClaim", false),
  }
  action resolveKnownFailure = all {
    s.job == "processing", originalCurrent, s.phase == "failed",
    s' = s.with("job", "failed").with("attempts", s.attempts + 1)
      .with("quiesced", true).with("outcome", "failed"),
  }
  // A failure before app claim, or exhaustion of lease recovery, can settle via
  // the worker's generation-scoped writeback instead of a runner failure receipt.
  action exhaust = all {
    s.job == "processing", s.attempts == 2, originalCurrent,
    s.phase == "building",
    s' = s.with("job", "failed").with("attempts", 3)
      .with("phase", "failed").with("quiesced", true).with("outcome", "failed"),
  }

  action beginHandoff = all {
    originalPersisted, s.claimed, s.phase == "deploying", not(s.quiesced),
    not(s.provisionStarted),
    s' = s.with("provisionStarted", true),
  }
  // A process already past the handoff boundary may commit after losing its lease.
  action commitHandoff = all {
    originalPersisted, s.phase == "deploying", s.provisionStarted, not(s.handoff),
    s' = s.with("handoff", true),
  }
  // The old parent could complete as soon as it saw the child job, before
  // its metadata link had committed.
  action legacyParentCompletes = all {
    s.job == "processing", originalHandingOff, s.handoff, not(s.linked),
    s' = s.with("job", "completed").with("quiesced", true).with("outcome", "legacyParent"),
  }
  // A live exact child now publishes readiness and its own link atomically.
  // The historical transition represents persisted results from older writers.
  action publishChildReady(currentWriter) = all {
    originalCurrent, s.phase == "deploying", s.handoff,
    s' = s.with("phase", "deployed").with("readyChild", true)
      .with("currentReadyChild", currentWriter).with("linked", s.linked or currentWriter),
  }
  // appsRepository.updateDeploymentGeneration fences the metadata merge.
  action linkHandoff = all {
    s.job == "processing", originalCurrent, originalHandingOff, s.handoff, not(s.linked),
    s' = s.with("linked", true),
  }
  action settleHandoff = all {
    s.job == "processing", originalHandingOff, s.handoff, s.linked or s.deleted,
    s' = s.with("job", "completed").with("quiesced", true).with("outcome", "handedOff"),
  }
  // An absent exact child row cannot certify absence of a late effect. Even
  // an app marked for deletion retains the original generation's uncertainty.
  action settleUnconfirmed = all {
    s.job == "processing", originalPersisted, s.phase == "deploying", not(s.handoff),
    not(s.ownerHasAppClaim) or s.provisionStarted or s.deleted,
    s' = s.with("job", "failed").with("attempts", s.attempts + 1).with("outcome", "unconfirmed"),
  }
  action exhaustDeploying = all {
    s.job == "processing", originalPersisted, s.phase == "deploying", s.attempts == 2,
    s' = s.with("job", "failed").with("attempts", 3).with("outcome", "unconfirmed"),
  }
  // If the child already published readiness, lease exhaustion preserves that
  // state. A missing legacy app link still requires reconciliation.
  action exhaustReady = all {
    s.job == "processing", originalPersisted, s.phase == "deployed", s.attempts == 2,
    s' = s.with("job", "failed").with("attempts", 3)
      .with("quiesced", true).with("outcome", "exhausted"),
  }
  action replaceGeneration = all {
    originalCurrent, s.phase == "failed" or s.phase == "deployed",
    s' = s.with("generation", 2).with("phase", "building"),
  }
  action deleteApp = all {
    not(s.deleted),
    s' = s.with("deleted", true),
  }
  action settleObsolete = all {
    s.job == "processing", not(originalPersisted) or (s.deleted and not(originalHandingOff)),
    s' = s.with("job", "completed").with("quiesced", true).with("outcome", "obsolete"),
  }

  action step = any {
    admit,
    insert(true, true), insert(true, false), insert(false, true), insert(false, false),
    compensate, dispatch, claimGeneration, publishFailure, recover, resolveKnownFailure,
    exhaust, beginHandoff, commitHandoff, legacyParentCompletes,
    publishChildReady(true), publishChildReady(false), linkHandoff, settleHandoff,
    settleUnconfirmed, exhaustDeploying, exhaustReady,
    replaceGeneration, deleteApp,
    settleObsolete, s' = s,
  }

  val bounds = s.generation >= 0 and s.generation <= 2 and s.inserts >= 0 and s.inserts <= 2
    and s.attempts >= 0 and s.attempts <= 3
  val jobHasAdmission = s.job != "none" implies (s.generation > 0 and s.inserts > 0)
  val confirmedHandoffHasClaim = s.outcome == "handedOff" implies (s.claimed and s.handoff)
  val knownFailureNeverCompletes = originalCurrent and s.phase == "failed" implies s.job != "completed"
  val oldJobCannotSetNewPhase = s.generation == 2 implies s.phase == "building"
  val deployingCompletionRequiresHandoff =
    (originalHandingOff and s.job == "completed") implies s.handoff
  val unconfirmedKeepsOriginalFence = s.outcome == "unconfirmed" implies
    (s.job == "failed" and not(s.quiesced) and
      (s.readyChild or (originalPersisted and s.phase == "deploying")))
  val currentHandoffCompletionLinksContainer =
    (originalCurrent and s.outcome == "handedOff") implies s.linked
  val appLinkRequiresHandoff = s.linked implies s.handoff
  val currentChildReadinessLinksContainer = s.currentReadyChild implies s.linked
  val safety = bounds and jobHasAdmission and confirmedHandoffHasClaim
    and knownFailureNeverCompletes and oldJobCannotSetNewPhase
    and deployingCompletionRequiresHandoff and unconfirmedKeepsOriginalFence
    and currentHandoffCompletionLinksContainer and appLinkRequiresHandoff
    and currentChildReadinessLinksContainer

  temporal KnownFailureSettles = (dispatch.weakFair(s) and resolveKnownFailure.weakFair(s)) implies
    always((originalCurrent and s.phase == "failed" and jobOutstanding) implies
      eventually(s.job == "failed" or not(originalCurrent)))
  temporal InterruptedHandoffSettles =
    (dispatch.weakFair(s) and linkHandoff.weakFair(s) and
      settleHandoff.weakFair(s) and settleUnconfirmed.weakFair(s)) implies
      always((originalHandingOff and not(s.ownerHasAppClaim) and jobOutstanding)
        implies eventually(s.job == "completed" or s.job == "failed" or not(originalPersisted)))
  temporal LiveChildLinksTerminalParent =
    (publishChildReady(true).weakFair(s) and always(s.readyChild implies s.currentReadyChild)) implies
      always((originalCurrent and s.outcome == "legacyParent" and not(s.readyChild))
        implies eventually(s.linked or not(originalCurrent)))

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
  run lateChildCannotClearAnUnconfirmedFenceTest = init.then(admit).then(insert(true, true))
    .then(dispatch).then(claimGeneration).then(beginHandoff).then(recover).then(dispatch)
    .then(deleteApp).then(settleUnconfirmed).then(commitHandoff)
    .expect(s.deleted and s.handoff and safety)
  run recoveredHandoffHasDurableChildTest = init.then(admit).then(insert(true, true))
    .then(dispatch).then(claimGeneration).then(beginHandoff).then(commitHandoff).then(recover)
    .then(dispatch).then(linkHandoff).then(settleHandoff)
    .expect(s.job == "completed" and s.quiesced and safety)
  run childReadyBeforeParentLinkTest = init.then(admit).then(insert(true, true))
    .then(dispatch).then(claimGeneration).then(beginHandoff).then(commitHandoff).then(recover)
    .then(publishChildReady(false)).then(dispatch).then(linkHandoff).then(settleHandoff)
    .expect(s.phase == "deployed" and s.linked and safety)
  run liveChildLinksTerminalParentTest = init.then(admit).then(insert(true, true))
    .then(dispatch).then(claimGeneration).then(beginHandoff).then(commitHandoff)
    .then(legacyParentCompletes).then(publishChildReady(true))
    .expect(s.phase == "deployed" and s.linked and s.outcome == "legacyParent" and safety)
  run bothHistoricalJobsTerminalKeepMissingLinkTest = init.then(admit).then(insert(true, true))
    .then(dispatch).then(claimGeneration).then(beginHandoff).then(commitHandoff)
    .then(legacyParentCompletes).then(publishChildReady(false))
    .expect(s.phase == "deployed" and not(s.linked) and s.outcome == "legacyParent" and safety)
  run missingEnqueueResponseKeepsFenceTest = init.then(admit).then(insert(true, true))
    .then(dispatch).then(claimGeneration).then(beginHandoff).then(settleUnconfirmed)
    .expect(s.outcome == "unconfirmed" and safety)
}
