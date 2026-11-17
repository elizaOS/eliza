# Code challenges

Sign-in, and proof of a phone being linked, with a six-digit code sent by
email or SMS. Sources are develop `packages/auth/src/server/auth/email.ts`
(10-minute code, 5 attempts, keyed digest) and `phone.ts` (5-minute code),
`sms-destination.ts` (allowed country codes, hourly budget), the code routes
of `packages/auth/src/server/api/routes/auth.ts`, and the server half of the
old `spec/auth/codeSignIn.md`. The device half (typing the code, resend,
cancel) is `spec/os/signIn/flow.md`.

Routes: `POST /api/v1/auth/email/code/{send,verify}`,
`POST /api/v1/auth/sms/code/{send,verify}` (public) and
`POST /api/v1/user/methods/phone/code/{send,verify}` (session). A send
carries `{email | phone, clientId, codeChallenge, codeChallengeMethod: "S256"}`
and answers `{expiresAt, codeLength: 6}`; a verify carries the destination,
`code`, `clientId` and `codeVerifier`. The Effect Schema refuses a malformed
address or a phone that is not E.164 with `400 invalid_request` before this
machine. The shell draws the code at random, stores only its keyed digest and
the S256 challenge, and passes the comparisons in as observations:
`codeMatches` (the code's digest equals the stored one) and `verifierMatches`
(the verifier hashes to the stored challenge). The code itself never enters
the model.

One machine instance is one challenge row. A destination and purpose hold at
most one Open challenge: an admitted send supersedes the Open one and opens
the new one in the same transaction, backed by a unique partial index.

## Story: Sign in with a code sent to my email or phone

> As a person, I want to sign in with a code sent to my email address or my
> phone, so that I need no password, while nobody can guess, replay or
> intercept my code into a session.

### A code goes only to an email address, or to a phone in a country the deployment allows

A sign-in code goes to either; a link code goes only to a phone and names
the user who asked for it. Any other send is refused `400 invalid_request`
without sending. An email code lives 10 minutes and an SMS code 5.

```quint
import types.* from "../shared/types"
import rateLimit as R from "../shared/rateLimit"
import secondFactor as F from "./secondFactor"
type CodePurpose = SignInCode | LinkPhoneCode({ userId: str })
type CodeYield = SessionYield | SecondFactorYield | PhoneProofYield
type ChallengePhase = Unsent | Open | Locked | Consumed({ yields: CodeYield }) | Superseded | Expired
type Challenge = { method: SignInMethod, purpose: CodePurpose, clientId: str, phase: ChallengePhase, failures: int, sentAt: Millis, expiresAt: Millis, now: Millis }
type ChallengeEffect = DeliverCode({ method: SignInMethod, expiresAt: Millis }) | FirstSightOf({ method: SignInMethod }) | BeginSession | BeginSecondFactor
type ChallengeStep = { state: Challenge, out: List[ChallengeEffect] }
pure val codeLength: int = 6
pure val emailCodeLifetime: Millis = 10 * millisPerMinute
pure val smsCodeLifetime: Millis = 5 * millisPerMinute
pure val initial: Challenge = { method: EmailSignIn, purpose: SignInCode, clientId: "", phase: Unsent, failures: 0, sentAt: 0, expiresAt: 0, now: 0 }
pure def isCodeMethod(method: SignInMethod): bool = method == EmailSignIn or method == PhoneSignIn
pure def lifetimeOf(method: SignInMethod): Millis = if (method == PhoneSignIn) smsCodeLifetime else emailCodeLifetime
pure def purposeFits(method: SignInMethod, purpose: CodePurpose): bool = match purpose { | LinkPhoneCode(p) => method == PhoneSignIn and p.userId != "" | SignInCode => isCodeMethod(method) }
pure def sendAllowed(method: SignInMethod, purpose: CodePurpose, countryAllowed: bool): bool = purposeFits(method, purpose) and (method == PhoneSignIn implies countryAllowed)
pure def canSend(c: Challenge, method: SignInMethod, purpose: CodePurpose, clientId: str, countryAllowed: bool): bool = c.phase == Unsent and clientId != "" and sendAllowed(method, purpose, countryAllowed)
pure def send(c: Challenge, method: SignInMethod, purpose: CodePurpose, clientId: str, countryAllowed: bool): ChallengeStep = {
  val deadline = c.now + lifetimeOf(method)
  { state: { ...c, method: method, purpose: purpose, clientId: clientId, phase: Open, failures: 0, sentAt: c.now, expiresAt: deadline }, out: List(DeliverCode({ method: method, expiresAt: deadline })) }
}
pure def canElapse(c: Challenge, elapsed: Millis): bool = elapsed > 0
pure def elapse(c: Challenge, elapsed: Millis): Challenge = { ...c, now: c.now + elapsed }
pure val elapsedValues = Set(1, 60000, 300000, 600000)
pure val purposeValues = Set(SignInCode, LinkPhoneCode({ userId: "user1" }))
pure val clientIdValues = Set("", "app.one", "app.two")
pure def alwaysASentCodeFitsItsMethod(c: Challenge): bool =
  c.now >= 0 and (c.phase == Unsent implies c.failures == 0)
  and (c.phase != Unsent implies (purposeFits(c.method, c.purpose) and c.clientId != "" and c.sentAt <= c.now and c.expiresAt == c.sentAt + lifetimeOf(c.method)))
pure def stepOnlyANewChallengeDelivers(before: Challenge, via: str, after: Challenge, out: List[ChallengeEffect]): bool =
  out.includes(DeliverCode({ method: after.method, expiresAt: after.expiresAt })) iff (before.phase == Unsent and after.phase == Open)
pure def sometimesSmsCodeSent(c: Challenge): bool = c.phase == Open and c.method == PhoneSignIn and c.now < c.expiresAt
```

### Sending is limited per client address and per destination, and SMS by a deployment-wide hourly budget

The shell checks these with `shared/rateLimit` before `send` or `verify`,
all of one request in one transaction, and answers `429 rate_limited` with
the latest window end. The per-destination subject is a keyed digest of the
address or phone; the budget's subject is fixed for the deployment.

```quint
pure val emailSendPerIp: R::RateLimit = R::perMinute("codeEmailSendPerIp", 30)
pure val smsSendPerIp: R::RateLimit = R::perMinute("codeSmsSendPerIp", 5)
pure val sendPerDestination: R::RateLimit = R::perWindow("codeSendPerDestination", 5, 10 * millisPerMinute)
pure val smsSendBudget: R::RateLimit = R::perWindow("codeSmsSendBudget", 300, millisPerHour)
pure val verifyPerIp: R::RateLimit = R::perMinute("codeVerifyPerIp", 10)
pure val verifyPerDestination: R::RateLimit = R::perWindow("codeVerifyPerDestination", 5, 10 * millisPerMinute)
pure def sendLimits(method: SignInMethod): List[R::RateLimit] =
  if (method == PhoneSignIn) List(smsSendPerIp, sendPerDestination, smsSendBudget) else List(emailSendPerIp, sendPerDestination)
pure val verifyLimits: List[R::RateLimit] = List(verifyPerIp, verifyPerDestination)
```

### A new code for the same destination and purpose supersedes the open one

A superseded code is refused like an unknown one, even when it is right.

```quint
pure def canSupersede(c: Challenge): bool = c.phase == Open
pure def supersede(c: Challenge): Challenge = { ...c, phase: Superseded }
pure def sometimesSuperseded(c: Challenge): bool = c.phase == Superseded
```

### A code is consumed once, only while live, and only with the right code, verifier and client

The code, the PKCE verifier and the client id are checked together, so a
code read off a lock screen or an inbox is useless without the device that
asked for it.

```quint
pure def isLive(c: Challenge): bool = c.phase == Open and c.now < c.expiresAt
pure def isConsumed(p: ChallengePhase): bool = match p { | Consumed(x) => true | _ => false }
pure def yieldOfPhase(p: ChallengePhase): CodeYield = match p { | Consumed(x) => x.yields | _ => PhoneProofYield }
pure def isLink(purpose: CodePurpose): bool = match purpose { | LinkPhoneCode(p) => true | SignInCode => false }
pure def yieldOf(purpose: CodePurpose, factorOutcome: F::FirstFactorOutcome): CodeYield =
  if (isLink(purpose)) PhoneProofYield else if (factorOutcome == F::SecondFactorRequired) SecondFactorYield else SessionYield
pure def effectsOf(method: SignInMethod, y: CodeYield): List[ChallengeEffect] =
  if (y == SessionYield) List(FirstSightOf({ method: method }), BeginSession)
  else if (y == SecondFactorYield) List(FirstSightOf({ method: method }), BeginSecondFactor)
  else List()
pure val maxFailures: int = 5
pure def canVerify(c: Challenge): bool = isLive(c)
pure def verify(c: Challenge, clientId: str, codeMatches: bool, verifierMatches: bool, factorOutcome: F::FirstFactorOutcome): ChallengeStep = {
  val y = yieldOf(c.purpose, factorOutcome)
  if (codeMatches and verifierMatches and clientId == c.clientId)
    { state: { ...c, phase: Consumed({ yields: y }) }, out: effectsOf(c.method, y) }
  else { state: { ...c, failures: c.failures + 1, phase: if (c.failures + 1 >= maxFailures) Locked else Open }, out: List() }
}
pure val weight_verify = 4
pure def stepConsumedOnlyByARightCodeWhileLive(before: Challenge, via: str, after: Challenge, out: List[ChallengeEffect]): bool = {
  val consumes = not(isConsumed(before.phase)) and isConsumed(after.phase)
  consumes implies (via == "verify" and isLive(before) and after.clientId == before.clientId)
}
pure def stepAWrongCodeCountsOneFailure(before: Challenge, via: str, after: Challenge, out: List[ChallengeEffect]): bool =
  (via == "verify" and not(isConsumed(after.phase))) implies (after.failures == before.failures + 1 and out == List())
```

### A sign-in code yields a session, or a second-factor challenge for a person who has a factor, never both

`factorOutcome` is `secondFactor`'s `afterFirstFactor` of the factors of the
person `FirstSightOf` lands on (a new account has none). A session answers
`{status: "signed_in", user, organizationId, accessToken, accessExpiresAt,
refreshToken, refreshExpiresAt, mfaAt, accountCreated}`; a second factor
answers `{status: "mfa_required", challengeId, methods, expiresAt}`. A link
code yields only the proof that `signInMethods` consumes, and starts nothing.

```quint
pure def stepSignInStartsExactlyOneThing(before: Challenge, via: str, after: Challenge, out: List[ChallengeEffect]): bool = {
  val consumes = not(isConsumed(before.phase)) and isConsumed(after.phase)
  not(out.includes(BeginSession) and out.includes(BeginSecondFactor))
  and (consumes implies out == effectsOf(after.method, yieldOfPhase(after.phase)))
  and (not(consumes) implies not(out.includes(BeginSession) or out.includes(BeginSecondFactor) or out.includes(FirstSightOf({ method: after.method }))))
}
pure def alwaysYieldFitsPurpose(c: Challenge): bool = isConsumed(c.phase) implies ((yieldOfPhase(c.phase) == PhoneProofYield) iff isLink(c.purpose))
pure def sometimesSignedInByEmail(c: Challenge): bool = c.phase == Consumed({ yields: SessionYield }) and c.method == EmailSignIn
pure def sometimesSignedInByPhone(c: Challenge): bool = c.phase == Consumed({ yields: SessionYield }) and c.method == PhoneSignIn
pure def sometimesSecondFactorRequired(c: Challenge): bool = c.phase == Consumed({ yields: SecondFactorYield })
pure def sometimesSignedInAfterAWrongCode(c: Challenge): bool = isConsumed(c.phase) and c.failures >= 1
```

### A consumed link code proves the phone for the user who asked for it, and for no one else

```quint
pure def provesPhoneFor(c: Challenge, userId: str): bool = c.phase == Consumed({ yields: PhoneProofYield }) and c.purpose == LinkPhoneCode({ userId: userId })
pure def sometimesPhoneProven(c: Challenge): bool = provesPhoneFor(c, "user1")
```

## Story: Stop guessing at my code

> As a person, I want a code to stop working after a few wrong tries or when
> it expires, so that someone guessing six digits never gets in.

### Five wrong codes lock the challenge, and a locked challenge refuses even the right code

A locked challenge answers `403 access_denied` reason `challenge_locked`,
which os reads as too many attempts; only a new send opens another.

```quint
pure def alwaysLockedExactlyAtTheFailureLimit(c: Challenge): bool =
  c.failures >= 0 and c.failures <= maxFailures and ((c.phase == Locked) iff (c.failures == maxFailures))
pure def sometimesLocked(c: Challenge): bool = c.phase == Locked
```

### An open code past its lifetime is closed as expired

```quint
pure def canExpire(c: Challenge): bool = c.phase == Open and c.now >= c.expiresAt
pure def expire(c: Challenge): Challenge = { ...c, phase: Expired }
pure def sometimesExpired(c: Challenge): bool = c.phase == Expired
```

### A locked, consumed, superseded or expired challenge never changes again

```quint
pure def isEnded(p: ChallengePhase): bool = p == Locked or p == Superseded or p == Expired or isConsumed(p)
pure def stepEndedStaysEnded(before: Challenge, after: Challenge): bool =
  isEnded(before.phase) implies (after.phase == before.phase and after.failures == before.failures and after.expiresAt == before.expiresAt)
```

### A refused verify says the challenge is locked, expired or unknown, or the code is wrong, and never which check failed

The shell answers this of the state after the attempt. A wrong code, a
wrong verifier and a wrong client all answer `401 credential_proof_invalid`.

```quint
pure def refusalFor(p: ChallengePhase, pastDeadline: bool): Refusal =
  if (p == Locked) refuseFor(AccessDenied, ChallengeLocked)
  else if (p == Expired or (p == Open and pastDeadline)) refuseFor(AuthenticationRequired, CredentialExpired)
  else if (p != Open) refuseFor(AuthenticationRequired, CredentialUnknown)
  else refuse(CredentialProofInvalid)
pure def verifyRefusal(c: Challenge): Refusal = refusalFor(c.phase, c.now >= c.expiresAt)
pure val pValues = Set(Unsent, Open, Locked, Consumed({ yields: SessionYield }), Superseded, Expired)
pure def lawVerifyRefusalIsWellFormed(p: ChallengePhase, pastDeadline: bool): bool = {
  val r = refusalFor(p, pastDeadline)
  wellFormed(r) and not(isRetryable(r.code)) and ((r.reason == ChallengeLocked) iff (p == Locked))
}
```
