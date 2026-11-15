// account-state.mjs: fixed filename order, private temporary write, atomic rename.
// One account has three selected configuration files and at most two calls.
// "retained" combines absent files and parsed files without the selected string.
// Filesystem settlement is explicit; bytes, directories and credential hashing
// are checked by real disk/process scenarios rather than duplicated as state.
module NativeAccountMigration {
  val slots = Set(0, 1, 2)
  type State = { files: int -> str, cursor: int, phase: str, attempts: int }
  var s: State

  action initialize(middle: str): bool = s' = {
    files: Map(0 -> "dirty", 1 -> middle, 2 -> "dirty"),
    cursor: 0, phase: "idle", attempts: 0,
  }
  action init = any { initialize("retained"), initialize("invalid") }
  action begin = all {
    s.phase.in(Set("idle", "done", "failed")), s.attempts < 2,
    s' = { ...s, cursor: 0, phase: "inspect", attempts: s.attempts + 1 },
  }
  pure def advance(state: State): State = if (state.cursor == 2) {
    ...state, cursor: 3, phase: "done",
  } else {
    ...state, cursor: state.cursor + 1, phase: "inspect",
  }
  action inspect = all {
    s.phase == "inspect",
    s' = if (s.files.get(s.cursor).in(Set("retained", "clean"))) advance(s)
      else if (s.files.get(s.cursor) == "dirty") { ...s, phase: "write" }
      else { ...s, phase: "failed" },
  }
  // writeFile(..., {flag:"wx",mode:0600}) stages a private replacement.
  // The selected original file still contains its complete previous document.
  action write = all { s.phase == "write", s' = { ...s, phase: "rename" } }
  // rename's effect and acknowledgement settle together in this projection.
  action publish = all {
    s.phase == "rename",
    s' = advance({ ...s, files: s.files.set(s.cursor, "clean") }),
  }
  action ioFailure = all {
    s.phase.in(Set("inspect", "write", "rename")),
    s' = { ...s, phase: "failed" },
  }
  // Host repair is a distinct operation after the rejected call. Migration
  // itself never replaces a malformed or unsafe configuration.
  action repair = all {
    s.phase == "failed", s.attempts == 1, s.cursor == 1,
    s.files.get(1) == "invalid",
    s' = { ...s, files: s.files.set(1, "dirty") },
  }
  action settle = any { inspect, write, publish, ioFailure }
  action step = any { begin, repair, settle, s' = s }

  val active = s.phase.in(Set("inspect", "write", "rename"))
  val terminal = s.phase.in(Set("done", "failed"))
  val TypeOK = and {
    s.files.keys() == slots,
    slots.forall(id => s.files.get(id).in(Set("dirty", "retained", "invalid", "clean"))),
    s.cursor.in(0.to(3)), s.attempts.in(0.to(2)),
    s.phase.in(Set("idle", "inspect", "write", "rename", "done", "failed")),
    active.implies(s.cursor.in(slots)),
  }
  val CompletedPrefixIsClean = slots.forall(id =>
    (id < s.cursor).implies(s.files.get(id).in(Set("retained", "clean"))))
  val OnlyDirtyFilesAreStaged = s.phase.in(Set("write", "rename")).implies(
    s.files.get(s.cursor) == "dirty")
  val SuccessHasNoSelectedCredential = (s.phase == "done").implies(
    slots.forall(id => s.files.get(id).in(Set("retained", "clean"))))
  temporal CleanFilesStayClean = always(slots.forall(id =>
    (s.files.get(id) == "clean").implies(next(s.files).get(id) == "clean")).orKeep(s))
  temporal FailurePreservesOriginal = always((active and next(s.phase) == "failed").implies(
    next(s.files) == s.files).orKeep(s))
  temporal MigrationSettles = settle.weakFair(s).implies(active.leadsTo(terminal))
  temporal MigrationWithoutFairness = active.leadsTo(terminal)

  run writeDoesNotPublishEarlyTest = initialize("retained").then(begin)
    .then(inspect).then(write).expect(s.files.get(0) == "dirty")
    .then(ioFailure).expect(s.phase == "failed" and s.files.get(0) == "dirty")
  run laterRejectionKeepsEarlierPublicationTest = initialize("invalid").then(begin)
    .then(inspect).then(write).then(publish).then(inspect)
    .expect(s.phase == "failed" and s.files.get(0) == "clean" and s.files.get(2) == "dirty")
  run repairAndRetryTest = initialize("invalid").then(begin)
    .then(inspect).then(write).then(publish).then(inspect).then(repair).then(begin)
    .then(inspect).then(inspect).then(write).then(publish)
    .then(inspect).then(write).then(publish)
    .expect(s.phase == "done" and SuccessHasNoSelectedCredential)
  run cleanRetryDoesNotStageFilesTest = initialize("retained").then(begin)
    .then(inspect).then(write).then(publish).then(inspect)
    .then(inspect).then(write).then(publish).then(begin)
    .then(inspect).then(inspect).then(inspect)
    .expect(s.phase == "done" and s.attempts == 2)
}
