// Maps owns the observation boundary; the existing billing owner owns money.
module maps_credit_funding {
  type State = {
    balance: int, plan: bool, active: bool,
    phase: int -> str, included: int -> bool,
    quote: int -> int, held: int -> int, charged: int -> int, chosen: int -> int,
    observed: int -> int, pending: int -> bool, admissions: int -> int,
  }
  var s: State
  pure val requestKeys = Set(0, 1)
  pure val terminal = Set("settled", "unknown")
  action init = s' = {
    balance: 3, plan: false, active: true,
    phase: requestKeys.mapBy(_ => "absent"),
    included: requestKeys.mapBy(_ => false),
    quote: requestKeys.mapBy(_ => 0), held: requestKeys.mapBy(_ => 0),
    charged: requestKeys.mapBy(_ => 0), chosen: requestKeys.mapBy(_ => 0),
    observed: requestKeys.mapBy(_ => 0),
    pending: requestKeys.mapBy(_ => false), admissions: requestKeys.mapBy(_ => 0),
  }
  action admit(key: int, price: int): bool = {
    val cost = if (s.plan) 0 else price
    all {
      s.active, s.phase.get(key) == "absent", s.balance >= cost,
      s' = { ...s, balance: s.balance - cost,
        phase: s.phase.set(key, "admitted"), included: s.included.set(key, s.plan),
        quote: s.quote.set(key, cost), held: s.held.set(key, cost),
        admissions: s.admissions.set(key, s.admissions.get(key) + 1) },
    }
  }
  // Atomic provider admission rechecks standing before starting any request.
  action dispatch(key: int): bool = all {
    s.phase.get(key) == "admitted", s.active, s.plan == s.included.get(key),
    s' = { ...s, phase: s.phase.set(key, "dispatched"), pending: s.pending.set(key, true) },
  }
  action observe(key: int, cost: int): bool = all {
    s.phase.get(key) == "dispatched", s.pending.get(key),
    cost >= 0, s.observed.get(key) + cost <= s.held.get(key),
    s.included.get(key) or cost > 0,
    s' = { ...s, observed: s.observed.set(key, s.observed.get(key) + cost),
      pending: s.pending.set(key, false) },
  }
  action reject(key: int): bool = all {
    s.phase.get(key) == "dispatched", s.pending.get(key),
    s' = s.with("pending", s.pending.set(key, false)),
  }
  action nextRequest(key: int): bool = all {
    // Sequential provider calls belong to the first acknowledged dispatch.
    s.phase.get(key) == "dispatched", not(s.pending.get(key)),
    s' = s.with("pending", s.pending.set(key, true)),
  }
  // Failure or cancellation before dispatch releases the whole reservation.
  // After a known reply it releases only the unused part, even if cancelled.
  action settleKnown(key: int): bool = all {
    s.phase.get(key).in(Set("admitted", "dispatched")), not(s.pending.get(key)),
    s' = { ...s, chosen: s.chosen.set(key, s.observed.get(key)),
      phase: s.phase.set(key, "settling-known") },
  }
  // The first unknown choice fixes a conservative charge at the admitted bound.
  action settleUnknown(key: int): bool = all {
    s.phase.get(key) == "dispatched", s.pending.get(key),
    s' = { ...s, chosen: s.chosen.set(key, s.quote.get(key)),
      phase: s.phase.set(key, "settling-unknown") },
  }
  action finish(key: int): bool = any { settleKnown(key), settleUnknown(key) }
  // Failed settlement and later callers retain that first choice. They cannot
  // turn an unknown settlement into a zero-cost cancellation.
  action retryChoice(key: int): bool = all {
    s.phase.get(key).in(Set("settling-known", "settling-unknown", "settled", "unknown")),
    s' = s,
  }
  action settlementFailed(key: int): bool = all {
    s.phase.get(key).in(Set("settling-known", "settling-unknown")), s' = s,
  }
  action acknowledge(key: int): bool = all {
    s.phase.get(key).in(Set("settling-known", "settling-unknown")),
    s' = { ...s, balance: s.balance + s.held.get(key) - s.chosen.get(key),
      held: s.held.set(key, 0), charged: s.charged.set(key, s.chosen.get(key)),
      phase: s.phase.set(key, if (s.phase.get(key) == "settling-unknown") "unknown" else "settled"),
      pending: s.pending.set(key, false) },
  }
  action changePlan(value: bool): bool = s' = s.with("plan", value)
  action revoke = s' = s.with("active", false)
  action step = any {
    { nondet key = requestKeys.oneOf(); nondet price = Set(1, 2).oneOf(); admit(key, price) },
    { nondet key = requestKeys.oneOf(); dispatch(key) },
    { nondet key = requestKeys.oneOf(); nondet cost = Set(0, 1, 2).oneOf(); observe(key, cost) },
    { nondet key = requestKeys.oneOf(); reject(key) },
    { nondet key = requestKeys.oneOf(); nextRequest(key) },
    { nondet key = requestKeys.oneOf(); finish(key) },
    { nondet key = requestKeys.oneOf(); acknowledge(key) },
    { nondet key = requestKeys.oneOf(); settlementFailed(key) },
    { nondet key = requestKeys.oneOf(); retryChoice(key) },
    { nondet value = Set(false, true).oneOf(); changePlan(value) }, revoke,
  }
  val held = requestKeys.fold(0, (total, key) => total + s.held.get(key))
  val charged = requestKeys.fold(0, (total, key) => total + s.charged.get(key))
  val TypeOK = s.balance.in(0.to(3)) and requestKeys.forall(key =>
    s.phase.get(key).in(Set("absent", "admitted", "dispatched", "settling-known", "settling-unknown", "unknown", "settled")) and
    s.quote.get(key).in(0.to(2)) and s.held.get(key).in(0.to(2)) and
    s.chosen.get(key).in(0.to(2)) and s.charged.get(key).in(0.to(2)) and s.observed.get(key).in(0.to(2)))
  val conserved = s.balance + held + charged == 3
  val includedNeverDebits = requestKeys.forall(key => s.included.get(key) implies
    (s.held.get(key) == 0 and s.charged.get(key) == 0))
  val acceptedCostNeverReleased = requestKeys.forall(key =>
    s.held.get(key) + s.charged.get(key) >= s.observed.get(key))
  val unknownRetainsLiability = requestKeys.forall(key =>
    (s.phase.get(key) == "settling-unknown" implies s.chosen.get(key) == s.quote.get(key)) and
    (s.phase.get(key) == "unknown" implies s.charged.get(key) == s.quote.get(key)))
  val noDuplicateAdmission = requestKeys.forall(key => s.admissions.get(key) <= 1)
  val terminalCostCoversObservation = requestKeys.forall(key => s.phase.get(key).in(terminal) implies
    (s.held.get(key) == 0 and s.charged.get(key) >= s.observed.get(key)))
  val safety = TypeOK and conserved and includedNeverDebits and acceptedCostNeverReleased and
    unknownRetainsLiability and noDuplicateAdmission and terminalCostCoversObservation
  temporal RequestsSettleWithoutFairness = requestKeys.forall(key =>
    (s.phase.get(key).in(Set("admitted", "dispatched", "settling-known", "settling-unknown"))).leadsTo(s.phase.get(key).in(terminal)))
  temporal LocalRequestsSettle = requestKeys.forall(key =>
    finish(key).weakFair(s) and acknowledge(key).weakFair(s)) implies
    RequestsSettleWithoutFairness
  run planDoesNotDebitTest = init.then(changePlan(true)).then(admit(0, 2))
    .then(dispatch(0)).then(observe(0, 0)).then(settleKnown(0)).then(acknowledge(0)).expect(s.balance == 3 and safety)
  run failedRequestRefundsTest = init.then(admit(0, 2)).then(dispatch(0))
    .then(reject(0)).then(settleKnown(0)).then(acknowledge(0)).expect(s.balance == 3 and safety)
  run cancellationKeepsAcceptedCostTest = init.then(admit(0, 2)).then(dispatch(0))
    .then(observe(0, 1)).then(settleKnown(0)).then(acknowledge(0)).expect(s.balance == 2 and s.charged.get(0) == 1 and safety)
  run lostReplyKeepsReservationTest = init.then(admit(0, 2)).then(dispatch(0))
    .then(settleUnknown(0)).then(acknowledge(0)).expect(s.balance == 1 and s.charged.get(0) == 2 and safety)
  run partialThenUnknownKeepsBothCostsTest = init.then(admit(0, 2)).then(dispatch(0))
    .then(observe(0, 1)).then(nextRequest(0)).then(settleUnknown(0)).then(acknowledge(0))
    .expect(s.balance == 1 and s.charged.get(0) == 2 and s.observed.get(0) == 1 and safety)
  run failedUnknownRetryKeepsFirstChoiceTest = init.then(admit(0, 2)).then(dispatch(0))
    .then(observe(0, 1)).then(nextRequest(0)).then(settleUnknown(0)).then(settlementFailed(0))
    .then(retryChoice(0)).then(acknowledge(0)).then(retryChoice(0))
    .expect(s.balance == 1 and s.charged.get(0) == 2 and safety)
  run revokedAfterFirstCallRetainsSecondCallLiabilityTest = init.then(admit(0, 2))
    .then(dispatch(0)).then(observe(0, 1)).then(revoke).then(nextRequest(0))
    .then(settleUnknown(0)).then(acknowledge(0))
    .expect(s.balance == 1 and s.charged.get(0) == 2 and safety)
  run planChangeBeforeDispatchReleasesTest = init.then(admit(0, 2)).then(changePlan(true))
    .then(settleKnown(0)).then(acknowledge(0)).expect(s.balance == 3 and s.phase.get(0) == "settled" and safety)
}
