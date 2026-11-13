// One Maps receipt owns each reservation. Provider observations and delivery
// completion are separate; unknown work is conservatively settled by billing.
module maps_credit_funding {
  type State = {
    balance: int, plan: bool, active: bool,
    phase: int -> str, included: int -> bool, quote: int -> int,
    held: int -> int, observed: int -> int, charged: int -> int,
    calls: int -> int,
  }
  var s: State
  pure val requestKeys = Set(0, 1)
  action init = s' = {
    balance: 3, plan: false, active: true,
    phase: requestKeys.mapBy(_ => "absent"), included: requestKeys.mapBy(_ => false),
    quote: requestKeys.mapBy(_ => 0), held: requestKeys.mapBy(_ => 0),
    observed: requestKeys.mapBy(_ => 0), charged: requestKeys.mapBy(_ => 0),
    calls: requestKeys.mapBy(_ => 0),
  }
  action admit(key: int, price: int): bool = {
    val cost = if (s.plan) 0 else price
    if (s.active and s.phase.get(key) == "absent" and s.balance >= cost)
      s' = s.with("balance", s.balance - cost)
        .with("phase", s.phase.set(key, "reserved"))
        .with("included", s.included.set(key, s.plan))
        .with("quote", s.quote.set(key, price)).with("held", s.held.set(key, cost))
    else s' = s
  }
  action dispatch(key: int): bool = all {
    s.active, s.phase.get(key).in(Set("reserved", "observed")),
    s.calls.get(key) < 2, s.observed.get(key) < s.quote.get(key),
    s' = s.with("phase", s.phase.set(key, "inflight"))
      .with("calls", s.calls.set(key, s.calls.get(key) + 1)),
  }
  action providerResult(key: int, outcome: str, cost: int): bool = all {
    s.phase.get(key) == "inflight",
    outcome != "accepted" or s.observed.get(key) + cost <= s.quote.get(key),
    s' = s.with("phase", s.phase.set(key, if (outcome == "lost") "unknown" else "observed"))
      .with("observed", s.observed.set(key,
        s.observed.get(key) + (if (outcome == "accepted") cost else 0))),
  }
  action settle(key: int): bool = {
    val phase = s.phase.get(key)
    val cost = if (s.included.get(key) or phase == "reserved") 0
      else if (phase == "unknown") s.quote.get(key) else s.observed.get(key)
    all {
      phase.in(Set("reserved", "observed", "unknown")),
      s' = s.with("balance", s.balance + s.held.get(key) - cost)
        .with("held", s.held.set(key, 0)).with("charged", s.charged.set(key, cost))
        .with("phase", s.phase.set(key, "settled")),
    }
  }
  action observe(key: int): bool = {
    nondet outcome = Set("accepted", "rejected", "lost").oneOf()
    nondet cost = Set(1, 2).oneOf()
    providerResult(key, outcome, cost)
  }
  action changePlan(value: bool): bool = s' = s.with("plan", value)
  action revoke = s' = s.with("active", false)
  action step = any {
    { nondet key = requestKeys.oneOf(); nondet price = Set(1, 2).oneOf(); admit(key, price) },
    { nondet key = requestKeys.oneOf(); dispatch(key) },
    { nondet key = requestKeys.oneOf(); observe(key) },
    { nondet key = requestKeys.oneOf(); settle(key) },
    { nondet value = Set(false, true).oneOf(); changePlan(value) },
    revoke, s' = s,
  }
  val conserved = s.balance + s.held.get(0) + s.held.get(1)
    + s.charged.get(0) + s.charged.get(1) == 3 and s.balance >= 0
  val includedNeverDebits = requestKeys.forall(key =>
    s.included.get(key) implies (s.held.get(key) == 0 and s.charged.get(key) == 0))
  val observedCostRetained = requestKeys.forall(key =>
    s.phase.get(key) == "settled" and not(s.included.get(key)) implies
      s.charged.get(key) >= s.observed.get(key))
  val safety = conserved and includedNeverDebits and observedCostRetained
    and requestKeys.forall(key => s.calls.get(key) <= 2 and s.observed.get(key) <= s.quote.get(key))
  temporal SettlesWhenObserved =
    requestKeys.forall(key => observe(key).weakFair(s) and settle(key).weakFair(s)) implies
      always(requestKeys.forall(key => s.phase.get(key) != "absent" implies
        eventually(s.phase.get(key) == "settled")))
  temporal NoFairnessSettles = always(requestKeys.forall(key =>
    s.phase.get(key) != "absent" implies eventually(s.phase.get(key) == "settled")))
  run includedPlanTest = init.then(changePlan(true)).then(admit(0, 2))
    .then(dispatch(0)).then(providerResult(0, "accepted", 1)).then(settle(0))
    .expect(s.balance == 3 and safety)
  run undispatchedRefundTest = init.then(admit(0, 2)).then(settle(0))
    .expect(s.balance == 3 and s.charged.get(0) == 0 and safety)
  run acceptedWorkKeepsCostTest = init.then(admit(0, 2)).then(dispatch(0))
    .then(providerResult(0, "accepted", 1)).then(settle(0))
    .expect(s.balance == 2 and s.charged.get(0) == 1 and safety)
  run partialUnknownRetainsFullQuoteTest = init.then(admit(0, 2)).then(dispatch(0))
    .then(providerResult(0, "accepted", 1)).then(dispatch(0))
    .then(providerResult(0, "lost", 1)).then(settle(0))
    .expect(s.balance == 1 and s.charged.get(0) == 2 and safety)
  run sameRequestCannotReadmitTest = init.then(admit(0, 2)).then(admit(0, 2))
    .then(settle(0)).then(admit(0, 2)).expect(s.balance == 3 and s.phase.get(0) == "settled" and safety)
}
