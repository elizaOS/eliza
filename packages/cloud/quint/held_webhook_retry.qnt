// A held gateway callback re-arms one durable retry using its reply time. The
// next serial poll observes the persisted score even after a quiesced restart.
module HeldWebhookRetry {
  pure val Payload = "complete held event"
  pure val Backoff = 2
  pure val InitialClockLimit = 3

  var s: {
    phase: str, clock: int, dueAt: int, reholdAt: int,
    payload: str, poller: str
  }

  action init = s' = {
    phase: "held", clock: 0, dueAt: 0, reholdAt: -1,
    payload: Payload, poller: "original"
  }

  val clockLimit = if (s.reholdAt < 0) InitialClockLimit else s.reholdAt + Backoff

  action tick = all {
    s.phase != "delivered", s.clock < clockLimit,
    s' = s.with("clock", s.clock + 1)
  }

  action startAttempt = all {
    s.phase == "held", s.poller != "paused", s.clock >= s.dueAt,
    s' = s.with("phase", "running")
  }

  action rehold = all {
    s.phase == "running", s.reholdAt < 0,
    s' = s.with("phase", "held").with("reholdAt", s.clock)
      .with("dueAt", s.clock + Backoff)
  }

  action deliver = all {
    s.phase == "running",
    s' = s.with("phase", "delivered").with("dueAt", -1).with("payload", "")
  }

  action settleAttempt = any { rehold, deliver }

  action pausePoller = all {
    s.phase == "held", s.reholdAt >= 0, s.poller == "original",
    s' = s.with("poller", "paused")
  }

  action resumePoller = all {
    s.poller == "paused",
    s' = s.with("poller", "restarted")
  }

  action earlyPoll = all {
    s.phase == "held", s.poller != "paused", s.clock < s.dueAt, s' = s
  }

  action step = any {
    tick, startAttempt, settleAttempt, pausePoller, resumePoller, earlyPoll, s' = s
  }

  val RetriedDelayFollowsReply = (s.reholdAt >= 0 and s.phase != "delivered") implies
    s.dueAt == s.reholdAt + Backoff
  val PendingRetainsPayload = s.phase != "delivered" implies s.payload == Payload
  val DeliveredRetiresHold = s.phase == "delivered" implies (s.dueAt == -1 and s.payload == "")

  temporal NoEarlyAdmission = always(
    (s.phase == "held" and next(s.phase) == "running" implies s.clock >= s.dueAt).orKeep(s))
  temporal DeliveryEventually = eventually(s.phase == "delivered")
  temporal FairDelivery =
    (tick.weakFair(s) and startAttempt.weakFair(s)
      and settleAttempt.weakFair(s) and resumePoller.weakFair(s)) implies DeliveryEventually

  run SlowReplyReceivesFullBackoffTest = init.then(startAttempt)
    .then(tick).then(tick).then(tick).then(rehold).then(earlyPoll)
    .expect(s.phase == "held" and s.dueAt == 5 and RetriedDelayFollowsReply and PendingRetainsPayload)
    .then(tick).then(earlyPoll).then(tick).then(startAttempt).then(deliver)
    .expect(s.phase == "delivered" and DeliveredRetiresHold)

  run RestartKeepsDueScoreAndPayloadTest = init.then(startAttempt).then(rehold)
    .then(pausePoller).then(tick).then(resumePoller).then(earlyPoll)
    .expect(s.poller == "restarted" and s.dueAt == 2 and PendingRetainsPayload)
    .then(tick).then(startAttempt).then(deliver)
    .expect(s.phase == "delivered" and DeliveredRetiresHold)
}

// Two replicas can read the same member before either takes its lease. A fresh
// bounded read under the lease checks that exact member at the poll's cutoff.
module HeldWebhookReplica {
  type Poll = { phase: str, cutoff: int }
  pure val Replicas = Set(1, 2)
  pure val Idle = { phase: "idle", cutoff: 0 }
  pure val Backoff = 2

  var s: {
    clock: int, dueAt: int, reheld: bool, other: str,
    polls: int -> Poll
  }

  action init = s' = {
    clock: 0, dueAt: 0, reheld: false, other: "absent",
    polls: Map(1 -> Idle, 2 -> Idle)
  }

  val leases = Replicas.filter(replica =>
    Set("leased", "running").contains(s.polls.get(replica).phase))
  def targetInWindow(cutoff: int): bool =
    s.dueAt >= 0 and s.dueAt <= cutoff and s.other != "due"

  action scan(replica: int): bool = all {
    s.polls.get(replica).phase == "idle", targetInWindow(s.clock),
    s' = s.with("polls", s.polls.set(replica, { phase: "scanned", cutoff: s.clock }))
  }

  action claim(replica: int): bool = {
    val poll = s.polls.get(replica)
    all {
      poll.phase == "scanned",
      s' = s.with("polls", s.polls.set(replica,
        if (leases == Set()) poll.with("phase", "leased") else Idle))
    }
  }

  action recheck(replica: int): bool = {
    val poll = s.polls.get(replica)
    all {
      poll.phase == "leased",
      s' = s.with("polls", s.polls.set(replica,
        if (targetInWindow(poll.cutoff)) poll.with("phase", "running") else Idle))
    }
  }

  action reply(replica: int, held: bool): bool = all {
    s.polls.get(replica).phase == "running", not(held) or not(s.reheld),
    s' = s.with("polls", s.polls.set(replica, Idle))
      .with("dueAt", if (held) s.clock + Backoff else -1)
      .with("reheld", s.reheld or held)
  }
  action settle(replica: int): bool = any { reply(replica, true), reply(replica, false) }

  action insertOther = all {
    s.other == "absent",
    s' = s.with("other", "due")
  }

  action retireOther = all {
    s.other == "due",
    s' = s.with("other", "settled")
  }

  action tick = all {
    s.dueAt >= 0, s.clock < (if (s.reheld) s.dueAt else 1),
    s' = s.with("clock", s.clock + 1)
  }

  action step = {
    nondet replica = Replicas.oneOf()
    any {
      scan(replica), claim(replica), recheck(replica), settle(replica),
      insertOther, retireOther, tick, s' = s
    }
  }

  val SingleLease = leases.size() <= 1
  val CallbackNeedsDueMember = Replicas.forall(replica =>
    s.polls.get(replica).phase == "running" implies
      (s.dueAt >= 0 and s.dueAt <= s.polls.get(replica).cutoff))

  temporal FreshWindowAtAdmission = always(
    (Replicas.forall(replica =>
      (s.polls.get(replica).phase == "leased" and next(s.polls.get(replica).phase) == "running")
      implies targetInWindow(s.polls.get(replica).cutoff))).orKeep(s))
  temporal TargetEventuallySettles = eventually(s.dueAt == -1)
  temporal FairReplicaDelivery =
    (tick.weakFair(s) and retireOther.weakFair(s)
      and scan(1).weakFair(s) and scan(2).weakFair(s)
      and claim(1).weakFair(s) and claim(2).weakFair(s)
      and recheck(1).weakFair(s) and recheck(2).weakFair(s)
      and settle(1).weakFair(s) and settle(2).weakFair(s)) implies TargetEventuallySettles

  run StaleScanIgnoresUnrelatedDueMemberTest = init.then(scan(1))
    .then(scan(2)).then(claim(2)).then(recheck(2)).then(reply(2, true))
    .then(insertOther).then(claim(1)).then(recheck(1))
    .expect(s.dueAt == 2 and s.other == "due" and leases == Set())
    .then(retireOther).then(tick).then(tick).then(scan(1)).then(claim(1)).then(recheck(1))
    .then(reply(1, false)).expect(s.dueAt == -1 and SingleLease)

  run CapturedCutoffDoesNotAdvanceWithCallbackTimeTest = init.then(scan(1))
    .then(scan(2)).then(claim(2)).then(recheck(2)).then(reply(2, true))
    .then(tick).then(tick).then(claim(1)).then(recheck(1))
    .expect(s.clock == s.dueAt and leases == Set())
    .then(scan(1)).then(claim(1)).then(recheck(1)).then(reply(1, false))
    .expect(s.dueAt == -1 and SingleLease)

  run BoundedWindowDisplacementDefersEligibleMemberTest = init.then(scan(1))
    .then(insertOther).then(claim(1)).then(recheck(1))
    .expect(s.dueAt == 0 and leases == Set())
    .then(retireOther).then(scan(1)).then(claim(1)).then(recheck(1)).then(reply(1, false))
    .expect(s.dueAt == -1 and SingleLease)
}
