/// Opt-in canonical Trash uses one serialized Notes document commit.
module CanonicalNotesTrash {
  type State = {
    retentionOn: bool, audio: bool, sharedAudio: bool, now: int,
    note: str, deletedAt: int, revision: int,
    reviewRevision: int, reviewDeletion: int,
    cleanup: bool, deviceErased: bool, cacheReady: bool, readAccepted: bool, outcome: str
  }
  var s: State

  pure def initial(retentionOn: bool, audio: bool): State = {
    retentionOn: retentionOn, audio: audio, sharedAudio: false, now: 0,
    note: "live", deletedAt: 0, revision: 0,
    reviewRevision: -1, reviewDeletion: -1,
    cleanup: false, deviceErased: false, cacheReady: true, readAccepted: false, outcome: "none"
  }

  action init = {
    nondet retentionOn = Bool.oneOf()
    nondet audio = Bool.oneOf()
    s' = initial(retentionOn, audio)
  }

  val due = s.now - s.deletedAt >= 3
  val reviewed = s.note == "trash" and s.revision == s.reviewRevision and
    s.deletedAt == s.reviewDeletion

  action tick = all {
    s.now < 7,
    s' = { ...s, now: s.now + 1 }
  }
  action delete = all {
    s.cacheReady, s.note == "live", s.revision < 7,
    s' = { ...s, note: "trash", deletedAt: s.now, revision: s.revision + 1 }
  }
  action review = all {
    s.cacheReady, s.note == "trash",
    s' = { ...s, reviewRevision: s.revision, reviewDeletion: s.deletedAt }
  }
  action restore = all {
    s.cacheReady, reviewed, not(s.retentionOn and due), s.revision < 7,
    s' = { ...s, note: "live", revision: s.revision + 1 }
  }

  action commitErase(saved: bool): bool =
    if (saved) s' = { ...s, note: "erased", cleanup: s.audio, revision: s.revision + 1, outcome: "success" }
    else s' = { ...s, outcome: "conflict" }

  action erase(owner: bool, saved: bool): bool = all {
    s.cacheReady, s.retentionOn, owner, reviewed, not(s.sharedAudio), s.revision < 7,
    commitErase(saved)
  }
  action sweep(saved: bool): bool = all {
    s.cacheReady, s.retentionOn, s.note == "trash", due, not(s.sharedAudio), s.revision < 7,
    commitErase(saved)
  }
  action shareAudio(shared: bool): bool = all {
    s.cacheReady, s.audio, s.note != "erased", s.revision < 7,
    s' = { ...s, sharedAudio: shared, revision: s.revision + 1 }
  }
  action restart = s' = { ...s, reviewRevision: -1, reviewDeletion: -1, cacheReady: true, readAccepted: false, outcome: "none" }
  action recover = all { not(s.cacheReady), restart }
  action failedReopen = all { not(s.cacheReady), s' = s }
  action read = s' = { ...s, readAccepted: s.cacheReady }
  // A thrown CAS may or may not have published. Readback failure after an
  // accepted CAS has the published branch. No cached success is allowed.
  action uncertainCommit(owner: bool, applied: bool): bool = all {
    s.cacheReady, owner, s.retentionOn, reviewed, not(s.sharedAudio), s.revision < 7,
    s' = if (applied)
      { ...s, note: "erased", cleanup: s.audio, revision: s.revision + 1, cacheReady: false, readAccepted: false, outcome: "unknown" }
    else { ...s, cacheReady: false, readAccepted: false, outcome: "unknown" },
  }
  action readbackFailure(owner: bool): bool = uncertainCommit(owner, true)
  action observeDeviceErase = all {
    s.cleanup,
    s' = { ...s, deviceErased: true }
  }
  action acknowledge(owner: bool, exact: bool): bool = all {
    s.cacheReady, owner, exact, s.cleanup, s.deviceErased, s.revision < 7,
    s' = { ...s, cleanup: false, revision: s.revision + 1 }
  }
  action step = {
    nondet owner = Bool.oneOf()
    nondet saved = Bool.oneOf()
    nondet exact = Bool.oneOf()
    any {
      tick, delete, review, restore, erase(owner, saved), sweep(saved),
      shareAudio(exact), restart, recover, failedReopen, read, uncertainCommit(owner, saved), readbackFailure(owner),
      observeDeviceErase, acknowledge(owner, exact), s' = s
    }
  }

  val safety = all {
    not(s.cacheReady) implies not(s.readAccepted),
    s.note == "erased" implies (s.retentionOn and not(s.sharedAudio)),
    s.cleanup implies (s.note == "erased" and s.audio),
    s.deviceErased implies (s.note == "erased" and s.audio),
    (s.note == "erased" and s.audio and not(s.deviceErased)) implies s.cleanup
  }

  val expiryReady = s.cacheReady and s.retentionOn and s.note == "trash" and due
    and not(s.sharedAudio) and s.revision < 7
  val receiptReady = s.cacheReady and s.cleanup and s.deviceErased and s.revision < 7
  temporal ExpirySettles = expiryReady.leadsTo(not(expiryReady))
  temporal FairExpiry = sweep(true).weakFair(s) implies ExpirySettles
  temporal ReceiptSettles = receiptReady.leadsTo(not(s.cleanup) or not(s.cacheReady))
  temporal FairReceipt = acknowledge(true, true).weakFair(s) implies ReceiptSettles
  temporal RecoverySettles = not(s.cacheReady).leadsTo(s.cacheReady)
  temporal FairRecovery = recover.weakFair(s) implies RecoverySettles

  action start(retentionOn: bool, audio: bool): bool = s' = initial(retentionOn, audio)

  action oneDayBeforeCutoff = start(true, false).then(delete).then(review)
    .then(tick).then(tick)
  action atCutoff = oneDayBeforeCutoff.then(tick)
  action newDeletion = start(true, true).then(delete).then(review).then(restore)
    .then(tick).then(delete)
  action reviewedRecording = start(true, true).then(delete).then(review)
  action restartedCleanup = reviewedRecording.then(erase(true, true)).then(restart)
  action reviewedSharedAudio = start(true, true).then(delete)
    .then(shareAudio(true)).then(review)

  run beforeCutoffTest = oneDayBeforeCutoff.then(sweep(true).fail())
  run expiredRestoreTest = atCutoff.then(restore.fail())
  run exactCutoffTest = atCutoff.then(sweep(true)).then(restart)
    .expect(s.note == "erased" and not(s.cleanup) and safety)

  run optOutTest = start(false, false).then(delete).then(tick).then(tick).then(tick)
    .then(restart).then(review).then(restore).expect(s.note == "live" and safety)
  run optOutSweepTest = start(false, false).then(delete).then(tick).then(tick)
    .then(tick).then(sweep(true).fail())

  run staleDeletionReviewTest = newDeletion.then(erase(true, true).fail())
  run foreignOwnerTest = newDeletion.then(review).then(erase(false, true).fail())
  run currentDeletionReviewTest = newDeletion.then(review)
    .then(erase(true, true)).then(restart).expect(s.cleanup and safety)

  run failedCommitTest = reviewedRecording.then(erase(true, false))
    .expect(s.note == "trash" and not(s.cleanup) and safety)
  run proofRequiredTest = restartedCleanup.then(acknowledge(true, true).fail())
  run exactReceiptRequiredTest = restartedCleanup.then(observeDeviceErase)
    .then(acknowledge(true, false).fail())
  run recordingProofTest = restartedCleanup.then(observeDeviceErase)
    .then(acknowledge(true, true)).expect(s.deviceErased and not(s.cleanup) and safety)

  run explicitSharedAudioTest = reviewedSharedAudio.then(erase(true, true).fail())
  run expiredSharedAudioTest = reviewedSharedAudio.then(tick).then(tick).then(tick)
    .expect(s.note == "trash" and not(s.cleanup) and safety).then(sweep(true).fail())
  run lostAcknowledgementKeepsReceiptTest = reviewedRecording.then(uncertainCommit(true, true))
    .then(read).expect(not(s.readAccepted) and s.cleanup and s.outcome == "unknown")
    .then(recover).expect(s.cleanup and s.note == "erased" and safety)
  run rejectedUnknownCommitKeepsNoteTest = reviewedRecording.then(uncertainCommit(true, false))
    .then(read).expect(not(s.readAccepted) and s.note == "trash")
    .then(recover).expect(s.note == "trash" and not(s.cleanup) and safety)
  run failedReadbackNeedsReopenTest = reviewedRecording.then(readbackFailure(true))
    .then(failedReopen).then(read).expect(not(s.readAccepted) and s.cleanup)
    .then(recover).expect(s.cleanup and safety)

}


// One queued caller over the existing serialized store. Cancellation before
// dispatch suppresses it. Once CAS has been dispatched, cancellation cannot
// undo a published document. Native verification is a trusted boolean port.
module NotesTrashCommitLifecycle {
  var s: { kind: str, phase: str, current: bool, cancelled: bool,
    changed: bool, pending: bool, proof: bool, cacheReady: bool, outcome: str }
  action initial(kind: str, owner: bool, current: bool): bool = s' = {
    kind: kind, phase: if (owner) (if (kind == "erase") "waiting-store" else "verifying") else "settled",
    current: current, cancelled: false, changed: false, pending: kind == "ack",
    proof: false, cacheReady: true, outcome: if (owner) "none" else "refused",
  }
  action init = {
    nondet kind = Set("erase", "ack").oneOf()
    nondet owner = Bool.oneOf()
    nondet current = Bool.oneOf()
    initial(kind, owner, current)
  }
  action replaceReview = all { s.phase == "waiting-store", s' = s.with("current", false) }
  action cancel = all {
    s.phase.in(Set("waiting-store", "verifying", "ready-to-ack", "committing", "awaiting-ack")),
    s' = s.with("cancelled", true)
      .with("phase", if (s.phase.in(Set("committing", "awaiting-ack"))) s.phase else "cancelled")
      .with("outcome", if (s.phase.in(Set("committing", "awaiting-ack"))) s.outcome else "cancelled"),
  }
  action dispatchErase = all { s.phase == "waiting-store",
    s' = s.with("phase", if (s.current and not(s.cancelled)) "committing" else "settled")
      .with("outcome", if (s.current and not(s.cancelled)) "none" else "conflict"),
  }
  action verify(ok: bool): bool = all { s.phase == "verifying",
    s' = s.with("phase", if (s.current and ok) "ready-to-ack" else "settled")
      .with("proof", s.current and ok)
      .with("outcome", if (s.current and ok) "none" else "refused"),
  }
  action lateVerification = all { s.phase == "cancelled", s.kind == "ack", s' = s.with("proof", true) }
  action dispatchAck = all { s.phase == "ready-to-ack", not(s.cancelled),
    s' = s.with("phase", "committing"),
  }
  action publish = all { s.phase == "committing",
    s' = s.with("phase", "awaiting-ack").with("changed", true)
      .with("pending", s.kind == "erase"),
  }
  action refusedCommit = all { s.phase == "committing",
    s' = s.with("phase", "settled").with("outcome", "conflict"),
  }
  action acknowledged = all { s.phase == "awaiting-ack",
    s' = s.with("phase", "settled").with("outcome", "success"),
  }
  action lostAcknowledgement = all { s.phase == "awaiting-ack",
    s' = s.with("phase", "settled").with("outcome", "unknown").with("cacheReady", false),
  }
  action reopen = all { not(s.cacheReady), s' = s.with("cacheReady", true) }
  action advance = any { dispatchErase, verify(false), verify(true), dispatchAck,
    publish, refusedCommit, acknowledged, lostAcknowledgement }
  action step = any { advance, replaceReview, cancel, lateVerification, reopen, s' = s }
  val safety = all {
    s.kind == "ack" and s.changed implies s.proof,
    s.kind == "erase" and s.changed implies s.pending,
    s.phase == "cancelled" implies not(s.changed),
    s.outcome == "success" implies s.changed,
    s.outcome == "unknown" implies s.changed,
  }
  val pendingCall = not(s.phase.in(Set("settled", "cancelled")))
  temporal CallSettles = pendingCall.leadsTo(not(pendingCall))
  temporal FairCallSettlement = advance.weakFair(s) implies CallSettles
  run cancelledQueuedEraseTest = initial("erase", true, true).then(cancel)
    .expect(not(s.changed) and safety).then(dispatchErase.fail())
  run changedReviewRefusedTest = initial("erase", true, true).then(replaceReview)
    .then(dispatchErase).expect(s.outcome == "conflict" and not(s.changed))
  run cancellationAfterDispatchRetainsReceiptTest = initial("erase", true, true)
    .then(dispatchErase).then(cancel).then(publish).then(acknowledged)
    .expect(s.changed and s.pending and s.outcome == "success" and safety)
  run cancelledLostAckIsUnknownTest = initial("erase", true, true)
    .then(dispatchErase).then(publish).then(cancel).then(lostAcknowledgement)
    .expect(s.outcome == "unknown" and not(s.cacheReady) and s.pending)
    .then(reopen).expect(s.pending and safety)
  run cancelledVerifierDoesNotRetireTest = initial("ack", true, true)
    .then(cancel).then(lateVerification).expect(s.pending and not(s.changed) and safety)
  run unverifiedReceiptRetainedTest = initial("ack", true, true).then(verify(false))
    .expect(s.pending and not(s.changed) and safety)
  run verifiedReceiptRetiresOnceTest = initial("ack", true, true).then(verify(true))
    .then(dispatchAck).then(publish).then(acknowledged)
    .expect(not(s.pending) and s.changed and s.proof and safety)
}
