// Proposed canonical Notes erase protocol. The Notes transaction and the
// recording store transaction are separate durable effects. A claim prevents
// restore from racing the exact recording deletion on its originating host.
module CanonicalTrashErase {
  type State = {
    phase: str,
    revision: int,
    hasRecording: bool,
    audioPhase: str,
    audioReceipt: int,
    operation: int,
    owner: bool,
    originatingHost: bool,
    reviewedRevision: int,
    confirmation: bool,
    observedClaim: bool,
    observedAudioPhase: str,
    observedAudioReceipt: int
  }
  var s: State

  action initFor(recording: bool): bool = s' = {
    phase: "archived", revision: 1, hasRecording: recording,
    audioPhase: if (recording) "retained" else "none", audioReceipt: 0, operation: 0,
    owner: true, originatingHost: true,
    reviewedRevision: 0, confirmation: false,
    observedClaim: false, observedAudioPhase: "unknown", observedAudioReceipt: 0
  }

  action init = {
    nondet recording = Bool.oneOf()
    initFor(recording)
  }

  val ownsRecording = not(s.hasRecording) or s.originatingHost
  val mayReview = s.owner and ownsRecording and s.phase == "archived"
  pure def exactTarget(id: int): bool = id == 1
  def mayClaim(id: int): bool =
    exactTarget(id) and mayReview and s.confirmation and s.reviewedRevision == s.revision
  val mayRestore = s.owner and s.phase == "archived" and s.revision < 3
  val mayTouchAudio =
    s.owner and s.originatingHost and s.phase == "erasing" and s.observedClaim
  val mayMarkAudio =
    mayTouchAudio and s.audioPhase == "retained" and s.observedAudioPhase == "retained"
  val mayPurgeAudio =
    mayTouchAudio and s.audioPhase == "removed" and s.observedAudioPhase == "removed" and
    s.observedAudioReceipt == s.operation
  def mayFinish(receipt: int): bool =
    mayTouchAudio and s.audioPhase == "purged" and s.observedAudioPhase == "purged" and
    receipt == s.operation and s.observedAudioReceipt == receipt and s.audioReceipt == receipt

  action review = all {
    mayReview,
    s' = { ...s, reviewedRevision: s.revision, confirmation: false }
  }
  action confirm = all {
    mayReview, s.reviewedRevision == s.revision,
    s' = { ...s, confirmation: true }
  }
  action cancelReview = s' = { ...s, reviewedRevision: 0, confirmation: false }

  // Text-only Notes require only the revision-fenced server transaction.
  // Audio-bearing Notes retain the archived record until exact cleanup proof.
  action commitErase(id: int): bool = all {
    mayClaim(id),
    s' = { ...s, phase: if (s.hasRecording) "erasing" else "erased",
      revision: s.revision + 1, operation: s.revision + 1,
      confirmation: false, observedClaim: false }
  }
  action restore = all {
    mayRestore,
    s' = { ...s, phase: "live", revision: s.revision + 1 }
  }
  action archiveAgain = all {
    s.owner, s.phase == "live", s.revision < 3,
    s' = { ...s, phase: "archived", revision: s.revision + 1 }
  }

  action readClaim = all {
    s.owner, s.originatingHost, s.phase == "erasing",
    s' = { ...s, observedClaim: true }
  }
  action markRecordingDeleted = all {
    mayMarkAudio,
    s' = { ...s, audioPhase: "removed", audioReceipt: s.operation, observedAudioPhase: "unknown" }
  }
  action purgeRecording = all {
    mayPurgeAudio,
    s' = { ...s, audioPhase: "purged", observedAudioPhase: "unknown" }
  }
  action readRecordingReceipt = all {
    mayTouchAudio,
    s' = { ...s, observedAudioPhase: s.audioPhase, observedAudioReceipt: s.audioReceipt }
  }
  action finishErase(receipt: int): bool = all {
    mayFinish(receipt),
    s' = { ...s, phase: "erased", revision: s.revision + 1,
      observedClaim: false, observedAudioPhase: "unknown", observedAudioReceipt: 0 }
  }

  // A crash, owner change, or lost response clears volatile authorization and
  // observations. It preserves the claim and any recorded audio-store receipt.
  action rebind(owner: bool, originatingHost: bool): bool = s' = {
    ...s, owner: owner, originatingHost: originatingHost,
    reviewedRevision: 0, confirmation: false,
    observedClaim: false, observedAudioPhase: "unknown", observedAudioReceipt: 0
  }
  action step = any {
    review, confirm, cancelReview, commitErase(1), restore, archiveAgain,
    readClaim, markRecordingDeleted, purgeRecording, readRecordingReceipt, finishErase(s.operation),
    rebind(true, true), rebind(true, false), rebind(false, true), s' = s
  }

  val ClaimFencesRestore =
    Set("erasing", "erased").contains(s.phase) implies
      (s.operation > 0 and not(mayRestore))
  val AudioEffectsRequireClaim =
    Set("removed", "purged").contains(s.audioPhase) implies (s.hasRecording and s.operation > 0 and s.audioReceipt == s.operation and
      Set("erasing", "erased").contains(s.phase))
  val ErasedRequiresAllEffects =
    s.phase == "erased" implies (not(s.hasRecording) or s.audioPhase == "purged")
  val StaleReviewCannotClaim =
    s.reviewedRevision != s.revision implies not(mayClaim(1))
  val ForeignCannotAct = and {
    not(s.owner).implies(not(mayClaim(1)) and not(mayRestore) and not(mayMarkAudio) and not(mayPurgeAudio) and not(mayFinish(s.operation))),
    (s.hasRecording and not(s.originatingHost)).implies(not(mayClaim(1)) and not(mayMarkAudio) and not(mayPurgeAudio) and not(mayFinish(s.operation)))
  }
  val safety =
    ClaimFencesRestore and AudioEffectsRequireClaim and ErasedRequiresAllEffects and
    StaleReviewCannotClaim and ForeignCannotAct and not(mayClaim(2)) and
    (s.observedAudioReceipt > 0 implies s.observedAudioReceipt == s.audioReceipt)

  run textCommitTest = initFor(false).then(review).then(confirm).then(commitErase(1))
    .expect(s.phase == "erased" and s.audioPhase != "purged" and safety)
  run staleReviewTest = initFor(true).then(review).then(confirm).then(restore).then(archiveAgain)
    .expect(s.phase == "archived" and not(mayClaim(1)) and s.audioPhase != "purged" and safety)
  run cancelTest = initFor(true).then(review).then(confirm).then(cancelReview)
    .expect(s.phase == "archived" and mayRestore and not(mayClaim(1)) and safety)
  run claimLostResponseTest = initFor(true).then(review).then(confirm).then(commitErase(1))
    .then(rebind(true, true)).expect(not(mayMarkAudio) and not(mayPurgeAudio) and not(mayRestore))
    .then(readClaim).then(readRecordingReceipt).then(markRecordingDeleted)
    .then(readRecordingReceipt).then(purgeRecording).expect(not(mayFinish(s.operation)))
    .then(readRecordingReceipt).then(finishErase(s.operation)).expect(s.phase == "erased" and safety)
  run audioLostResponseTest = initFor(true).then(review).then(confirm).then(commitErase(1))
    .then(readClaim).then(readRecordingReceipt).then(markRecordingDeleted)
    .then(readRecordingReceipt).then(purgeRecording).then(rebind(true, true)).then(readClaim)
    .expect(not(mayMarkAudio) and not(mayPurgeAudio) and not(mayFinish(s.operation)))
    .then(readRecordingReceipt).expect(not(mayFinish(s.operation + 1)))
    .then(finishErase(s.operation)).expect(s.phase == "erased" and safety)
  run foreignHostCannotContinueTest = initFor(true).then(review).then(confirm).then(commitErase(1))
    .then(rebind(true, false)).expect(not(mayMarkAudio) and not(mayPurgeAudio) and not(mayFinish(s.operation)) and safety)
  run ownerChangeBeforeCommitTest = initFor(true).then(review).then(confirm).then(rebind(false, true))
    .expect(s.phase == "archived" and not(mayClaim(1)) and safety)
  run originalHostResumesTest = initFor(true).then(review).then(confirm).then(commitErase(1))
    .then(rebind(false, true)).then(rebind(true, true)).then(readClaim).then(readRecordingReceipt).then(markRecordingDeleted)
    .then(readRecordingReceipt).then(purgeRecording)
    .then(readRecordingReceipt).then(finishErase(s.operation)).expect(s.phase == "erased" and safety)
}
