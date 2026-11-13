// Maps admission selects one funding source. Credit settlement uses the existing
// organization-inference admission owner; included plan requests never debit credits.
module maps_credit_funding {
  type State = {
    balance: int, plan: bool, active: bool,
    phase: int -> str, included: int -> bool,
    held: int -> int, charged: int -> int,
  }
  var s: State
  pure val requestKeys = Set(0, 1, 2)
  action init = s' = {
    balance: 3, plan: false, active: true,
    phase: requestKeys.mapBy(_ => "absent"), included: requestKeys.mapBy(_ => false),
    held: requestKeys.mapBy(_ => 0), charged: requestKeys.mapBy(_ => 0),
  }
  action admit(key: int, price: int): bool = {
    val cost = if (s.plan) 0 else price
    if (s.active and s.phase.get(key) == "absent" and s.balance >= cost)
      s' = s.with("balance", s.balance - cost)
        .with("phase", s.phase.set(key, "admitted"))
        .with("included", s.included.set(key, s.plan))
        .with("held", s.held.set(key, cost))
    else s' = s
  }
  action dispatch(key: int): bool =
    if (s.phase.get(key) == "admitted" and s.active)
      s' = s.with("phase", s.phase.set(key, "dispatched"))
    else s' = s
  action settle(key: int, cost: int): bool = {
    val phase = s.phase.get(key)
    val canSettle = cost >= 0 and cost <= s.held.get(key) and
      (phase == "dispatched" or (phase == "admitted" and cost == 0))
    if (canSettle)
      s' = s.with("balance", s.balance + s.held.get(key) - cost)
        .with("held", s.held.set(key, 0))
        .with("charged", s.charged.set(key, cost))
        .with("phase", s.phase.set(key, "settled"))
    else s' = s
  }
  action changePlan(value: bool): bool = s' = s.with("plan", value)
  action revoke = s' = s.with("active", false)
  action finish(key: int): bool = { nondet cost = Set(0, 1, 2).oneOf(); settle(key, cost) }
  action step = any {
    { nondet key = requestKeys.oneOf(); nondet price = Set(1, 2).oneOf(); admit(key, price) },
    { nondet key = requestKeys.oneOf(); dispatch(key) },
    { nondet key = requestKeys.oneOf(); finish(key) },
    { nondet value = Set(false, true).oneOf(); changePlan(value) },
    revoke,
  }
  val held = s.held.get(0) + s.held.get(1) + s.held.get(2)
  val charged = s.charged.get(0) + s.charged.get(1) + s.charged.get(2)
  val conserved = s.balance + held + charged == 3 and s.balance >= 0
  val includedNeverDebits = requestKeys.forall(key =>
    s.included.get(key) implies (s.held.get(key) == 0 and s.charged.get(key) == 0))
  val safety = conserved and includedNeverDebits
  temporal SettlesWhenObserved = requestKeys.forall(key => finish(key).weakFair(s)) implies
    always(requestKeys.forall(key =>
      (s.phase.get(key) == "admitted" or s.phase.get(key) == "dispatched") implies
        eventually(s.phase.get(key) == "settled")))
  run planDoesNotDebitTest = init.then(changePlan(true)).then(admit(0, 2))
    .then(dispatch(0)).then(settle(0, 0)).expect(s.balance == 3 and safety)
  run failedRequestRefundsTest = init.then(admit(0, 2)).then(dispatch(0))
    .then(settle(0, 0)).then(settle(0, 2)).expect(s.balance == 3 and safety)
  run sameRequestDoesNotDebitTwiceTest = init.then(admit(0, 2)).then(admit(0, 2))
    .then(dispatch(0)).then(settle(0, 2)).expect(s.balance == 1 and safety)
  run unusedReservationReturnsTest = init.then(admit(0, 2)).then(dispatch(0))
    .then(settle(0, 1)).expect(s.balance == 2 and safety)
  run acceptedWorkKeepsCostTest = init.then(admit(0, 2)).then(dispatch(0))
    .then(settle(0, 1)).then(settle(0, 0)).expect(s.balance == 2 and safety)
}
