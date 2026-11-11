/// Opt-in canonical Trash uses one serialized Notes document commit.
module CanonicalNotesTrash {
  type State = {
    retentionOn: bool, audio: bool, sharedAudio: bool, now: int,
    note: str, deletedAt: int, revision: int,
    reviewRevision: int, reviewDeletion: int,
    cleanup: bool, deviceErased: bool
  }
  var s: State

  pure def initial(retentionOn: bool, audio: bool): State = {
    retentionOn: retentionOn, audio: audio, sharedAudio: false, now: 0,
    note: "live", deletedAt: 0, revision: 0,
    reviewRevision: -1, reviewDeletion: -1,
    cleanup: false, deviceErased: false
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
    s.note == "live", s.revision < 7,
    s' = { ...s, note: "trash", deletedAt: s.now, revision: s.revision + 1 }
  }
  action review = all {
    s.note == "trash",
    s' = { ...s, reviewRevision: s.revision, reviewDeletion: s.deletedAt }
  }
  action restore = all {
    reviewed, not(s.retentionOn and due), s.revision < 7,
    s' = { ...s, note: "live", revision: s.revision + 1 }
  }

  action commitErase(saved: bool): bool =
    if (saved) s' = { ...s, note: "erased", cleanup: s.audio, revision: s.revision + 1 }
    else s' = s

  action erase(owner: bool, saved: bool): bool = all {
    s.retentionOn, owner, reviewed, not(s.sharedAudio), s.revision < 7,
    commitErase(saved)
  }
  action sweep(saved: bool): bool = all {
    s.retentionOn, s.note == "trash", due, not(s.sharedAudio), s.revision < 7,
    commitErase(saved)
  }
  action shareAudio(shared: bool): bool = all {
    s.audio, s.note != "erased", s.revision < 7,
    s' = { ...s, sharedAudio: shared, revision: s.revision + 1 }
  }
  action restart = s' = { ...s, reviewRevision: -1, reviewDeletion: -1 }
  action observeDeviceErase = all {
    s.cleanup,
    s' = { ...s, deviceErased: true }
  }
  action acknowledge(owner: bool, exact: bool): bool = all {
    owner, exact, s.cleanup, s.deviceErased, s.revision < 7,
    s' = { ...s, cleanup: false, revision: s.revision + 1 }
  }
  action step = {
    nondet owner = Bool.oneOf()
    nondet saved = Bool.oneOf()
    nondet exact = Bool.oneOf()
    any {
      tick, delete, review, restore, erase(owner, saved), sweep(saved),
      shareAudio(exact), restart, observeDeviceErase, acknowledge(owner, exact), s' = s
    }
  }

  val safety = all {
    s.note == "erased" implies (s.retentionOn and not(s.sharedAudio)),
    s.cleanup implies (s.note == "erased" and s.audio),
    s.deviceErased implies (s.note == "erased" and s.audio),
    (s.note == "erased" and s.audio and not(s.deviceErased)) implies s.cleanup
  }

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
}
