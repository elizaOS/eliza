// Native task-evidence-store append-only transactions, owner/epoch and idempotency.
// Evidence records do not authorize or transition the separate task journal.
module api_native_evidence {
  var s: { epoch: int, recorded: Set[int], length: int, transaction: bool, staged: int, captured: int, failed: bool }
  action init = s' = { epoch: 0, recorded: Set(), length: 0, transaction: false, staged: 0, captured: -1, failed: false }
  action begin(id: int): bool = all { not(s.transaction), not(s.failed), s.length < 2, not(s.recorded.contains(id)), s' = s.with("transaction", true).with("staged", id).with("captured", s.epoch) }
  action commit = all { s.transaction, s.captured == s.epoch, s' = s.with("transaction", false).with("recorded", s.recorded.union(Set(s.staged))).with("length", s.length + 1).with("staged", 0) }
  action duplicate(id: int): bool = all { s.recorded.contains(id), s' = s }
  action rollback = all { s.transaction, s' = s.with("transaction", false).with("staged", 0) }
  action rollbackFailure = all { s.transaction, s' = s.with("transaction", false).with("staged", 0).with("failed", true) }
  action advanceEpoch = all { not(s.transaction), s.epoch < 2, s' = s.with("epoch", s.epoch + 1) }
  action idle = s' = s
  action step = any { begin(1), begin(2), commit, duplicate(1), duplicate(2), rollback, rollbackFailure, advanceEpoch, idle }
  val safety = all { s.length == s.recorded.size(), s.length <= 2, s.length >= 0, s.transaction implies (s.staged != 0 and s.captured == s.epoch), s.failed implies not(s.transaction) }
  run duplicateDoesNotAdvanceSequenceTest = init.then(begin(1)).then(commit).then(duplicate(1)).expect(s.length == 1)
  run rollbackDoesNotPublishTest = init.then(begin(1)).then(rollback).expect(s.recorded == Set() and s.length == 0)
  run rollbackFailureDiscardsConnectionTest = init.then(begin(1)).then(rollbackFailure).expect(s.failed)
}
