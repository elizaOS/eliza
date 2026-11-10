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
