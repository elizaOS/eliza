// Source: StripeCheckoutOrdersService.markProviderStarted and Checkout route.
// Immutable first-dispatch time authorizes retries; audit updated_at may advance.
// Hours are abstracted to {0,22,44,66}. This proves only the bounded time gate,
// not live clock accuracy, provider retention, or external-effect uniqueness.
module checkout_retry_clock {
  type State = {
    now: int, firstStarted: int, updated: int, phase: str, calls: int, outsideOriginalWindow: bool
  }
  var s: State
  action init = s' = {
    now: 0, firstStarted: -1, updated: 0, phase: "quoted", calls: 0, outsideOriginalWindow: false
  }
  action advance = all {
    s.now < 66,
    s' = s.with("now", s.now + 22)
  }
  action dispatch = s' = s.with("phase", "started").with("calls", s.calls + 1).with("updated", s.now)
    .with("firstStarted", if (s.firstStarted == -1) s.now else s.firstStarted)
    .with("outsideOriginalWindow", s.outsideOriginalWindow
      or (s.firstStarted != -1 and s.now - s.firstStarted >= 23))
  action create = all {
    s.calls < 3,
    s.phase == "quoted" or (s.phase == "ambiguous" and s.firstStarted != -1 and s.now - s.firstStarted < 23),
    dispatch
  }
  action providerError = all {
    s.phase == "started",
    s' = s.with("phase", "ambiguous").with("updated", s.now)
  }
  action idle = s' = s
  action step = any { advance, create, providerError, idle }
  val originalHorizonRespected = not(s.outsideOriginalWindow)
  val safety = originalHorizonRespected and s.now >= 0 and s.now <= 66
    and s.calls >= 0 and s.calls <= 3 and s.updated <= s.now
    and (s.calls == 0 or s.firstStarted <= s.updated)

  run retryInsideOriginalWindowTest = init.then(create).then(providerError).then(advance).then(create)
    .expect(safety and s.calls == 2 and s.firstStarted == 0 and s.updated == 22)
  run repeatedFailuresDoNotResetDeadlineTest = init.then(create).then(providerError).then(advance)
    .then(create).then(providerError).then(advance)
    .expect(safety and s.calls == 2 and s.now - s.firstStarted >= 23)
  run delayedFirstDispatchGetsItsOwnWindowTest = init.then(advance).then(create).then(providerError)
    .then(advance).then(create).then(providerError).then(advance)
    .expect(safety and s.calls == 2 and s.firstStarted == 22 and s.updated == 44)

  // The former updated_at gate could reset indefinitely. Excluded from step.
  action legacyCreate = all {
    s.calls < 3,
    s.phase == "quoted" or (s.phase == "ambiguous" and s.now - s.updated < 23),
    dispatch
  }
  run rollingTimestampNegativeWitnessTest = init.then(legacyCreate).then(providerError).then(advance)
    .then(legacyCreate).then(providerError).then(advance).then(legacyCreate)
    .expect(not(safety) and s.calls == 3)
}
