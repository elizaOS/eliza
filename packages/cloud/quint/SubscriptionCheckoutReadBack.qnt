// Settlement of one dispatched organization checkout by the recovery sweep in
// subscription-checkout.ts. One tick is the first read-back age (two minutes).
// The read-back lane observes an unfenced checkout inside the provider retry
// horizon, waiting its age at the last inspection, between one tick and the
// cap. The closure lane handles fenced organizations and checkouts at the
// horizon. The webhook and the app's confirm settle the same payment.
// Command CAS, revision history and entitlement publication are refined by
// PlatformSubscriptionCommand and SubscriptionTerminalReceipt.
module SubscriptionCheckoutReadBack {
  pure val MinAge = 1
  pure val MaxBackoff = 4
  pure val Horizon = 10
  pure val CreateSettle = 1
  pure val End = 12
  type State = {
    clock: int,
    command: str,
    session: str,
    fenced: bool,
    webhook: str,
    inspectedAt: int,
    reads: int,
    applications: int,
    readBackWrote: bool,
    readBackOutsideLane: bool
  }
  var s: State

  // Dispatch committed at clock 0. The create call may or may not have reached
  // the provider.
  action initWith(session: str): bool = s' = {
    clock: 0, command: "pending", session: session, fenced: false, webhook: "none",
    inspectedAt: 0, reads: 0, applications: 0,
    readBackWrote: false, readBackOutsideLane: false
  }
  action init = { nondet session = Set("open", "missing").oneOf(); initWith(session) }

  pure def clamp(value: int, low: int, high: int): int =
    if (value < low) low else if (value > high) high else value
  // listDispatchedCheckoutsDueForInspection. rotateCheckoutRecovery stamps
  // inspectedAt, so the wait is the age at the last inspection, clamped.
  def Due = and {
    s.command == "pending", not(s.fenced), s.clock < Horizon,
    s.clock >= MinAge,
    s.clock >= s.inspectedAt + clamp(s.inspectedAt, MinAge, MaxBackoff)
  }
  // listStalePendingCheckouts.
  def Stale = s.command == "pending" and (s.fenced or s.clock >= Horizon)
  // Reconciliation is idempotent across the webhook, confirm and both lanes.
  pure def Applied(state: State): State =
    if (state.command == "pending") { ...state, command: "applied", applications: state.applications + 1 }
    else state

  action Tick = all { s.clock < End, s' = { ...s, clock: s.clock + 1 } }
  action Fence = all { not(s.fenced), s' = { ...s, fenced: true } }
  // The original idempotent create can still land inside the retry horizon.
  action Materialize = all {
    s.session == "missing", s.clock < Horizon, s' = { ...s, session: "open" }
  }
  action Pay(delivered: bool): bool = all {
    s.session == "open",
    s' = { ...s, session: "complete", webhook: if (delivered) "pending" else "lost" }
  }
  action ProviderExpires = all { s.session == "open", s' = { ...s, session: "expired" } }
  action Webhook = all {
    s.webhook == "pending", s' = Applied({ ...s, webhook: "delivered" })
  }
  action Confirm = all { s.session == "complete", s' = Applied(s) }

  // The read-back lane only observes: it never expires, creates or closes.
  action ReadBack = all {
    Due,
    s' = {
      ...(if (s.session == "complete") Applied(s)
        else if (s.session == "expired") { ...s, command: "retired" }
        else { ...s, inspectedAt: s.clock }),
      reads: s.reads + 1,
      readBackOutsideLane: s.readBackOutsideLane or s.fenced or s.clock >= Horizon
    }
  }
  // The closure lane expires a payable session only for a fenced organization
  // and fails a missing session only after the create horizon has settled.
  action Close = all {
    Stale,
    s' = if (s.session == "complete") Applied(s)
      else if (s.session == "expired") { ...s, command: "retired" }
      else if (s.session == "open" and s.fenced) { ...s, session: "expired", command: "retired" }
      else if (s.session == "missing" and s.clock >= Horizon + CreateSettle) { ...s, command: "retired" }
      else { ...s, inspectedAt: s.clock }
  }

  action step = any {
    Tick, Fence, Materialize, ProviderExpires, Webhook, Confirm, ReadBack, Close,
    { nondet delivered = Set(true, false).oneOf(); Pay(delivered) },
    s' = s
  }

  // Read-backs of one checkout by a given age: at 1, 2, 4 and 8 ticks.
  pure def MaxReads(age: int): int =
    if (age < 1) 0 else if (age < 2) 1 else if (age < 4) 2 else if (age < 8) 3 else 4
  val TypeOK = and {
    s.clock >= 0, s.clock <= End,
    Set("pending", "applied", "retired").contains(s.command),
    Set("missing", "open", "complete", "expired").contains(s.session),
    Set("none", "pending", "lost", "delivered").contains(s.webhook),
    s.inspectedAt >= 0, s.inspectedAt <= s.clock
  }
  val OneApplication = s.applications <= 1 and (s.command == "applied") == (s.applications == 1)
  val AppliedOnlyWhenPaid = s.command != "applied" or s.session == "complete"
  val PaidNeverRetired = s.command != "retired" or Set("expired", "missing").contains(s.session)
  val ReadBackOnlyObserves = not(s.readBackWrote) and not(s.readBackOutsideLane)
  val BoundedReadBacks = s.reads <= MaxReads(s.clock)
  val safety = TypeOK and OneApplication and AppliedOnlyWhenPaid and PaidNeverRetired and
    ReadBackOnlyObserves and BoundedReadBacks

  temporal Fairness = Tick.weakFair(s) and ReadBack.weakFair(s) and Close.weakFair(s)
  // A captured payment is entitled without its webhook or the app's confirm.
  temporal PaidSettlesWithoutWebhook = Fairness implies
    always(s.session == "complete" implies eventually(s.command == "applied"))
  // No bound is promised without the sweep running.
  temporal PaidSettlesUnconditionally =
    always(s.session == "complete" implies eventually(s.command == "applied"))

  // Excluded mutants show the invariants reject weakened lane guards.
  action UnsafeReadBackExpiresOpen = all {
    Due, s.session == "open",
    s' = { ...s, session: "expired", command: "retired", reads: s.reads + 1, readBackWrote: true }
  }
  action UnsafeReadBackWithoutBackoff = all {
    s.command == "pending", s.clock >= MinAge,
    s' = { ...s, inspectedAt: s.clock, reads: s.reads + 1 }
  }
  action UnsafeCloseOpenUnfenced = all {
    Stale, s.session == "open", s' = { ...s, command: "retired" }
  }

  run lostWebhookSettlesAtFirstReadBackTest = initWith("open").then(Pay(false))
    .then(Tick).then(ReadBack)
    .expect(safety and s.command == "applied" and s.reads == 1 and s.clock == 1)
  run openCheckoutIsReadWithDoublingCappedBackoffTest = initWith("open")
    .then(Tick).then(ReadBack).then(Tick).then(ReadBack)
    .then(Tick).then(Tick).then(ReadBack)
    .then(Tick).then(Tick).then(Tick).then(Tick).then(ReadBack)
    .expect(safety and s.reads == 4 and s.inspectedAt == 8 and s.session == "open" and
      s.command == "pending" and not(Due))
  run readBackWaitsItsIntervalTest = initWith("open")
    .then(Tick).then(Tick).then(ReadBack).then(Tick)
    .expect(safety and s.reads == 1 and not(Due))
  run webhookConfirmAndSweepApplyOnceTest = initWith("open").then(Pay(true))
    .then(Tick).then(ReadBack).then(Webhook).then(Confirm)
    .expect(safety and s.applications == 1 and s.webhook == "delivered")
  run fencedCheckoutIsClosedNotObservedTest = initWith("open").then(Tick).then(Fence)
    .expect(not(Due) and Stale)
    .then(Close)
    .expect(safety and s.session == "expired" and s.command == "retired" and s.reads == 0)
  run fencedPaidCheckoutIsStillReconciledTest = initWith("open").then(Pay(false))
    .then(Fence).then(Close)
    .expect(safety and s.command == "applied")
  run missingSessionWaitsForTheCreateHorizonTest = initWith("missing").then(Tick).then(ReadBack)
    .expect(safety and s.command == "pending" and s.session == "missing")
    .then(10.reps(_ => Tick)).then(Close)
    .expect(safety and s.command == "retired" and s.clock == Horizon + CreateSettle)
  run lateCreateIsNeverFailedInsideTheHorizonTest = initWith("missing").then(9.reps(_ => Tick))
    .then(Materialize).then(Tick).then(Close)
    .expect(safety and s.command == "pending" and s.session == "open")
  run readBackExpiryGuardNegativeWitnessTest = initWith("open").then(Tick)
    .then(UnsafeReadBackExpiresOpen).expect(not(safety))
  run backoffGuardNegativeWitnessTest = initWith("open").then(Tick)
    .then(ReadBack).then(UnsafeReadBackWithoutBackoff).expect(not(safety))
}
