// Single-runtime admission queue, durable approval boundaries and reply retention.
// SQL operations can fail. Removing expired rows is separate from eligibility.
module PairingAdmission {
  pure val senders = Set(0, 1, 2)
  pure val none = -1
  var s: { rows: int -> str, active: int, phase: str, result: str,
    observedCount: int, lastSender: int, created: bool }
  action init = s' = { rows: senders.mapBy(_ => "absent"), active: none,
    phase: "idle", result: "idle", observedCount: 0, lastSender: 0, created: false }
  action enter(sender: int): bool = all {
    s.phase == "idle",
    s' = { ...s, active: sender, phase: "reading", result: "pending", created: false },
  }
  action read = all {
    s.phase == "reading",
    val count = senders.filter(sender => s.rows.get(sender) == "live").size()
    s' = { ...s, observedCount: count,
      phase: if (s.rows.get(s.active) == "live") "updating"
        else if (count >= 2) "rejecting" else "creating" },
  }
  action write(ok: bool): bool = all {
    Set("updating", "creating").contains(s.phase),
    s' = { ...s, rows: if (ok and s.phase == "creating") s.rows.set(s.active, "live") else s.rows,
      lastSender: s.active, active: none, phase: "idle", result: if (ok) "ok" else "failed",
      created: ok and s.phase == "creating" },
  }
  action reject = all {
    s.phase == "rejecting",
    s' = { ...s, lastSender: s.active, active: none, phase: "idle", result: "full", created: false },
  }
  action expire(sender: int): bool = all {
    s.rows.get(sender) == "live",
    s' = { ...s, rows: s.rows.set(sender, "expired") },
  }
  action clean(sender: int): bool = all {
    s.rows.get(sender) == "expired",
    s' = { ...s, rows: s.rows.set(sender, "absent") },
  }
  action step = {
    nondet sender = senders.oneOf()
    any { enter(sender), read, write(true), write(false), reject, expire(sender), clean(sender), s' = s }
  }
  val PendingLimit = senders.filter(sender => s.rows.get(sender) == "live").size() <= 2
  val SingleAdmission = (s.phase == "idle") == (s.active == none)
  val AdmissionUsesBoundedRead = (s.phase == "creating").implies(s.observedCount < 2)
  // The model separates expiry after read from update. Updating a previously
  // eligible row does not renew createdAt and therefore does not revive it.
  temporal QueueProgress = (step.weakFair(s) and read.weakFair(s)
    and write(true).weakFair(s) and reject.weakFair(s)).implies(
      (s.phase != "idle").leadsTo(s.phase == "idle"))
  run capRejectsNewSenderTest = init.then(enter(0)).then(read).then(write(true))
    .then(enter(1)).then(read).then(write(true)).then(enter(2)).then(read).then(reject)
    .expect(s.result == "full" and PendingLimit)
  run failedWriteDoesNotPoisonQueueTest = init.then(enter(0)).then(read).then(write(false))
    .then(enter(1)).then(read).then(write(true)).expect(s.result == "ok" and s.rows.get(0) == "absent")
  run expiryDuringUpdateDoesNotRenewTest = init.then(enter(0)).then(read).then(write(true))
    .then(enter(0)).then(read).then(expire(0)).then(write(true)).expect(s.rows.get(0) == "expired")
}

module PairingApprovalRecovery {
  var s: { request: bool, grant: bool, phase: str, result: str, consumedWithoutGrant: bool }
  action init = s' = { request: true, grant: false, phase: "idle", result: "none", consumedWithoutGrant: false }
  action begin = all {
    s.phase == "idle" and s.request,
    s' = { ...s, phase: "grant", result: "pending" },
  }
  action grant(ok: bool): bool = all {
    s.phase == "grant",
    s' = { ...s, grant: s.grant or ok, phase: if (ok) "consume" else "idle",
      result: if (ok) "pending" else "failed" },
  }
  action consume(ok: bool): bool = all {
    s.phase == "consume",
    s' = { ...s, request: s.request and not(ok), phase: "idle", result: if (ok) "ok" else "failed",
      consumedWithoutGrant: s.consumedWithoutGrant or (ok and not(s.grant)) },
  }
  action step = any { begin, grant(true), grant(false), consume(true), consume(false), s' = s }
  val GrantPrecedesConsumption = not(s.consumedWithoutGrant)
  val SuccessfulApprovalHasGrant = (s.result == "ok").implies(s.grant and not(s.request))
  val FailedWriteRetainsCode = (not(s.grant)).implies(s.request)
  temporal SuccessfulRetryProgress = (begin.weakFair(s) and grant(true).strongFair(s)
    and consume(true).strongFair(s)).implies((s.request).leadsTo(not(s.request)))
  run grantFailureCanRetryTest = init.then(begin).then(grant(false)).then(begin)
    .then(grant(true)).then(consume(true)).expect(SuccessfulApprovalHasGrant)
  run failedConsumptionRetainsGrantTest = init.then(begin).then(grant(true)).then(consume(false))
    .then(begin).then(grant(true)).then(consume(true)).expect(SuccessfulApprovalHasGrant)
}

module PairingReplyWindow {
  pure val senders = Set(0, 1, 2)
  var s: { retained: List[int], live: Set[int], lastSender: int, accepted: bool, wasRetained: bool }
  action init = s' = { retained: [], live: Set(), lastSender: 0, accepted: false, wasRetained: false }
  action claim(sender: int): bool = {
    val held = s.retained.indices().exists(i => s.retained.nth(i) == sender) and s.live.contains(sender)
    val fresh = if (s.retained.length() >= 2)
      s.retained.select(owner => s.live.contains(owner)) else s.retained
    val bounded = if (fresh.length() >= 2) fresh.tail() else fresh
    val updated = if (bounded.indices().exists(i => bounded.nth(i) == sender)) bounded else bounded.append(sender)
    s' = if (held) { ...s, lastSender: sender, accepted: false, wasRetained: true }
      else { retained: updated, live: s.live.union(Set(sender)), lastSender: sender,
        accepted: true, wasRetained: false }
  }
  action expire(sender: int): bool = s' = { ...s, live: s.live.exclude(Set(sender)) }
  action step = { nondet sender = senders.oneOf(); any { claim(sender), expire(sender) } }
  val CacheBound = s.retained.length() <= 2
  val RetainedLiveClaimSuppressesReply = s.wasRetained.implies(not(s.accepted))
  val UniqueRetainedKeys = s.retained.foldl(Set(), (result, sender) => result.union(Set(sender))).size() == s.retained.length()
  run expiryRearmsReplyTest = init.then(claim(0)).then(claim(0)).expect(not(s.accepted))
    .then(expire(0)).then(claim(0)).expect(s.accepted)
  run evictionRearmsReplyTest = init.then(claim(0)).then(claim(1)).then(claim(2))
    .then(claim(0)).expect(s.accepted and CacheBound)
}
