# Account storage reset

A reset removes every stored provider credential of a deployment at once,
for example when the person signs out of everything or the storage policy
changes. The reset writes a durable intent before it deletes anything,
calls the host's one-time callback, then publishes a new storage epoch that
fences every writer holding an older storage policy. If the reset process
crashes, a later recovery completes the reset from its intent without
calling the host again; if the reset fails before it publishes the epoch,
it restores what it deleted. Writes are admitted only while no reset or
recovery holds the storage and no intent is pending.

Ported from develop `packages/auth/quint/AccountStorageReset.qnt` (source
`src/auth/account-storage.ts`: `resetAccountCredentialStorage`,
`recoverCredentialResetUnlocked`). The [storage lock](./accountStorageLock.md)
serializes these steps with every other storage call. Artifacts 1 and 2
exist before the reset; artifact 3 is written by a writer holding the old
policy, artifact 4 by a writer that captured a policy later.

## Story: Reset all stored provider credentials, even across a crash

> As a person signing out of every linked account, I want every stored
> credential gone and no old writer able to put one back, even if the
> machine stops in the middle.

### A reset's intent is durable before deletion, and success needs the new epoch

```quint
type ResetPhase = ResetIdle | ResetDeleting | ResetCallback | ResetCommit | ResetCleanup | ResetRollback | ResetDone | ResetFailed | ResetCrashed
type RecoveryPhase = RecoveryIdle | RecoveryDeleting | RecoveryCommit | RecoveryCleanup | RecoveryDone
type WriterResult = WriterPending | WriterAccepted | WriterRefused
type StorageReset = {
  artifacts: int -> int, snapshot: int -> int, epoch: int, intent: bool, phase: ResetPhase, recovery: RecoveryPhase, callbacks: int,
  oldWriter: WriterResult, oldWriterEpoch: int, freshWriter: WriterResult, freshPolicyEpoch: int, rollbackComplete: bool, recoveryInterrupted: bool
}
pure val artifactIds = List(1, 2, 3, 4)
pure val initial: StorageReset = {
  artifacts: Map(1 -> 1, 2 -> 1, 3 -> 0, 4 -> 0), snapshot: Map(1 -> 0, 2 -> 0, 3 -> 0, 4 -> 0), epoch: 0, intent: false, phase: ResetIdle, recovery: RecoveryIdle, callbacks: 0,
  oldWriter: WriterPending, oldWriterEpoch: -1, freshWriter: WriterPending, freshPolicyEpoch: -1, rollbackComplete: true, recoveryInterrupted: false
}
pure def resetHeld(s: StorageReset): bool = s.phase == ResetDeleting or s.phase == ResetCallback or s.phase == ResetCommit or s.phase == ResetCleanup or s.phase == ResetRollback
pure def recoveryHeld(s: StorageReset): bool = s.recovery == RecoveryDeleting or s.recovery == RecoveryCommit or s.recovery == RecoveryCleanup
pure def allDeleted(s: StorageReset): bool = artifactIds.every(id => s.artifacts.getOr(id, 0) == 0)
pure def canBeginReset(s: StorageReset): bool = s.phase == ResetIdle and not(recoveryHeld(s)) and not(s.intent)
pure def beginReset(s: StorageReset): StorageReset = { ...s, intent: true, phase: ResetDeleting, snapshot: s.artifacts }
pure def canDeleteArtifact(s: StorageReset, id: int): bool = s.phase == ResetDeleting and s.artifacts.getOr(id, 0) != 0
pure def deleteArtifact(s: StorageReset, id: int): StorageReset = { ...s, artifacts: s.artifacts.put(id, 0) }
pure def canArtifactsDeleted(s: StorageReset): bool = s.phase == ResetDeleting and allDeleted(s)
pure def artifactsDeleted(s: StorageReset): StorageReset = { ...s, phase: ResetCallback }
pure def canPublishEpoch(s: StorageReset): bool = s.phase == ResetCommit
pure def publishEpoch(s: StorageReset): StorageReset = { ...s, epoch: 1, phase: ResetCleanup }
pure def canCompleteReset(s: StorageReset): bool = s.phase == ResetCleanup
pure def completeReset(s: StorageReset): StorageReset = { ...s, intent: false, phase: ResetDone }
pure val idValues = Set(1, 2, 3, 4)
pure val weight_deleteArtifact = 3
pure val weight_artifactsDeleted = 3
pure val weight_hostCallback = 3
pure val weight_publishEpoch = 3
pure val weight_completeReset = 3
pure val weight_restoreArtifact = 3
pure val weight_finishRollback = 3
pure def alwaysSuccessRequiresTheFence(s: StorageReset): bool = s.phase == ResetDone implies (s.epoch == 1 and not(s.intent))
pure def alwaysDeletionHappensUnderIntent(s: StorageReset): bool = (s.phase == ResetDeleting or s.phase == ResetCallback or s.phase == ResetCommit or s.recovery == RecoveryDeleting) implies s.intent
pure def sometimesResetDone(s: StorageReset): bool = s.phase == ResetDone
```

### The host's callback runs at most once, even when recovery completes a crashed reset

```quint
pure def canHostCallback(s: StorageReset): bool = s.phase == ResetCallback
pure def hostCallback(s: StorageReset): StorageReset = { ...s, callbacks: s.callbacks + 1, phase: ResetCommit }
pure def canCrashDuringReset(s: StorageReset): bool = resetHeld(s)
pure def crashDuringReset(s: StorageReset): StorageReset = { ...s, phase: ResetCrashed }
pure def canBeginRecovery(s: StorageReset): bool = not(resetHeld(s)) and s.intent and s.recovery == RecoveryIdle
pure def beginRecovery(s: StorageReset): StorageReset = { ...s, recovery: if (s.epoch == 0) RecoveryDeleting else RecoveryCleanup }
pure def canRecoverDelete(s: StorageReset, id: int): bool = s.recovery == RecoveryDeleting and s.artifacts.getOr(id, 0) != 0
pure def recoverDelete(s: StorageReset, id: int): StorageReset = { ...s, artifacts: s.artifacts.put(id, 0) }
pure def canRecoverDeleted(s: StorageReset): bool = s.recovery == RecoveryDeleting and allDeleted(s)
pure def recoverDeleted(s: StorageReset): StorageReset = { ...s, recovery: RecoveryCommit }
pure def canRecoverEpoch(s: StorageReset): bool = s.recovery == RecoveryCommit
pure def recoverEpoch(s: StorageReset): StorageReset = { ...s, epoch: 1, recovery: RecoveryCleanup }
pure def canRecoverComplete(s: StorageReset): bool = s.recovery == RecoveryCleanup
pure def recoverComplete(s: StorageReset): StorageReset = { ...s, intent: false, recovery: RecoveryDone }
pure def canInterruptRecovery(s: StorageReset): bool = recoveryHeld(s) and not(s.recoveryInterrupted)
pure def interruptRecovery(s: StorageReset): StorageReset = { ...s, recovery: RecoveryIdle, recoveryInterrupted: true }
pure def alwaysOneHostCallback(s: StorageReset): bool = s.callbacks >= 0 and s.callbacks <= 1 and (s.callbacks == 1 implies (s.phase != ResetIdle and s.phase != ResetDeleting and s.phase != ResetCallback))
pure def alwaysRecoveryOnlyAfterACrash(s: StorageReset): bool = s.recovery != RecoveryIdle implies s.phase == ResetCrashed
pure def sometimesRecoveredWithoutCallback(s: StorageReset): bool = s.recovery == RecoveryDone and s.callbacks == 0 and s.epoch == 1
pure def sometimesInterruptedRecoveryRetried(s: StorageReset): bool = s.recovery == RecoveryDone and s.recoveryInterrupted
```

### A reset that fails before publishing the epoch restores every artifact and clears its intent

```quint
pure def canFailBeforePublication(s: StorageReset): bool = s.phase == ResetDeleting or s.phase == ResetCallback or s.phase == ResetCommit
pure def failBeforePublication(s: StorageReset): StorageReset = { ...s, phase: ResetRollback, rollbackComplete: false }
pure def canRestoreArtifact(s: StorageReset, id: int): bool = s.phase == ResetRollback and s.artifacts.getOr(id, 0) != s.snapshot.getOr(id, 0)
pure def restoreArtifact(s: StorageReset, id: int): StorageReset = { ...s, artifacts: s.artifacts.put(id, s.snapshot.getOr(id, 0)) }
pure def canFinishRollback(s: StorageReset): bool = s.phase == ResetRollback and artifactIds.every(id => s.artifacts.getOr(id, 0) == s.snapshot.getOr(id, 0))
pure def finishRollback(s: StorageReset): StorageReset = { ...s, phase: ResetFailed, intent: false, rollbackComplete: true }
pure def alwaysCompleteRollbackClearsIntent(s: StorageReset): bool = s.phase == ResetFailed implies (s.rollbackComplete and not(s.intent) and s.epoch == 0)
pure def sometimesRolledBack(s: StorageReset): bool = s.phase == ResetFailed
```

### A writer holding an older storage epoch can never write into the new one

```quint
pure def writable(s: StorageReset): bool = not(resetHeld(s)) and not(recoveryHeld(s)) and not(s.intent)
pure def canOldWrite(s: StorageReset): bool = s.oldWriter == WriterPending and writable(s)
pure def oldWrite(s: StorageReset): StorageReset =
  if (s.epoch == 0) { ...s, artifacts: s.artifacts.put(3, 1), oldWriter: WriterAccepted, oldWriterEpoch: 0 } else { ...s, oldWriter: WriterRefused }
pure def canCapturePolicy(s: StorageReset): bool = s.freshPolicyEpoch == -1 and writable(s)
pure def capturePolicy(s: StorageReset): StorageReset = { ...s, freshPolicyEpoch: s.epoch }
pure def canFreshWrite(s: StorageReset): bool = s.freshWriter == WriterPending and s.freshPolicyEpoch != -1 and writable(s)
pure def freshWrite(s: StorageReset): StorageReset =
  if (s.freshPolicyEpoch == s.epoch) { ...s, artifacts: s.artifacts.put(4, s.epoch + 1), freshWriter: WriterAccepted } else { ...s, freshWriter: WriterRefused }
pure def alwaysRecordsBelongToTheCurrentEpoch(s: StorageReset): bool =
  artifactIds.every(id => s.artifacts.getOr(id, 0) == 0 or s.artifacts.getOr(id, 0) == s.epoch + 1)
pure def alwaysOldPolicyNeverWritesTheNewEpoch(s: StorageReset): bool = s.oldWriterEpoch == -1 or s.oldWriterEpoch == 0
pure def sometimesOldWriterFenced(s: StorageReset): bool = s.oldWriter == WriterRefused
pure def sometimesFreshWriterAfterReset(s: StorageReset): bool = s.freshWriter == WriterAccepted and s.epoch == 1
```
