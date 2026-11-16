# MFA completion

After a first factor admits an MFA challenge, the person completes it with
a TOTP or SMS code. The trusted host checks the input against the admitted
challenge and its exact deadline before the challenge leaves the host, and
it hands the resulting session over only when no saved receipt is pending
and the attempt is still current. The service's side of a completion,
which makes the second factor recent, is `completeChallenge` in
[second factor](./mfa.md), whose factors and challenge lifetime this
machine shares.

## Story: Complete an admitted MFA challenge

> As a person with a second factor, I want my code checked against the
> challenge I was given, before it expires, so that an old, foreign or
> cancelled challenge can never sign me in.

### An MFA challenge completes only with its own method, before its deadline and in the current attempt

The host dispatches a code to the service only for the current session,
with well-formed digits, for the completion operation, before the deadline. A
failed dispatch keeps the challenge for another try. The service may
replace the challenge with another method; a replacement can only bring
the deadline closer.

```quint
import mfa as M from "./mfa"
type MfaPhase = Ready | AtProvider | ReadingReceipt | HandedOff | Cleared
type MfaOperation = CompleteMfa | OtherOperation
type ProviderReply = ProviderFailed | ProviderToken | ProviderReplacement
type MfaResult = ChallengeOpen | MfaBusy | MfaExpired | MfaBadCode | MfaUnsupported | Submitted | ProviderError | Replaced | SessionReceived | ReceiptSaved | GrantHandedOff | ReplyAfterCancel | CancelRequested | CancelSettled
type MfaSubmission = { session: int, method: M::Factor, challenge: int, at: int, deadline: int, epoch: int }
type MfaCompletion = {
  now: int, phase: MfaPhase, method: M::Factor, challenge: int, deadline: int, initialDeadline: int, replacementDeadline: int,
  request: MfaSubmission, dispatches: int, epoch: int, cancelling: bool, pendingSeen: bool, grants: int, result: MfaResult
}
pure val noSubmission: MfaSubmission = { session: 0, method: M::Totp, challenge: 0, at: 0, deadline: 0, epoch: 0 }
pure val initial: MfaCompletion = {
  now: 0, phase: Ready, method: M::Totp, challenge: 1, deadline: M::challengeLifetime, initialDeadline: M::challengeLifetime, replacementDeadline: 0,
  request: noSubmission, dispatches: 0, epoch: 0, cancelling: false, pendingSeen: false, grants: 0, result: ChallengeOpen
}
pure def earlier(a: int, b: int): int = if (a <= b) a else b
pure def pending(s: MfaCompletion): bool = s.phase == AtProvider or s.phase == ReadingReceipt
pure def submitRefusal(s: MfaCompletion, session: int, digits: bool, operation: MfaOperation): MfaResult =
  if (pending(s) or s.cancelling) MfaBusy
  else if (s.challenge == 0 or session != 1 or s.now >= s.deadline) MfaExpired
  else if (not(digits)) MfaBadCode
  else if (operation != CompleteMfa) MfaUnsupported
  else Submitted
pure def canSubmit(s: MfaCompletion): bool = s.phase != HandedOff
pure def submit(s: MfaCompletion, session: int, digits: bool, operation: MfaOperation): MfaCompletion = {
  val refusal = submitRefusal(s, session, digits, operation)
  if (refusal != Submitted) { ...s, result: refusal }
  else { ...s, phase: AtProvider, dispatches: s.dispatches + 1, result: Submitted,
    request: { session: session, method: s.method, challenge: s.challenge, at: s.now, deadline: s.deadline, epoch: s.epoch } }
}
pure val sessionValues = Set(1, 2)
pure def canProviderReplies(s: MfaCompletion, reply: ProviderReply, replacement: M::Factor, replacementDeadline: int): bool =
  s.phase == AtProvider and (reply != ProviderReplacement or (s.replacementDeadline == 0 and replacementDeadline > 0))
pure def providerReplies(s: MfaCompletion, reply: ProviderReply, replacement: M::Factor, replacementDeadline: int): MfaCompletion =
  if (s.request.epoch != s.epoch) { ...s, phase: Cleared, result: ReplyAfterCancel }
  else if (reply == ProviderFailed) { ...s, phase: Ready, result: ProviderError }
  else if (reply == ProviderReplacement) { ...s, phase: Ready, challenge: 2, method: replacement, deadline: earlier(s.deadline, replacementDeadline), replacementDeadline: replacementDeadline, result: Replaced }
  else { ...s, phase: ReadingReceipt, result: SessionReceived }
pure val replacementDeadlineValues = Set(60, 300, 600)
pure def canElapse(s: MfaCompletion, seconds: int): bool = seconds > 0
pure def elapse(s: MfaCompletion, seconds: int): MfaCompletion = { ...s, now: s.now + seconds }
pure val secondsValues = Set(1, 300)
pure def alwaysCompletionUsesMatchingLiveFactor(s: MfaCompletion): bool =
  s.dispatches > 0 implies (s.request.session == 1 and s.request.at < s.request.deadline and (s.request.challenge == 1 or s.request.challenge == 2)
    and ((pending(s) and s.request.epoch == s.epoch) implies (s.request.challenge == s.challenge and s.request.method == s.method)))
pure def alwaysReplacementOnlyShortensDeadline(s: MfaCompletion): bool =
  s.deadline <= s.initialDeadline and (s.replacementDeadline == 0 implies s.deadline == s.initialDeadline) and (s.replacementDeadline > 0 implies s.deadline == earlier(s.initialDeadline, s.replacementDeadline))
pure def alwaysProviderFailureKeepsChallenge(s: MfaCompletion): bool =
  s.result == ProviderError implies (s.challenge == s.request.challenge and s.method == s.request.method and s.phase == Ready)
pure def sometimesReplacedFactorSubmitted(s: MfaCompletion): bool = s.phase == AtProvider and s.request.challenge == 2
pure def sometimesExpiredRefused(s: MfaCompletion): bool = s.result == MfaExpired and s.challenge > 0
```

### A session is handed over only with an empty saved receipt and in the current attempt

```quint
pure def canReceiptReply(s: MfaCompletion, hasPending: bool): bool = s.phase == ReadingReceipt
pure def receiptReply(s: MfaCompletion, hasPending: bool): MfaCompletion = {
  val inEpoch = s.request.epoch == s.epoch
  val allowed = not(hasPending) and inEpoch
  { ...s, pendingSeen: hasPending, grants: if (allowed) 1 else 0,
    phase: if (allowed) HandedOff else if (inEpoch) Ready else Cleared,
    result: if (hasPending) ReceiptSaved else if (allowed) GrantHandedOff else ReplyAfterCancel }
}
pure def alwaysGrantNeedsCurrentEpochAndEmptyReceipt(s: MfaCompletion): bool =
  s.grants > 0 implies (s.phase == HandedOff and s.result == GrantHandedOff and s.request.epoch == s.epoch and not(s.pendingSeen))
pure def sometimesHandedOff(s: MfaCompletion): bool = s.phase == HandedOff
pure def sometimesSavedReceiptBlocksGrant(s: MfaCompletion): bool = s.result == ReceiptSaved and s.grants == 0
```

### Cancel retires the challenge and no later reply can restore it or hand over a session

```quint
pure def canCancel(s: MfaCompletion): bool = not(s.cancelling) and s.phase != HandedOff
pure def cancel(s: MfaCompletion): MfaCompletion = { ...s, epoch: s.epoch + 1, challenge: 0, cancelling: true, phase: if (pending(s)) s.phase else Cleared, result: CancelRequested }
pure def canSettleCancel(s: MfaCompletion): bool = s.cancelling and not(pending(s))
pure def settleCancel(s: MfaCompletion): MfaCompletion = { ...s, cancelling: false, result: CancelSettled }
pure def alwaysCancelCannotRestoreChallengeOrGrant(s: MfaCompletion): bool = s.epoch > 0 implies (s.challenge == 0 and s.grants == 0)
pure def alwaysPendingRequestIsNoNewerThanTheAttempt(s: MfaCompletion): bool = s.request.epoch <= s.epoch and s.epoch >= 0 and (s.phase == HandedOff implies s.epoch == 0) and (s.epoch > 0 implies s.request.epoch < s.epoch)
pure def sometimesCancelledDuringReceiptRead(s: MfaCompletion): bool = s.result == ReplyAfterCancel and s.grants == 0
pure val fair_providerReplies = "weak"
pure val fair_receiptReply = "weak"
pure def leadsToAdmittedMfaSettles(s: MfaCompletion, later: MfaCompletion): bool = pending(s) implies not(pending(later))
```
