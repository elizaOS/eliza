// One campaign and its retained allocation. The SQL transaction publishes deletion,
// balance restoration, credit receipt and advertising receipt together.
module ad_campaign_refund {
  pure val workers = Set(1, 2)
  pure val terminal = Set("idle", "failed", "done", "response_failed", "absent")
  type State = { row: bool, allocated: int, spent: int, balance: int,
    credit: bool, ledger: bool, receipt: int, lockOwner: int, accountingValid: bool,
    phase: int -> str, attempts: int -> int, observed: int -> int }
  var s: State
  action init = s' = { row: true, allocated: 5, spent: 2, balance: 0,
    credit: false, ledger: false, receipt: 0, lockOwner: 0, accountingValid: true,
    phase: workers.mapBy(_ => "idle"), attempts: workers.mapBy(_ => 0),
    observed: workers.mapBy(_ => 0) }
  // Corrupt retained NUMERIC input is unavailable, never an implicit zero refund.
  action corruptAccounting = all { workers.forall(worker => s.attempts.get(worker) == 0),
    s.accountingValid, s' = { ...s, accountingValid: false } }
  action begin(worker) = all {
    Set("idle", "failed").contains(s.phase.get(worker)), s.attempts.get(worker) < 2,
    s' = { ...s, phase: s.phase.set(worker, "waiting"),
      attempts: s.attempts.set(worker, s.attempts.get(worker) + 1),
      observed: s.observed.set(worker, s.allocated - s.spent) }
  }
  action spend = all { s.row, s.lockOwner == 0, s.spent < s.allocated,
    s' = { ...s, spent: s.spent + 1 } }
  action acquire(worker) = all { s.phase.get(worker) == "waiting", s.lockOwner == 0,
    s' = if (s.row) { ...s, lockOwner: worker, phase: s.phase.set(worker, "working") }
      else { ...s, phase: s.phase.set(worker, "absent") } }
  action commit(worker) = all { s.lockOwner == worker, s.phase.get(worker) == "working", s.row, s.accountingValid,
    val amount = s.allocated - s.spent
    s' = { ...s, row: false, balance: s.balance + amount, receipt: amount,
      credit: amount > 0, ledger: amount > 0, lockOwner: 0,
      phase: s.phase.set(worker, "committed") }
  }
  // Credit/advertising insertion failure, suppressed RETURNING, and SQL rollback
  // leave the original row and all financial state untouched.
  action rollback(worker) = all { s.lockOwner == worker, s.phase.get(worker) == "working",
    s' = { ...s, lockOwner: 0, phase: s.phase.set(worker, "failed") } }
  action reply(worker, failed) = all { s.phase.get(worker) == "committed",
    s' = { ...s, phase: s.phase.set(worker, if (failed) "response_failed" else "done") } }
  action advance = { nondet worker = workers.oneOf()
    any { acquire(worker), commit(worker), rollback(worker), reply(worker, false), reply(worker, true) } }
  action step = { nondet worker = workers.oneOf()
    any { begin(worker), spend, corruptAccounting, advance, s' = s } }
  val safety = all {
    s.balance + s.spent + (if (s.row) s.allocated - s.spent else 0) == 5,
    s.credit == s.ledger,
    not(s.accountingValid) implies (s.row and not(s.credit) and s.balance == 0),
    s.credit implies (not(s.row) and s.receipt == s.balance and s.receipt > 0),
    s.lockOwner != 0 implies s.row,
  }
  temporal RequestsSettle = advance.weakFair(s) implies
    always(workers.forall(worker => not(terminal.contains(s.phase.get(worker)))
      implies eventually(terminal.contains(s.phase.get(worker)))))

  run completeSettlementTest = init.then(begin(1)).then(acquire(1)).then(commit(1))
    .then(reply(1, false)).expect(safety and s.balance == 3 and s.credit and s.ledger)
  run rollbackRetainsAllocationTest = init.then(begin(1)).then(acquire(1)).then(rollback(1))
    .expect(safety and s.row and s.balance == 0)
  run retryAfterRollbackTest = init.then(begin(1)).then(acquire(1)).then(rollback(1))
    .then(begin(1)).then(acquire(1)).then(commit(1)).expect(safety and s.balance == 3)
  run waitingDeleteAfterRollbackTest = init.then(begin(1)).then(begin(2)).then(acquire(1))
    .then(rollback(1)).then(acquire(2)).then(commit(2)).expect(safety and s.balance == 3)
  run concurrentDeletesTest = init.then(begin(1)).then(begin(2)).then(acquire(1))
    .then(commit(1)).then(acquire(2)).expect(safety and s.phase.get(2) == "absent" and s.balance == 3)
  run spendBeforeClaimTest = init.then(begin(1)).then(spend).then(acquire(1))
    .then(commit(1)).expect(safety and s.observed.get(1) == 3 and s.balance == 2)
  run fullySpentTest = init.then(spend).then(spend).then(spend).then(begin(1))
    .then(acquire(1)).then(commit(1)).expect(safety and s.balance == 0 and not(s.credit))
  run lostReplyCannotRepeatRefundTest = init.then(begin(1)).then(acquire(1)).then(commit(1))
    .then(reply(1, true)).then(begin(2)).then(acquire(2)).expect(safety and s.balance == 3)
  run corruptAccountingPreservesAllocationTest = init.then(corruptAccounting).then(begin(1))
    .then(acquire(1)).then(rollback(1)).expect(safety and s.row and s.balance == 0)
  action oldDeleteBeforeRefund = s' = { ...s, row: false }
  action oldRefundBeforeLedger = s' = { ...s, row: false, balance: 3, credit: true, receipt: 3 }
  run lostAllocationWitnessTest = init.then(oldDeleteBeforeRefund).expect(not(safety))
  run splitLedgerWitnessTest = init.then(oldRefundBeforeLedger).expect(not(safety))
}
