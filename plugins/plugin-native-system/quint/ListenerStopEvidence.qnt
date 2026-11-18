// One stop operation: a confirmed absent companion or a saved OFF receipt is safe.
module ListenerStopEvidence {
  pure val Replies = Set("absent", "saved-off", "unknown", "active", "contradictory")
  var s: { phase: str, reply: str, outcome: str, confirmed: bool, requests: int, captures: int }
  action init = s' = { phase: "idle", reply: "unknown", outcome: "none",
    confirmed: false, requests: 0, captures: 0 }
  action request(reply: str): bool = all {
    s.phase == "idle", reply.in(Replies),
    s' = { ...s, phase: "pending", reply: reply, requests: s.requests + 1 }
  }
  action complete(outcome: str): bool = all {
    s.phase == "pending", outcome.in(Set("reply", "timeout", "failure")),
    s' = { ...s, phase: "done", outcome: outcome,
      confirmed: outcome == "reply" and s.reply.in(Set("absent", "saved-off")) }
  }
  action settle = any { complete("reply"), complete("timeout"), complete("failure") }
  action lateReply = all { s.phase == "done", s' = s }
  action step = any {
    { nondet reply = Replies.oneOf(); request(reply) }, settle, lateReply
  }
  val TypeOK = s.phase.in(Set("idle", "pending", "done")) and s.reply.in(Replies)
    and s.outcome.in(Set("none", "reply", "timeout", "failure"))
    and s.requests.in(Set(0, 1)) and s.captures == 0
  val OneNativeRequest = s.requests <= 1
  val OnlySafeEvidenceConfirms = s.confirmed implies
    (s.phase == "done" and s.outcome == "reply" and s.reply.in(Set("absent", "saved-off")))
  val NoCaptureStarted = s.captures == 0
  temporal StopFinishesWithoutFairness = (s.phase == "pending").leadsTo(s.phase == "done")
  temporal StopFinishes = settle.weakFair(s).implies(StopFinishesWithoutFairness)
  run absentIsSafeTest = init.then(request("absent")).then(complete("reply"))
    .expect(s.confirmed and NoCaptureStarted)
  run unknownIsNotConfirmedTest = init.then(request("unknown")).then(complete("reply"))
    .expect(not(s.confirmed))
  run contradictoryAbsenceIsNotConfirmedTest = init.then(request("contradictory"))
    .then(complete("reply")).expect(not(s.confirmed))
  run timeoutRetiresLateReplyTest = init.then(request("saved-off")).then(complete("timeout"))
    .then(lateReply).expect(not(s.confirmed))
}
