module ClefDailyQuota {
  pure val Funding = Set("free", "purchase", "subscription", "promo", "unavailable")
  pure def hasFunding(source: str): bool = source.in(Set("purchase", "subscription"))
  pure def limit(source: str): int = if (hasFunding(source)) 4 else 2

  var s: { source: str, count: int, observedSource: str, observedCount: int,
           outcome: str, credentialAllowed: bool, storageAvailable: bool }

  action init = s' = {
    source: "free", count: 0, observedSource: "free", observedCount: 0,
    outcome: "idle", credentialAllowed: false, storageAvailable: false
  }

  action observe(source: str): bool = s' = s.with("source", source)
  action reset = s' = s.with("count", 0)
  action request(credentialAllowed: bool, storageAvailable: bool): bool = {
    val reachesCounter = credentialAllowed and storageAvailable
    s' = { ...s,
      count: if (reachesCounter and s.count < 5) s.count + 1 else s.count,
      observedSource: s.source, observedCount: s.count,
      credentialAllowed: credentialAllowed, storageAvailable: storageAvailable,
      outcome: if (reachesCounter and s.count < limit(s.source)) "admitted" else "refused"
    }
  }

  action step = any {
    { nondet source = Funding.oneOf() observe(source) },
    reset,
    {
      nondet credentialAllowed = Set(false, true).oneOf()
      nondet storageAvailable = Set(false, true).oneOf()
      request(credentialAllowed, storageAvailable)
    }
  }

  val Limited = s.outcome == "admitted" implies
    s.credentialAllowed and s.storageAvailable and s.observedCount < limit(s.observedSource)
  val FundedOnly = (s.outcome == "admitted" and s.observedCount >= 2)
    implies hasFunding(s.observedSource)

  run purchaseThenRefund = init.then(request(true, true)).then(request(true, true))
    .then(observe("purchase")).then(request(true, true))
    .expect(s.outcome == "admitted" and s.count == 3)
    .then(observe("free")).then(request(true, true))
    .expect(s.outcome == "refused" and s.count == 4)
}
