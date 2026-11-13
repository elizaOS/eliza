// Finite projection of api/src/inference-admission-budget.ts.
// Two installed grants of two units and two immutable request IDs. Durable
// transactions are atomic; provider execution and database minting are outside
// this model. Expiry blocks new reservations, not settlement of existing work.
module inference_budget {
  type Allocation = { first: int, second: int }
  type Budget = {
    clock: int,
    phases: str -> str,
    maxima: str -> int,
    deadlines: str -> int,
    allocated: str -> Allocation,
    charges: str -> int,
    acknowledged: Set[str],
    outbox: Set[str],
    remaining: int -> int,
    consumed: int -> int,
    active: int -> int,
    unacknowledged: int -> int,
    sequence: int -> int,
    sealed: Set[int],
    sealConsumed: int -> int,
  }
  pure val requests = Set("first", "second")
  pure val grants = Set(1, 2)
  pure val emptyAllocation = { first: 0, second: 0 }
  pure def min(a, c) = if (a < c) a else c
  pure def countPositive(amount) = if (amount > 0) 1 else 0
  var budget: Budget

  action init = budget' = {
    clock: 0,
    phases: Map("first" -> "new", "second" -> "new"),
    maxima: Map("first" -> 0, "second" -> 0),
    deadlines: Map("first" -> 0, "second" -> 0),
    allocated: Map("first" -> emptyAllocation, "second" -> emptyAllocation),
    charges: Map("first" -> -1, "second" -> -1),
    acknowledged: Set(),
    outbox: Set(),
    remaining: Map(1 -> 2, 2 -> 2),
    consumed: Map(1 -> 0, 2 -> 0),
    active: Map(1 -> 0, 2 -> 0),
    unacknowledged: Map(1 -> 0, 2 -> 0),
    sequence: Map(1 -> 0, 2 -> 0),
    sealed: Set(),
    sealConsumed: Map(1 -> -1, 2 -> -1),
  }

  action unchanged = budget' = budget
  def terminal(r) = Set("completed", "cancelled").contains(budget.phases.get(r))
  def available(g) = if (not(budget.sealed.contains(g)) and budget.clock < g + 1)
    budget.remaining.get(g) else 0
  def canReserve(r) = all {
    budget.phases.get(r) == "prepared",
    budget.clock < budget.deadlines.get(r),
    available(1) + available(2) >= budget.maxima.get(r),
  }
  action prepare(r, maximum) = all {
    budget.phases.get(r) == "new",
    maximum >= 1 and maximum <= 3,
    budget' = budget
      .with("phases", budget.phases.set(r, "prepared"))
      .with("maxima", budget.maxima.set(r, maximum))
      .with("deadlines", budget.deadlines.set(r, budget.clock + 1)),
  }
  action reserve(r) = {
    val first = min(available(1), budget.maxima.get(r))
    val second = budget.maxima.get(r) - first
    all {
      canReserve(r),
      budget' = budget
        .with("phases", budget.phases.set(r, "dispatched"))
        .with("allocated", budget.allocated.set(r, { first: first, second: second }))
        .with("remaining", Map(1 -> budget.remaining.get(1) - first, 2 -> budget.remaining.get(2) - second))
        .with("active", Map(1 -> budget.active.get(1) + countPositive(first), 2 -> budget.active.get(2) + countPositive(second))),
    }
  }
  action tryReserve(r) = if (canReserve(r)) reserve(r) else unchanged
  action settle(r, cost, cancel) = {
    val held = budget.allocated.get(r)
    val first = min(cost, held.first)
    val second = cost - first
    all {
      budget.phases.get(r) == "dispatched",
      cost >= 0 and cost <= budget.maxima.get(r),
      not(cancel) or cost == 0,
      budget' = budget
        .with("phases", budget.phases.set(r, if (cancel) "cancelled" else "completed"))
        .with("charges", budget.charges.set(r, cost))
        .with("remaining", Map(1 -> budget.remaining.get(1) + held.first - first, 2 -> budget.remaining.get(2) + held.second - second))
        .with("consumed", Map(1 -> budget.consumed.get(1) + first, 2 -> budget.consumed.get(2) + second))
        .with("active", Map(1 -> budget.active.get(1) - countPositive(held.first), 2 -> budget.active.get(2) - countPositive(held.second)))
        .with("unacknowledged", Map(1 -> budget.unacknowledged.get(1) + countPositive(held.first), 2 -> budget.unacknowledged.get(2) + countPositive(held.second)))
        .with("sequence", Map(1 -> budget.sequence.get(1) + countPositive(first), 2 -> budget.sequence.get(2) + countPositive(second)))
        .with("outbox", budget.outbox.union(Set(r))),
    }
  }
  // A replay never mutates the receipt or applies another credit/refund. An
  // unequal cost is rejected; a matching cost returns the retained receipt.
  action replay(r, cost) = all { terminal(r), cost >= 0, unchanged }
  action acknowledge(r) = {
    val held = budget.allocated.get(r)
    all {
      terminal(r),
      not(budget.acknowledged.contains(r)),
      budget' = budget
        .with("acknowledged", budget.acknowledged.union(Set(r)))
        .with("outbox", budget.outbox.exclude(Set(r)))
        .with("unacknowledged", Map(1 -> budget.unacknowledged.get(1) - countPositive(held.first), 2 -> budget.unacknowledged.get(2) - countPositive(held.second))),
    }
  }
  action acknowledgeAgain(r) = all { budget.acknowledged.contains(r), unchanged }
  def canSeal(g) = budget.active.get(g) == 0 and budget.unacknowledged.get(g) == 0
  action seal(g) = all {
    canSeal(g),
    budget' = budget
      .with("sealed", budget.sealed.union(Set(g)))
      .with("sealConsumed", budget.sealConsumed.set(g, budget.consumed.get(g))),
  }
  action trySeal(g) = if (canSeal(g)) seal(g) else unchanged
  action tick = all { budget.clock < 4, budget' = budget.with("clock", budget.clock + 1) }
  action step = {
    nondet r = requests.oneOf()
    nondet g = grants.oneOf()
    nondet amount = 0.to(3).oneOf()
    any {
      prepare(r, amount), reserve(r), settle(r, amount, false), settle(r, 0, true),
      replay(r, amount), acknowledge(r), acknowledgeAgain(r), seal(g), tick, unchanged,
    }
  }

  def allocation(r, g) = if (g == 1) budget.allocated.get(r).first else budget.allocated.get(r).second
  def held(g) = requests.fold(0, (total, r) => total + (if (budget.phases.get(r) == "dispatched") allocation(r, g) else 0))
  def leaseCount(g) = requests.filter(r => budget.phases.get(r) == "dispatched" and allocation(r, g) > 0).size()
  def debtCount(g) = requests.filter(r => terminal(r) and not(budget.acknowledged.contains(r)) and allocation(r, g) > 0).size()
  val conservation = grants.forall(g => budget.remaining.get(g) + budget.consumed.get(g) + held(g) == 2)
  val counters = grants.forall(g => all {
    budget.remaining.get(g) >= 0,
    budget.consumed.get(g) >= 0,
    budget.active.get(g) == leaseCount(g),
    budget.unacknowledged.get(g) == debtCount(g),
  })
  val outboxMatchesDebt = requests.forall(r => budget.outbox.contains(r) == (terminal(r) and not(budget.acknowledged.contains(r))))
  val boundedCharges = requests.forall(r => not(terminal(r)) or all {
    budget.charges.get(r) >= 0,
    budget.charges.get(r) <= budget.maxima.get(r),
    budget.phases.get(r) != "cancelled" or budget.charges.get(r) == 0,
  })
  val sealsAreFinal = budget.sealed.forall(g => all {
    budget.active.get(g) == 0,
    budget.unacknowledged.get(g) == 0,
    budget.consumed.get(g) == budget.sealConsumed.get(g),
  })
  def chargedFrom(r, g) = if (not(terminal(r))) 0 else
    if (g == 1) min(budget.charges.get(r), budget.allocated.get(r).first)
    else budget.charges.get(r) - min(budget.charges.get(r), budget.allocated.get(r).first)
  val receiptSequences = grants.forall(g =>
    budget.sequence.get(g) == requests.filter(r => chargedFrom(r, g) > 0).size())
  val receiptAmounts = grants.forall(g =>
    budget.consumed.get(g) == requests.fold(0, (total, r) => total + chargedFrom(r, g)))
  val safety = conservation and counters and outboxMatchesDebt and boundedCharges and sealsAreFinal and receiptSequences and receiptAmounts

  run zeroCostStillRequiresAcknowledgementTest = init
    .then(prepare("first", 3)).then(reserve("first")).then(settle("first", 0, true))
    .then(trySeal(1)).then(trySeal(2))
    .expect(safety and budget.sealed == Set() and budget.unacknowledged == Map(1 -> 1, 2 -> 1))
  run acknowledgementEnablesSealTest = init
    .then(prepare("first", 3)).then(reserve("first")).then(settle("first", 1, false))
    .then(acknowledge("first")).then(seal(1)).then(seal(2))
    .expect(safety and budget.sealConsumed == Map(1 -> 1, 2 -> 0))
  run overReservationRefusedTest = init
    .then(prepare("first", 3)).then(reserve("first"))
    .then(prepare("second", 2)).then(tryReserve("second"))
    .expect(safety and budget.phases.get("second") == "prepared" and held(1) + held(2) == 3)
  run settlementReplayDoesNotRefundTest = init
    .then(prepare("first", 2)).then(reserve("first")).then(settle("first", 2, false))
    .then(replay("first", 0)).then(replay("first", 2))
    .expect(safety and budget.remaining.get(1) == 0 and budget.consumed.get(1) == 2)
  run expiryDoesNotEraseExistingDebtTest = init
    .then(prepare("first", 3)).then(reserve("first")).then(tick).then(tick).then(tick)
    .then(settle("first", 3, false)).then(acknowledge("first")).then(seal(1))
    .expect(safety and budget.consumed == Map(1 -> 2, 2 -> 1))
  run duplicateAcknowledgementTest = init
    .then(prepare("first", 1)).then(reserve("first")).then(settle("first", 0, true))
    .then(acknowledge("first")).then(acknowledgeAgain("first"))
    .expect(safety and budget.unacknowledged == Map(1 -> 0, 2 -> 0))
}
