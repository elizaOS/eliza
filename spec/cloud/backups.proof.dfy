lemma UploadParts(b: AgentBackups, writer: int, chunk: int)
  ensures recordUpload(b, writer, chunk).uploaded == b.uploaded + ProofLib.Filter((set_x: int) => !((set_x in b.uploaded)), [chunk])
{}

lemma LeaseParts(b: AgentBackups, attempt: int)
  ensures acquireLease(b, attempt).acquired == b.acquired + ProofLib.Filter((set_x: int) => !((set_x in b.acquired)), [attempt])
  ensures acquireLease(b, attempt).released == b.released + ProofLib.Filter((set_x: int) => !((set_x in b.released)), b.acquired)
  ensures releaseLease(b, attempt).released == b.released + ProofLib.Filter((set_x: int) => !((set_x in b.released)), [attempt])
  ensures alwaysOneUnreleasedLease(b) == ((|ProofLib.Filter((set_x: int) => !((set_x in b.released)), b.acquired)| <= 1) && (forall x :: x in b.released ==> x in b.acquired))
  ensures alwaysOneUnreleasedLease(acquireLease(b, attempt)) == ((|ProofLib.Filter((set_x: int) => !((set_x in acquireLease(b, attempt).released)), acquireLease(b, attempt).acquired)| <= 1) && (forall x :: x in acquireLease(b, attempt).released ==> x in acquireLease(b, attempt).acquired))
  ensures alwaysOneUnreleasedLease(releaseLease(b, attempt)) == ((|ProofLib.Filter((set_x: int) => !((set_x in releaseLease(b, attempt).released)), b.acquired)| <= 1) && (forall x :: x in releaseLease(b, attempt).released ==> x in b.acquired))
{}

lemma recordUpload_ensures(b: AgentBackups, writer: int, chunk: int)
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysReceiptFollowsCatalog(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysPublicationNeedsReceipt(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysPublishedCaptureIsComplete(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysIntentOwnsTheAttempt(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysPartialSpoolHasIntent(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysConfirmedSpoolIsAbsent(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysLockMatchesExecution(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysOneUnreleasedLease(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysLiveLeaseIsCurrent(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysLeaseHolderAcquired(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysRouteMovesOnlyToAVerifiedCandidate(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysPreviousRetiredOnlyAfterRouteMoved(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysFinalizedRestoreMovedTheRoute(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysRestorePhaseKeepsItsEvidence(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysTerminalFailureKeepsTheOldRoute(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysLateFailureKeepsTheNewRoute(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> alwaysResumeBeforeMaterializing(recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> stepOneWriterAtATime(b, recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> stepCaptureEvidenceIsDurable(b, recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> stepSpoolChangesOnlyUnderLock(b, recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> stepIntentRetiresOnlyWhenAbsent(b, recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> stepCancellingKeepsSpoolAndIntent(b, recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> stepAuthorizedOnlyWithAcceptedProof(b, recordUpload(b, writer, chunk)))
  ensures (inv(b) ==> canRecordUpload(b, writer, chunk) ==> stepReleasedLeaseNeverReopens(b, recordUpload(b, writer, chunk)))
{
  if inv(b) && canRecordUpload(b, writer, chunk) {
    UploadParts(b, writer, chunk);
    ProofLib.FilterSubset((set_x: int) => !((set_x in b.uploaded)), [chunk]);
  }
}

lemma acquireLease_ensures(b: AgentBackups, attempt: int)
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysReceiptFollowsCatalog(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysPublicationNeedsReceipt(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysPublishedCaptureIsComplete(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysIntentOwnsTheAttempt(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysPartialSpoolHasIntent(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysConfirmedSpoolIsAbsent(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysLockMatchesExecution(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysOneUnreleasedLease(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysLiveLeaseIsCurrent(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysLeaseHolderAcquired(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysRouteMovesOnlyToAVerifiedCandidate(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysPreviousRetiredOnlyAfterRouteMoved(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysFinalizedRestoreMovedTheRoute(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysRestorePhaseKeepsItsEvidence(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysTerminalFailureKeepsTheOldRoute(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysLateFailureKeepsTheNewRoute(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> alwaysResumeBeforeMaterializing(acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> stepOneWriterAtATime(b, acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> stepCaptureEvidenceIsDurable(b, acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> stepSpoolChangesOnlyUnderLock(b, acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> stepIntentRetiresOnlyWhenAbsent(b, acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> stepCancellingKeepsSpoolAndIntent(b, acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> stepAuthorizedOnlyWithAcceptedProof(b, acquireLease(b, attempt)))
  ensures (inv(b) ==> canAcquireLease(b, attempt) ==> stepReleasedLeaseNeverReopens(b, acquireLease(b, attempt)))
{
  if inv(b) && canAcquireLease(b, attempt) {
    var after := acquireLease(b, attempt);
    LeaseParts(b, attempt);
    ProofLib.FilterCons((set_x: int) => !((set_x in b.acquired)), [attempt]);
    ProofLib.FilterNil((set_x: int) => !((set_x in b.acquired)), [attempt][1..]);
    assert after.acquired == b.acquired + [attempt];
    var unreleased := (set_x: int) => !((set_x in after.released));
    forall x | x in b.acquired ensures x in after.released {
      if x !in b.released { ProofLib.FilterMember((set_x: int) => !((set_x in b.released)), b.acquired, x); }
    }
    forall x | x in after.released ensures x in b.acquired {
      if x !in b.released { ProofLib.FilterMember((set_x: int) => !((set_x in b.released)), b.acquired, x); }
    }
    ProofLib.FilterAppend(unreleased, b.acquired, attempt);
    ProofLib.FilterNone(unreleased, b.acquired);
  }
}

lemma releaseLease_ensures(b: AgentBackups, attempt: int)
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysReceiptFollowsCatalog(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysPublicationNeedsReceipt(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysPublishedCaptureIsComplete(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysIntentOwnsTheAttempt(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysPartialSpoolHasIntent(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysConfirmedSpoolIsAbsent(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysLockMatchesExecution(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysOneUnreleasedLease(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysLiveLeaseIsCurrent(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysLeaseHolderAcquired(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysRouteMovesOnlyToAVerifiedCandidate(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysPreviousRetiredOnlyAfterRouteMoved(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysFinalizedRestoreMovedTheRoute(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysRestorePhaseKeepsItsEvidence(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysTerminalFailureKeepsTheOldRoute(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysLateFailureKeepsTheNewRoute(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> alwaysResumeBeforeMaterializing(releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> stepOneWriterAtATime(b, releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> stepCaptureEvidenceIsDurable(b, releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> stepSpoolChangesOnlyUnderLock(b, releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> stepIntentRetiresOnlyWhenAbsent(b, releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> stepCancellingKeepsSpoolAndIntent(b, releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> stepAuthorizedOnlyWithAcceptedProof(b, releaseLease(b, attempt)))
  ensures (inv(b) ==> canReleaseLease(b, attempt) ==> stepReleasedLeaseNeverReopens(b, releaseLease(b, attempt)))
{
  if inv(b) && canReleaseLease(b, attempt) {
    var after := releaseLease(b, attempt);
    LeaseParts(b, attempt);
    forall x | x in after.released ensures x in b.released || x == attempt {
      if x !in b.released { ProofLib.FilterMember((set_x: int) => !((set_x in b.released)), [attempt], x); }
    }
    ProofLib.FilterImpLength((set_x: int) => !((set_x in after.released)), (set_x: int) => !((set_x in b.released)), b.acquired);
  }
}
