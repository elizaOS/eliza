// One nonlegacy purchase attempt. The first claim permits one registrar start.
// Recovery claims permit status reads and fence the old worker's SQL writes.
module DomainPurchaseAttempt {
  type State = {
    phase: str, now: int, expires: int, quote: int, charged: bool,
    starts: int, token: int, lastToken: int, observations: int -> str,
    proof: str, publisher: int, refundLedger: bool, refundAttached: bool,
    managedDomain: bool, receipt: str
  }

  pure val Tokens = Set(1, 2, 3)
  pure val Prices = Set(1, 2)
  pure val Observations = Set("registered", "failed", "ambiguous")
  pure val ProviderPhases = Set("provider_started", "provider_ambiguous")
  pure val Horizon = 4

  var s: State
  action init = s' = {
    phase: "processing", now: 0, expires: 1, quote: 0, charged: false,
    starts: 0, token: 0, lastToken: 0, observations: Tokens.mapBy(_ => "none"),
    proof: "none", publisher: 0, refundLedger: false, refundAttached: false,
    managedDomain: false, receipt: "none"
  }

  def canQuote(price: int): bool =
    Set("processing", "quoted").contains(s.phase) and (s.quote == 0 or s.quote == price)

  action pinQuote(price: int): bool = all {
    canQuote(price),
    s' = s.with("phase", "quoted").with("quote", price).with("expires", s.now + 1)
  }

  def canAttachCharge(exact: bool): bool = exact and Set("quoted", "charged").contains(s.phase)

  action attachCharge(exact: bool): bool = all {
    canAttachCharge(exact),
    s' = s.with("phase", "charged").with("charged", true)
  }

  action failUncharged = all {
    Set("processing", "quoted").contains(s.phase),
    s' = s.with("phase", "failed").with("receipt", "failed").with("expires", s.now + 1)
  }

  action eraseExpiredUnchargedFailure = all {
    s.phase == "failed" and not(s.charged) and s.expires <= s.now,
    s' = s.with("phase", "erased").with("receipt", "none")
  }

  action claimRegistrarStart = all {
    s.phase == "charged" and s.charged,
    s' = s.with("phase", "provider_started").with("starts", s.starts + 1)
      .with("token", 1).with("lastToken", 1).with("expires", s.now + 1)
      .with("observations", s.observations.set(1, "pending"))
  }

  action claimReconciliation = all {
    ProviderPhases.contains(s.phase) and s.expires <= s.now and s.lastToken < 3,
    {
      val token = s.lastToken + 1
      s' = s.with("phase", "provider_ambiguous").with("token", token)
        .with("lastToken", token).with("expires", s.now + 1)
        .with("observations", s.observations.set(token, "pending"))
    }
  }

  action observe(token: int, result: str): bool = all {
    s.observations.get(token) == "pending",
    s' = s.with("observations", s.observations.set(token, result))
  }

  def canPublish(token: int): bool = ProviderPhases.contains(s.phase) and s.token == token and
    Observations.contains(s.observations.get(token))

  action publish(token: int): bool = all {
    canPublish(token),
    {
      val result = s.observations.get(token)
      if (result == "registered")
        s' = s.with("phase", "registered").with("proof", "registered")
          .with("token", 0).with("publisher", token)
      else if (result == "failed")
        s' = s.with("phase", "refund_pending").with("proof", "failed")
          .with("publisher", token)
      else
        s' = s.with("phase", "provider_ambiguous").with("token", 0)
          .with("expires", s.now + 1)
    }
  }

  // The route permits a refund before dispatch for a verified foreign local owner.
  action refundBeforeStart = all {
    s.phase == "charged" and s.charged,
    s' = s.with("phase", "refund_pending").with("proof", "unstarted")
  }

  action ensureRefund = all {
    s.phase == "refund_pending" and not(s.refundLedger),
    s' = s.with("refundLedger", true)
  }

  def canAttachRefund(exact: bool): bool = exact and s.refundLedger and
    Set("refund_pending", "refunded").contains(s.phase)

  action attachRefund(exact: bool): bool = all {
    canAttachRefund(exact),
    s' = s.with("phase", "refunded").with("refundAttached", true)
      .with("receipt", "refunded").with("token", 0)
  }

  action persistManagedDomain = all {
    s.phase == "registered" and not(s.managedDomain),
    s' = s.with("managedDomain", true)
  }

  action complete = all {
    s.phase == "registered" and s.managedDomain,
    s' = s.with("phase", "completed").with("receipt", "completed")
  }

  action tick = all { s.now < Horizon, s' = s.with("now", s.now + 1) }
  action wait = s' = s

  action step = any {
    attachCharge(true), failUncharged, eraseExpiredUnchargedFailure,
    claimRegistrarStart, claimReconciliation, refundBeforeStart,
    ensureRefund, attachRefund(true), persistManagedDomain, complete, tick, wait,
    {
      nondet price = Prices.oneOf()
      pinQuote(price)
    },
    {
      nondet token = Tokens.oneOf()
      nondet result = Observations.oneOf()
      any { observe(token, result), publish(token) }
    }
  }

  val Safety = and {
    s.starts <= 1,
    s.charged implies (s.quote > 0 and not(Set("failed", "erased").contains(s.phase))),
    s.starts == 1 implies s.charged,
    s.refundAttached implies (s.refundLedger and s.receipt == "refunded"),
    s.refundLedger implies (s.charged and Set("unstarted", "failed").contains(s.proof)),
    s.managedDomain implies s.proof == "registered",
    s.receipt == "completed" implies (s.managedDomain and s.charged and not(s.refundLedger)),
    s.proof == "unstarted" implies s.starts == 0,
    Set("registered", "failed").contains(s.proof) implies s.publisher > 0,
    Tokens.forall(token => token > s.lastToken implies s.observations.get(token) == "none")
  }

  temporal DurableAuthority = always((all {
    s.quote > 0 implies next(s.quote) == s.quote,
    s.charged implies next(s.charged),
    (next(s.starts) > s.starts) implies s.phase == "charged",
    (s.publisher == 0 and next(s.publisher) > 0) implies next(s.publisher) == s.token,
    (ProviderPhases.contains(s.phase) and s.token > 0 and next(s.phase) == "provider_ambiguous" and
      next(s.token) == 0) implies Tokens.exists(token =>
        s.token == token and s.observations.get(token) == "ambiguous"),
    Set("completed", "refunded").contains(s.receipt) implies all {
      next(s.receipt) == s.receipt, next(s.phase) == s.phase, next(s.starts) == s.starts
    }
  }).orKeep(s))

  temporal LocalSettlement = and {
    (s.phase == "registered").leadsTo(s.phase == "completed"),
    (s.phase == "refund_pending").leadsTo(s.phase == "refunded")
  }
  temporal FairRecovery = (persistManagedDomain.weakFair(s) and complete.weakFair(s) and
    ensureRefund.weakFair(s) and attachRefund(true).weakFair(s)) implies LocalSettlement

  run quoteAndChargeStayPinnedTest = init.then(pinQuote(2))
    .expect(not(canQuote(1)) and not(canAttachCharge(false)))
    .then(attachCharge(true)).then(attachCharge(true))
    .expect(s.quote == 2 and s.charged and s.starts == 0)

  run expiredUnchargedFailureCanBeErasedTest = init.then(pinQuote(1)).then(failUncharged)
    .then(tick).then(eraseExpiredUnchargedFailure)
    .expect(s.phase == "erased" and not(s.charged))

  run staleStartCannotPublishAfterTakeoverTest = init.then(pinQuote(1)).then(attachCharge(true))
    .then(claimRegistrarStart).then(tick).then(claimReconciliation).then(observe(1, "failed"))
    .expect(not(canPublish(1)) and s.token == 2 and s.starts == 1)
    .then(observe(2, "registered")).then(publish(2)).then(persistManagedDomain).then(complete)
    .expect(s.receipt == "completed" and not(s.refundLedger))

  run uncertainReplyRetainsChargeAndDoesNotRestartTest = init.then(pinQuote(1)).then(attachCharge(true))
    .then(claimRegistrarStart).then(observe(1, "ambiguous")).then(publish(1))
    .expect(s.charged and s.token == 0 and s.phase == "provider_ambiguous")
    .then(tick).then(claimReconciliation).then(observe(2, "ambiguous")).then(publish(2))
    .expect(s.starts == 1 and s.proof == "none" and s.receipt == "none")

  run exactRefundSurvivesAttachmentRetryTest = init.then(pinQuote(1)).then(attachCharge(true))
    .then(claimRegistrarStart).then(tick).then(claimReconciliation)
    .then(observe(2, "failed")).then(publish(2)).then(ensureRefund)
    .expect(s.phase == "refund_pending" and not(canAttachRefund(false)))
    .then(attachRefund(true)).then(attachRefund(true))
    .expect(s.receipt == "refunded" and s.refundAttached and s.starts == 1)

  run chargedConflictRefundsWithoutRegistrarStartTest = init.then(pinQuote(1)).then(attachCharge(true))
    .then(refundBeforeStart).then(ensureRefund).then(attachRefund(true))
    .expect(s.receipt == "refunded" and s.starts == 0 and s.proof == "unstarted")

  run originalLeaseCanSettleBeforeTakeoverTest = init.then(pinQuote(1)).then(attachCharge(true))
    .then(claimRegistrarStart).then(tick).then(observe(1, "registered")).then(publish(1))
    .expect(s.phase == "registered" and s.publisher == 1 and s.starts == 1)
}
