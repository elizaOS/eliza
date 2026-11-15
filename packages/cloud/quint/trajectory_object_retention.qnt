// Object upload and SQL publication are separate. A SQL error is not absence proof.
module trajectory_object_retention {
  type State = { objectPresent: bool, rowPresent: bool, phase: str, expired: bool }
  var s: State
  action init = s' = { objectPresent: false, rowPresent: false, phase: "idle", expired: false }
  action begin = all { s.phase == "idle", s' = { ...s, phase: "uploading" } }
  action uploadSucceeded = all {
    s.phase == "uploading", s' = { ...s, objectPresent: true, phase: "inserting" }
  }
  action uploadFailed = all {
    s.phase == "uploading", s' = { ...s, phase: "failed" }
  }
  action uploadOutcomeUnknown = all {
    s.phase == "uploading", s' = { ...s, objectPresent: true, phase: "failed" }
  }
  action insertCommitted = all {
    s.phase == "inserting", s' = { ...s, rowPresent: true, phase: "succeeded" }
  }
  action insertRolledBack = all {
    s.phase == "inserting", s' = { ...s, phase: "failed" }
  }
  action insertCommittedButReplyLost = all {
    s.phase == "inserting", s' = { ...s, rowPresent: true, phase: "failed" }
  }
  action finish = any { uploadSucceeded, uploadFailed, uploadOutcomeUnknown,
    insertCommitted, insertRolledBack, insertCommittedButReplyLost }
  // Existing retention only discovers rows whose configured retention expired.
  action retentionExpires = all {
    s.rowPresent, Set("failed", "succeeded").contains(s.phase),
    s' = { ...s, expired: true }
  }
  action purgeExpiredObject = all {
    s.rowPresent, s.expired, s' = { ...s, objectPresent: false }
  }
  action purgeExpiredRow = all {
    s.rowPresent, s.expired, not(s.objectPresent), s' = { ...s, rowPresent: false }
  }
  action step = any { begin, finish, retentionExpires, purgeExpiredObject, purgeExpiredRow, s' = s }
  val safety = s.rowPresent and not(s.expired) implies s.objectPresent
  val cleanupDebt = s.objectPresent and not(s.rowPresent)
  temporal LogSettles = finish.weakFair(s) implies
    always(Set("uploading", "inserting").contains(s.phase)
      implies eventually(Set("failed", "succeeded").contains(s.phase)))

  run committedPayloadRetainedTest = init.then(begin).then(uploadSucceeded).then(insertCommitted)
    .expect(safety and s.rowPresent and s.objectPresent)
  run unknownSqlCommitRetainedTest = init.then(begin).then(uploadSucceeded)
    .then(insertCommittedButReplyLost).expect(safety and s.rowPresent and s.objectPresent)
  run definiteRollbackLeavesCleanupDebtTest = init.then(begin).then(uploadSucceeded)
    .then(insertRolledBack).expect(safety and cleanupDebt)
  run unknownUploadLeavesCleanupDebtTest = init.then(begin).then(uploadOutcomeUnknown)
    .expect(safety and cleanupDebt)
  run uploadFailurePublishesNothingTest = init.then(begin).then(uploadFailed)
    .expect(safety and not(s.objectPresent) and not(s.rowPresent))
  run expiredRetentionStillDeletesTest = init.then(begin).then(uploadSucceeded)
    .then(insertCommitted).then(retentionExpires).then(purgeExpiredObject).then(purgeExpiredRow)
    .expect(safety and not(s.objectPresent) and not(s.rowPresent))

  action oldCleanupOnAnySqlError = all {
    s.phase == "failed", s' = { ...s, objectPresent: false }
  }
  run oldUnknownCommitDeletionWitnessTest = init.then(begin).then(uploadSucceeded)
    .then(insertCommittedButReplyLost).then(oldCleanupOnAnySqlError).expect(not(safety))
}
