// One environment's protected four-client snapshot, its transaction, and
// idempotent import receipt. Source/provider authenticity is checked before
// begin and is an assumption represented by validSource, not proved here.
module NativeRegistryMigration {
  var storedRows: int
  var stagedRows: int
  var receiptRows: int
  var phase: str
  var validSource: bool
  var conflict: bool
  action init = all { storedRows' = 0, stagedRows' = 0, receiptRows' = 0,
    phase' = "idle", validSource' = true, conflict' = false }
  action begin(valid: bool, conflicting: bool): bool = all {
    phase != "running", phase' = "running", validSource' = valid, conflict' = conflicting,
    stagedRows' = 0, storedRows' = storedRows, receiptRows' = receiptRows
  }
  action stage = all { phase == "running", validSource, not(conflict),
    stagedRows' = 4, storedRows' = storedRows, receiptRows' = receiptRows,
    phase' = phase, validSource' = validSource, conflict' = conflict }
  action commit = all { phase == "running", validSource, not(conflict), stagedRows == 4,
    storedRows' = 4, receiptRows' = 4, stagedRows' = 0, phase' = "committed",
    validSource' = validSource, conflict' = conflict }
  action rollback = all { phase == "running", storedRows' = storedRows,
    receiptRows' = receiptRows, stagedRows' = 0, phase' = "idle",
    validSource' = validSource, conflict' = conflict }
  action step = any {
    { nondet valid = Bool.oneOf(); nondet conflicting = Bool.oneOf(); begin(valid, conflicting) },
    stage, commit, rollback
  }
  val atomic = storedRows.in(Set(0, 4)) and receiptRows == storedRows
  val bounded = stagedRows.in(Set(0, 4))
  val safety = atomic and bounded
  run importAndRetryTest = init.then(begin(true, false)).then(stage).then(commit)
    .then(begin(true, false)).then(stage).then(commit).expect(storedRows == 4 and receiptRows == 4)
  run conflictDoesNotPublishTest = init.then(begin(true, true)).then(rollback).expect(storedRows == 0 and receiptRows == 0)
  run invalidSourceDoesNotPublishTest = init.then(begin(false, false)).then(rollback).expect(storedRows == 0 and receiptRows == 0)
  run rollbackPreservesPriorImportTest = init.then(begin(true, false)).then(stage).then(commit)
    .then(begin(true, true)).then(rollback).expect(storedRows == 4 and receiptRows == 4)
}
