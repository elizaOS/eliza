// Source: lib/services/payment-request-settlement.ts. This models current
// behavior with exact-claim completion and dispatch-time lease checks.
// Bounds: one payment, one failure and one successful provider event, two workers,
// eight clock ticks, four wire attempts. Attempt threshold 2 abstracts production
// threshold 12; two ticks abstract the 60-second callback claim. Provider proofs,
// SSRF/HMAC validation and transaction isolation require implementation tests.
// Wire attempts are at-least-once: recipient side effects are not modeled as
// exactly-once. Historical failure delivery after settlement is observable, not
// classified as invalid. The guarded credit increment abstracts the atomic
// payment/credit transaction; SQL isolation still requires implementation tests.
// Negative actions retain missing-credit-guard and pre-fix lease witnesses.
module payment_delivery {
  type Job = { event: int, phase: str, deadline: int }
  type State = {
    payment: str, credits: int, states: int -> str, attempts: int -> int,
    until: int -> int, due: int -> int, owners: int -> int, jobs: int -> Job, time: int,
    sends: int -> int, historicalFailureSent: bool, expiredSend: bool,
    staleCompletion: bool
  }
  var s: State
  pure val events = Set(0, 1) // 0 = failure; 1 = successful payment
  pure val workers = Set(0, 1)

  action init = s' = {
    payment: "pending", credits: 0, states: events.mapBy(_ => "absent"),
    attempts: events.mapBy(_ => 0), until: events.mapBy(_ => -1), due: events.mapBy(_ => 0),
    owners: events.mapBy(_ => -1), jobs: workers.mapBy(_ => { event: 0, phase: "idle", deadline: -1 }),
    time: 0, sends: events.mapBy(_ => 0), historicalFailureSent: false,
    expiredSend: false, staleCompletion: false
  }
  def eligible(event: int): bool = Set("pending", "failed").contains(s.states.get(event))

  action providerFailure = s' = s
    .with("payment", if (s.payment == "pending") "failed" else s.payment)
    .with("states", s.states.set(0,
      if (s.payment == "settled" and s.states.get(0) != "dispatched") "superseded"
      else if (s.states.get(0) == "absent") "pending" else s.states.get(0)))

  action settleProviderSuccess(guarded: bool): bool = s' = s.with("payment", "settled")
    .with("credits", s.credits + (if (not(guarded) or s.payment != "settled") 1 else 0))
    .with("states", s.states.set(1,
      if (s.states.get(1) == "absent") "pending" else s.states.get(1))
      .set(0, if (eligible(0)) "superseded" else s.states.get(0)))
    .with("until", if (eligible(0)) s.until.set(0, -1) else s.until)
    .with("due", if (eligible(0)) s.due.set(0, -1) else s.due)
    .with("owners", if (eligible(0)) s.owners.set(0, -1) else s.owners)

  action providerSuccess = settleProviderSuccess(true)

  action claim(worker: int, event: int): bool = all {
    s.jobs.get(worker).phase == "idle", eligible(event),
    s.attempts.get(event) < 2, s.until.get(event) < s.time, s.due.get(event) <= s.time,
    s' = s.with("until", s.until.set(event, s.time + 2))
      .with("owners", s.owners.set(event, worker))
      .with("jobs", s.jobs.set(worker, { event: event, phase: "queued", deadline: s.time + 2 }))
  }
  action tick = all { s.time < 8, s' = s.with("time", s.time + 1) }

  def owns(worker: int): bool = {
    val event = s.jobs.get(worker).event
    s.owners.get(event) == worker and s.until.get(event) == s.jobs.get(worker).deadline
  }

  // Production claims each job when ready and checks the remaining primary-
  // clock budget before safeFetch. A started request may still finish late.
  action startSend(worker: int, fenced: bool): bool = {
    val event = s.jobs.get(worker).event
    all {
      s.jobs.get(worker).phase == "queued", s.sends.get(event) < 4,
      not(fenced) or (owns(worker) and eligible(event) and s.jobs.get(worker).deadline > s.time),
      s' = s.with("jobs", s.jobs.set(worker, { event: event, phase: "sent", deadline: s.jobs.get(worker).deadline }))
        .with("sends", s.sends.set(event, s.sends.get(event) + 1))
        .with("expiredSend", s.expiredSend or s.jobs.get(worker).deadline <= s.time)
    }
  }

  action send(worker: int): bool = startSend(worker, true)
  action rejectExpiredOrSupersededSend(worker: int): bool = all {
    s.jobs.get(worker).phase == "queued",
    not(owns(worker)) or s.jobs.get(worker).deadline <= s.time,
    s' = s.with("jobs", s.jobs.set(worker, s.jobs.get(worker).with("phase", "idle")))
  }

  // Completion may acknowledge a late in-flight result, but only the exact
  // persisted claim can mutate retry state. It never clears a newer claim.
  action finishAttempt(worker: int, ok: bool, fenced: bool): bool = {
    val event = s.jobs.get(worker).event
    val writable = eligible(event) and (not(fenced) or owns(worker))
    all {
      s.jobs.get(worker).phase == "sent",
      s' = s.with("jobs", s.jobs.set(worker, { event: event, phase: "idle", deadline: s.jobs.get(worker).deadline }))
        .with("states", if (writable)
          s.states.set(event, if (ok) "dispatched" else "failed") else s.states)
        .with("attempts", if (writable)
          s.attempts.set(event, s.attempts.get(event) + 1) else s.attempts)
        .with("until", if (writable) s.until.set(event, -1) else s.until)
        .with("due", if (writable) s.due.set(event, if (ok) -1 else s.time + 2) else s.due)
        .with("owners", if (writable) s.owners.set(event, -1) else s.owners)
        .with("historicalFailureSent", s.historicalFailureSent or
          (event == 0 and ok and s.payment == "settled"))
        .with("staleCompletion", s.staleCompletion or
          (writable and not(owns(worker))))
    }
  }
  action complete(worker: int, ok: bool): bool = finishAttempt(worker, ok, true)
  action idle = s' = s
  action step = {
    nondet worker = workers.oneOf()
    nondet event = events.oneOf()
    nondet ok = Set(true, false).oneOf()
    any { providerFailure, providerSuccess, claim(worker, event), tick, send(worker), rejectExpiredOrSupersededSend(worker), complete(worker, ok), idle }
  }

  val safety = all {
    s.credits >= 0, s.credits <= 1, not(s.expiredSend), not(s.staleCompletion),
    (s.payment == "settled") == (s.credits == 1),
    s.states.get(1) == "absent" or s.payment == "settled",
    s.states.get(0) != "superseded" or s.payment == "settled",
    events.forall(event => Set("absent", "pending", "failed", "superseded", "dispatched")
      .contains(s.states.get(event)))
  }
  val historicalFailureAfterSettlement = s.historicalFailureSent
  val noExpiredSend = not(s.expiredSend)
  val noStaleCompletion = not(s.staleCompletion)

  run duplicatePaymentDoesNotCreditTwiceTest = init.then(providerSuccess)
    .then(providerSuccess).expect(safety and s.credits == 1)
  run missingPaymentGuardNegativeWitnessTest = init.then(providerSuccess)
    .then(settleProviderSuccess(false)).expect(not(safety) and s.credits == 2)
  run retryDeliveryTest = init.then(providerSuccess).then(claim(0, 1))
    .then(send(0)).then(complete(0, false)).then(tick).then(tick).then(claim(1, 1))
    .then(send(1)).then(complete(1, true))
    .expect(safety and s.states.get(1) == "dispatched" and s.sends.get(1) == 2)
  run inFlightFailureMayArriveAfterSettlementTest = init.then(providerFailure).then(claim(0, 0))
    .then(send(0)).then(providerSuccess).then(complete(0, true))
    .expect(safety and historicalFailureAfterSettlement and s.states.get(0) == "superseded")
  run queuedExpiredJobDoesNotSendTest = init.then(providerFailure).then(claim(0, 0))
    .then(tick).then(tick).then(tick).then(rejectExpiredOrSupersededSend(0))
    .expect(safety and s.sends.get(0) == 0)
  run lateCompletionPreservesNewClaimTest = init.then(providerFailure).then(claim(0, 0))
    .then(send(0)).then(tick).then(tick).then(tick).then(claim(1, 0)).then(complete(0, false))
    .expect(safety and s.owners.get(0) == 1 and s.jobs.get(1).phase == "queued")
  // Replaying the former transitions demonstrates why both guards matter.
  run expiredStartNegativeWitnessTest = init.then(providerFailure).then(claim(0, 0))
    .then(tick).then(tick).then(tick).then(startSend(0, false)).expect(not(safety))
  run staleCompletionNegativeWitnessTest = init.then(providerFailure).then(claim(0, 0))
    .then(send(0)).then(tick).then(tick).then(tick).then(claim(1, 0))
    .then(finishAttempt(0, false, false)).expect(not(safety))
}
