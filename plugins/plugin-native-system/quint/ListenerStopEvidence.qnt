// Sources are linked by ListenerStopEvidence.cases.json.
// One native request settles through a reply, cancellation, or the five-second deadline.
module ListenerStopEvidence {
  var phase: str
  var response: str
  var confirmed: bool
  var requests: int
  var captures: int
  val replies = Set("absent", "off", "unavailable", "active", "contradictory")
  action init = all { phase' = "idle", response' = "unavailable", confirmed' = false, requests' = 0, captures' = 0 }
  action request(kind: str): bool = all {
    phase == "idle", replies.contains(kind), phase' = "pending", response' = kind,
    confirmed' = false, requests' = requests + 1, captures' = captures
  }
  action reply = all {
    phase == "pending", phase' = "done", response' = response,
    confirmed' = response.in(Set("absent", "off")), requests' = requests, captures' = captures
  }
  action retire(reason: str): bool = all {
    phase == "pending", phase' = "done", response' = reason, confirmed' = false,
    requests' = requests, captures' = captures
  }
  action lateReply = all {
    phase == "done", phase' = phase, response' = response, confirmed' = confirmed,
    requests' = requests, captures' = captures
  }
  action step = any {
    request("absent"), request("off"), request("unavailable"), request("active"), request("contradictory"),
    reply, retire("timeout"), lateReply
  }
  val invariant = phase.in(Set("idle", "pending", "done")) and requests >= 0 and captures >= 0
  val OneNativeRequest = requests <= 1
  val OnlySafeEvidenceConfirms = not(confirmed) or (phase == "done" and response.in(Set("absent", "off")))
  val NoCaptureStarted = captures == 0
  run absentIsSafeTest = init.then(request("absent")).then(reply).expect(confirmed and NoCaptureStarted)
  run activeIsNotConfirmedTest = init.then(request("active")).then(reply).expect(not(confirmed))
  run contradictoryAbsenceIsNotConfirmedTest = init.then(request("contradictory")).then(reply).expect(not(confirmed))
  run timeoutRetiresLateReplyTest = init.then(request("off")).then(retire("timeout")).then(lateReply).expect(not(confirmed))
}
