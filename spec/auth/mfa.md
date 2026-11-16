# Second factor

The identity service manages a person's second factors: TOTP, SMS and
single-use recovery codes. It requires a recent second factor before it
changes a person's factors, and every change of factors ends the authority
that came before it. Completing an admitted challenge on the trusted host
is [MFA completion](./mfaCompletion.md).

## Story: Set up and change a second factor

> As a person with a second factor, I want changes to my factors to need a
> fresh second factor, so that a stolen session alone can never replace
> them.

### Changing sign-in factors requires a recent second factor

A second factor is recent for five minutes after the person answers a
live challenge with a valid code, or uses a recovery code; nothing else
grants it. When the last second factor is too old, enrollment start fails with 428
`account_verification_required` and starts no resend cooldown.

```quint
type Factor = Totp | Sms
type EnrollmentPhase = NotEnrolling | EnrollmentStarted | EnrollmentAmbiguous | EnrollmentConfirmed
type EnrollmentResult = NoEnrollmentResult | AccountVerificationRequired | EnrollmentCodeSent | FactorConfirmed | AuthorityCleared
type Mfa = {
  now: int, authority: bool, lastMfaAt: int, challengeDeadline: int, enrollment: EnrollmentPhase, enrollmentResult: EnrollmentResult, cooldownStarted: bool,
  recoveryCodes: Set[int], usedRecoveryCodes: Set[int], retiredRecoveryCodes: Set[int], recoveryGeneration: int
}
pure val initial: Mfa = {
  now: 0, authority: false, lastMfaAt: -1, challengeDeadline: 0, enrollment: NotEnrolling, enrollmentResult: NoEnrollmentResult, cooldownStarted: false,
  recoveryCodes: Set(1, 2), usedRecoveryCodes: Set(), retiredRecoveryCodes: Set(), recoveryGeneration: 1
}
pure val challengeLifetime = 300
pure def issueChallenge(s: Mfa): Mfa = { ...s, challengeDeadline: s.now + challengeLifetime }
pure def canCompleteChallenge(s: Mfa, codeValid: bool): bool = s.now < s.challengeDeadline
pure def completeChallenge(s: Mfa, codeValid: bool): Mfa = if (codeValid) { ...s, authority: true, lastMfaAt: s.now, challengeDeadline: 0 } else s
pure def canElapse(s: Mfa, seconds: int): bool = seconds > 0
pure def elapse(s: Mfa, seconds: int): Mfa = { ...s, now: s.now + seconds }
pure val secondsValues = Set(1, 300)
pure val recentMfaWindow = 300
pure def recentMfa(s: Mfa): bool = s.authority and s.lastMfaAt >= 0 and s.now - s.lastMfaAt <= recentMfaWindow
pure def canStartEnrollment(s: Mfa, factor: Factor): bool = s.enrollment != EnrollmentStarted
pure def startEnrollment(s: Mfa, factor: Factor): Mfa =
  if (recentMfa(s)) { ...s, enrollment: EnrollmentStarted, enrollmentResult: EnrollmentCodeSent, cooldownStarted: s.cooldownStarted or factor == Sms }
  else { ...s, enrollmentResult: AccountVerificationRequired }
pure val factorValues = Set(Totp, Sms)
pure def stepStaleMfaRefusesEnrollment(before: Mfa, via: str, after: Mfa): bool =
  (via == "startEnrollment" and not(recentMfa(before))) implies (after.enrollmentResult == AccountVerificationRequired and after.cooldownStarted == before.cooldownStarted and after.enrollment == before.enrollment)
pure def stepRecentMfaNeedsALiveChallengeOrRecoveryCode(before: Mfa, via: str, after: Mfa): bool =
  (after.lastMfaAt != before.lastMfaAt or (after.authority and not(before.authority))) implies
    ((via == "completeChallenge" and before.now < before.challengeDeadline) or via == "useRecoveryCode")
pure def sometimesVerificationRequired(s: Mfa): bool = s.enrollmentResult == AccountVerificationRequired
```

### Confirmed or ambiguous enrollment clears earlier authority, and an ambiguous verification is never replayed

```quint
type EnrollmentReply = EnrollmentVerified | EnrollmentUnclear | EnrollmentWrongCode
pure def canConfirmEnrollment(s: Mfa, answer: EnrollmentReply): bool = s.enrollment == EnrollmentStarted
pure def confirmEnrollment(s: Mfa, answer: EnrollmentReply): MfaChange =
  if (answer == EnrollmentVerified) audited(FactorChanged, { ...s, enrollment: EnrollmentConfirmed, enrollmentResult: FactorConfirmed, authority: false })
  else if (answer == EnrollmentUnclear) audited(FactorChanged, { ...s, enrollment: EnrollmentAmbiguous, enrollmentResult: AuthorityCleared, authority: false })
  else { state: s, out: List() }
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
pure def useRecoveryCode(s: Mfa, code: int): MfaChange =
  audited(RecoveryCodeUsed, { ...s, recoveryCodes: s.recoveryCodes.exclude(Set(code)), usedRecoveryCodes: s.usedRecoveryCodes.union(Set(code)), authority: true, lastMfaAt: s.now })
pure def canRegenerateRecoveryCodes(s: Mfa): bool = recentMfa(s)
pure def regenerateRecoveryCodes(s: Mfa): MfaChange = {
  val generation = s.recoveryGeneration + 1
  audited(RecoveryCodesRegenerated, { ...s, recoveryGeneration: generation, retiredRecoveryCodes: s.retiredRecoveryCodes.union(s.recoveryCodes), recoveryCodes: Set(generation * 10 + 1).union(Set(generation * 10 + 2)) })
}
pure val codeValues = Set(1, 2, 21, 22)
pure def alwaysRecoveryCodesSingleUse(s: Mfa): bool =
  s.usedRecoveryCodes.intersect(s.recoveryCodes).size() == 0 and s.retiredRecoveryCodes.intersect(s.recoveryCodes).size() == 0
    and s.recoveryGeneration >= 1
    and s.recoveryCodes.forall(c => if (s.recoveryGeneration == 1) (c == 1 or c == 2) else (c / 10 == s.recoveryGeneration and c % 10 >= 1 and c % 10 <= 2))
    and s.usedRecoveryCodes.union(s.retiredRecoveryCodes).forall(c => c >= 1 and c / 10 <= s.recoveryGeneration)
pure def sometimesRegeneratedAfterUse(s: Mfa): bool = s.recoveryGeneration > 1 and s.usedRecoveryCodes.size() > 0
```

### Every change of factors and every use of a recovery code is written to the audit log

Each emits one entry for the [audit log](./audit.md).

```quint
type AuditEntry = FactorChanged | RecoveryCodeUsed | RecoveryCodesRegenerated
type MfaChange = { state: Mfa, out: List[AuditEntry] }
pure def audited(entry: AuditEntry, changed: Mfa): MfaChange = { state: changed, out: List(entry) }
pure def emits(entries: List[AuditEntry], entry: AuditEntry): bool = entries.select(e => e == entry).length() > 0
pure def stepFactorChangeIsAudited(before: Mfa, after: Mfa, out: List[AuditEntry]): bool =
  ((after.enrollment != before.enrollment and after.enrollment != EnrollmentStarted) implies emits(out, FactorChanged)) and
    (not(after.usedRecoveryCodes.subseteq(before.usedRecoveryCodes)) implies emits(out, RecoveryCodeUsed)) and
    (after.recoveryGeneration != before.recoveryGeneration implies emits(out, RecoveryCodesRegenerated))
```
