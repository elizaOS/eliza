// One exact organization PUT receipt and its immutable provider generation.
// Leases fence SQL writes, while the provider may apply an already sent PUT late.
module NativeStoragePutRecovery {
  type Work = { token: int, kind: str, head: str }
  type State = {
    phase: str, now: int, touched: int, leaseUntil: int, token: int,
    work: int -> Work,
    absenceSeen: bool, sent: bool, inFlight: bool, providerPresent: bool,
    quotaHeld: bool, credit: str, catalogPublished: bool, receipt: str,
    terminalToken: int
  }

  pure val Workers = Set(1, 2)
  pure val Idle = { token: 0, kind: "idle", head: "none" }
  pure val Terminal = Set("committed", "refunded")
  pure val Leased = Set("provider_started", "reconciling")
  pure val Grace = 2
  pure val Lease = 1
  pure val Quarantine = 2
  pure val Horizon = 9
  pure val MaxToken = 4

  var s: State
  action init = s' = {
    phase: "prepared", now: 0, touched: 0, leaseUntil: 0, token: 0,
    work: Workers.mapBy(_ => Idle),
    absenceSeen: false, sent: false, inFlight: false, providerPresent: false,
    quotaHeld: true, credit: "none", catalogPublished: false, receipt: "none",
    terminalToken: 0
  }

  val due = if (Set("prepared", "reserved").contains(s.phase))
    s.touched + Grace < s.now
    else Leased.contains(s.phase) and s.leaseUntil < s.now

  action reserve = all {
    s.phase == "prepared",
    s' = s.with("phase", "reserved").with("credit", "held").with("touched", s.now)
  }

  action insufficient = all {
    s.phase == "prepared",
    s' = s.with("phase", "refunded").with("quotaHeld", false).with("receipt", "insufficient")
  }

  action claim(worker: int, recovery: bool): bool = all {
    s.work.get(worker) == Idle,
    s.token < MaxToken,
    if (recovery) due
    else s.phase == "reserved" or (s.phase == "provider_started" and s.leaseUntil < s.now),
    {
      val token = s.token + 1
      val kind = if (recovery) "recovery" else "writer"
      val phase = if (recovery and s.phase != "provider_started") "reconciling" else "provider_started"
      s' = s.with("token", token).with("leaseUntil", s.now + Lease).with("touched", s.now)
        .with("phase", phase).with("work", s.work.set(worker, { token: token, kind: kind, head: "pending" }))
        .with("sent", s.sent or not(recovery)).with("inFlight", s.inFlight or not(recovery))
    }
  }

  action providerApply = all {
    s.inFlight,
    s' = s.with("inFlight", false).with("providerPresent", true)
  }

  action providerDrop = all {
    s.inFlight,
    s' = s.with("inFlight", false)
  }

  action observe(worker: int): bool = all {
    s.work.get(worker).head == "pending",
    {
      val observed = if (s.providerPresent) "present" else "absent"
      s' = s.with("work", s.work.set(worker, s.work.get(worker).with("head", observed)))
    }
  }

  // Failure, cancellation or crash loses process-local evidence, not the durable lease or hold.
  action abandon(worker: int): bool = all {
    s.work.get(worker) != Idle,
    s' = s.with("work", s.work.set(worker, Idle))
  }

  def owns(worker: int): bool = Leased.contains(s.phase) and s.work.get(worker).token == s.token

  action deferAbsence(worker: int): bool = all {
    owns(worker),
    s.work.get(worker).kind == "recovery" and s.work.get(worker).head == "absent",
    s.phase == "provider_started",
    s' = s.with("phase", "reconciling").with("absenceSeen", true)
      .with("leaseUntil", s.touched + Quarantine).with("work", s.work.set(worker, Idle))
  }

  action commit(worker: int): bool = all {
    owns(worker),
    s.work.get(worker).head == "present",
    s' = s.with("phase", "committed").with("catalogPublished", true)
      .with("credit", "settled").with("receipt", "committed").with("terminalToken", s.token)
      .with("work", s.work.set(worker, Idle)).with("leaseUntil", 0)
      .with("absenceSeen", false)
  }

  action refund(worker: int): bool = all {
    owns(worker),
    s.work.get(worker).kind == "recovery",
    s.phase == "reconciling",
    not(s.absenceSeen) or s.work.get(worker).head == "absent",
    s' = s.with("phase", "refunded").with("quotaHeld", false)
      .with("credit", if (s.credit == "held") "returned" else s.credit)
      .with("receipt", if (s.absenceSeen) "second-absence" else "unstarted")
      .with("terminalToken", s.token).with("work", s.work.set(worker, Idle))
      .with("leaseUntil", 0).with("absenceSeen", false)
  }

  action finishWork(worker: int): bool = any {
    observe(worker), deferAbsence(worker), commit(worker), refund(worker), abandon(worker)
  }
  action tick = all { s.now < Horizon, s' = s.with("now", s.now + 1) }
  action replay = all { Terminal.contains(s.phase), s' = s }
  action wait = s' = s

  action step = any {
    reserve, insufficient, providerApply, providerDrop, tick, replay, wait,
    {
      nondet worker = Workers.oneOf()
      any { claim(worker, false), claim(worker, true), finishWork(worker) }
    }
  }

  val Safety = and {
    s.catalogPublished == (s.phase == "committed"),
    s.quotaHeld == (s.phase != "refunded"),
    (s.phase == "committed") implies (s.providerPresent and s.credit == "settled" and s.receipt == "committed"),
    (s.phase == "refunded") implies s.credit != "held",
    (s.phase == "refunded" and s.sent) implies s.receipt == "second-absence",
    s.absenceSeen implies (s.sent and s.phase == "reconciling"),
    Terminal.contains(s.phase) == (s.receipt != "none"),
    Terminal.contains(s.phase) implies s.terminalToken == s.token,
    Leased.contains(s.phase) implies s.token > 0,
    Workers.forall(worker => s.work.get(worker).token <= s.token),
    not(Workers.forall(worker => owns(worker)))
  }

  temporal DurableAuthority = always((all {
    (next(s.token) > s.token and Leased.contains(s.phase)) implies s.leaseUntil < s.now,
    (s.phase == "provider_started" and next(s.phase) == "reconciling") implies
      (next(s.absenceSeen) and next(s.token) == s.token),
    (not(s.catalogPublished) and next(s.catalogPublished)) implies
      Workers.exists(worker => owns(worker) and s.work.get(worker).head == "present"),
    (s.receipt == "none" and next(s.receipt) == "second-absence") implies all {
      s.phase == "reconciling" and s.absenceSeen,
      Workers.exists(worker => owns(worker) and s.work.get(worker).head == "absent")
    },
    Terminal.contains(s.phase) implies all {
      next(s.phase) == s.phase, next(s.receipt) == s.receipt,
      next(s.catalogPublished) == s.catalogPublished, next(s.credit) == s.credit
    }
  }).orKeep(s))

  temporal CallsSettle = Workers.forall(worker =>
    (s.work.get(worker) != Idle).leadsTo(s.work.get(worker) == Idle))
  temporal FairCallsSettle = Workers.forall(worker => finishWork(worker).weakFair(s)) implies CallsSettle

  run freshReservationIsNotDueTest = init.then(tick).then(reserve).then(tick).then(tick)
    .expect(not(due)).then(tick).expect(due)

  run providerWinsDueScanRaceTest = init.then(reserve).then(tick).then(tick).then(tick)
    .expect(due).then(claim(1, false)).expect(not(due) and not(owns(2)))

  run missingResponseCanStillCommitTest = init.then(reserve).then(claim(1, false))
    .then(abandon(1)).then(providerApply).then(tick).then(tick).then(claim(2, true))
    .then(observe(2)).then(commit(2)).then(replay)
    .expect(s.catalogPublished and s.credit == "settled")

  run quarantineRequiresAnotherClaimTest = init.then(reserve).then(claim(1, false))
    .then(tick).then(tick).then(claim(2, true)).then(observe(2)).then(deferAbsence(2))
    .then(tick).then(tick).expect(not(due)).then(tick).then(claim(2, true))
    .then(observe(2)).then(refund(2)).then(providerApply).then(replay)
    .expect(s.providerPresent and not(s.catalogPublished) and not(s.quotaHeld) and s.credit == "returned")

  run staleHeadCannotPublishTest = init.then(reserve).then(claim(1, false))
    .then(providerApply).then(observe(1)).then(tick).then(tick).then(claim(2, true))
    .expect(not(owns(1)) and owns(2)).then(observe(2)).then(commit(2))
    .expect(s.terminalToken == 2 and s.catalogPublished)

  run unstartedRecoveryKeepsNoCreditHoldTest = init.then(tick).then(tick).then(tick)
    .then(claim(1, true)).then(refund(1)).then(replay)
    .expect(not(s.quotaHeld) and s.credit == "none" and not(s.sent))
}
