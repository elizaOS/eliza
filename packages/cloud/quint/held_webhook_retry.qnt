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
