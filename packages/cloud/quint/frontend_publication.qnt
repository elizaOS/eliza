// One immutable deployment, its complete object set and an existing live deployment.
// SQL mutations are atomic; an exception can arrive before the SQL outcome is known.
module frontend_publication {
  type State = { row: str, objects: bool, upload: str, finalize: str,
    client: str, retire: str, cleanupPermit: bool, deletePermit: bool,
    otherActive: bool, wasPublished: bool }
  var s: State
  pure val published = Set("ready", "active", "superseded")
  action init = s' = { row: "pending", objects: false, upload: "idle",
    finalize: "idle", client: "working", retire: "idle", cleanupPermit: false,
    deletePermit: false, otherActive: true, wasPublished: false }
  action beginUpload(organizationMatches) = all { s.row == "pending", s.upload == "idle",
    s' = if (organizationMatches) { ...s, row: "uploading", upload: "pending" } else s }
  action finishPut(fails, accepted) = all { s.upload == "pending",
    s' = { ...s, objects: accepted, upload: "done",
      client: if (fails) "failed" else s.client } }
  action startFinalize = all { s.upload == "done", s.objects,
    s.client == "working", s.finalize == "idle",
    s' = { ...s, finalize: "pending" } }
  // A connection failure need not cancel a query still waiting for its row lock.
  action loseFinalizeReply = all { Set("pending", "committed", "rejected").contains(s.finalize), s.client == "working",
    s' = { ...s, client: "failed" } }
  action finishFinalize(commits) = all { s.finalize == "pending",
    val applies = commits and s.row == "uploading"
    s' = { ...s, row: if (applies) "ready" else s.row,
      finalize: if (applies) "committed" else "rejected",
      wasPublished: s.wasPublished or applies } }
  action receiveFinalize = all { s.client == "working",
    Set("committed", "rejected").contains(s.finalize),
    s' = { ...s, client: if (s.finalize == "committed") "success" else "failed" } }
  action startRetire = all { s.client == "failed", s.retire == "idle",
    s' = { ...s, retire: "pending" } }
  // mode 0 rejects before commit; 1 acknowledges commit; 2 loses the commit reply.
  action finishRetire(mode) = all { s.retire == "pending",
    val applies = mode != 0 and Set("pending", "uploading").contains(s.row)
    s' = { ...s, row: if (applies) "failed" else s.row, retire: "done",
      cleanupPermit: applies and mode == 1 } }
  action cleanup = all { s.cleanupPermit,
    s' = { ...s, objects: false, cleanupPermit: false } }
  // The locked parent must match the caller's authorized organization.
  action activate(organizationMatches) = all { published.contains(s.row),
    s' = if (organizationMatches) { ...s, row: "active", otherActive: false } else s }
  action activatePrevious = all { s.row == "active",
    s' = { ...s, row: "superseded", otherActive: true } }
  action deleteInactive(replyLost) = all {
    s.row != "active", s.row != "deleted",
    s' = { ...s, row: "deleted", deletePermit: not(replyLost) } }
  action deleteArtifacts = all { s.deletePermit,
    s' = { ...s, objects: false, deletePermit: false } }
  action finish = {
    nondet mode = 0.to(2).oneOf()
    any { finishPut(false, true), finishPut(true, true), finishPut(true, false),
      finishFinalize(true), finishFinalize(false), receiveFinalize,
      finishRetire(mode), cleanup, deleteArtifacts }
  }
  action step = any { beginUpload(true), beginUpload(false), startFinalize, loseFinalizeReply, startRetire,
    finish, activate(true), activate(false), activatePrevious, deleteInactive(false), deleteInactive(true), s' = s }
  val safety = all {
    published.contains(s.row) implies s.objects,
    s.wasPublished implies (published.contains(s.row) or s.row == "deleted"),
    s.cleanupPermit implies Set("failed", "deleted").contains(s.row),
    s.deletePermit implies s.row == "deleted",
    s.row == "active" implies not(s.otherActive),
    s.row != "active" implies s.otherActive,
  }
  // Each outstanding storage operation can settle under fair continuation scheduling.
  temporal StorageOperationsSettle = finish.weakFair(s) implies
    always((s.upload == "pending" or s.finalize == "pending" or s.retire == "pending"
      or s.cleanupPermit or s.deletePermit) implies eventually(
        s.upload != "pending" and s.finalize != "pending" and s.retire != "pending"
          and not(s.cleanupPermit) and not(s.deletePermit)))

  run foreignOrganizationCannotBeginUploadTest = init.then(beginUpload(false))
    .expect(safety and s.row == "pending" and s.upload == "idle" and not(s.objects) and s.otherActive)
  run successfulPublicationTest = init.then(beginUpload(true)).then(finishPut(false, true))
    .then(startFinalize).then(finishFinalize(true)).then(receiveFinalize)
    .then(activate(true)).expect(safety and s.row == "active")
  run foreignOrganizationKeepsLiveDeploymentTest = init.then(beginUpload(true))
    .then(finishPut(false, true)).then(startFinalize).then(finishFinalize(true))
    .then(activate(false)).expect(safety and s.row == "ready" and s.otherActive)
  run committedReplyLostTest = init.then(beginUpload(true)).then(finishPut(false, true))
    .then(startFinalize).then(finishFinalize(true)).then(loseFinalizeReply)
    .then(startRetire).then(finishRetire(1)).expect(safety and s.row == "ready" and s.objects)
  run activationBeforeFailureCleanupTest = init.then(beginUpload(true)).then(finishPut(false, true))
    .then(startFinalize).then(finishFinalize(true)).then(activate(true)).then(loseFinalizeReply)
    .then(startRetire).then(finishRetire(1)).expect(safety and s.row == "active" and s.objects)
  run retirementWinsPendingSqlTest = init.then(beginUpload(true)).then(finishPut(false, true))
    .then(startFinalize).then(loseFinalizeReply).then(startRetire).then(finishRetire(1))
    .then(cleanup).then(finishFinalize(true)).expect(safety and s.row == "failed" and not(s.objects))
  run lostRetirementReceiptTest = init.then(beginUpload(true)).then(finishPut(true, true))
    .then(startRetire).then(finishRetire(2)).expect(safety and s.row == "failed" and s.objects)
  run deleteBeforePublicationTest = init.then(beginUpload(true)).then(finishPut(false, true))
    .then(startFinalize).then(deleteInactive(false)).then(deleteArtifacts)
    .then(finishFinalize(true)).expect(safety and s.row == "deleted")
  run rollbackAndDeleteTest = init.then(beginUpload(true)).then(finishPut(false, true))
    .then(startFinalize).then(finishFinalize(true)).then(activate(true)).then(activatePrevious)
    .then(deleteInactive(false)).then(deleteArtifacts).expect(safety and s.otherActive)
  action oldErrorCleanup = s' = { ...s, row: "failed", objects: false }
  run oldCleanupWitnessTest = init.then(beginUpload(true)).then(finishPut(false, true))
    .then(startFinalize).then(finishFinalize(true)).then(activate(true)).then(oldErrorCleanup)
    .expect(not(safety))
  run oldReadyCleanupWitnessTest = init.then(beginUpload(true)).then(finishPut(false, true))
    .then(startFinalize).then(finishFinalize(true)).then(oldErrorCleanup)
    .expect(not(safety))
}
