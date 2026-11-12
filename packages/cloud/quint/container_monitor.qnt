// Production projection: HetznerContainersClient.monitorInflight samples a row,
// awaits remote health, then ContainersRepository.update compares status,
// lifecycle_revision, full metadata and exact created_at database text in one SQL write.
// Bounds: one logical container, two row incarnations, one restart, metadata
// placement A->B->A, one bookkeeping update and one newer deployment.
// Target integers abstract full JSONB equality. Placement changes increment the
// canonical revision; bookkeeping changes do not. A distinct original created_at
// value identifies each row incarnation; malicious reuse of that timestamp is excluded.
// Pending probe completion requires a fair response/error continuation. Provider
// health truth, SSH reliability and SQL refinement remain outside this model.
module container_monitor {
  type State = {
    status: str,
    revision: int,
    target: int,
    probePending: bool,
    sampledRevision: int,
    sampledTarget: int,
    terminal: bool,
    deleteJob: bool,
    staleWrite: bool,
    incarnation: int,
    sampledIncarnation: int,
    metadataMoves: int,
    restarted: bool,
    bookkeepingChanged: bool
  }
  var s: State
  action init = s' = {
    status: "deploying", revision: 0, target: 0, probePending: false,
    sampledRevision: 0, sampledTarget: 0, terminal: false, deleteJob: false,
    staleWrite: false, incarnation: 0, sampledIncarnation: 0,
    metadataMoves: 0, restarted: false, bookkeepingChanged: false
  }
  action sample = all {
    s.status == "deploying", not(s.probePending),
    s' = s.with("probePending", true).with("sampledRevision", s.revision)
      .with("sampledTarget", s.target).with("sampledIncarnation", s.incarnation)
  }
  action retire = all {
    not(s.terminal), not(s.deleteJob),
    s' = s.with("status", "deleting").with("deleteJob", true)
      .with("revision", s.revision + 1)
  }
  action delete = all {
    s.deleteJob, s.status == "deleting",
    s' = s.with("status", "deleted").with("terminal", true)
      .with("deleteJob", false).with("revision", s.revision + 1)
  }
  action newerDeployment = all {
    s.status == "deploying", s.revision == 0,
    s' = s.with("revision", 1).with("target", 1)
  }
  // Migration 0558 advances the canonical revision for placement fields.
  action replaceTargetMetadata = all {
    s.status == "deploying", s.metadataMoves == 0,
    s' = s.with("target", 1).with("revision", s.revision + 1).with("metadataMoves", 1)
  }
  action restoreTargetMetadata = all {
    s.status == "deploying", s.metadataMoves == 1,
    s' = s.with("target", 0).with("revision", s.revision + 1).with("metadataMoves", 2)
  }
  action replaceBookkeepingMetadata = all {
    s.status == "deploying", not(s.bookkeepingChanged),
    s' = s.with("target", 2).with("bookkeepingChanged", true)
  }
  action restart = all {
    s.status == "deploying", not(s.restarted),
    s' = s.with("revision", s.revision + 1).with("restarted", true)
  }
  action recreateRow = all {
    s.incarnation == 0,
    s' = s.with("incarnation", 1).with("revision", 0).with("status", "deploying")
      .with("target", 0).with("terminal", false).with("deleteJob", false)
  }
  val sameDeployment = s.status == "deploying"
    and s.revision == s.sampledRevision and s.target == s.sampledTarget
    and s.incarnation == s.sampledIncarnation
  action finishProbe(result) = all {
    s.probePending,
    s' = s.with("probePending", false)
      .with("status", if (sameDeployment) result else s.status)
      .with("revision", if (sameDeployment) s.revision + 1 else s.revision)
  }
  // Starting/unknown provider status and a rejected health request both leave
  // the row unchanged while completing this observation attempt.
  action finishWithoutUpdate = all {
    s.probePending, s' = s.with("probePending", false)
  }
  action finishObservation = any {
    { nondet result = Set("running", "failed").oneOf(); finishProbe(result) },
    finishWithoutUpdate
  }
  action idle = s' = s
  action step = any {
    sample, retire, delete, newerDeployment, replaceTargetMetadata, restoreTargetMetadata,
    replaceBookkeepingMetadata, restart, recreateRow, finishObservation, idle
  }
  val safety = all {
    not(s.staleWrite),
    s.terminal implies s.status == "deleted",
    s.deleteJob implies s.status == "deleting"
  }
  temporal PendingObservationCompletes = finishObservation.weakFair(s) implies
    always(s.probePending implies eventually(not(s.probePending)))

  run currentProbeAppliesTest = init.then(sample).then(finishProbe("running"))
    .expect(s.status == "running" and safety)
  run pendingProviderLeavesDeploymentTest = init.then(sample).then(finishWithoutUpdate)
    .expect(s.status == "deploying" and not(s.probePending) and safety)
  run retirementWinsTest = init.then(sample).then(retire).then(finishProbe("running"))
    .expect(s.status == "deleting" and safety)
  run deletionWinsTest = init.then(sample).then(retire).then(delete).then(finishProbe("running"))
    .expect(s.status == "deleted" and safety)
  run newerDeploymentWinsTest = init.then(sample).then(newerDeployment).then(finishProbe("failed"))
    .expect(s.status == "deploying" and safety)
  run targetMetadataWinsTest = init.then(sample).then(replaceTargetMetadata).then(finishProbe("running"))
    .expect(s.status == "deploying" and safety)

  // Historical guard removal is excluded from step. These witnesses show why
  // status-only and revision-only comparisons are each insufficient.
  action unfencedProbe(result) = all {
    s.probePending,
    s' = s.with("probePending", false).with("status", result)
      .with("staleWrite", not(sameDeployment))
  }
  run deletedResurrectionDetectedTest = init.then(sample).then(retire).then(delete)
    .then(unfencedProbe("running")).expect(not(safety))
  run unchangedStatusStaleWriteDetectedTest = init.then(sample).then(newerDeployment)
    .then(unfencedProbe("failed")).expect(not(safety))
  run unchangedRevisionStaleWriteDetectedTest = init.then(sample).then(replaceBookkeepingMetadata)
    .then(unfencedProbe("running")).expect(not(safety))
  run metadataAbaIsFencedTest = init.then(sample).then(replaceTargetMetadata).then(restoreTargetMetadata)
    .then(finishProbe("running")).expect(s.status == "deploying" and safety)
  run restartIsFencedTest = init.then(sample).then(restart).then(finishProbe("running"))
    .expect(s.status == "deploying" and safety)
  run rowIncarnationIsFencedTest = init.then(sample).then(recreateRow).then(finishProbe("running"))
    .expect(s.status == "deploying" and safety)
  run missingBirthIdentityGuardDetectedTest = init.then(sample).then(recreateRow)
    .then(unfencedProbe("running")).expect(not(safety))
}
