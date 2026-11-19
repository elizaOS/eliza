module ClefDailyQuota {
  pure val Funding = Set("free", "purchase", "subscription", "promo", "unavailable")
  pure val Credentials = Set("first", "second")
  pure def dailyLimit(source: str): int =
    if (source.in(Set("purchase", "subscription"))) 4 else 2

  var s: {
    source: str, daily: int, minute: int, observedSource: str,
    observedDaily: int, observedMinute: int, credential: str,
    outcome: str, credentialAllowed: bool, dailyAvailable: bool, minuteAvailable: bool
  }

  action init = s' = {
    source: "free", daily: 0, minute: 0, observedSource: "free",
    observedDaily: 0, observedMinute: 0, credential: "first", outcome: "idle",
    credentialAllowed: false, dailyAvailable: false, minuteAvailable: false
  }

  action observe(source: str): bool = s' = s.with("source", source)
  action resetDaily = s' = s.with("daily", 0)
  action renewMinute = s' = s.with("minute", 0)

  action request(credential: str, credentialAllowed: bool, dailyAvailable: bool, minuteAvailable: bool): bool = {
    val checksDaily = credentialAllowed and dailyAvailable
    val checksMinute = checksDaily and s.daily >= dailyLimit(s.source) and s.source == "subscription"
    s' = { ...s,
      daily: if (checksDaily and s.daily < 5) s.daily + 1 else s.daily,
      minute: if (checksMinute and minuteAvailable and s.minute < 3) s.minute + 1 else s.minute,
      observedSource: s.source, observedDaily: s.daily, observedMinute: s.minute,
      credential: credential, credentialAllowed: credentialAllowed, dailyAvailable: dailyAvailable,
      minuteAvailable: minuteAvailable,
      outcome: if (not(credentialAllowed)) "credential-refused"
        else if (not(dailyAvailable) or (checksMinute and not(minuteAvailable))) "unavailable"
        else if (s.daily < dailyLimit(s.source)) "daily-admit"
        else if (checksMinute and s.minute < 2) "minute-admit"
        else if (checksMinute) "minute-refused" else "daily-refused"
    }
  }

  action step = any {
    { nondet source = Funding.oneOf() observe(source) },
    resetDaily,
    renewMinute,
    {
      nondet credential = Credentials.oneOf()
      nondet credentialAllowed = Set(false, true).oneOf()
      nondet dailyAvailable = Set(false, true).oneOf()
      nondet minuteAvailable = Set(false, true).oneOf()
      request(credential, credentialAllowed, dailyAvailable, minuteAvailable)
    }
  }

  val DailyAdmissionBounded = s.outcome == "daily-admit" implies
    (s.credentialAllowed and s.dailyAvailable and s.observedDaily < dailyLimit(s.observedSource))
  val ContinuedOnlyWhileSubscribed = s.outcome == "minute-admit" implies
    (s.credentialAllowed and s.dailyAvailable and s.minuteAvailable and
      s.observedSource == "subscription" and s.observedDaily >= dailyLimit(s.observedSource) and s.observedMinute < 2)
  val ExhaustedSubscriptionWindowRefuses = s.outcome == "minute-refused" implies
    (s.credentialAllowed and s.dailyAvailable and s.minuteAvailable and
      s.observedSource == "subscription" and s.observedMinute >= 2)

  temporal ContinuationRenews = renewMinute.weakFair(s) implies
    (s.source == "subscription" and s.minute >= 2)
      .leadsTo(s.minute < 2 or s.source != "subscription")

  run purchaseThenRefund = init.then(request("first", true, true, true)).then(request("first", true, true, true))
    .then(observe("purchase")).then(request("first", true, true, true))
    .expect(s.outcome == "daily-admit" and s.daily == 3)
    .then(observe("free")).then(request("first", true, true, true))
    .expect(s.outcome == "daily-refused" and s.daily == 4)

  run subscriptionRenewsAcrossCredentials = init.then(observe("subscription"))
    .then(request("first", true, true, true)).then(request("first", true, true, true))
    .then(request("first", true, true, true)).then(request("second", true, true, true))
    .expect(s.outcome == "daily-admit" and s.daily == 4 and s.minute == 0)
    .then(request("first", true, true, true)).then(request("second", true, true, true))
    .expect(s.outcome == "minute-admit" and s.minute == 2)
    .then(request("first", true, true, true)).expect(s.outcome == "minute-refused")
    .then(renewMinute).then(request("first", true, true, true))
    .expect(s.outcome == "minute-admit" and s.minute == 1 and s.daily == 5)
    .then(observe("free")).then(request("second", true, true, true))
    .expect(s.outcome == "daily-refused")
}
