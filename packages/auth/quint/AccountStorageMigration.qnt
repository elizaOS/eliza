// Locked account reads validate the authenticated binding and record identity
// before rewriting. A load publishes one file. A list uses the same per-file
// write, so a later failure can leave an earlier migration visible on disk.
module AccountStorageMigration {
  val slots = Set(1, 2)
  val formats = Set("legacy", "plaintext", "canonical", "corrupt", "wrong-identity")
  type Artifact = { format: str, generation: int, payload: int }
  type State = {
    original: int -> Artifact, current: int -> Artifact, writes: int -> int,
    before: Artifact, candidate: Artifact, staged: int -> int, result: int -> int,
    operation: str, cursor: int, phase: str, outcome: str, attempts: int,
  }
  val empty = slots.mapBy(_ => 0)
  val unused = { format: "corrupt", generation: 0, payload: 0 }
  var s: State

  pure def artifact(id: int, format: str, withGeneration: bool): Artifact =
    { format: format, generation: if (withGeneration) id else 0, payload: id }
  action start(first: str, firstHasGeneration: bool, second: str, secondHasGeneration: bool): bool = {
    val records = Map(1 -> artifact(1, first, firstHasGeneration), 2 -> artifact(2, second, secondHasGeneration))
    s' = {
      original: records, current: records, writes: empty,
      before: unused, candidate: unused, staged: empty, result: empty,
      operation: "load", cursor: 1, phase: "idle", outcome: "none", attempts: 0,
    }
  }
  action init = {
    nondet first = formats.oneOf()
    nondet second = formats.oneOf()
    nondet firstHasGeneration = Set(false, true).oneOf()
    nondet secondHasGeneration = Set(false, true).oneOf()
    start(first, firstHasGeneration, second, secondHasGeneration)
  }

  // Other callers acquire the existing lock after the preceding operation.
  action begin(operation: str, id: int): bool = all {
    s.phase.in(Set("idle", "done")), s.attempts < 2,
    s' = {
      ...s, operation: operation, cursor: id, phase: "inspect",
      before: unused, candidate: unused, staged: empty, result: empty,
      outcome: "pending", attempts: s.attempts + 1,
    },
  }
  pure def acceptRecord(state: State): State = {
    val staged = state.staged.set(state.cursor, state.current.get(state.cursor).generation)
    if (state.operation == "list" and state.cursor == 1) {
      ...state, staged: staged, cursor: 2, phase: "inspect",
    } else {
      ...state, staged: staged, result: staged, phase: "done", outcome: "returned",
    }
  }

  action inspect = {
    val current = s.current.get(s.cursor)
    all {
      s.phase == "inspect",
      s' = if (current.format.in(Set("corrupt", "wrong-identity"))) {
        ...s, before: current, phase: "done", outcome: "invalid",
      } else if (current.format == "canonical" and current.generation > 0) {
        acceptRecord(s)
      } else {
        ...s, phase: "stage", before: current,
        candidate: {
          ...current, format: "canonical",
          generation: if (current.generation == 0) s.cursor + 2 else current.generation,
        },
      },
    }
  }
  // The temp file remains private until the atomic rename. Before-rename I/O
  // failures leave the original file. A later sync failure leaves visible bytes
  // but the interrupted read still throws.
  action failBeforeRename = all {
    s.phase == "stage",
    s' = { ...s, phase: "done", outcome: "before-error" },
  }
  action publish = all {
    s.phase == "stage",
    s' = {
      ...s, phase: "sync", current: s.current.set(s.cursor, s.candidate),
      writes: s.writes.set(s.cursor, s.writes.get(s.cursor) + 1),
    },
  }
  action failAfterRename = all {
    s.phase == "sync",
    s' = { ...s, phase: "done", outcome: "after-error" },
  }
  action confirm = all { s.phase == "sync", s' = acceptRecord(s) }

  action readWork = any { inspect, publish, failBeforeRename, failAfterRename, confirm }
  action step = any {
    begin("load", 1), begin("load", 2), begin("list", 1),
    readWork,
    s' = s,
  }

  val TypeOK = and {
    s.attempts.in(0.to(2)), s.cursor.in(slots),
    s.current.keys() == slots, s.result.keys() == slots, s.writes.keys() == slots,
    s.phase.in(Set("idle", "inspect", "stage", "sync", "done")),
    s.outcome.in(Set("none", "pending", "invalid", "returned", "before-error", "after-error")),
  }
  val PreservesContentsAndExistingGeneration = slots.forall(id => {
    val old = s.original.get(id)
    val current = s.current.get(id)
    current.payload == old.payload and (old.generation > 0).implies(current.generation == old.generation)
  })
  val InvalidRecordsStayUntouched = slots.forall(id =>
    s.original.get(id).format.in(Set("corrupt", "wrong-identity"))
      .implies(s.current.get(id) == s.original.get(id) and s.writes.get(id) == 0))
  val OneCanonicalRewritePerFile = slots.forall(id => {
    val old = s.original.get(id)
    s.writes.get(id) <= 1 and
      (old.format == "canonical" and old.generation > 0).implies(s.writes.get(id) == 0)
  })
  val FailedReadHasNoResult = (s.outcome != "returned").implies(s.result == empty)
  val ReturnedRecordsAreCanonical = (s.outcome == "returned").implies(
    slots.forall(id => {
      val current = s.current.get(id)
      val requested = s.operation == "list" or id == s.cursor
      if (requested) {
        current.format == "canonical" and current.generation > 0 and
          s.result.get(id) == current.generation
      } else s.result.get(id) == 0
    }))
  val FailurePreservesPublicationBoundary = and {
    s.outcome.in(Set("invalid", "before-error")).implies(s.current.get(s.cursor) == s.before),
    (s.outcome == "after-error").implies(s.current.get(s.cursor) == s.candidate),
  }
  val EarlierListRewriteSurvives = (s.operation == "list" and s.cursor == 2 and s.staged.get(1) > 0).implies(
    s.current.get(1).format == "canonical" and s.current.get(1).generation == s.staged.get(1))

  temporal AdmittedReadSettles = readWork.weakFair(s) implies
    always(s.phase.in(Set("inspect", "stage", "sync")).implies(eventually(s.phase == "done")))

  run oldBindingPreservesGenerationTest = start("legacy", true, "canonical", true)
    .then(begin("load", 1)).then(inspect).then(publish).then(confirm)
    .expect(s.result.get(1) == 1 and PreservesContentsAndExistingGeneration)
  run rejectedIdentityDoesNotRewriteTest = start("wrong-identity", true, "canonical", true)
    .then(begin("load", 1)).then(inspect)
    .expect(s.outcome == "invalid" and InvalidRecordsStayUntouched and FailedReadHasNoResult)
  run preRenameErrorLeavesLegacyForRetryTest = start("legacy", false, "canonical", true)
    .then(begin("load", 1)).then(inspect).then(failBeforeRename)
    .expect(s.current.get(1).format == "legacy" and FailedReadHasNoResult)
    .then(begin("load", 1)).then(inspect).then(publish).then(confirm)
    .expect(s.result.get(1) == 3 and s.writes.get(1) == 1)
  run postRenameErrorWithholdsResultButRetryReadsSameGenerationTest =
    start("legacy", false, "canonical", true)
    .then(begin("load", 1)).then(inspect).then(publish).then(failAfterRename)
    .expect(s.current.get(1).format == "canonical" and FailedReadHasNoResult)
    .then(begin("load", 1)).then(inspect)
    .expect(s.result.get(1) == 3 and s.writes.get(1) == 1)
  run laterCorruptionLeavesEarlierListRewriteTest = start("legacy", true, "corrupt", false)
    .then(begin("list", 1)).then(inspect).then(publish).then(confirm).then(inspect)
    .expect(s.outcome == "invalid" and FailedReadHasNoResult and
      s.current.get(1).format == "canonical" and s.current.get(1).generation == 1)
}
