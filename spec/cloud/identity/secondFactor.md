# Second factor

A person's TOTP and SMS factors, the login challenge a first factor opens for
a person who has one, and the step-up that marks a live session. Sources are
develop `packages/auth/src/server/api/routes/auth.ts` (`/mfa/*`) and
`auth/totp.ts`, and the server halves of the old `spec/auth/mfa.md` and
`spec/auth/mfaCompletion.md`. Recovery codes are gone. The device half
(submitting a code, cancel, the saved receipt) is os.

One machine follows one person's factors, their current login challenge and
the session that calls the factor routes. Its clock is that session's. Codes
enter as observations: `codeMatches` says the presented code matched, and for
TOTP `matchedStep` is the 30-second step it matched at. The shell keeps the
sealed TOTP seed (`Sealed {purpose: TotpSeed}`) and the phone number, sends
SMS codes as `codeChallenges` does (6 digits, keyed digest, the sending
limits of `shared/rateLimit`) and answers a sign-in that needs this factor as
`{status: "mfa_required", challengeId, methods, expiresAt}`, `methods` being
the confirmed ones.

## Story: Set up and change my second factor

> As an account owner, I want to add an authenticator app or my phone as a
> second factor, and to need a recent confirmation before I change one, so
> that a stolen session alone can never replace my factors.

### A factor counts only once a code from it is confirmed before its setup expires

TOTP setup lives 10 minutes and an SMS setup code 5. A confirmed method is
refused a second setup until it is removed.

```quint
import types.* from "../shared/types"
import sessions as S from "./sessions"
type FactorMethod = Totp | Sms
type Enrollment = Absent | Pending({ setupExpiresAt: Millis }) | Confirmed
type Factors = { totp: Enrollment, sms: Enrollment, lastTotpStep: int }
type SmsCode = NoCode | CodeSent({ codeExpiresAt: Millis })
type ChallengePhase = Unopened | Open | Completed({ method: FactorMethod }) | Expired | Locked
type LoginChallenge = { phase: ChallengePhase, failures: int, expiresAt: Millis, smsCode: SmsCode }
type SecondFactor = { factors: Factors, challenge: LoginChallenge, stepUpCode: SmsCode, caller: S::Family }
pure val noTotpStep: int = -1
pure val totpSetupLifetime: Millis = 10 * millisPerMinute
pure val smsCodeLifetime: Millis = 5 * millisPerMinute
pure val initial: SecondFactor = { factors: { totp: Absent, sms: Absent, lastTotpStep: noTotpStep }, challenge: { phase: Unopened, failures: 0, expiresAt: 0, smsCode: NoCode }, stepUpCode: NoCode, caller: S::signIn(S::initial, S::SingleFactor) }
pure def clock(s: SecondFactor): Millis = s.caller.now
pure def earlier(a: Millis, b: Millis): Millis = if (a <= b) a else b
pure def enrollmentOf(f: Factors, method: FactorMethod): Enrollment = if (method == Totp) f.totp else f.sms
pure def withEnrollment(f: Factors, method: FactorMethod, e: Enrollment): Factors = if (method == Totp) { ...f, totp: e } else { ...f, sms: e }
pure def isConfirmed(f: Factors, method: FactorMethod): bool = enrollmentOf(f, method) == Confirmed
pure def hasFactor(f: Factors): bool = isConfirmed(f, Totp) or isConfirmed(f, Sms)
pure def setupLive(e: Enrollment, now: Millis): bool = match e { | Pending(p) => now < p.setupExpiresAt | _ => false }
pure def canEnroll(s: SecondFactor, method: FactorMethod): bool = mayChangeFactors(s) and not(isConfirmed(s.factors, method))
pure def enroll(s: SecondFactor, method: FactorMethod): SecondFactor = { ...s, factors: withEnrollment(s.factors, method, Pending({ setupExpiresAt: clock(s) + (if (method == Totp) totpSetupLifetime else smsCodeLifetime) })) }
pure def canConfirmEnrollment(s: SecondFactor, method: FactorMethod): bool = mayChangeFactors(s) and setupLive(enrollmentOf(s.factors, method), clock(s))
pure def confirmEnrollment(s: SecondFactor, method: FactorMethod, codeMatches: bool, matchedStep: int): SecondFactor =
  if (factorCodeAccepted(s.factors, method, clock(s), codeMatches, matchedStep)) { ...s, factors: withEnrollment(advanceTotpStep(s.factors, method, matchedStep), method, Confirmed) }
  else s
pure def canElapse(s: SecondFactor, elapsed: Millis): bool = elapsed > 0
pure def elapse(s: SecondFactor, elapsed: Millis): SecondFactor = { ...s, caller: S::elapse(s.caller, elapsed) }
pure val elapsedValues = Set(1, 30000, 300000, 600001)
pure def alwaysCallerIsASession(s: SecondFactor): bool = S::alwaysAccessWithinLifetimes(s.caller) and S::alwaysEpochNeverAhead(s.caller)
pure def sometimesBothFactorsConfirmed(s: SecondFactor): bool = isConfirmed(s.factors, Totp) and isConfirmed(s.factors, Sms)
```

### Setting up the first factor needs a session at most 5 minutes old, and every other change of factors needs a step-up at most 5 minutes old

Removing a factor ends any SMS code sent for it.

```quint
pure def mayChangeFactors(s: SecondFactor): bool = S::isSteppedUp(s.caller) or (not(hasFactor(s.factors)) and S::isNewlySignedIn(s.caller))
pure def canRemoveFactor(s: SecondFactor, method: FactorMethod): bool = S::isSteppedUp(s.caller) and enrollmentOf(s.factors, method) != Absent
pure def removeFactor(s: SecondFactor, method: FactorMethod): SecondFactor =
  if (method == Totp) { ...s, factors: withEnrollment(s.factors, Totp, Absent) }
  else { ...s, factors: withEnrollment(s.factors, Sms, Absent), stepUpCode: NoCode, challenge: { ...s.challenge, smsCode: NoCode } }
pure def stepFactorsChangeOnlyWithRecentAuthority(before: SecondFactor, after: SecondFactor): bool = (after.factors.totp != before.factors.totp or after.factors.sms != before.factors.sms) implies mayChangeFactors(before)
pure def sometimesFactorRemovedAfterStepUp(s: SecondFactor): bool = s.factors.totp == Absent and s.factors.lastTotpStep > noTotpStep
```

## Story: Finish sign-in with my second factor

> As a person with a second factor, I want a sign-in to ask for it before I
> get a session, and to give up on a challenge after a few wrong codes, so
> that a stolen password, email or phone code alone never signs anyone in.

### A first factor for a person with a confirmed factor opens a challenge of 5 minutes instead of a session

`codeChallenges` and `federatedSignIn` answer `afterFirstFactor` of the
person's factors: a session, or this challenge, never both. A new sign-in
replaces a challenge that is no longer live.

```quint
type FirstFactorOutcome = SessionStarts | SecondFactorRequired
pure def afterFirstFactor(f: Factors): FirstFactorOutcome = if (hasFactor(f)) SecondFactorRequired else SessionStarts
pure val challengeLifetime: Millis = 5 * millisPerMinute
pure def isLive(c: LoginChallenge, now: Millis): bool = c.phase == Open and now < c.expiresAt
pure def canOpenChallenge(s: SecondFactor): bool = hasFactor(s.factors) and not(isLive(s.challenge, clock(s)))
pure def openChallenge(s: SecondFactor): SecondFactor = { ...s, challenge: { phase: Open, failures: 0, expiresAt: clock(s) + challengeLifetime, smsCode: NoCode } }
pure def alwaysChallengeEndsWithinFiveMinutes(s: SecondFactor): bool = s.challenge.expiresAt <= clock(s) + challengeLifetime and (s.challenge.phase == Unopened implies (s.challenge.failures == 0 and s.challenge.smsCode == NoCode))
pure def sometimesChallengeOpen(s: SecondFactor): bool = isLive(s.challenge, clock(s))
```

### A TOTP code is accepted only within one step of now and at a later step than the last one accepted

The step is 30 seconds; a code replayed at a step already used is refused.

```quint
pure val totpStep: Millis = 30 * millisPerSecond
pure val totpWindow: int = 1
pure def totpStepAt(now: Millis): int = now / totpStep
pure def totpAccepted(f: Factors, now: Millis, codeMatches: bool, matchedStep: int): bool = codeMatches and matchedStep >= totpStepAt(now) - totpWindow and matchedStep <= totpStepAt(now) + totpWindow and matchedStep > f.lastTotpStep
pure def factorCodeAccepted(f: Factors, method: FactorMethod, now: Millis, codeMatches: bool, matchedStep: int): bool = if (method == Totp) totpAccepted(f, now, codeMatches, matchedStep) else codeMatches
pure def advanceTotpStep(f: Factors, method: FactorMethod, matchedStep: int): Factors = if (method == Totp) { ...f, lastTotpStep: matchedStep } else f
pure def alwaysAcceptedTotpStepNotAhead(s: SecondFactor): bool = s.factors.lastTotpStep >= noTotpStep and s.factors.lastTotpStep <= totpStepAt(clock(s)) + totpWindow
pure def stepAcceptedTotpStepOnlyGrows(before: SecondFactor, after: SecondFactor): bool = after.factors.lastTotpStep != before.factors.lastTotpStep implies after.factors.lastTotpStep > before.factors.lastTotpStep
```

### An SMS code exists only for a confirmed phone and never outlives the challenge or 5 minutes

A code is sent for the live challenge, or for the calling session's step-up;
sending again replaces it and never moves the challenge's deadline.

```quint
pure def codeLive(c: SmsCode, now: Millis): bool = match c { | CodeSent(x) => now < x.codeExpiresAt | NoCode => false }
pure def codeEndsBy(c: SmsCode, deadline: Millis): bool = match c { | CodeSent(x) => x.codeExpiresAt <= deadline | NoCode => true }
pure def canSendChallengeSms(s: SecondFactor): bool = isLive(s.challenge, clock(s)) and isConfirmed(s.factors, Sms)
pure def sendChallengeSms(s: SecondFactor): SecondFactor = { ...s, challenge: { ...s.challenge, smsCode: CodeSent({ codeExpiresAt: earlier(s.challenge.expiresAt, clock(s) + smsCodeLifetime) }) } }
pure def canSendStepUpSms(s: SecondFactor): bool = S::isActive(s.caller) and isConfirmed(s.factors, Sms)
pure def sendStepUpSms(s: SecondFactor): SecondFactor = { ...s, stepUpCode: CodeSent({ codeExpiresAt: clock(s) + smsCodeLifetime }) }
pure def alwaysSmsCodesBelongToAConfirmedPhone(s: SecondFactor): bool = ((s.challenge.smsCode != NoCode or s.stepUpCode != NoCode) implies isConfirmed(s.factors, Sms)) and codeEndsBy(s.challenge.smsCode, s.challenge.expiresAt) and codeEndsBy(s.stepUpCode, clock(s) + smsCodeLifetime)
pure def sometimesChallengeCodeSent(s: SecondFactor): bool = codeLive(s.challenge.smsCode, clock(s))
```

### A challenge completes once, while live, with a confirmed factor and its code, and starts exactly one multi-factor session

The session is started by `sessions` with `MultiFactor`, so its `mfaAt` is
the moment of completion. The shell loads the factors of the challenge's own
person.

```quint
type FactorEffect = StartSession({ assurance: S::Assurance })
type FactorStep = { state: SecondFactor, out: List[FactorEffect] }
pure val maxFailures: int = 5
pure def isCompletedPhase(p: ChallengePhase): bool = match p { | Completed(x) => true | _ => false }
pure def completedBy(p: ChallengePhase, f: Factors): bool = match p { | Completed(x) => isConfirmed(f, x.method) | _ => false }
pure def canCompleteChallenge(s: SecondFactor, method: FactorMethod): bool = isLive(s.challenge, clock(s)) and isConfirmed(s.factors, method) and (method == Totp or codeLive(s.challenge.smsCode, clock(s)))
pure def completeChallenge(s: SecondFactor, method: FactorMethod, codeMatches: bool, matchedStep: int): FactorStep = {
  val c = s.challenge
  if (factorCodeAccepted(s.factors, method, clock(s), codeMatches, matchedStep))
    { state: { ...s, factors: advanceTotpStep(s.factors, method, matchedStep), challenge: { ...c, phase: Completed({ method: method }), smsCode: NoCode } }, out: List(StartSession({ assurance: S::MultiFactor })) }
  else { state: { ...s, challenge: { ...c, failures: c.failures + 1, phase: if (c.failures + 1 >= maxFailures) Locked else Open } }, out: List() }
}
pure val weight_completeChallenge = 4
pure def stepSessionOnlyFromALiveChallenge(before: SecondFactor, via: str, after: SecondFactor, out: List[FactorEffect]): bool = {
  val completes = not(isCompletedPhase(before.challenge.phase)) and isCompletedPhase(after.challenge.phase)
  (completes implies (isLive(before.challenge, clock(before)) and completedBy(after.challenge.phase, before.factors) and out == List(StartSession({ assurance: S::MultiFactor })))) and (not(completes) implies out == List())
}
pure def sometimesSignedInWithTotp(s: SecondFactor): bool = s.challenge.phase == Completed({ method: Totp })
pure def sometimesSignedInWithSms(s: SecondFactor): bool = s.challenge.phase == Completed({ method: Sms })
```

### Five wrong codes lock the challenge, and only a new sign-in opens another

A locked challenge answers `403 access_denied` reason `challenge_locked`, for
the right code too.

```quint
pure def alwaysLockedExactlyAtTheFailureLimit(s: SecondFactor): bool = s.challenge.failures >= 0 and s.challenge.failures <= maxFailures and ((s.challenge.phase == Locked) iff (s.challenge.failures == maxFailures))
pure def sometimesLocked(s: SecondFactor): bool = s.challenge.phase == Locked
```

### An open challenge past its deadline is closed as expired

```quint
pure def canExpireChallenge(s: SecondFactor): bool = s.challenge.phase == Open and clock(s) >= s.challenge.expiresAt
pure def expireChallenge(s: SecondFactor): SecondFactor = { ...s, challenge: { ...s.challenge, phase: Expired, smsCode: NoCode } }
pure def sometimesExpired(s: SecondFactor): bool = s.challenge.phase == Expired
```

### A refused completion says the challenge is locked, expired or unknown, the method is not set up, or the code is wrong

The shell answers this of the state after the attempt.

```quint
pure def challengeRefusal(s: SecondFactor, method: FactorMethod): Refusal =
  if (s.challenge.phase == Locked) refuseFor(AccessDenied, ChallengeLocked)
  else if (s.challenge.phase == Expired or (s.challenge.phase == Open and clock(s) >= s.challenge.expiresAt)) refuseFor(AuthenticationRequired, CredentialExpired)
  else if (s.challenge.phase != Open) refuseFor(AuthenticationRequired, CredentialUnknown)
  else if (not(isConfirmed(s.factors, method))) refuse(InvalidRequest)
  else refuse(CredentialProofInvalid)
```

## Story: Confirm it is me before a sensitive change

> As an account owner, I want to confirm a sensitive change with my second
> factor on the session I already have, so that I do not sign in again and
> my session keeps working.

### A step-up with a confirmed factor and its code marks the calling session and keeps its token

The session records `stepUpAt` and `mfaAt` as now and answers
`{stepUpAt, mfaAt}`; an SMS step-up code is used once.

```quint
pure def canStepUp(s: SecondFactor, method: FactorMethod): bool = S::isActive(s.caller) and isConfirmed(s.factors, method) and (method == Totp or codeLive(s.stepUpCode, clock(s)))
pure def stepUp(s: SecondFactor, method: FactorMethod, codeMatches: bool, matchedStep: int): SecondFactor =
  if (factorCodeAccepted(s.factors, method, clock(s), codeMatches, matchedStep))
    { ...s, factors: advanceTotpStep(s.factors, method, matchedStep), stepUpCode: if (method == Sms) NoCode else s.stepUpCode, caller: S::recordStepUp(s.caller, S::MultiFactor) }
  else s
pure def stepOnlyAFactorMarksTheSession(before: SecondFactor, via: str, after: SecondFactor): bool = after.caller.stepUpAt != before.caller.stepUpAt implies (via == "stepUp" and hasFactor(before.factors) and after.caller.generation == before.caller.generation and after.caller.mfaAt == S::At({ ms: clock(before) }))
pure def sometimesSteppedUpBySms(s: SecondFactor): bool = S::isSteppedUp(s.caller) and s.factors.lastTotpStep == noTotpStep
pure def sometimesSteppedUpByTotp(s: SecondFactor): bool = S::isSteppedUp(s.caller) and s.factors.lastTotpStep > noTotpStep and isConfirmed(s.factors, Totp)
```
