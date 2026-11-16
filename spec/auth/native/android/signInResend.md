# Android sign-in resend

A code resend starts a second native request while Android keeps one
native sign-in slot. Verification and cancellation then follow the request
Android admitted, fenced by the scoped receipt of
[sign-in cancel](./signInCancel.md).

## Story: Verify and cancel the request Android admitted after a resend

> As a person who asked for a new code, I want the code I type checked
> against the request on my screen, and a cancel to retire exactly my
> requests, whichever of them Android kept.

### After a resend, verification and cancellation follow the request Android admitted

A resend starts a second native request; an absent or refused reply does
not say which request owns Android's single slot. The code screen verifies
the request it displays, and a result counts only for the request that is
live, with an echo naming it or none. Cancellation fences both requests
and retires each only on its own acknowledged cancel; a missing
acknowledgement is retried for that request alone. The bridge delivers a
request's start before its cancel, so a resend is never admitted after
cancellation retired the sign-in.

```quint
import signInCancel as C from "./signInCancel"
type ResendStage = CodeStage | SendingStage | VerifyingStage | AuthenticatedStage | CancellingStage | RetiredStage
type Delivery = NotSent | SentResend | AdmittedResend | RefusedResend | DroppedResend
type VerifiedOutcome = { verifiedStep: int, verified: int, echo: int }
type SignInResend = { live: int, displayed: int, verifying: int, stage: ResendStage, delivery: Delivery, known: Set[int], pending: Set[int],
  fenced: bool, receipt: C::ScopedReceipt, verdict: VerifiedOutcome, lateAdmission: bool }
pure val originalRequest = 1
pure val resendRequest = 2
pure val foreignRequest = 3
pure val noOutcome: VerifiedOutcome = { verifiedStep: 0, verified: 0, echo: 0 }
pure val initial: SignInResend = { live: originalRequest, displayed: originalRequest, verifying: 0, stage: CodeStage, delivery: NotSent, known: Set(originalRequest),
  pending: Set(), fenced: false, receipt: C::noReceipt, verdict: noOutcome, lateAdmission: false }
pure def resendDelivered(r: SignInResend): bool = r.delivery != SentResend
pure def canSendResend(r: SignInResend): bool = r.stage == CodeStage and not(r.fenced) and r.delivery == NotSent
pure def sendResend(r: SignInResend): SignInResend = { ...r, stage: SendingStage, delivery: SentResend, known: r.known.union(Set(resendRequest)) }
pure def canDeliverResend(r: SignInResend, admitted: bool): bool = r.delivery == SentResend
pure def deliverResend(r: SignInResend, admitted: bool): SignInResend =
  { ...r, delivery: if (admitted) AdmittedResend else RefusedResend, live: if (admitted) resendRequest else r.live, lateAdmission: r.lateAdmission or (admitted and r.stage == RetiredStage) }
pure def canDropResend(r: SignInResend): bool = r.delivery == SentResend
pure def dropResend(r: SignInResend): SignInResend = { ...r, delivery: DroppedResend }
pure def canLoseResendReply(r: SignInResend): bool = r.stage == SendingStage
pure def loseResendReply(r: SignInResend): SignInResend = { ...r, stage: CodeStage }
pure def canAcceptResendReply(r: SignInResend): bool = r.stage == SendingStage and r.delivery == AdmittedResend and not(r.fenced)
pure def acceptResendReply(r: SignInResend): SignInResend = { ...r, stage: CodeStage, displayed: resendRequest }
pure def canVerifyDisplayed(r: SignInResend): bool = r.stage == CodeStage and not(r.fenced) and r.known.contains(r.displayed)
pure def verifyDisplayed(r: SignInResend): SignInResend = { ...r, stage: VerifyingStage, verifying: r.displayed }
pure def authenticatedBy(echo: int, r: SignInResend): SignInResend = { ...r, stage: AuthenticatedStage, live: 0, verdict: { verifiedStep: r.displayed, verified: r.verifying, echo: echo } }
pure def canVerifyReply(r: SignInResend, echo: int): bool = r.stage == VerifyingStage and not(r.fenced) and resendDelivered(r)
pure def verifyReply(r: SignInResend, echo: int): SignInResend =
  if (r.live == r.verifying and (echo == 0 or echo == r.verifying)) authenticatedBy(echo, r) else { ...r, stage: CodeStage, verifying: 0 }
pure def canRetainedReply(r: SignInResend, echo: int): bool =
  r.stage == VerifyingStage and not(r.fenced) and resendDelivered(r) and r.live == r.verifying and echo == r.verifying
pure def retainedReply(r: SignInResend, echo: int): SignInResend = authenticatedBy(echo, r)
pure def canBeginCancellation(r: SignInResend): bool = r.stage != RetiredStage and r.stage != AuthenticatedStage and r.known.size() > 0 and r.pending.size() == 0
pure def beginCancellation(r: SignInResend): SignInResend = { ...r, stage: CancellingStage, pending: r.known, fenced: true, verifying: 0 }
pure def canCancelReply(r: SignInResend, scope: int, acknowledged: bool): bool =
  r.pending.contains(scope) and (not(acknowledged) or scope != resendRequest or resendDelivered(r))
pure def cancelReply(r: SignInResend, scope: int, acknowledged: bool): SignInResend = {
  val known = if (acknowledged) r.known.exclude(Set(scope)) else r.known
  { ...r, pending: r.pending.exclude(Set(scope)), known: known, live: if (acknowledged) C::scopeCancel(r.live, scope) else r.live,
    stage: if (known.size() == 0) RetiredStage else CancellingStage, fenced: known.size() > 0,
    receipt: if (acknowledged) C::cancelReceipt(r.live, scope) else r.receipt }
}
pure def canFinishNative(r: SignInResend): bool = r.live == originalRequest or r.live == resendRequest
pure def finishNative(r: SignInResend): SignInResend = { ...r, live: 0 }
pure def canForeignStarts(r: SignInResend): bool = r.live == 0
pure def foreignStarts(r: SignInResend): SignInResend = { ...r, live: foreignRequest }
pure val echoValues = Set(0, 1, 2, 3)
pure val scopeValues = Set(1, 2)
pure def alwaysRetirementRequiresReceipts(r: SignInResend): bool =
  r.known.forall(k => k == originalRequest or k == resendRequest) and r.pending.subseteq(r.known) and
    (r.fenced implies (r.stage == CancellingStage and r.known.size() > 0)) and
    (r.stage == RetiredStage implies (r.known.size() == 0 and r.pending.size() == 0 and r.live != originalRequest and r.live != resendRequest))
pure def alwaysScopedResendReceipt(r: SignInResend): bool = C::receiptScoped(r.receipt)
pure def alwaysVerificationUsesDisplayedOwner(r: SignInResend): bool =
  (r.stage == VerifyingStage implies r.verifying == r.displayed) and
    (r.verdict != noOutcome implies (r.verdict.verifiedStep == r.verdict.verified and (r.verdict.echo == 0 or r.verdict.echo == r.verdict.verified)))
pure def alwaysNoLateAdmission(r: SignInResend): bool = not(r.lateAdmission)
pure def sometimesResendAuthenticated(r: SignInResend): bool = r.stage == AuthenticatedStage and r.verdict.verified == resendRequest
pure def sometimesPartialCleanupKeepsResend(r: SignInResend): bool = r.fenced and r.known.size() == 1 and r.known.contains(resendRequest)
pure def sometimesCancellationRetired(r: SignInResend): bool = r.stage == RetiredStage
```
