// Wallet key restore/persist contract. Two key slots, opaque values (never actual secrets).
// Vault I/O serialized by the owning caller; cross-process vault transactions are external.
// A failed read must never be interpreted as absence and trigger key replacement.
module api_wallet_keys {
  var s: { env: int, vault: int, checked: bool, readFailed: bool, generated: bool, pending: bool, written: bool, failed: bool, rollbackFailed: bool }
  action initExisting = s' = { env: 0, vault: 1, checked: false, readFailed: false, generated: false, pending: false, written: false, failed: false, rollbackFailed: false }
  action initEmpty = s' = { env: 0, vault: 0, checked: false, readFailed: false, generated: false, pending: false, written: false, failed: false, rollbackFailed: false }
  action init = any { initExisting, initEmpty }
  action restore = all { s.env == 0, not(s.readFailed), s' = s.with("env", s.vault).with("checked", true) }
  action readError = all { not(s.checked), s' = s.with("readFailed", true) }
  action generate = all { s.checked, s.env == 0, not(s.readFailed), s' = s.with("env", 2).with("generated", true) }
  action persist = all { s.env != 0, not(s.pending), not(s.failed), s' = s.with("pending", true) }
  action write = all { s.pending, not(s.failed), s' = s.with("written", true) }
  action commit = all { s.pending, s.written, not(s.failed), s' = s.with("pending", false).with("vault", s.env) }
  action failure = all { s.pending, s' = s.with("failed", true) }
  action rollback = all { s.pending, s.failed, s' = s.with("written", false).with("pending", false) }
  action rollbackFailure = all { s.pending, s.failed, s' = s.with("rollbackFailed", true).with("pending", false) }
  action idle = s' = s
  action step = any { restore, readError, generate, persist, write, commit, failure, rollback, rollbackFailure, idle }
  val safety = all { s.generated implies (s.checked and not(s.readFailed)), s.readFailed implies not(s.generated), s.rollbackFailed implies s.failed }
  run existingVaultPreventsRegenerationTest = initExisting.then(restore).expect(s.env == 1 and not(s.generated))
  run readFailurePreservesWalletTest = initExisting.then(readError).expect(s.env == 0 and s.vault == 1 and not(s.generated))
  run rollbackFailureIsVisibleTest = initExisting.then(restore).then(persist).then(write).then(failure).then(rollbackFailure).expect(s.failed and s.rollbackFailed)
  run emptyVaultPermitsGenerationTest = initEmpty.then(restore).then(generate).expect(s.generated and s.env == 2)
}
