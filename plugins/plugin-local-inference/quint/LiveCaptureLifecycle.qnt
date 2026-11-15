// One capture and one original host epoch. A phone call may close startup
// without revoking delivery to the host that already admitted this capture.
module LiveCaptureLifecycle {
  var s: {
    phase: str,
    hostOpen: bool,
    startAllowed: bool,
    reported: bool,
    discarded: bool,
    delivered: bool,
    deliveryRequired: bool,
    consumed: bool
  }

  action init = s' = {
    phase: "reserved", hostOpen: true, startAllowed: true,
    reported: false, discarded: false, delivered: false,
    deliveryRequired: false, consumed: false
  }

  action nativeStart = all {
    s.phase == "reserved",
    s' = if (s.hostOpen and s.startAllowed)
      s.with("phase", "starting") else s.with("phase", "refused").with("discarded", true)
  }

  action reportStart = all {
    s.phase == "starting",
    s' = if (s.hostOpen and s.startAllowed)
      s.with("phase", "running").with("reported", true)
      else s.with("phase", "refused").with("discarded", true)
  }

  action protect = s' = s.with("startAllowed", false)
  action unprotect = s' = s.with("startAllowed", true)
  // A changed host epoch never becomes the original epoch again.
  action retireHost = s' = s.with("hostOpen", false)

  action interrupt = all {
    Set("reserved", "starting", "running").contains(s.phase),
    s' = if (s.reported) s.with("phase", "pending-end")
      else s.with("phase", "refused").with("discarded", true)
  }

  action deliverEnd = all {
    s.phase == "pending-end",
    s' = s.with("phase", "ended").with("consumed", true)
      .with("deliveryRequired", s.hostOpen)
      .with("delivered", s.hostOpen)
  }

  // Deliberately excluded from step. This is the previous implementation's
  // additional startup guard, exercised by the negative-control trace below.
  action obsoleteDelivery = all {
    s.phase == "pending-end",
    s' = s.with("phase", "ended").with("consumed", true)
      .with("deliveryRequired", s.hostOpen)
      .with("delivered", s.hostOpen and s.startAllowed)
  }

  action step = any {
    nativeStart, reportStart, protect, unprotect, retireHost,
    interrupt, deliverEnd, s' = s
  }

  val TerminalDelivered = s.consumed and s.deliveryRequired implies s.delivered
  val NoUnreportedEnd = s.delivered implies s.reported and not(s.discarded)
  val RefusedStartDiscarded = s.phase == "refused" implies s.discarded and not(s.reported)
  val safety = TerminalDelivered and NoUnreportedEnd and RefusedStartDiscarded

  // An admitted interruption reaches its still-current host, or that host retires.
  // This checks model progress under delivery fairness, not the Java executor.
  temporal TerminalDeliverySettlesWithoutFairness =
    (s.phase == "pending-end").leadsTo(s.delivered or not(s.hostOpen))
  temporal TerminalDeliverySettles =
    deliverEnd.weakFair(s).implies(TerminalDeliverySettlesWithoutFairness)

  run phoneCallKeepsTerminalEventTest = init.then(nativeStart).then(reportStart)
    .then(protect).then(interrupt).then(deliverEnd).expect(s.delivered and safety)
  run oldStartupGuardDropsTerminalEventTest = init.then(nativeStart).then(reportStart)
    .then(protect).then(interrupt).then(obsoleteDelivery).expect(not(TerminalDelivered))
  run lateProtectionDiscardsUnreportedCaptureTest = init.then(nativeStart).then(protect)
    .then(reportStart).expect(s.discarded and not(s.reported) and safety)
  run changedHostDoesNotReceiveTerminalEventTest = init.then(nativeStart).then(reportStart)
    .then(interrupt).then(retireHost).then(deliverEnd).expect(not(s.delivered) and safety)
}
