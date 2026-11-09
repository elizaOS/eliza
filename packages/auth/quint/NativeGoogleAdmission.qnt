// Google admission in createNativeCloudAuth. The host owns the state and
// verifier, consumes a matching return before code validation, and fences
// a pending exchange by epoch when cancel clears the attempt.
module NativeGoogleAdmission {
  val attempts = Set(1, 2)
  val forms = Set("bad-url", "bad-code", "failure", "success")
  type State = {
    attempt: int, phase: str, expired: bool, verifier: int,
    flight: int, flightVerifier: int, epoch: int, ticket: int,
    dispatched: int -> int, cancelling: bool, cancelled: bool, result: str,
  }
  var s: State
  action init = s' = {
    attempt: 0, phase: "empty", expired: false, verifier: 0,
    flight: 0, flightVerifier: 0, epoch: 0, ticket: 0,
    dispatched: attempts.mapBy(_ => 0), cancelling: false, cancelled: false,
    result: "none",
  }
  action issue = all {
    s.attempt < 2, s.flight == 0, not(s.cancelling),
    s' = {
      ...s, attempt: s.attempt + 1, phase: "live", expired: false,
      verifier: s.attempt + 1, result: "issued",
    },
  }
  action expire = all {
    s.phase == "live", not(s.expired),
    s' = { ...s, expired: true, result: "elapsed" },
  }
  action callback(returnedState: int, form: str): bool = {
    val refusal = if (s.flight != 0 or s.cancelling) "busy"
      else if (s.phase != "live" or s.expired) "unavailable"
      else if (form == "bad-url") "bad-url"
      else if (returnedState != s.attempt) "mismatch" else "none"
    s' = if (refusal != "none") {
      ...s, result: refusal,
    } else if (form == "failure" or form == "bad-code") {
      ...s, phase: if (form == "failure") "empty" else "spent",
      verifier: 0, result: form,
    } else {
      ...s, phase: "exchange", verifier: 0,
      flight: s.attempt, flightVerifier: s.verifier, ticket: s.epoch,
      dispatched: s.dispatched.set(s.attempt, s.dispatched.get(s.attempt) + 1),
      result: "dispatched",
    }
  }
  action cancel = all {
    not(s.cancelled), not(s.cancelling),
    s' = {
      ...s, epoch: s.epoch + 1, phase: "empty", verifier: 0,
      cancelling: true, result: "cancelling",
    },
  }
  action exchangeReply(mfa: bool): bool = {
    val current = s.ticket == s.epoch
    all {
      s.flight != 0,
      s' = {
        ...s, flight: 0, flightVerifier: 0,
        phase: if (not(current)) "empty" else if (mfa) "mfa" else "spent",
        result: if (not(current)) "cancelled-reply" else if (mfa) "mfa" else "exchange-error",
      },
    }
  }
  action finishCancel = all {
    s.cancelling, s.flight == 0,
    s' = { ...s, cancelling: false, cancelled: true, result: "cancelled" },
  }
  action exchangeWork = any { exchangeReply(true), exchangeReply(false) }
  action step = any {
    issue, expire, cancel, exchangeWork, finishCancel,
    {
      nondet state = 0.to(2).oneOf()
      nondet form = forms.oneOf()
      callback(state, form)
    },
    s' = s,
  }

  val TypeOK = and {
    s.attempt.in(0.to(2)), s.flight.in(0.to(2)), s.epoch.in(0.to(1)),
    s.dispatched.keys() == attempts,
    s.phase.in(Set("empty", "live", "exchange", "spent", "mfa")),
  }
  val OneExchangePerAttempt = attempts.forall(id => s.dispatched.get(id).in(0.to(1)))
  val InvalidShapeOrStateKeepsChallenge =
    s.result.in(Set("bad-url", "mismatch")).implies(
      s.phase == "live" and s.verifier == s.attempt and s.dispatched.get(s.attempt) == 0)
  val MatchedFailuresConsumeWithoutDispatch =
    s.result.in(Set("bad-code", "failure")).implies(
      s.phase != "live" and s.verifier == 0 and s.dispatched.get(s.attempt) == 0)
  val ExchangeUsesOwnVerifier = (s.flight != 0).implies(
    s.flightVerifier == s.flight and s.verifier == 0 and s.dispatched.get(s.flight) == 1)
  val CancelledExchangeCannotRestoreChallenge = and {
    (s.phase == "mfa").implies(s.ticket == s.epoch and not(s.cancelling)),
    (s.result == "cancelled-reply").implies(s.phase == "empty" and s.verifier == 0),
  }
  temporal ExchangeAndCancellationSettle =
    (exchangeWork.weakFair(s) and finishCancel.weakFair(s)) implies and {
      always((s.flight != 0).implies(eventually(s.flight == 0))),
      always(s.cancelling.implies(eventually(not(s.cancelling)))),
    }

  run mismatchPreservesMatchingReturnTest = init.then(issue).then(callback(2, "success"))
    .expect(InvalidShapeOrStateKeepsChallenge and s.result == "mismatch")
    .then(callback(1, "success")).then(exchangeReply(false)).then(callback(1, "success"))
    .expect(s.result == "unavailable" and s.dispatched.get(1) == 1)
  run badCodeConsumesMatchingChallengeTest = init.then(issue).then(callback(1, "bad-code"))
    .expect(MatchedFailuresConsumeWithoutDispatch and s.result == "bad-code")
    .then(callback(1, "success")).expect(s.result == "unavailable")
  run cancelledExchangeCannotAdvanceTest = init.then(issue).then(callback(1, "success"))
    .then(cancel).then(exchangeReply(true)).then(finishCancel).then(callback(1, "success"))
    .expect(s.result == "unavailable" and s.dispatched.get(1) == 1)
  run replacementRejectsOldCallbackTest = init.then(issue).then(issue).then(callback(1, "success"))
    .expect(s.result == "mismatch" and s.attempt == 2 and s.verifier == 2)
  run expiredAttemptRejectsMatchingCallbackTest = init.then(issue).then(expire)
    .then(callback(1, "success")).expect(s.result == "unavailable" and s.dispatched.get(1) == 0)
}
