// Legacy snapshots stay complete until their complete normalized row set commits.
module LegacyTrajectoryMigration {
  var s: { rows: int, staged: int, migrating: bool, failureUsed: bool, reads: int }
  action init = s' = { rows: 0, staged: 0, migrating: false, failureUsed: false, reads: 0 }
  action begin = all { s.rows == 0, not(s.migrating), s' = { ...s, migrating: true } }
  action writeStep = all { s.migrating, s.staged < 2, s' = { ...s, staged: s.staged + 1 } }
  action rollback = all { s.migrating, not(s.failureUsed), s' = { ...s, staged: 0, migrating: false, failureUsed: true } }
  action commit = all { s.migrating, s.staged == 2, s' = { ...s, rows: 2, staged: 0, migrating: false } }
  // Readers use all normalized rows, or the complete retained snapshot on rollback.
  val visible = if (s.rows == 0) 2 else s.rows
  action read = all { s.reads < 2, s' = { ...s, reads: s.reads + 1 } }
  action progress = any { begin, writeStep, rollback, commit }
  action step = any { progress, read, s' = s }
  val CompleteReads = visible == 2
  val AtomicRows = s.rows == 0 or s.rows == 2
  temporal MigrationSettles = progress.weakFair(s).implies(eventually(s.rows == 2))
  run rollbackPreservesHistoryTest = init.then(begin).then(writeStep).then(rollback).then(read)
    .expect(CompleteReads and AtomicRows and s.rows == 0)
    .then(begin).then(writeStep).then(writeStep).then(commit).then(read)
    .expect(CompleteReads and s.rows == 2)
}
