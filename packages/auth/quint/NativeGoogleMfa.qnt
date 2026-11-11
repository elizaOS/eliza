// The Google exchange has admitted an MFA challenge. Native input is checked
// against that attempt and its exact deadline before the private challenge
// leaves the host. A token still needs an empty receipt and a current epoch
// before dispatching the first Cloud grant.
module NativeGoogleMfa {
  val methods = Set("totp", "sms", "passkey")
  val supported = Set("totp", "sms")
  type Request = { session: int, method: str, challenge: int, at: int, deadline: int, epoch: int }
  type State = {
    phase: str, method: str, challenge: int, now: int, deadline: int,
    initialDeadline: int, replacementDeadline: int, request: Request,
    dispatches: int, epoch: int, cancelling: bool, pendingSeen: bool,
    grants: int, result: str,
  }
  var s: State
  val empty = { session: 0, method: "passkey", challenge: 0, at: 0, deadline: 0, epoch: 0 }
  pure def earlier(a: int, b: int): int = if (a <= b) a else b

  action start(method: str, googleDeadline: int, factorDeadline: int): bool = {
    val deadline = earlier(googleDeadline, factorDeadline)
    s' = {
      phase: "ready", method: method, challenge: 1, now: 0, deadline: deadline,
      initialDeadline: deadline, replacementDeadline: 0, request: empty,
      dispatches: 0, epoch: 0, cancelling: false, pendingSeen: false,
      grants: 0, result: "challenge",
    }
  }
  action init = {
    nondet method = methods.oneOf()
    nondet googleDeadline = Set(1, 2).oneOf()
    nondet factorDeadline = Set(1, 2, 3).oneOf()
    start(method, googleDeadline, factorDeadline)
  }
  val pending = s.phase.in(Set("provider", "receipt-read"))
  action submit(session: int, digits: bool, operation: str): bool = {
    val refusal = if (pending or s.cancelling) "busy"
      else if (s.challenge == 0 or session != 1 or s.now >= s.deadline) "expired"
      else if (not(digits)) "bad-code"
      else if (operation != "mfa" or not(supported.contains(s.method))) "unsupported"
      else "none"
    all {
      s.phase != "handoff", refusal != "none" or s.dispatches < 3,
      s' = if (refusal != "none") { ...s, result: refusal } else {
        ...s, phase: "provider", dispatches: s.dispatches + 1, result: "submitted",
        request: {
          session: session, method: s.method, challenge: s.challenge,
          at: s.now, deadline: s.deadline, epoch: s.epoch,
        },
      },
    }
  }
  action tick = all { s.now < 3, s' = { ...s, now: s.now + 1 } }
  action cancel = all {
    s.epoch == 0, s.phase != "handoff",
    s' = {
      ...s, epoch: 1, challenge: 0, cancelling: true,
      phase: if (pending) s.phase else "cleared", result: "cancelling",
    },
  }
  action settleCancel = all {
    s.cancelling, not(pending),
    s' = { ...s, cancelling: false, result: "cancelled" },
  }

  action providerReply(kind: str, replacement: str, replacementDeadline: int): bool = all {
    s.phase == "provider",
    kind != "replacement" or s.replacementDeadline == 0,
    s' = if (s.request.epoch != s.epoch) {
      ...s, phase: "cleared", result: "cancelled-reply",
    } else if (kind == "failure") {
      ...s, phase: "ready", result: "provider-error",
    } else if (kind == "replacement") {
      ...s, phase: "ready", challenge: 2, method: replacement,
      deadline: earlier(s.deadline, replacementDeadline),
      replacementDeadline: replacementDeadline, result: "replacement",
    } else {
      ...s, phase: "receipt-read", result: "session",
    },
  }
  action receiptReply(hasPending: bool): bool = {
    val current = s.request.epoch == s.epoch
    val allowed = not(hasPending) and current
    all {
      s.phase == "receipt-read",
      s' = {
        ...s, pendingSeen: hasPending, grants: if (allowed) 1 else 0,
        phase: if (allowed) "handoff" else if (current) "ready" else "cleared",
        result: if (hasPending) "saved" else if (allowed) "handoff" else "cancelled-reply",
      },
    }
  }
  action providerWork = any {
    providerReply("failure", "totp", 0), providerReply("token", "totp", 0),
    {
      nondet method = methods.oneOf()
      nondet deadline = Set(1, 2, 3).oneOf()
      providerReply("replacement", method, deadline)
    },
  }
  action receiptWork = any { receiptReply(true), receiptReply(false) }
  action step = any {
    {
      nondet session = Set(1, 2).oneOf()
      nondet digits = Set(true, false).oneOf()
      nondet operation = Set("mfa", "verify").oneOf()
      submit(session, digits, operation)
    },
    tick, cancel, settleCancel, providerWork, receiptWork,
    s' = s,
  }

  val TypeOK = and {
    s.phase.in(Set("ready", "provider", "receipt-read", "handoff", "cleared")),
    methods.contains(s.method), s.challenge.in(0.to(2)), s.now.in(0.to(3)),
    s.dispatches.in(0.to(3)), s.epoch.in(0.to(1)), s.grants.in(0.to(1)),
  }
  val CompletionUsesMatchingLiveFactor = (s.dispatches > 0).implies(and {
    s.request.session == 1, supported.contains(s.request.method),
    s.request.at < s.request.deadline, s.request.challenge.in(Set(1, 2)),
    (pending and s.request.epoch == s.epoch).implies(
      s.request.challenge == s.challenge and s.request.method == s.method),
  })
  val ReplacementCanOnlyShortenDeadline =
    s.deadline <= s.initialDeadline and
    (s.replacementDeadline > 0).implies(s.deadline == earlier(s.initialDeadline, s.replacementDeadline))
  val ProviderFailureKeepsChallenge = (s.result == "provider-error").implies(
    s.challenge == s.request.challenge and s.method == s.request.method and s.phase == "ready")
  val GrantNeedsCurrentEpochAndEmptyReceipt = (s.grants > 0).implies(
    s.phase == "handoff" and s.result == "handoff" and
      s.request.epoch == s.epoch and not(s.pendingSeen))
  val CancelCannotRestoreChallengeOrDispatchGrant =
    (s.epoch > 0).implies(s.challenge == 0 and s.grants == 0)
  temporal AdmittedMfaSettles = (providerWork.weakFair(s) and receiptWork.weakFair(s)) implies
    always(pending.implies(eventually(not(pending))))

  run wrongSessionAndMalformedCodeDoNotDispatchTest = start("totp", 2, 2)
    .then(submit(2, true, "mfa")).expect(s.result == "expired" and s.dispatches == 0)
    .then(submit(1, false, "mfa")).expect(s.result == "bad-code" and s.dispatches == 0)
  run replacementAfterRetryUsesCurrentFactorTest = start("totp", 2, 2)
    .then(submit(1, true, "mfa")).then(providerReply("failure", "totp", 0))
    .then(submit(1, true, "mfa")).then(providerReply("replacement", "sms", 1))
    .then(submit(1, true, "mfa"))
    .expect(s.request.challenge == 2 and s.request.method == "sms" and s.deadline == 1)
  run exactExpiryRejectsMfaTest = start("totp", 2, 1).then(tick)
    .then(submit(1, true, "mfa")).expect(s.result == "expired" and s.dispatches == 0)
  run cancelDuringReceiptReadPreventsGrantTest = start("sms", 2, 2)
    .then(submit(1, true, "mfa")).then(providerReply("token", "totp", 0))
    .then(cancel).then(receiptReply(false))
    .expect(s.result == "cancelled-reply" and s.grants == 0)
  run savedReceiptBlocksGrantTest = start("totp", 2, 2)
    .then(submit(1, true, "mfa")).then(providerReply("token", "totp", 0))
    .then(receiptReply(true)).expect(s.result == "saved" and s.grants == 0)
}
