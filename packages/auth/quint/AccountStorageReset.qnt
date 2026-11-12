// Source mapping: account-storage.ts resetAccountCredentialStorage,
// recoverCredentialResetUnlocked, createAccountStoragePolicy, acquireStorageLock.
// The lock module proves serialized admission. Each filesystem effect here is
// atomic. The intent is durable before deletion; rename+directory fsync supplies
// the durability boundary. Power-loss hardware/fsync correctness is assumed.
// Two original encrypted artifacts, one old-policy writer, one fresh-policy
// writer, one reset, one reset-process crash and one interrupted recovery are bounded.
module AccountStorageReset {
  val artifacts = Set(1, 2, 3, 4)
  type State = {
    files: int -> int,
    snapshot: int -> int,
    generation: int,
    intent: bool,
    phase: str,
    recovery: str,
    callbacks: int,
    oldWriter: str,
    freshWriter: str,
    freshGeneration: int,
    admittedOldGeneration: int,
    rollbackComplete: bool,
    recoveryCrashes: int,
  }
  var s: State
  action init = s' = {
    files: artifacts.mapBy(id => if (id <= 2) 1 else 0),
    snapshot: artifacts.mapBy(_ => 0),
    generation: 0, intent: false, phase: "idle", recovery: "idle",
    callbacks: 0, oldWriter: "pending", freshWriter: "pending",
    freshGeneration: -1, admittedOldGeneration: -1, rollbackComplete: true, recoveryCrashes: 0,
  }
  def resetHeld = s.phase.in(Set("deleting", "callback", "commit", "cleanup", "rollback"))
  def recoveryHeld = s.recovery.in(Set("deleting", "commit", "cleanup"))
  def admitted = not(resetHeld) and not(recoveryHeld) and not(s.intent)
  action beginReset = all {
    s.phase == "idle", not(recoveryHeld), not(s.intent),
    s' = { ...s, intent: true, phase: "deleting", snapshot: s.files },
  }
  action deleteArtifact(id: int): bool = all {
    s.phase == "deleting", s.files.get(id) != 0,
    s' = { ...s, files: s.files.set(id, 0) },
  }
  action deleted = all {
    s.phase == "deleting", artifacts.forall(id => s.files.get(id) == 0),
    s' = { ...s, phase: "callback" },
  }
  action callback = all {
    s.phase == "callback",
    s' = { ...s, callbacks: s.callbacks + 1, phase: "commit" },
  }
  action publishGeneration = all {
    s.phase == "commit",
    s' = { ...s, generation: 1, phase: "cleanup" },
  }
  action completeReset = all {
    s.phase == "cleanup",
    s' = { ...s, intent: false, phase: "done" },
  }
  action failBeforePublication = all {
    s.phase.in(Set("deleting", "callback", "commit")),
    s' = { ...s, phase: "rollback", rollbackComplete: false },
  }
  action restoreArtifact(id: int): bool = all {
    s.phase == "rollback", s.files.get(id) != s.snapshot.get(id),
    s' = { ...s, files: s.files.set(id, s.snapshot.get(id)) },
  }
  action finishRollback = all {
    s.phase == "rollback", s.files == s.snapshot,
    s' = { ...s, phase: "failed", intent: false, rollbackComplete: true },
  }
  action crash = all {
    resetHeld,
    s' = { ...s, phase: "unknown" },
  }
  action beginRecovery = all {
    not(resetHeld), s.intent, s.recovery == "idle",
    s' = {
      ...s, recovery: if (s.generation == 0) "deleting" else "cleanup",
    },
  }
  action recoverDelete(id: int): bool = all {
    s.recovery == "deleting", s.files.get(id) != 0,
    s' = { ...s, files: s.files.set(id, 0) },
  }
  action recoverDeleted = all {
    s.recovery == "deleting", artifacts.forall(id => s.files.get(id) == 0),
    s' = { ...s, recovery: "commit" },
  }
  action recoverGeneration = all {
    s.recovery == "commit",
    s' = { ...s, generation: 1, recovery: "cleanup" },
  }
  action interruptRecovery = all {
    recoveryHeld, s.recoveryCrashes == 0,
    s' = { ...s, recovery: "idle", recoveryCrashes: 1 },
  }
  action recoverComplete = all {
    s.recovery == "cleanup",
    s' = { ...s, intent: false, recovery: "done" },
  }
  action oldWrite = all {
    s.oldWriter == "pending", admitted,
    s' = if (s.generation == 0) {
      ...s, files: s.files.set(3, 1), oldWriter: "accepted",
      admittedOldGeneration: s.generation,
    } else { ...s, oldWriter: "rejected" },
  }
  action freshPolicy = all {
    s.freshGeneration == -1, admitted,
    s' = { ...s, freshGeneration: s.generation },
  }
  action freshWrite = all {
    s.freshWriter == "pending", s.freshGeneration != -1, admitted,
    s' = if (s.freshGeneration == s.generation) {
      ...s, files: s.files.set(4, s.generation + 1), freshWriter: "accepted",
    } else { ...s, freshWriter: "rejected" },
  }
  action resetWork = any {
    { nondet id = artifacts.oneOf() deleteArtifact(id) },
    deleted, callback, publishGeneration, completeReset,
    { nondet id = artifacts.oneOf() restoreArtifact(id) }, finishRollback,
  }
  action recoveryWork = any {
    beginRecovery,
    { nondet id = artifacts.oneOf() recoverDelete(id) },
    recoverDeleted, recoverGeneration, recoverComplete,
  }
  action step = any {
    beginReset, resetWork, failBeforePublication, crash, recoveryWork, interruptRecovery,
    oldWrite, freshPolicy, freshWrite, s' = s,
  }
  val TypeOK = and {
    s.generation.in(Set(0, 1)), s.callbacks.in(Set(0, 1)),
    s.recoveryCrashes.in(Set(0, 1)),
    artifacts.forall(id => s.files.get(id).in(Set(0, 1, 2))),
  }
  val RecordsBelongToCurrentGeneration = artifacts.forall(id =>
    s.files.get(id) == 0 or s.files.get(id) == s.generation + 1)
  val OldPolicyCannotWriteNewGeneration = s.admittedOldGeneration.in(Set(-1, 0))
  val SuccessRequiresFence = s.phase == "done" implies and {
    s.generation == 1, not(s.intent),
  }
  val RecoveryPreservesUnknownOutcome = s.recovery != "idle" implies s.phase == "unknown"
  val OneShotHostCallback = s.callbacks <= 1
  val CompleteRollbackClearsIntent = s.phase == "failed" implies and {
    s.rollbackComplete, not(s.intent), s.generation == 0,
  }
  temporal FairWork = and {
    beginReset.weakFair(s), resetWork.weakFair(s), recoveryWork.weakFair(s),
    oldWrite.weakFair(s), freshPolicy.weakFair(s), freshWrite.weakFair(s),
  }
  temporal CallsSettle = FairWork.implies(eventually(and {
    s.phase.in(Set("done", "failed", "unknown")), not(s.intent),
    s.oldWriter != "pending", s.freshWriter != "pending",
  }))
  run crashAfterDeleteFencesOldWriterTest = init.then(beginReset)
    .then(deleteArtifact(1)).then(deleteArtifact(2)).then(deleted)
    .then(callback).then(crash).then(beginRecovery).then(recoverDeleted)
    .then(recoverGeneration).then(recoverComplete).then(oldWrite)
    .expect(s.oldWriter == "rejected" and s.callbacks == 1 and s.phase == "unknown")
  run interruptedRecoveryCanRetryTest = init.then(beginReset)
    .then(deleteArtifact(1)).then(crash).then(beginRecovery)
    .then(recoverDelete(2)).then(interruptRecovery).then(beginRecovery)
    .then(recoverDeleted).then(recoverGeneration).then(recoverComplete)
    .expect(s.generation == 1 and not(s.intent) and s.callbacks == 0)
  run rollbackPreservesOriginalsTest = init.then(beginReset)
    .then(deleteArtifact(1)).then(failBeforePublication)
    .then(restoreArtifact(1)).then(finishRollback)
    .expect(s.files == s.snapshot and not(s.intent) and s.generation == 0)
  run crashAfterGenerationDoesNotReplayCallbackTest = init.then(beginReset)
    .then(deleteArtifact(1)).then(deleteArtifact(2)).then(deleted)
    .then(callback).then(publishGeneration).then(crash).then(beginRecovery)
    .then(recoverComplete)
    .expect(s.callbacks == 1 and s.generation == 1 and not(s.intent))
}
