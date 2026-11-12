// Four distinct lease tokens, two workers and logical clock 0..6.
// One durable Stripe row and two racing drains. A lease may expire while its
// handler continues; token-guarded settlement must not overwrite a successor.
module StripeDeliveryOutbox {
  pure val workers = Set(1, 2)
  pure val maxAttempts = 3
  var s: {
    status: str,
    payload: bool,
    token: int,
    nextToken: int,
    expiry: int,
    due: int,
    now: int,
    attempts: int,
    claim: int -> int,
    claimAttempts: int -> int,
    pc: int -> str,
    accepted: bool,
    event: str,
    beforeToken: int,
    attemptedToken: int,
    previousStatus: str,
    previousAttempts: int
  }
  action init = s' = {
    status: "pending",
    payload: true,
    token: 0,
    nextToken: 1,
    expiry: 0,
    due: 0,
    now: 0,
    attempts: 0,
    claim: workers.mapBy(_ => 0),
    claimAttempts: workers.mapBy(_ => 0),
    pc: workers.mapBy(_ => "idle"),
    accepted: false,
    event: "init",
    beforeToken: 0,
    attemptedToken: 0,
    previousStatus: "pending",
    previousAttempts: 0
  }
  // claimDueStripeDeliveries atomically installs a token and spends an attempt.
  action claim(w: int): bool = all {
    s.pc.get(w) == "idle",
    s.nextToken <= 4,
    s.status == "pending",
    s.due <= s.now,
    s.token == 0 or s.expiry <= s.now,
    s' = s
      .with("token", s.nextToken)
      .with("nextToken", s.nextToken + 1)
      .with("expiry", s.now + 2)
      .with("attempts", s.attempts + 1)
      .with("claim", s.claim.set(w, s.nextToken))
      .with("claimAttempts", s.claimAttempts.set(w, s.attempts + 1))
      .with("pc", s.pc.set(w, "claimed"))
      .with("event", "claim")
  }
  action handle(w: int): bool = all {
    s.pc.get(w) == "claimed",
    s.claimAttempts.get(w) <= maxAttempts,
    s' = s
      .with("pc", s.pc.set(w, "handled"))
      .with("event", "handle")
  }
  // settleStripeDelivery checks the row's current token, even after lease expiry.
  // releaseStripeDeliveries only returns rows that this drain never handled.
  action settle(w: int, result: str): bool = {
    val releaseUnstarted = result == "release" and s.pc.get(w) == "claimed"
    val exhausted = result == "dlq" and s.claimAttempts.get(w) > maxAttempts
    val handlerFinished = result != "release" and (s.pc.get(w) == "handled" or exhausted)
    val accepted = s.token == s.claim.get(w) and s.status == "pending"
    val dead = result == "dlq" or (result == "retry" and s.claimAttempts.get(w) >= maxAttempts)
    val status = if (result == "ack") "complete" else if (dead) "dead" else "pending"
    all {
      Set("claimed", "handled").contains(s.pc.get(w)),
      releaseUnstarted or handlerFinished,
      s' = s
          .with("accepted", accepted)
          .with("event", result)
          .with("beforeToken", s.token)
          .with("attemptedToken", s.claim.get(w))
          .with("previousStatus", s.status)
          .with("previousAttempts", s.attempts)
          .with("status", if (accepted) status else s.status)
          .with("token", if (accepted) 0 else s.token)
          .with("payload", s.payload and not(accepted and result == "ack"))
          .with("attempts", if (accepted and result == "release") s.attempts - 1 else s.attempts)
          .with("due", if (accepted and result == "retry") s.now + 2 else s.due)
          .with("pc", s.pc.set(w, "idle"))
    }
  }
  // reviveDeadStripeDelivery admits a verified resend with a fresh attempt budget.
  action resend = all {
    s.status == "dead",
    s' = s
      .with("status", "pending")
      .with("payload", true)
      .with("attempts", 0)
      .with("token", 0)
      .with("due", s.now)
      .with("event", "resend")
  }
  action tick = all {
    s.now < 6,
    s' = s
      .with("now", s.now + 1)
      .with("event", "tick")
  }
  action step = {
    nondet w = workers.oneOf();
    nondet result = Set("ack", "retry", "dlq", "release").oneOf();
    any {
      claim(w),
      handle(w),
      settle(w, result),
      resend,
      tick
    }
  }
  val invariant = and {
    s.attempts >= 0,
    (s.status == "complete") implies not(s.payload),
    Set("ack", "retry", "dlq", "release").contains(s.event) implies (s.accepted == (s.beforeToken == s.attemptedToken and s.previousStatus == "pending")),
    (Set("ack", "retry", "dlq", "release").contains(s.event) and not(s.accepted)) implies (s.status == s.previousStatus and s.attempts == s.previousAttempts),
    (s.event == "release" and s.accepted) implies s.attempts == s.previousAttempts - 1
  }
}
