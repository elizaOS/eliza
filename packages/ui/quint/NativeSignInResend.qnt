// Renderer dispatch and native admission are distinct. An absent or rejected
// resend reply does not identify which request owns Android's single slot.
module NativeSignInResend {
  pure val Original = 1
  pure val Resend = 2
  pure val Foreign = 3
  pure val Owned = Set(Original, Resend)
  pure val NoReceipt = { scope: 0, before: 0, after: 0 }
  pure val NoOutcome = { step: 0, verified: 0, echo: 0 }

  type Receipt = { scope: int, before: int, after: int }
  type Outcome = { step: int, verified: int, echo: int }
  type State = {
    ordered: bool, live: int, displayed: int, verifying: int, stage: str,
    delivery: str, known: Set[int], pending: Set[int], fenced: bool,
    receipt: Receipt, outcome: Outcome, lateAdmission: bool
  }
  var s: State

  pure def initial(ordered: bool): State = {
    ordered: ordered, live: Original, displayed: Original, verifying: 0,
    stage: "code", delivery: "none", known: Set(Original), pending: Set(),
    fenced: false, receipt: NoReceipt, outcome: NoOutcome, lateAdmission: false
  }

  action initOrdered = s' = initial(true)
  action initReordered = s' = initial(false)

  action resend = all {
    s.stage == "code", not(s.fenced), s.delivery == "none",
    s' = { ...s, stage: "sending", delivery: "sent", known: s.known.union(Set(Resend)) }
  }

  action deliverResend(admitted: bool): bool = all {
    s.delivery == "sent",
    s' = { ...s, delivery: if (admitted) "admitted" else "refused",
      live: if (admitted) Resend else s.live,
      lateAdmission: s.lateAdmission or (admitted and s.stage == "retired") }
  }

  action dropResend = all {
    s.delivery == "sent",
    s' = { ...s, delivery: "dropped" }
  }

  def dispatchDelivered: bool = not(s.ordered and s.delivery == "sent")

  // A renderer bridge rejection can be observed with either request live.
  action loseResendReply = all {
    s.stage == "sending",
    s' = { ...s, stage: "code" }
  }

  action acceptResendReply = all {
    s.stage == "sending", s.delivery == "admitted", not(s.fenced),
    s' = { ...s, stage: "code", displayed: Resend }
  }

  action verify = all {
    s.stage == "code", not(s.fenced), s.known.contains(s.displayed),
    s' = { ...s, stage: "verifying", verifying: s.displayed }
  }

  action verifyReply(echo: int): bool = all {
    s.stage == "verifying", not(s.fenced), dispatchDelivered,
    s' = if (s.live == s.verifying and (echo == 0 or echo == s.verifying))
      { ...s, stage: "authenticated", live: 0,
        outcome: { step: s.displayed, verified: s.verifying, echo: echo } }
      else { ...s, stage: "code", verifying: 0 }
  }

  // An event may retire the held verifier only with its admitted request ID.
  action retainedReply(echo: int): bool =
    s' = if (s.stage == "verifying" and not(s.fenced) and dispatchDelivered and
      s.live == s.verifying and echo == s.verifying)
      { ...s, stage: "authenticated", live: 0,
        outcome: { step: s.displayed, verified: s.verifying, echo: echo } }
      else s

  action beginCancellation = all {
    not(Set("retired", "authenticated").contains(s.stage)),
    s.known != Set(), s.pending == Set(),
    s' = { ...s, stage: "cancelling", pending: s.known, fenced: true, verifying: 0 }
  }

  action cancelReply(scope: int, acknowledged: bool): bool = {
    val pending = s.pending.exclude(Set(scope))
    val known = if (acknowledged) s.known.exclude(Set(scope)) else s.known
    val after = if (acknowledged and s.live == scope) 0 else s.live
    all {
      s.pending.contains(scope),
      // The Android bridge posts plugin calls to one handler. A scoped cancel
      // reply cannot precede the previously delivered start on that handler.
      not(acknowledged) or scope != Resend or dispatchDelivered,
      s' = { ...s, pending: pending, known: known, live: after,
        stage: if (known == Set()) "retired" else "cancelling",
        fenced: known != Set(),
        receipt: if (acknowledged) { scope: scope, before: s.live, after: after }
          else s.receipt }
    }
  }

  action cancelReplyEither(scope: int): bool = any {
    cancelReply(scope, true), cancelReply(scope, false)
  }

  action finishNative = all {
    Owned.contains(s.live),
    s' = { ...s, live: 0 }
  }

  action foreignStarts = all {
    s.live == 0,
    s' = { ...s, live: Foreign }
  }

  action idle = s' = s
  action step = any {
    resend, deliverResend(true), deliverResend(false), dropResend, loseResendReply,
    acceptResendReply, verify, beginCancellation, finishNative, foreignStarts,
    nondet echo = Set(0, Original, Resend, Foreign).oneOf()
    any { verifyReply(echo), retainedReply(echo) },
    nondet scope = Owned.oneOf()
    cancelReplyEither(scope),
    idle
  }

  val RetirementRequiresReceipts = all {
    s.known.subseteq(Owned), s.pending.subseteq(s.known),
    s.fenced implies (s.stage == "cancelling" and s.known != Set()),
    (s.stage == "retired").implies(s.known == Set() and s.pending == Set())
  }

  val ScopedReceiptPreservesOtherAttempt =
    if (s.receipt.scope == 0) s.receipt == NoReceipt
    else s.receipt.after == (if (s.receipt.before == s.receipt.scope) 0 else s.receipt.before)

  val VerificationUsesDisplayedOwner = all {
    (s.stage == "verifying").implies(s.verifying == s.displayed),
    (s.outcome != NoOutcome).implies(
      s.outcome.step == s.outcome.verified and
      (s.outcome.echo == 0 or s.outcome.echo == s.outcome.verified))
  }

  val NoLateAdmission = not(s.lateAdmission)
  val RetiredOwnsNoNativeAttempt =
    (s.stage == "retired").implies(not(Owned.contains(s.live)))

  temporal EachCancellationReplyReturns = Owned.forall(id => always(
    (s.pending.contains(id)).implies(eventually(not(s.pending.contains(id))))))

  temporal UnderFairReplies = Owned.forall(id => cancelReplyEither(id).weakFair(s))
    .implies(EachCancellationReplyReturns)

  temporal NoLateAdmissionEventually = eventually(always(NoLateAdmission))

  run failedResendKeepsOriginalCodeTest = initOrdered.then(resend)
    .then(deliverResend(false)).then(loseResendReply).then(verify)
    .then(retainedReply(Resend)).expect(s.stage == "verifying")
    .then(verifyReply(Original)).expect(s.stage == "authenticated")

  run partialCleanupRetriesOnlyMissingReceiptTest = initOrdered.then(resend)
    .then(deliverResend(true)).then(loseResendReply).then(beginCancellation)
    .then(cancelReply(Original, true)).then(cancelReply(Resend, false))
    .expect(s.fenced and s.known == Set(Resend) and s.live == Resend)
    .then(beginCancellation).expect(s.pending == Set(Resend))
    .then(cancelReply(Resend, true))
    .expect(s.stage == "retired" and RetiredOwnsNoNativeAttempt)

  run lateStartCanOutrunCancellationTest = initReordered.then(resend)
    .then(beginCancellation).then(cancelReply(Original, true))
    .then(cancelReply(Resend, true)).then(deliverResend(true))
    .expect(s.stage == "retired" and not(NoLateAdmission))
}
