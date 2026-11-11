// Source: StripeCheckoutOrdersService.markProviderStarted and Checkout route.
// Immutable first-dispatch time authorizes retries; audit updated_at may advance.
// Database and application hours are independently abstracted to {0,22,44,66}.
// Only primary database time authorizes dispatch; application clock skew is
// unconstrained in this finite range. Audit error timestamps may use app time.
// This proves only the bounded time gate, not provider retention, network delay,
// external-effect uniqueness, or the correctness of the primary clock itself.
module checkout_retry_clock {
  type State = {
    now: int, appNow: int, firstStarted: int, updated: int, phase: str, calls: int, outsideOriginalWindow: bool
  }
  var s: State
  action init = s' = {
    now: 0, appNow: 0, firstStarted: -1, updated: 0, phase: "quoted", calls: 0, outsideOriginalWindow: false
  }
  action advance = all {
    s.now < 66,
    s' = s.with("now", s.now + 22).with("appNow", if(s.appNow < 66) s.appNow + 22 else 66)
  }
  action skewApplication = {
    nondet t = Set(0,22,44,66).oneOf()
    s' = s.with("appNow", t)
  }
  action dispatch = s' = s.with("phase", "started").with("calls", s.calls + 1).with("updated", s.now)
    .with("firstStarted", if (s.firstStarted == -1) s.now else s.firstStarted)
    .with("outsideOriginalWindow", s.outsideOriginalWindow
      or (s.firstStarted != -1 and s.now - s.firstStarted >= 23))
  def canCreate = s.calls < 3 and
    (s.phase == "quoted" or (s.phase == "ambiguous" and s.firstStarted != -1 and s.now - s.firstStarted < 23))
  action create = all {
    canCreate,
    dispatch
  }
  action providerError = all {
    s.phase == "started",
    s' = s.with("phase", "ambiguous").with("updated", s.appNow)
  }
  action idle = s' = s
  action step = any { advance, skewApplication, create, providerError, idle }
  val originalHorizonRespected = not(s.outsideOriginalWindow)
  val safety = originalHorizonRespected and s.now >= 0 and s.now <= 66
    and s.appNow >= 0 and s.appNow <= 66 and s.calls >= 0 and s.calls <= 3
    and s.updated >= 0 and s.updated <= 66

  run retryInsideOriginalWindowTest = init.then(create).then(providerError).then(advance).then(create)
    .expect(safety and s.calls == 2 and s.firstStarted == 0 and s.updated == 22)
  run repeatedFailuresDoNotResetDeadlineTest = init.then(create).then(providerError).then(advance)
    .then(create).then(providerError).then(advance)
    .expect(safety and s.calls == 2 and s.now - s.firstStarted >= 23)
  run delayedFirstDispatchGetsItsOwnWindowTest = init.then(advance).then(create).then(providerError)
    .then(advance).then(create).then(providerError).then(advance)
    .expect(safety and s.calls == 2 and s.firstStarted == 22 and s.updated == 44)

  action slowApplication = s' = s.with("appNow", 0)
  action unsafeApplicationCreate = all {
    s.calls < 3, s.phase == "ambiguous", s.appNow - s.firstStarted < 23, dispatch
  }
  run slowApplicationCannotExtendWindowTest = init.then(create).then(providerError).then(advance).then(advance).then(slowApplication)
    .expect(safety and not(canCreate))
  run applicationClockGateNegativeWitnessTest = init.then(create).then(providerError).then(advance).then(advance).then(slowApplication).then(unsafeApplicationCreate)
    .expect(not(safety) and s.calls == 2)

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
