// Metering starts after the caller has already verified the consumer identity.
module ConsumerQuotaSettlementModel {
  const SeparateConsumers: bool
  const AllowDayRollover: bool
  val Calls = Set("first", "second")
  val Quota = 3
  val Ttl = 1
  val Held = Set("remove", "append", "total", "ack")
  val Terminal = Set("reported", "failed")
  type Meter = { phase: str, reserved: bool, reserveDay: int, expiresAt: int,
    receiptDay: int, used: int, log: bool, total: bool }
  var s: { now: int, day: int, lock: str, calls: str -> Meter }

  pure def consumer(call: str): str = if (SeparateConsumers) call else "first"
  pure def units(call: str): int = if (call == "first") 2 else 1
  def live(meter: Meter): bool = meter.reserved and meter.expiresAt > s.now
  def recordedFor(owner: str, day: int): int = Calls.fold(0, (count, call) => {
    val meter = s.calls.get(call)
    if (consumer(call) == owner and meter.log and meter.receiptDay == day)
      count + meter.used else count
  })
  def reservedFor(owner: str, day: int): int = Calls.fold(0, (count, call) => {
    val meter = s.calls.get(call)
    if (consumer(call) == owner and live(meter) and meter.reserveDay == day)
      count + units(call) else count
  })

  action init = s' = { now: 0, day: 0, lock: "", calls: Calls.mapBy(_ => {
    phase: "idle", reserved: false, reserveDay: 0, expiresAt: 0,
    receiptDay: 0, used: 0, log: false, total: false }) }
  action admit(call: str, storeSucceeds: bool): bool = {
    val current = s.calls.get(call)
    val allowed = recordedFor(consumer(call), s.day)
      + reservedFor(consumer(call), s.day) + units(call) <= Quota
    all {
      s.lock == "", current.phase == "idle",
      s' = { ...s, calls: s.calls.set(call,
        if (not(allowed)) { ...current, phase: "refused" }
        else if (not(storeSucceeds)) { ...current, phase: "admissionFailed" }
        else { ...current, phase: "admitted", reserved: true,
          reserveDay: s.day, expiresAt: s.now + Ttl }) },
    }
  }
  action requestReport(call: str, actual: int): bool = {
    val current = s.calls.get(call)
    all {
      current.phase == "admitted",
      s' = { ...s, calls: s.calls.set(call, { ...current,
        phase: "waiting", receiptDay: s.day, used: actual }) },
    }
  }
  action acquire(call: str): bool = {
    val current = s.calls.get(call)
    all {
      s.lock == "", current.phase == "waiting",
      s' = { ...s, lock: call, calls: s.calls.set(call, { ...current, phase: "remove" }) },
    }
  }
  action persist(call: str, succeeds: bool): bool = {
    val current = s.calls.get(call)
    all {
      s.lock == call, Held.contains(current.phase),
      // Removing an expired reservation is a no-op, so that write cannot fail.
      succeeds or current.phase != "remove" or live(current),
      s' = if (not(succeeds)) { ...s, lock: "",
        calls: s.calls.set(call, { ...current, phase: "failed" }) }
      else if (current.phase == "remove") { ...s, calls: s.calls.set(call,
        { ...current, phase: "append", reserved: current.reserved and not(live(current)) }) }
      else if (current.phase == "append") { ...s, calls: s.calls.set(call,
        { ...current, phase: "total", log: true }) }
      else if (current.phase == "total") { ...s, calls: s.calls.set(call,
        { ...current, phase: "ack", total: true }) }
      else { ...s, lock: "", calls: s.calls.set(call, { ...current, phase: "reported" }) },
    }
  }
  action progress(call: str): bool = any { acquire(call), persist(call, true), persist(call, false) }
  action tick = all { s.now < 2, s' = { ...s, now: s.now + 1 } }
  action rollDay = all { AllowDayRollover, s.day == 0, s' = { ...s, day: 1 } }
  action step = any {
    tick, rollDay, s' = s,
    { nondet call = Calls.oneOf()
      nondet actual = Set(0, 1, 4).oneOf()
      any { admit(call, true), admit(call, false), requestReport(call, actual), progress(call) }
    },
  }

  val SingleLedgerWriter = Calls.filter(call => Held.contains(s.calls.get(call).phase))
    == (if (s.lock == "") Set() else Set(s.lock))
  val ConfirmedReportHasBothWrites = Calls.forall(call => {
    val meter = s.calls.get(call)
    (meter.phase == "reported").implies(meter.log and meter.total and not(live(meter)))
  })
  val AggregateRequiresLedger = Calls.forall(call => {
    val meter = s.calls.get(call)
    meter.total.implies(meter.log)
  })
  temporal AdmissionUsesOwnerAndDay = always(Calls.forall(call =>
    (s.calls.get(call).phase == "idle" and next(s.calls.get(call).phase) == "admitted")
      .implies(next(s.calls.get(call).reserveDay) == s.day
        and recordedFor(consumer(call), s.day) + reservedFor(consumer(call), s.day) + units(call) <= Quota)
  ).orKeep(s))
  temporal FailedWriteRetainsPublishedEvidence = always(Calls.forall(call => and {
    s.calls.get(call).log.implies(next(s.calls.get(call).log)),
    s.calls.get(call).total.implies(next(s.calls.get(call).total)),
  }).orKeep(s))
  temporal ReportSettlesWithoutFairness = Calls.forall(call =>
    (s.calls.get(call).phase == "waiting").leadsTo(Terminal.contains(s.calls.get(call).phase)))
  temporal ReportSettles = Calls.forall(call => progress(call).weakFair(s))
    .implies(ReportSettlesWithoutFairness)
}

module ConsumerQuotaSettlement {
  import ConsumerQuotaSettlementModel(SeparateConsumers = false, AllowDayRollover = false).*

  run overlappingReservationsReconcileTest = init.then(admit("first", true))
    .then(admit("second", true)).expect(reservedFor("first", 0) == 3)
    .then(requestReport("first", 1)).then(acquire("first"))
    .then(persist("first", true)).expect(reservedFor("first", 0) == 1)
    .then(persist("first", true)).then(persist("first", true)).then(persist("first", true))
    .expect(recordedFor("first", 0) == 1 and reservedFor("first", 0) == 1)

  run partialPublicationRemainsVisibleTest = init.then(admit("first", true))
    .then(requestReport("first", 4)).then(acquire("first")).then(persist("first", true))
    .then(persist("first", true)).then(persist("first", false))
    .expect(s.calls.get("first").phase == "failed" and not(s.calls.get("first").total)
      and recordedFor("first", 0) == 4).then(admit("second", true))
    .expect(s.calls.get("second").phase == "refused")
}

module ConsumerQuotaSettlementAcrossDay {
  import ConsumerQuotaSettlementModel(SeparateConsumers = true, AllowDayRollover = true).*

  run recordsInCompletionDayTest = init.then(admit("first", true)).then(rollDay)
    .then(requestReport("first", 4)).then(admit("second", true)).then(acquire("first"))
    .then(tick).then(persist("first", true)).then(persist("first", true))
    .then(persist("first", true)).then(persist("first", true))
    .expect(recordedFor("first", 0) == 0 and recordedFor("first", 1) == 4
      and recordedFor("second", 1) == 0)
}
