// A cancelled Shared stream stages an exact history pair before its room can
// admit another reader. The finalizer and the durable checkpoint settle
// independently. A new generation reads the checkpoint after eviction.
module SharedInterruptedTurn {
  pure val Snapshot = List("prior history")
  pure val Interrupted = List("exact user text", "partial assistant text marked interrupted")
  var s: {
    phase: str, generation: int, archive: List[str], finalizer: str,
    observed: List[str], readGeneration: int
  }

  action init = s' = {
    phase: "streaming", generation: 1, archive: List(),
    finalizer: "none", observed: List(), readGeneration: 0
  }
  action cancelStream = all {
    s.phase == "streaming",
    s' = s.with("phase", "checkpointing").with("finalizer", "pending")
  }
  action checkpointReply(success: bool): bool = all {
    s.phase == "checkpointing",
    s' = if (success) s.with("phase", "persisted").with("archive", Interrupted)
      else s.with("phase", "closed")
  }
  action releaseRoom = all {
    s.phase == "persisted",
    s' = s.with("phase", "open")
  }
  action finalizeReply(success: bool): bool = all {
    s.finalizer == "pending",
    s' = s.with("finalizer", if (success) "settled" else "failed")
  }
  action evict = all {
    s.phase == "open", s.generation == 1,
    s' = s.with("phase", "reloading").with("generation", 2)
      .with("finalizer", if (s.finalizer == "pending") "retired" else s.finalizer)
  }
  action reload = all {
    s.phase == "reloading",
    s' = s.with("phase", "open")
  }
  action readHistory = all {
    s.phase == "open", s.readGeneration != s.generation,
    s' = s.with("observed", Snapshot.concat(s.archive))
      .with("readGeneration", s.generation)
  }
  action checkpoint = any { checkpointReply(true), checkpointReply(false) }
  action finalize = any { finalizeReply(true), finalizeReply(false) }
  action step = any {
    cancelStream, checkpoint, releaseRoom, finalize, evict, reload, readHistory,
    s' = s
  }

  val ReleaseNeedsCheckpoint =
    Set("persisted", "open", "reloading").contains(s.phase) implies s.archive == Interrupted
  val FailureHoldsRoom =
    s.phase == "closed" implies (s.generation == 1 and s.archive == List() and s.readGeneration == 0)
  val ReadRetainsHistory =
    s.readGeneration > 0 implies s.observed == Snapshot.concat(Interrupted)
  temporal CheckpointStaysDurable =
    always((s.archive == Interrupted implies next(s.archive) == Interrupted).orKeep(s))
  temporal GateSettles = Set("checkpointing", "persisted").contains(s.phase)
    .leadsTo(Set("closed", "open", "reloading").contains(s.phase))
  temporal FairGateSettles = (checkpoint.weakFair(s) and releaseRoom.weakFair(s)) implies GateSettles
  temporal FairReload = reload.weakFair(s) implies (s.phase == "reloading").leadsTo(s.phase == "open")

  run PendingFinalizationDoesNotOwnRoomTest = init.then(cancelStream)
    .then(checkpointReply(true)).then(releaseRoom).then(readHistory)
    .expect(s.finalizer == "pending" and ReleaseNeedsCheckpoint and ReadRetainsHistory)
  run EvictionRecoversInterruptedPairTest = init.then(cancelStream).then(finalizeReply(false))
    .then(checkpointReply(true)).then(releaseRoom).then(evict).then(reload).then(readHistory)
    .expect(s.readGeneration == 2 and ReadRetainsHistory and s.finalizer == "failed")
  run FailedCheckpointKeepsRoomClosedTest = init.then(cancelStream).then(checkpointReply(false))
    .then(finalizeReply(true)).expect(FailureHoldsRoom and s.phase == "closed")
}

// The same Durable Object retires non-Personal snapshots after idle expiry.
// The alarm captures a deadline before external mirror I/O. The transaction
// rechecks that deadline and the selected version before dropping the snapshot
// and its replay claims together.
module SharedMirrorRetirement {
  var s: {
    latest: int, mirrored: int, deadline: int, due: bool,
    phase: str, captured: int, candidate: int, mayReject: bool
  }

  action initial(mirrored: int): bool = s' = {
    latest: 1, mirrored: mirrored, deadline: 1, due: true,
    phase: "waiting", captured: 0, candidate: 0, mayReject: true
  }

  action init = any { initial(0), initial(1) }

  action save(refresh: bool): bool = all {
    s.phase != "retired", s.latest == 1,
    refresh or Set("mirroring", "committing").contains(s.phase),
    s' = if (refresh)
      s.with("latest", 2).with("deadline", s.deadline + 1).with("due", false)
    else s.with("latest", 2)
  }

  action due = all {
    s.phase != "retired", not(s.due),
    s' = s.with("due", true)
  }

  action wake = all {
    s.phase == "waiting", s.due,
    s' = s.with("phase", "checking").with("captured", s.deadline)
  }

  action selectSnapshot = all {
    s.phase == "checking",
    s' = if (s.captured != s.deadline) s.with("phase", "waiting")
      else s.with("candidate", s.latest)
        .with("phase", if (s.mirrored == s.latest) "committing" else "mirroring")
  }

  action mirror(success: bool): bool = all {
    s.phase == "mirroring", success or s.mayReject,
    s' = if (success)
      s.with("mirrored", s.candidate).with("phase", "committing")
    else s.with("mayReject", false).with("phase", "committing")
  }

  action mirrorReply = any { mirror(true), mirror(false) }

  action acknowledgeQueuedMirror = all {
    Set("waiting", "checking", "committing").contains(s.phase),
    s.mirrored < s.latest,
    s' = s.with("mirrored", s.latest)
  }

  action settle = all {
    s.phase == "committing",
    s' = if (s.captured != s.deadline) s.with("phase", "waiting")
      else if (s.candidate != s.latest or s.mirrored != s.latest)
        s.with("phase", "waiting").with("deadline", s.deadline + 1).with("due", false)
      else s.with("phase", "retired")
  }

  action step = any {
    save(true), save(false), due, wake, selectSnapshot, mirrorReply,
    acknowledgeQueuedMirror, settle, s' = s
  }

  // In the terminal phase, these tokens are the transaction's historical
  // inputs. The local snapshot, replay claims and expiry are all absent.
  val RetiresMirrorConfirmedSnapshot = s.phase == "retired" implies s.latest == s.mirrored
  val RetiresSelectedVersion = s.phase == "retired" implies s.latest == s.candidate
  val RetiresCurrentDueDeadline = s.phase == "retired" implies
    (s.captured == s.deadline and s.due)

  temporal RetiresEventually = eventually(s.phase == "retired")
  temporal FairRetirement =
    (due.weakFair(s) and wake.weakFair(s) and selectSnapshot.weakFair(s)
      and mirrorReply.weakFair(s) and settle.weakFair(s)) implies RetiresEventually

  run RenewalDuringEarlierMirrorTest = initial(0).then(wake).then(save(true))
    .then(selectSnapshot).expect(s.phase == "waiting" and not(s.due) and s.latest == 2)
  run RenewalDuringExpiryMirrorTest = initial(0).then(wake).then(selectSnapshot)
    .then(save(true)).then(mirror(false)).then(acknowledgeQueuedMirror).then(settle)
    .expect(s.phase == "waiting" and not(s.due) and s.latest == 2 and s.mirrored == 2)
  run ReplacedSnapshotBeforeDeadlineRefreshTest = initial(1).then(wake).then(selectSnapshot)
    .then(save(false)).then(acknowledgeQueuedMirror).then(settle)
    .expect(s.phase == "waiting" and not(s.due) and s.latest == 2)
  run FailedMirrorRearmsExpiryTest = initial(0).then(wake).then(selectSnapshot).then(mirror(false))
    .then(settle).expect(s.phase == "waiting" and s.mirrored == 0 and s.deadline == 2)
    .then(due).then(wake).then(selectSnapshot).then(mirror(true)).then(settle)
    .expect(s.phase == "retired" and RetiresMirrorConfirmedSnapshot
      and RetiresSelectedVersion and RetiresCurrentDueDeadline)
}
