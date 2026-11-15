// MapsRequestAllowanceController.handle /maps/admit and /maps/usage.
// Each SQL-backed Durable Object transaction is one atomic action. Paired
// bucket arithmetic is checked separately in maps_request_buckets.qnt.
module maps_request_receipts {
  type Receipt = { window: int, outcome: str, firstOutcome: str }
  type State = {
    now: int,
    window: int,
    highWindow: int,
    used: int,
    receipts: int -> Receipt,
    admissions: int -> int,
    activeCredentials: Set[int],
    lastKey: int,
    reply: str,
  }
  var s: State
  // Keys 0 and 1 have one credential. Key 2 uses another credential with the
  // same caller-supplied request id as key 0.
  pure val receiptKeys = Set(0, 1, 2)
  pure val credentials = Set(0, 1)
  pure val terminalOutcomes = Set("succeeded", "failed", "cancelled")
  pure def credential(key: int): int = if (key == 2) 1 else 0
  val currentWindow = s.now / 2

  action init = s' = {
    now: 0, window: -1, highWindow: -1, used: 0,
    receipts: receiptKeys.mapBy(_ => { window: -1, outcome: "absent", firstOutcome: "unknown" }),
    admissions: receiptKeys.mapBy(_ => 0),
    activeCredentials: credentials,
    lastKey: 0, reply: "none",
  }

  action clock(now: int): bool = all {
    now >= 0, now <= 3, s' = s.with("now", now),
  }
  action revoke(owner: int): bool = s' = s.with("activeCredentials", s.activeCredentials.exclude(Set(owner)))

  // serializeRevocation orders credential rejection with the transaction.
  // The caller holds its primary policy read lock through admission.
  action admit(key: int, matchesIdentity: bool, acknowledged: bool, guard: str): bool = {
    val previous = s.receipts.get(key)
    val oldWindowActive = s.window >= 0 and s.window >= currentWindow
    val used = if (oldWindowActive) s.used else 0
    val reply =
      if (not(s.activeCredentials.contains(credential(key)))) "revoked"
      else if (guard == "stale") "stale"
      else if (guard == "unconfigured") "unconfigured"
      else if (previous.outcome != "absent")
        (if (matchesIdentity) "duplicate" else "identity-conflict")
      else if (oldWindowActive and s.window != currentWindow) "window-conflict"
      else if (used >= 2) "exhausted"
      else if (guard == "rate-limited") "rate-limited"
      else if (acknowledged) "admitted" else "unknown"
    val accepted = reply == "admitted" or reply == "unknown"
    s' = if (accepted)
      s.with("window", currentWindow)
        .with("highWindow", if (currentWindow > s.highWindow) currentWindow else s.highWindow)
        .with("used", used + 1)
        .with("receipts", s.receipts.set(key, {
          window: currentWindow, outcome: "unknown", firstOutcome: "unknown",
        }))
        .with("admissions", s.admissions.set(key, s.admissions.get(key) + 1))
        .with("lastKey", key).with("reply", reply)
    else s.with("lastKey", key).with("reply", reply)
  }

  // Usage does not read the plan's current expiry or configuration, and never
  // releases an admission. It still requires a currently valid credential.
  action usage(key: int, matchesIdentity: bool, outcome: str): bool = {
    val previous = s.receipts.get(key)
    val reply =
      if (not(s.activeCredentials.contains(credential(key)))) "revoked"
      else if (previous.outcome == "absent" or not(matchesIdentity)) "identity-conflict"
      else if (previous.outcome != "unknown" and previous.outcome != outcome) "outcome-conflict"
      else "recorded"
    s' = if (reply == "recorded" and previous.outcome == "unknown")
      s.with("receipts", s.receipts.set(key,
        previous.with("outcome", outcome).with("firstOutcome", outcome)))
        .with("lastKey", key).with("reply", reply)
    else s.with("lastKey", key).with("reply", reply)
  }
  action observeTerminal(key: int): bool = {
    nondet outcome = terminalOutcomes.oneOf()
    all { s.receipts.get(key).outcome == "unknown", usage(key, true, outcome) }
  }

  // A restart loses the transport response but retains the SQLite count and
  // every per-credential receipt. Transaction aborts have the same durable stutter.
  action restart = s' = s.with("reply", "none")
  action step = any {
    { nondet now = 0.to(3).oneOf(); clock(now) },
    { nondet owner = credentials.oneOf(); revoke(owner) },
    {
      nondet key = receiptKeys.oneOf()
      nondet matches = Set(false, true).oneOf()
      nondet acknowledged = Set(false, true).oneOf()
      nondet guard = Set("eligible", "stale", "unconfigured", "rate-limited").oneOf()
      admit(key, matches, acknowledged, guard)
    },
    {
      nondet key = receiptKeys.oneOf()
      nondet matches = Set(false, true).oneOf()
      nondet outcome = terminalOutcomes.oneOf()
      usage(key, matches, outcome)
    },
    restart,
  }

  val boundedAllowance = s.used >= 0 and s.used <= 2 and
    0.to(1).forall(window =>
      receiptKeys.filter(key => s.receipts.get(key).window == window).size() <= 2)
  val countMatchesReceipts = s.window < 0 or s.used ==
    receiptKeys.filter(key => s.receipts.get(key).window == s.window).size()
  val oneAdmissionPerReceipt = receiptKeys.forall(key => {
    val receipt = s.receipts.get(key)
    s.admissions.get(key) == (if (receipt.outcome == "absent") 0 else 1)
  })
  val firstTerminalOutcomeWins = receiptKeys.forall(key => {
    val receipt = s.receipts.get(key)
    receipt.firstOutcome == "unknown" or receipt.outcome == receipt.firstOutcome
  })
  val unknownReplyRetainsReceipt = s.reply != "unknown" or
    s.admissions.get(s.lastKey) == 1
  val windowNeverRetreats = s.window == s.highWindow
  val safety = boundedAllowance and countMatchesReceipts and oneAdmissionPerReceipt
    and firstTerminalOutcomeWins and unknownReplyRetainsReceipt and windowNeverRetreats

  temporal ObservedUsageSettles =
    receiptKeys.forall(key => observeTerminal(key).weakFair(s)) implies
      always(receiptKeys.forall(key =>
        (s.receipts.get(key).outcome == "unknown" and
          s.activeCredentials.contains(credential(key))) implies
          eventually(s.receipts.get(key).outcome != "unknown" or
            not(s.activeCredentials.contains(credential(key))))))

  run lostAcknowledgementCannotReplayTest = init.then(admit(0, true, false, "eligible"))
    .then(restart).then(admit(0, true, true, "eligible"))
    .expect(s.reply == "duplicate" and s.used == 1 and safety)
  run cancellationDoesNotRefundTest = init.then(admit(0, true, true, "eligible"))
    .then(admit(1, true, true, "eligible")).then(usage(0, true, "cancelled"))
    .then(admit(2, true, true, "eligible")).expect(s.reply == "exhausted" and s.used == 2 and safety)
  run firstUsageOutcomeWinsTest = init.then(admit(0, true, true, "eligible"))
    .then(usage(0, true, "failed")).then(usage(0, true, "failed"))
    .then(usage(0, true, "succeeded"))
    .expect(s.reply == "outcome-conflict" and s.receipts.get(0).outcome == "failed" and safety)
  run receiptSurvivesWindowRolloverTest = init.then(admit(0, true, false, "eligible"))
    .then(clock(2)).then(admit(1, true, true, "eligible")).then(admit(0, true, true, "eligible"))
    .expect(s.reply == "duplicate" and s.used == 1 and safety)
  run usageOutlivesPlanWindowTest = init.then(admit(0, true, true, "eligible"))
    .then(admit(1, true, true, "stale")).then(usage(0, true, "cancelled"))
    .expect(s.reply == "recorded" and s.used == 1 and safety)
  run credentialsHaveSeparateRequestIdsTest = init.then(admit(0, true, true, "eligible"))
    .then(admit(2, true, true, "eligible")).expect(s.used == 2 and safety)
  run foreignUsageCannotSettleTest = init.then(admit(0, true, true, "eligible"))
    .then(usage(0, false, "succeeded"))
    .expect(s.reply == "identity-conflict" and s.receipts.get(0).outcome == "unknown" and safety)
  run revocationBlocksNewAdmissionAndUsageTest = init.then(admit(0, true, true, "eligible"))
    .then(revoke(0)).then(usage(0, true, "succeeded")).then(admit(1, true, true, "eligible"))
    .expect(s.reply == "revoked" and s.used == 1 and safety)
  run clockRollbackCannotResetCountTest = init.then(clock(2)).then(admit(0, true, true, "eligible"))
    .then(clock(0)).then(admit(1, true, true, "eligible"))
    .expect(s.reply == "window-conflict" and s.window == 1 and s.used == 1 and safety)
}
