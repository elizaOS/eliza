# Second factor

After a first factor admits an MFA challenge, the person completes it with
a TOTP or SMS code, or with a single-use recovery code. The trusted host
checks the input against the admitted challenge and its exact deadline
before the challenge leaves the host, and it hands the resulting session
over only when no saved receipt is pending and the attempt is still current.
The identity service requires a recent second factor before it changes a
person's factors, and every change of factors ends the authority that came
before it. Times are in seconds.

Ported from develop `packages/auth/quint/NativeGoogleMfa.qnt` (the host's
completion of a Google MFA challenge); the enrollment, recent-MFA and
recovery-code rules are new, from develop `src/server/routes/auth.ts` and
`routes/user.ts`. Passkeys are listed by the service but not completed
through this path.

## Story: Complete or set up a second factor

> As a person with a second factor, I want my code checked against the
> challenge I was given, before it expires, so that an old, foreign or
> cancelled challenge can never sign me in, and I want changes to my factors
> to need a fresh second factor.

### An MFA challenge completes only with its own method, before its deadline and in the current attempt

The host dispatches a code to the service only for the current session,
with well-formed digits, for a supported method, before the deadline. A
failed dispatch keeps the challenge for another try. The service may
replace the challenge with another method; a replacement can only bring
the deadline closer.

```quint
type MfaMethod = Totp | Sms | Passkey
type MfaPhase = Ready | AtProvider | ReadingReceipt | HandedOff | Cleared
type MfaOperation = CompleteMfa | OtherOperation
type ProviderReply = ProviderFailed | ProviderToken | ProviderReplacement
type MfaResult = ChallengeOpen | MfaBusy | MfaExpired | MfaBadCode | MfaUnsupported | Submitted | ProviderError | Replaced | SessionReceived | ReceiptSaved | GrantHandedOff | ReplyAfterCancel | CancelRequested | CancelSettled
type MfaSubmission = { session: int, method: MfaMethod, challenge: int, at: int, deadline: int, epoch: int }
type EnrollmentPhase = NotEnrolling | EnrollmentStarted | EnrollmentAmbiguous | EnrollmentConfirmed
type EnrollmentResult = NoEnrollmentResult | AccountVerificationRequired | EnrollmentCodeSent | FactorConfirmed | AuthorityCleared
type Mfa = {
  now: int, phase: MfaPhase, method: MfaMethod, challenge: int, deadline: int, initialDeadline: int, replacementDeadline: int,
  request: MfaSubmission, dispatches: int, epoch: int, cancelling: bool, pendingSeen: bool, grants: int, result: MfaResult,
  authority: bool, lastMfaAt: int, enrollment: EnrollmentPhase, enrollmentResult: EnrollmentResult, cooldownStarted: bool,
  recoveryCodes: Set[int], usedRecoveryCodes: Set[int], retiredRecoveryCodes: Set[int], recoveryGeneration: int
}
pure val challengeLifetime = 300
pure val noSubmission: MfaSubmission = { session: 0, method: Passkey, challenge: 0, at: 0, deadline: 0, epoch: 0 }
pure val initial: Mfa = {
  now: 0, phase: Ready, method: Totp, challenge: 1, deadline: challengeLifetime, initialDeadline: challengeLifetime, replacementDeadline: 0,
  request: noSubmission, dispatches: 0, epoch: 0, cancelling: false, pendingSeen: false, grants: 0, result: ChallengeOpen,
  authority: false, lastMfaAt: -1, enrollment: NotEnrolling, enrollmentResult: NoEnrollmentResult, cooldownStarted: false,
  recoveryCodes: Set(1, 2), usedRecoveryCodes: Set(), retiredRecoveryCodes: Set(), recoveryGeneration: 1
}
pure def supportedMethod(m: MfaMethod): bool = m == Totp or m == Sms
pure def earlier(a: int, b: int): int = if (a <= b) a else b
pure def pending(s: Mfa): bool = s.phase == AtProvider or s.phase == ReadingReceipt
pure def submitRefusal(s: Mfa, session: int, digits: bool, operation: MfaOperation): MfaResult =
  if (pending(s) or s.cancelling) MfaBusy
  else if (s.challenge == 0 or session != 1 or s.now >= s.deadline) MfaExpired
  else if (not(digits)) MfaBadCode
  else if (operation != CompleteMfa or not(supportedMethod(s.method))) MfaUnsupported
  else Submitted
pure def canSubmit(s: Mfa): bool = s.phase != HandedOff
pure def submit(s: Mfa, session: int, digits: bool, operation: MfaOperation): Mfa = {
  val refusal = submitRefusal(s, session, digits, operation)
  if (refusal != Submitted) { ...s, result: refusal }
  else { ...s, phase: AtProvider, dispatches: s.dispatches + 1, result: Submitted,
    request: { session: session, method: s.method, challenge: s.challenge, at: s.now, deadline: s.deadline, epoch: s.epoch } }
}
pure val sessionValues = Set(1, 2)
pure def canProviderReplies(s: Mfa, reply: ProviderReply, replacement: MfaMethod, replacementDeadline: int): bool =
  s.phase == AtProvider and (reply != ProviderReplacement or (s.replacementDeadline == 0 and replacementDeadline > 0))
pure def providerReplies(s: Mfa, reply: ProviderReply, replacement: MfaMethod, replacementDeadline: int): Mfa =
  if (s.request.epoch != s.epoch) { ...s, phase: Cleared, result: ReplyAfterCancel }
  else if (reply == ProviderFailed) { ...s, phase: Ready, result: ProviderError }
  else if (reply == ProviderReplacement) { ...s, phase: Ready, challenge: 2, method: replacement, deadline: earlier(s.deadline, replacementDeadline), replacementDeadline: replacementDeadline, result: Replaced }
  else { ...s, phase: ReadingReceipt, result: SessionReceived }
pure val replacementDeadlineValues = Set(60, 300, 600)
pure def canElapse(s: Mfa, seconds: int): bool = seconds > 0
pure def elapse(s: Mfa, seconds: int): Mfa = { ...s, now: s.now + seconds }
pure val secondsValues = Set(1, 300)
pure def alwaysCompletionUsesMatchingLiveFactor(s: Mfa): bool =
  s.dispatches > 0 implies (s.request.session == 1 and supportedMethod(s.request.method) and s.request.at < s.request.deadline and (s.request.challenge == 1 or s.request.challenge == 2)
    and ((pending(s) and s.request.epoch == s.epoch) implies (s.request.challenge == s.challenge and s.request.method == s.method)))
pure def alwaysReplacementOnlyShortensDeadline(s: Mfa): bool =
  s.deadline <= s.initialDeadline and (s.replacementDeadline == 0 implies s.deadline == s.initialDeadline) and (s.replacementDeadline > 0 implies s.deadline == earlier(s.initialDeadline, s.replacementDeadline))
pure def alwaysProviderFailureKeepsChallenge(s: Mfa): bool =
  s.result == ProviderError implies (s.challenge == s.request.challenge and s.method == s.request.method and s.phase == Ready)
pure def sometimesReplacedFactorSubmitted(s: Mfa): bool = s.phase == AtProvider and s.request.challenge == 2
pure def sometimesExpiredRefused(s: Mfa): bool = s.result == MfaExpired and s.challenge > 0
```

### A session is handed over only with an empty saved receipt and in the current attempt

```quint
pure def canReceiptReply(s: Mfa, hasPending: bool): bool = s.phase == ReadingReceipt
pure def receiptReply(s: Mfa, hasPending: bool): Mfa = {
  val inEpoch = s.request.epoch == s.epoch
  val allowed = not(hasPending) and inEpoch
  { ...s, pendingSeen: hasPending, grants: if (allowed) 1 else 0,
    phase: if (allowed) HandedOff else if (inEpoch) Ready else Cleared,
    result: if (hasPending) ReceiptSaved else if (allowed) GrantHandedOff else ReplyAfterCancel,
    authority: s.authority or allowed, lastMfaAt: if (allowed) s.now else s.lastMfaAt }
}
pure def alwaysGrantNeedsCurrentEpochAndEmptyReceipt(s: Mfa): bool =
  s.grants > 0 implies (s.phase == HandedOff and s.result == GrantHandedOff and s.request.epoch == s.epoch and not(s.pendingSeen))
pure def sometimesHandedOff(s: Mfa): bool = s.phase == HandedOff
pure def sometimesSavedReceiptBlocksGrant(s: Mfa): bool = s.result == ReceiptSaved and s.grants == 0
```

### Cancel retires the challenge and no later reply can restore it or hand over a session

```quint
pure def canCancel(s: Mfa): bool = not(s.cancelling) and s.phase != HandedOff
pure def cancel(s: Mfa): Mfa = { ...s, epoch: s.epoch + 1, challenge: 0, cancelling: true, phase: if (pending(s)) s.phase else Cleared, result: CancelRequested }
pure def canSettleCancel(s: Mfa): bool = s.cancelling and not(pending(s))
pure def settleCancel(s: Mfa): Mfa = { ...s, cancelling: false, result: CancelSettled }
pure def alwaysCancelCannotRestoreChallengeOrGrant(s: Mfa): bool = s.epoch > 0 implies (s.challenge == 0 and s.grants == 0)
pure def alwaysPendingRequestIsNoNewerThanTheAttempt(s: Mfa): bool = s.request.epoch <= s.epoch and s.epoch >= 0 and (s.phase == HandedOff implies s.epoch == 0) and (s.epoch > 0 implies s.request.epoch < s.epoch)
pure def sometimesCancelledDuringReceiptRead(s: Mfa): bool = s.result == ReplyAfterCancel and s.grants == 0
pure val fair_providerReplies = "weak"
pure val fair_receiptReply = "weak"
pure def leadsToAdmittedMfaSettles(s: Mfa, later: Mfa): bool = pending(s) implies not(pending(later))
```

### Changing sign-in factors requires a recent second factor

When the last second factor is too old, enrollment start fails with 428
`account_verification_required` and starts no resend cooldown.

```quint
pure val recentMfaWindow = 300
pure def recentMfa(s: Mfa): bool = s.authority and s.lastMfaAt >= 0 and s.now - s.lastMfaAt <= recentMfaWindow
pure def canStartEnrollment(s: Mfa, factor: MfaMethod): bool = s.enrollment != EnrollmentStarted and supportedMethod(factor)
pure def startEnrollment(s: Mfa, factor: MfaMethod): Mfa =
  if (recentMfa(s)) { ...s, enrollment: EnrollmentStarted, enrollmentResult: EnrollmentCodeSent, cooldownStarted: s.cooldownStarted or factor == Sms }
  else { ...s, enrollmentResult: AccountVerificationRequired }
pure val factorValues = Set(Totp, Sms)
pure def stepStaleMfaRefusesEnrollment(before: Mfa, via: str, after: Mfa): bool =
  (via == "startEnrollment" and not(recentMfa(before))) implies (after.enrollmentResult == AccountVerificationRequired and after.cooldownStarted == before.cooldownStarted and after.enrollment == before.enrollment)
pure def sometimesVerificationRequired(s: Mfa): bool = s.enrollmentResult == AccountVerificationRequired
```

### Confirmed or ambiguous enrollment clears earlier authority, and an ambiguous verification is never replayed

```quint
type EnrollmentReply = EnrollmentVerified | EnrollmentUnclear | EnrollmentWrongCode
pure def canConfirmEnrollment(s: Mfa, answer: EnrollmentReply): bool = s.enrollment == EnrollmentStarted
pure def confirmEnrollment(s: Mfa, answer: EnrollmentReply): Mfa =
  if (answer == EnrollmentVerified) { ...s, enrollment: EnrollmentConfirmed, enrollmentResult: FactorConfirmed, authority: false }
  else if (answer == EnrollmentUnclear) { ...s, enrollment: EnrollmentAmbiguous, enrollmentResult: AuthorityCleared, authority: false }
  else s
pure def stepFactorChangeClearsAuthority(before: Mfa, via: str, after: Mfa): bool =
  (via == "confirmEnrollment" and after.enrollment != EnrollmentStarted) implies not(after.authority)
pure def stepOnlyAStartedEnrollmentIsConfirmed(before: Mfa, via: str, after: Mfa): bool =
  via == "confirmEnrollment" implies before.enrollment == EnrollmentStarted
pure def sometimesFactorConfirmed(s: Mfa): bool = s.enrollment == EnrollmentConfirmed and not(s.authority)
pure def sometimesAmbiguousEnrollment(s: Mfa): bool = s.enrollment == EnrollmentAmbiguous
```

### Recovery codes are single use, and regeneration invalidates the previous set

```quint
pure def canUseRecoveryCode(s: Mfa, code: int): bool = s.recoveryCodes.contains(code)
pure def useRecoveryCode(s: Mfa, code: int): Mfa =
  { ...s, recoveryCodes: s.recoveryCodes.exclude(Set(code)), usedRecoveryCodes: s.usedRecoveryCodes.union(Set(code)), authority: true, lastMfaAt: s.now }
pure def canRegenerateRecoveryCodes(s: Mfa): bool = recentMfa(s)
pure def regenerateRecoveryCodes(s: Mfa): Mfa = {
  val generation = s.recoveryGeneration + 1
  { ...s, recoveryGeneration: generation, retiredRecoveryCodes: s.retiredRecoveryCodes.union(s.recoveryCodes), recoveryCodes: Set(generation * 10 + 1).union(Set(generation * 10 + 2)) }
}
pure val codeValues = Set(1, 2, 21, 22)
pure def alwaysRecoveryCodesSingleUse(s: Mfa): bool =
  s.usedRecoveryCodes.intersect(s.recoveryCodes).size() == 0 and s.retiredRecoveryCodes.intersect(s.recoveryCodes).size() == 0
    and s.recoveryGeneration >= 1
    and s.recoveryCodes.forall(c => if (s.recoveryGeneration == 1) (c == 1 or c == 2) else (c / 10 == s.recoveryGeneration and c % 10 >= 1 and c % 10 <= 2))
    and s.usedRecoveryCodes.union(s.retiredRecoveryCodes).forall(c => c >= 1 and c / 10 <= s.recoveryGeneration)
pure def sometimesRegeneratedAfterUse(s: Mfa): bool = s.recoveryGeneration > 1 and s.usedRecoveryCodes.size() > 0
```
