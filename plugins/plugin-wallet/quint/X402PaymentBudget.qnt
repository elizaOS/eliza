// sdk/x402/budget.ts reserve/recordPayment/releaseReservation and client.ts
// payment flow. The charged amount includes the protocol fee before reserve.
// Scope is calls through X402Client, with one service and a fixed budget.
module X402PaymentBudget {
  pure val Payments = Set("first", "second", "third")
  pure val DailyLimit = 6
  pure val PerRequestLimit = 4
  type State = {
    day: int, spent: int, phase: str -> str, amount: str -> int,
    held: Set[str], approved: Set[str], attempted: Set[str], recorded: Set[str]
  }
  var s: State
  val Pending = s.held.fold(0, (total, p) => total + s.amount.get(p))
  action init = s' = {
    day: 0, spent: 0, phase: Payments.mapBy(_ => "idle"), amount: Payments.mapBy(_ => 0),
    held: Set(), approved: Set(), attempted: Set(), recorded: Set()
  }
  action Reserve(p: str): bool = {
    nondet amount = 0.to(5).oneOf()
    all {
      s.phase.get(p) == "idle",
      if (amount <= PerRequestLimit and s.spent + Pending + amount <= DailyLimit)
        s' = { ...s, amount: s.amount.set(p, amount), held: s.held.union(Set(p)), phase: s.phase.set(p, "review") }
      else s' = { ...s, amount: s.amount.set(p, amount), phase: s.phase.set(p, "declined") }
    }
  }
  action Review(p: str): bool = {
    nondet approved = Set(true, false).oneOf()
    all {
      s.phase.get(p) == "review",
      if (approved) s' = { ...s, approved: s.approved.union(Set(p)), phase: s.phase.set(p, "approved") }
      else s' = { ...s, held: s.held.exclude(Set(p)), phase: s.phase.set(p, "declined") }
    }
  }
  action FailBeforeTransfer(p: str): bool = all {
    Set("review", "approved").contains(s.phase.get(p)),
    s' = { ...s, held: s.held.exclude(Set(p)), phase: s.phase.set(p, "failed") }
  }
  action AttemptTransfer(p: str): bool = all {
    s.phase.get(p) == "approved",
    s' = { ...s, attempted: s.attempted.union(Set(p)), phase: s.phase.set(p, "attempted") }
  }
  action TransferResponse(p: str): bool = {
    nondet confirmed = Set(true, false).oneOf()
    all {
      s.phase.get(p) == "attempted",
      if (confirmed) s' = { ...s, spent: s.spent + s.amount.get(p), held: s.held.exclude(Set(p)),
        recorded: s.recorded.union(Set(p)), phase: s.phase.set(p, "recorded") }
      else s' = { ...s, phase: s.phase.set(p, "unknown") }
    }
  }
  // maybeResetDaily clears settled daily totals. In-flight and uncertain
  // reservations survive the reset and still count against new admission.
  action NextDay = all { s.day == 0, s' = { ...s, day: 1, spent: 0 } }
  action step = any {
    { nondet p = Payments.oneOf()
      any { Reserve(p), Review(p), FailBeforeTransfer(p), AttemptTransfer(p), TransferResponse(p) } },
    NextDay, s' = s
  }
  val BudgetConserved = s.spent >= 0 and Pending >= 0 and s.spent + Pending <= DailyLimit
  val TransferHasApproval = s.attempted.subseteq(s.approved)
  val UnknownKeepsHold = Payments.forall(p => (s.phase.get(p) == "unknown").implies(s.held.contains(p)))
  val ReceiptReplacesReservation = s.recorded.intersect(s.held).size() == 0 and s.recorded.subseteq(s.attempted)
  val PreTransferFailureReleases = Payments.forall(p => Set("failed", "declined").contains(s.phase.get(p)).implies(not(s.held.contains(p))))
  val RecordedHasReceipt = Payments.forall(p => (s.phase.get(p) == "recorded").iff(s.recorded.contains(p)))
}
