// Source: shared/src/lib/services/credits.ts (reserve and reconcileReservationTransaction).
// A single server-owned reservation, with competing inline and recovery writers.
// Integer amounts abstract exact money units; real rounding and SQL isolation are
// covered by PGlite/Postgres tests, not by this finite state model. An atomic
// action represents a committed transaction; crash represents rollback before commit.
module billing_reservations {
  var phase: str
  var balance: int
  var reserved: int
  var actual: int
  var collected: int
  var refunds: int
  var overages: int
  var commits: int
  var winner: str

  action init = all {
    phase' = "new", balance' = 5, reserved' = 0, actual' = -1,
    collected' = 0, refunds' = 0, overages' = 0, commits' = 0,
    winner' = "none",
  }

  action hold(amount: int): bool = all {
    phase == "new", amount > 0, amount <= balance,
    phase' = "held", balance' = balance - amount, reserved' = amount,
    actual' = actual, collected' = amount, refunds' = refunds,
    overages' = overages, commits' = commits, winner' = winner,
  }

  action settle(cost: int, writer: str): bool = {
    val refund = if (cost < reserved) reserved - cost else 0
    val overage = if (cost > reserved and balance >= cost - reserved) cost - reserved else 0
    all {
      phase == "held", cost >= 0,
      phase' = "settled", balance' = balance + refund - overage,
      reserved' = reserved, actual' = cost,
      collected' = reserved - refund + overage,
      refunds' = refund, overages' = overage,
      commits' = commits + 1, winner' = writer,
    }
  }

  // A failed transaction or a duplicate loser moves no money. Post-commit
  // notification retries are deliberately outside the monetary authority.
  action noCommit = all {
    phase' = phase, balance' = balance, reserved' = reserved, actual' = actual,
    collected' = collected, refunds' = refunds, overages' = overages,
    commits' = commits, winner' = winner,
  }

  action attemptSettlement(cost: int, writer: str): bool =
    if (phase == "held") settle(cost, writer) else noCommit

  action step = {
    nondet amount = 1.to(3).oneOf()
    nondet cost = 0.to(8).oneOf()
    nondet writer = Set("inline", "sweep").oneOf()
    any { hold(amount), attemptSettlement(cost, writer), noCommit }
  }

  val safety = all {
    balance >= 0, collected >= 0, balance + collected == 5,
    commits <= 1, refunds >= 0, refunds <= reserved, overages >= 0,
    collected == reserved - refunds + overages,
    phase != "settled" or commits == 1,
    phase != "settled" or collected <= actual,
    phase != "settled" or Set("inline", "sweep").contains(winner),
  }

  run refundRaceTest = init.then(hold(3)).then(settle(1, "inline"))
    .then(attemptSettlement(0, "sweep"))
    .expect(safety and balance == 4 and actual == 1 and winner == "inline")
  run recoveryWinsTest = init.then(hold(2)).then(noCommit).then(settle(1, "sweep"))
    .then(attemptSettlement(0, "inline"))
    .expect(safety and commits == 1 and actual == 1 and winner == "sweep")
  run overageTest = init.then(hold(2)).then(settle(4, "inline"))
    .expect(safety and balance == 1 and overages == 2)
  run uncollectedOverageTest = init.then(hold(2)).then(settle(8, "sweep"))
    .expect(safety and balance == 3 and actual == 8 and collected == 2)
  run zeroCostTest = init.then(hold(3)).then(settle(0, "inline"))
    .expect(safety and balance == 5 and refunds == 3)
}
