# Sign-in flow

The device half of sign-in: the plugin's one native sign-in slot and the
renderer requests it answers. A person signs in with an email code, an SMS
code or Google (the account picker, or the browser when the host selects
it), finishes a second factor when the cloud asks, and the device key is
then exchanged and kept by [the device credential](./credential.md). The
same flow re-authenticates the signed-in account for a billing change. The
cloud's halves are `spec/cloud/identity/{codeChallenges,secondFactor,federatedSignIn}.md`;
a browser return reaches this flow through [browser returns](./browserReturn.md).

Codes, PKCE verifiers, ID tokens, Google's one-use server code, keys and
sessions stay in the Java shell; the model sees attempt numbers, steps and
outcomes. The shell turns each cloud reply into a `CloudReply` (`signed_in`,
`mfa_required`, a refusal by code and reason, or no usable answer), carries
out `ConnectGoogle`, `AbandonExchange` (the credential's `signInEnded`) and
`HandSession` (the credential's `grantSession`), and answers each renderer
call with its `Settled` receipt.

The standalone Android account custodian offers email codes when its exact
native client registration advertises email sign-in. It keeps the pending
address and verifier in the existing native credential store and abandons it
on cancellation or replacement. It exchanges the temporary session for the
same account's device key, acknowledges the key before publishing sign-in,
and ends the temporary session. A host that lacks a second-factor screen
reports that additional verification is required and ends its local attempt.

## Story: Sign in with a code, Google or a second factor

> As a person signing in on the device, I want to use an email code, an SMS
> code or my Google account on the app's own screens, finish a second factor
> when my account has one, and be told plainly what went wrong, so that I
> am signed in once and never through a hosted page.

### A registration that is incomplete or ambiguous is refused when the plugin loads, and then nothing starts

The host gives its client id, environments (redirects, App Link host),
Google mode and Google scopes as data, checked once at load. A refused
registration leaves every call refused, never a hosted page. A release
build admits only production unless the host enables test environments.

```quint
import readiness.* from "./readiness"
import credential as C from "./credential"
import types as T from "../../cloud/shared/types"
type Environment = Production | Staging
type BuildKind = ReleaseBuild | DebugBuild
type Registration = { complete: bool, googleScopes: bool, testEnvironments: bool }
type Plugin = NotLoaded | Loaded({ googleScopes: bool, testEnvironments: bool }) | RegistrationRefused
type Purpose = SignInPurpose | ReauthPurpose({ account: C::Account })
type Stage = CodeStage | FactorStage | GoogleStage
type FailureCode = Cancelled | Busy | InvalidInput | WrongCode | Expired | TooManyAttempts | Unavailable | GoogleUnavailable | WrongAccount | Rejected
type SignInPhase = Idle | Sending({ fallback: int }) | CodeSent | Picking | Verifying({ stage: Stage }) | SecondFactor
  | Exchanging({ credentialAttempt: int }) | Connecting | SignedIn | Reauthenticated | Failed({ failure: FailureCode })
type ServerCode = NoServerCode | HeldCode | SpentCode | DroppedCode
type GoogleReport = GoogleNotRequested | GoogleConnected | GoogleRefused
type SignIn = { plugin: Plugin, lastRequest: int, open: int, lastAttempt: int, attempt: int, environment: Environment, method: SignInMethod,
  purpose: Purpose, phase: SignInPhase, serverCode: ServerCode, google: GoogleReport, credentialId: str }
pure val initial: SignIn = { plugin: NotLoaded, lastRequest: 0, open: 0, lastAttempt: 0, attempt: 0, environment: Production, method: EmailCode,
  purpose: SignInPurpose, phase: Idle, serverCode: NoServerCode, google: GoogleNotRequested, credentialId: "" }
pure def isLoaded(p: Plugin): bool = match p { | Loaded(l) => true | _ => false }
pure def admits(p: Plugin, environment: Environment): bool = match p { | Loaded(l) => environment == Production or l.testEnvironments | _ => false }
pure def scopesRegistered(p: Plugin): bool = match p { | Loaded(l) => l.googleScopes | _ => false }
pure def canLoad(s: SignIn): bool = s.plugin == NotLoaded
pure def load(s: SignIn, registration: Registration, build: BuildKind): SignIn =
  { ...s, plugin: if (registration.complete) Loaded({ googleScopes: registration.googleScopes, testEnvironments: registration.testEnvironments or build == DebugBuild }) else RegistrationRefused }
pure val registrationValues = Set({ complete: true, googleScopes: true, testEnvironments: false }, { complete: true, googleScopes: false, testEnvironments: true }, { complete: false, googleScopes: true, testEnvironments: true })
pure def alwaysNothingStartsWithoutARegistration(s: SignIn): bool = not(isLoaded(s.plugin)) implies (s.phase == Idle and s.lastAttempt == 0 and s.lastRequest == 0)
pure def alwaysAttemptInAnAdmittedEnvironment(s: SignIn): bool = s.phase != Idle implies admits(s.plugin, s.environment)
pure def sometimesRegistrationRefused(s: SignIn): bool = s.plugin == RegistrationRefused
pure def sometimesTestEnvironmentInUse(s: SignIn): bool = s.phase != Idle and s.environment == Staging
```

### A sign-in starts an offered method or an eligible browser fallback

Email and SMS send a code first; the picker opens Android's account
picker; the browser path waits for its return. A start may use the default
method or an explicitly admitted browser fallback. A start replaces a sign-in
that waits for the person, never one waiting for an answer.

```quint
pure def isBusy(phase: SignInPhase): bool = match phase { | Sending(x) => true | Picking => true | Verifying(v) => true | Exchanging(e) => true | Connecting => true | _ => false }
pure def firstStep(method: SignInMethod): SignInPhase = match method { | Google(g) => if (g.mode == Picker) Picking else Verifying({ stage: GoogleStage }) | _ => Sending({ fallback: 0 }) }
pure def opened(environment: Environment, method: SignInMethod, purpose: Purpose, s: SignIn): SignIn =
  { ...s, lastRequest: s.lastRequest + 1, open: s.lastRequest + 1, lastAttempt: s.lastAttempt + 1, attempt: s.lastAttempt + 1, environment: environment,
    method: method, purpose: purpose, phase: firstStep(method), serverCode: NoServerCode, google: GoogleNotRequested, credentialId: "" }
pure def canStart(s: SignIn, environment: Environment, method: SignInMethod, readiness: Readiness, device: DeviceFacts): bool =
  not(isBusy(s.phase)) and admits(s.plugin, environment) and canStartMethod(readiness, device, method)
pure def start(s: SignIn, environment: Environment, method: SignInMethod, readiness: Readiness, device: DeviceFacts): SignIn = opened(environment, method, SignInPurpose, s)
pure def isCodeMethod(method: SignInMethod): bool = method == EmailCode or method == SmsCode
pure def fitsMethod(phase: SignInPhase, method: SignInMethod): bool = match phase {
  | Sending(x) => isCodeMethod(method) | CodeSent => isCodeMethod(method) | Picking => method == Google({ mode: Picker })
  | Verifying(v) => if (v.stage == CodeStage) isCodeMethod(method) else if (v.stage == GoogleStage) not(isCodeMethod(method)) else true
  | _ => true }
pure def alwaysStepsFitTheMethod(s: SignIn): bool = fitsMethod(s.phase, s.method)
pure val weight_start = 3
```

### One renderer request is open at a time, it is open exactly while the slot waits for an answer, and only it is settled

Each call (start, resend, verify, reauthenticate) opens the next request;
a call while one is open is refused (`busy`). A request is settled once,
when the slot comes to rest, with its request and attempt numbers and a
verdict: the credential id and Google report, or one of ten failure codes.
The shell refuses malformed input (`invalid-input`) before the model; no
receipt carries a code, a verifier, a key or a session.

```quint
type Verdict = CodeOnItsWay | FactorAsked | SignedInAs({ credentialId: str, google: GoogleReport }) | AccountConfirmed
  | TryAgain({ retry: FailureCode }) | Ended({ problem: FailureCode })
type SignInEffect = Settled({ request: int, attempt: int, verdict: Verdict }) | ConnectGoogle | AbandonExchange({ abandoned: int })
  | HandSession({ account: C::Account, accessExpiresAt: T::Millis })
type SignInStep = { state: SignIn, out: List[SignInEffect] }
pure def unchanged(s: SignIn): SignInStep = { state: s, out: List() }
pure def rest(phase: SignInPhase, verdict: Verdict, s: SignIn): SignInStep =
  { state: { ...s, phase: phase, open: 0 }, out: List(Settled({ request: s.open, attempt: s.attempt, verdict: verdict })) }
pure def isSettled(e: SignInEffect): bool = match e { | Settled(x) => true | _ => false }
pure def settledRequest(e: SignInEffect): int = match e { | Settled(x) => x.request | _ => 0 }
pure def alwaysOneRequestOpenWhileWaiting(s: SignIn): bool = s.open >= 0 and s.open <= s.lastRequest and ((s.open != 0) iff isBusy(s.phase))
pure def alwaysAttemptsAreNumbered(s: SignIn): bool =
  s.attempt >= 0 and s.attempt <= s.lastAttempt and ((s.attempt == 0) iff (s.phase == Idle)) and fallbackOf(s.phase) >= 0 and fallbackOf(s.phase) < s.attempt + (if (s.attempt == 0) 1 else 0)
pure def stepOnlyTheOpenRequestIsSettled(before: SignIn, via: str, after: SignIn, out: List[SignInEffect]): bool = {
  val receipts = out.select(e => isSettled(e))
  receipts.length() <= 1 and ((receipts.length() == 1) iff (before.open != 0 and after.open == 0)) and receipts.every(e => settledRequest(e) == before.open)
}
```

### A wrong or unanswered code keeps the step, and a locked or rate-limited one ends the attempt as too many attempts

The cloud counts wrong codes. Its `401 credential_proof_invalid` asks for
the code again; no answer, or a passing outage, keeps the step too, because
the code may still be right. `403 access_denied` reason `challenge_locked`
and `429 rate_limited` end the attempt with `too-many-attempts`; an
expired, used or unknown challenge (`401` with a credential reason) ends it
as `expired`. A Google proof is never asked again: any refusal ends it.

```quint
type CloudReply = Delivered | Authenticated({ userId: str, credentialAttempt: int, accessExpiresAt: T::Millis, google: GoogleReport })
  | FactorRequired | Refused({ code: T::RefusalCode, reason: T::RefusalReason }) | Unanswered
pure def failureOf(checkingCode: bool, code: T::RefusalCode, reason: T::RefusalReason): FailureCode =
  if (code == T::RateLimited or (code == T::AccessDenied and reason == T::ChallengeLocked)) TooManyAttempts
  else if (code == T::AuthenticationRequired) Expired
  else if (code == T::CredentialProofInvalid and checkingCode) WrongCode
  else if (code == T::ProviderUnavailable) GoogleUnavailable
  else if (T::isRetryable(code)) Unavailable
  else Rejected
pure def endedState(failure: FailureCode, s: SignIn): SignIn =
  { ...s, phase: Failed({ failure: failure }), open: 0, serverCode: if (s.serverCode == HeldCode) DroppedCode else s.serverCode,
    google: if (s.serverCode == HeldCode) GoogleRefused else s.google }
pure def endWith(failure: FailureCode, s: SignIn): SignInStep =
  { state: endedState(failure, s), out: List(Settled({ request: s.open, attempt: s.attempt, verdict: Ended({ problem: failure }) })) }
pure def checkRefused(stage: Stage, failure: FailureCode, s: SignIn): SignInStep =
  if (stage != GoogleStage and (failure == WrongCode or failure == Unavailable)) rest(if (stage == FactorStage) SecondFactor else CodeSent, TryAgain({ retry: failure }), s)
  else endWith(failure, s)
pure def canVerify(s: SignIn, attempt: int): bool = attempt == s.attempt and (s.phase == CodeSent or s.phase == SecondFactor)
pure def verify(s: SignIn, attempt: int): SignIn =
  { ...s, lastRequest: s.lastRequest + 1, open: s.lastRequest + 1, phase: Verifying({ stage: if (s.phase == SecondFactor) FactorStage else CodeStage }) }
pure def lawPassingTroubleIsNeverThePersonsFault(checkingCode: bool, code: T::RefusalCode, reason: T::RefusalReason): bool = {
  val failure = failureOf(checkingCode, code, reason)
  T::isRetryable(code) implies (failure == TooManyAttempts or failure == Unavailable or failure == GoogleUnavailable) }
pure val attemptValues = Set(1, 2, 3)
pure val weight_verify = 3
pure def sometimesTooManyAttempts(s: SignIn): bool = s.phase == Failed({ failure: TooManyAttempts })
```

### A code is sent before it is asked for, and the cloud's answer moves the attempt on

An answer to a code or a factor starts the key exchange, asks for a
second factor (the device half of the cloud's challenge, which Google's
picker may also ask for), or is refused as above.

```quint
pure def fallbackOf(phase: SignInPhase): int = match phase { | Sending(x) => x.fallback | _ => 0 }
pure def isRefusal(reply: CloudReply): bool = match reply { | Refused(r) => true | _ => false }
pure def authenticatedFits(reply: CloudReply): bool = match reply { | Authenticated(a) => a.userId != "" and a.credentialAttempt >= 1 and a.accessExpiresAt > 0 | _ => true }
pure def replyFits(phase: SignInPhase, reply: CloudReply): bool = match phase {
  | Sending(x) => reply == Delivered or reply == Unanswered or isRefusal(reply)
  | Verifying(v) => reply != Delivered and authenticatedFits(reply)
  | _ => false }
pure def sendFailed(fallback: int, failure: FailureCode, s: SignIn): SignInStep =
  if (fallback >= 1) { state: { ...s, attempt: fallback, phase: CodeSent, open: 0 }, out: List(Settled({ request: s.open, attempt: fallback, verdict: TryAgain({ retry: failure }) })) }
  else endWith(failure, s)
pure def sendAnswered(fallback: int, reply: CloudReply, s: SignIn): SignInStep = match reply {
  | Delivered => rest(CodeSent, CodeOnItsWay, s)
  | Refused(r) => sendFailed(fallback, failureOf(false, r.code, r.reason), s)
  | Unanswered => sendFailed(fallback, Unavailable, s)
  | _ => unchanged(s) }
pure def checkAnswered(stage: Stage, reply: CloudReply, s: SignIn): SignInStep = match reply {
  | Authenticated(a) => authenticated(stage, a.userId, a.credentialAttempt, a.accessExpiresAt, a.google, s)
  | FactorRequired => rest(SecondFactor, FactorAsked, s)
  | Refused(r) => checkRefused(stage, failureOf(stage != GoogleStage, r.code, r.reason), s)
  | Unanswered => checkRefused(stage, Unavailable, s)
  | Delivered => unchanged(s) }
pure def canCloudAnswered(s: SignIn, attempt: int, reply: CloudReply): bool = attempt >= 1 and attempt == s.attempt and replyFits(s.phase, reply)
pure def cloudAnswered(s: SignIn, attempt: int, reply: CloudReply): SignInStep = {
  val phase = s.phase
  match phase { | Sending(x) => sendAnswered(x.fallback, reply, s) | Verifying(v) => checkAnswered(v.stage, reply, s) | _ => unchanged(s) } }
pure val replyValues = Set(Delivered, FactorRequired, Unanswered,
  Authenticated({ userId: "u1", credentialAttempt: 1, accessExpiresAt: 900000, google: GoogleConnected }),
  Authenticated({ userId: "u2", credentialAttempt: 2, accessExpiresAt: 900000, google: GoogleRefused }),
  Refused({ code: T::CredentialProofInvalid, reason: T::NoReason }), Refused({ code: T::AccessDenied, reason: T::ChallengeLocked }),
  Refused({ code: T::RateLimited, reason: T::NoReason }), Refused({ code: T::AuthenticationRequired, reason: T::CredentialExpired }),
  Refused({ code: T::ServiceUnavailable, reason: T::NoReason }), Refused({ code: T::ProviderUnavailable, reason: T::NoReason }))
pure val weight_cloudAnswered = 5
pure def sometimesSecondFactorAsked(s: SignIn): bool = s.phase == SecondFactor
```

### The person is signed in only when the credential has the new key acknowledged

A `signed_in` answer starts the credential's exchange under the attempt
number the shell passes in; a refused token or acknowledgement ends the
sign-in as `expired`.

```quint
type KeyOutcome = KeyAcknowledged({ credentialId: str }) | KeyRefused
pure def authenticated(stage: Stage, userId: str, credentialAttempt: int, accessExpiresAt: T::Millis, google: GoogleReport, s: SignIn): SignInStep = {
  val p = s.purpose
  val redeemed = stage == GoogleStage and s.serverCode == HeldCode
  match p {
    | ReauthPurpose(r) => if (userId == r.account.userId)
        { state: { ...s, phase: Reauthenticated, open: 0 }, out: List(Settled({ request: s.open, attempt: s.attempt, verdict: AccountConfirmed }), HandSession({ account: r.account, accessExpiresAt: accessExpiresAt })) }
      else endWith(WrongAccount, s)
    | SignInPurpose => { state: { ...s, phase: Exchanging({ credentialAttempt: credentialAttempt }), serverCode: if (redeemed) SpentCode else s.serverCode,
        google: if (redeemed) (if (google == GoogleConnected) GoogleConnected else GoogleRefused) else s.google }, out: List() }
  } }
pure def keyNamed(key: KeyOutcome): bool = match key { | KeyAcknowledged(k) => k.credentialId != "" | KeyRefused => true }
pure def canExchangeSettled(s: SignIn, credentialAttempt: int, key: KeyOutcome): bool = s.phase == Exchanging({ credentialAttempt: credentialAttempt }) and keyNamed(key)
pure def exchangeSettled(s: SignIn, credentialAttempt: int, key: KeyOutcome): SignInStep = match key {
  | KeyAcknowledged(k) => if (s.serverCode == HeldCode) { state: { ...s, phase: Connecting, serverCode: SpentCode, credentialId: k.credentialId }, out: List(ConnectGoogle) }
      else rest(SignedIn, SignedInAs({ credentialId: k.credentialId, google: s.google }), { ...s, credentialId: k.credentialId })
  | KeyRefused => endWith(Expired, s) }
pure val credentialAttemptValues = Set(1, 2)
pure val keyValues = Set(KeyAcknowledged({ credentialId: "c1" }), KeyRefused)
pure val weight_exchangeSettled = 3
pure def alwaysExchangeHasAnAttempt(s: SignIn): bool = { val phase = s.phase  match phase { | Exchanging(e) => e.credentialAttempt >= 1 and s.purpose == SignInPurpose | _ => true } }
pure def alwaysSignedInHasACredential(s: SignIn): bool = (s.phase == SignedIn or s.phase == Connecting) implies (s.credentialId != "" and s.purpose == SignInPurpose)
pure def sometimesSignedInWithACode(s: SignIn): bool = s.phase == SignedIn and isCodeMethod(s.method)
pure def sometimesSignedInWithGoogleInTheBrowser(s: SignIn): bool = s.phase == SignedIn and s.method == Google({ mode: Browser })
```

## Story: Connect my Google mail and calendar with the same sign-in

> As a person signing in with my Google account, I want the app to connect
> the mail and calendar access its host asks for in the same sign-in, and
> my sign-in to succeed even when that connection does not.

### Google's one-use server code is asked for only under the host's registered scopes, and is held in memory until it is redeemed or dropped

With scopes registered the picker asks Google for exactly those; the
granted code travels with `POST /api/v1/app-auth/mobile/google`, which
redeems it when it signs the person in. A declined grant reports Google
refused. A second factor keeps the code; a refusal, expiry or cancel drops it.

```quint
type PickerResult = Picked({ granted: bool }) | PickerDismissed | NoGoogleAccount
pure def canPickerAnswered(s: SignIn, attempt: int, picked: PickerResult): bool = attempt == s.attempt and s.phase == Picking
pure def pickerAnswered(s: SignIn, attempt: int, picked: PickerResult): SignInStep = match picked {
  | Picked(p) => { state: { ...s, phase: Verifying({ stage: GoogleStage }), serverCode: if (scopesRegistered(s.plugin) and p.granted) HeldCode else NoServerCode,
      google: if (scopesRegistered(s.plugin) and not(p.granted)) GoogleRefused else GoogleNotRequested }, out: List() }
  | PickerDismissed => endWith(Cancelled, s)
  | NoGoogleAccount => endWith(GoogleUnavailable, s) }
pure val pickedValues = Set(Picked({ granted: true }), Picked({ granted: false }), PickerDismissed, NoGoogleAccount)
pure val weight_pickerAnswered = 3
pure def scopedPicker(s: SignIn): bool = scopesRegistered(s.plugin) and s.method == Google({ mode: Picker }) and s.purpose == SignInPurpose
pure def holdsCode(phase: SignInPhase): bool = match phase { | Verifying(v) => v.stage != CodeStage | SecondFactor => true | Exchanging(e) => true | _ => false }
pure def alwaysServerCodeOnlyUnderScopes(s: SignIn): bool =
  (s.serverCode != NoServerCode implies scopedPicker(s)) and (s.serverCode == HeldCode implies (holdsCode(s.phase) and s.google == GoogleNotRequested))
    and (s.phase == Picking implies s.serverCode == NoServerCode) and (s.phase == Connecting implies s.serverCode == SpentCode)
pure def alwaysGoogleReportedOnlyWhenAsked(s: SignIn): bool = s.google != GoogleNotRequested implies scopedPicker(s)
```

### After a second factor the held code is sent once, with the new key, only after the cloud acknowledged it

`POST /api/v1/eliza/google/connect/native` carries the held code,
authorised by the acknowledged key; a key never acknowledged drops it. A
spent or dropped code stays so for the rest of its attempt.

```quint
pure def stepServerCodeRedeemedAtMostOnce(before: SignIn, via: str, after: SignIn, out: List[SignInEffect]): bool =
  (out.includes(ConnectGoogle) implies (before.serverCode == HeldCode and after.serverCode == SpentCode))
    and ((after.attempt == before.attempt and (before.serverCode == SpentCode or before.serverCode == DroppedCode)) implies after.serverCode == before.serverCode)
pure def sometimesConnectingAfterSecondFactor(s: SignIn): bool = s.phase == Connecting
```

### A Google refusal never fails the sign-in, and a scoped picker sign-in always says what became of Google

The receipt reports `google` as connected, refused or not requested; any
answer to the connect call, or none, signs the person in.

```quint
pure def canGoogleConnected(s: SignIn, attempt: int, connected: bool): bool = attempt == s.attempt and s.phase == Connecting
pure def googleConnected(s: SignIn, attempt: int, connected: bool): SignInStep = {
  val report = if (connected) GoogleConnected else GoogleRefused
  rest(SignedIn, SignedInAs({ credentialId: s.credentialId, google: report }), { ...s, google: report }) }
pure def pastPicker(phase: SignInPhase): bool = match phase { | Verifying(v) => true | SecondFactor => true | Exchanging(e) => true | SignedIn => true | _ => false }
pure def alwaysScopedPickerReportsGoogle(s: SignIn): bool = (scopedPicker(s) and pastPicker(s.phase)) implies (s.serverCode == HeldCode or s.google != GoogleNotRequested)
pure def stepGoogleNeverFailsSignIn(before: SignIn, after: SignIn): bool = before.phase == Connecting implies (after.phase == Connecting or after.phase == SignedIn)
pure def sometimesSignedInWithGoogleConnected(s: SignIn): bool = s.phase == SignedIn and s.google == GoogleConnected
pure def sometimesSignedInThoughGoogleRefused(s: SignIn): bool = s.phase == SignedIn and s.google == GoogleRefused
```

## Story: Cancel or resend exactly the request I mean

> As a person who asks for a new code or leaves sign-in, I want the code I
> type checked against the code on my screen, and a cancel to end only my
> own sign-in, never a newer one another screen started.

### A resend opens a new attempt, and a resend the cloud did not take leaves the earlier code in use

Verify and cancel name the attempt they mean; only the attempt that owns
the slot is verified. While a resend is on its way, a cancel naming either
the new or the earlier attempt ends both.

```quint
pure def canResend(s: SignIn, attempt: int): bool = attempt == s.attempt and s.phase == CodeSent
pure def resend(s: SignIn, attempt: int): SignIn =
  { ...s, lastRequest: s.lastRequest + 1, open: s.lastRequest + 1, lastAttempt: s.lastAttempt + 1, attempt: s.lastAttempt + 1, phase: Sending({ fallback: s.attempt }) }
pure def sometimesResendInFlight(s: SignIn): bool = fallbackOf(s.phase) >= 1
pure def sometimesEarlierCodeKeptAfterRefusedResend(s: SignIn): bool = s.phase == CodeSent and s.attempt < s.lastAttempt
```

### A cancel retires only its own attempt, abandons its key exchange, and a stale cancel changes nothing

A cancel of the owning attempt settles the open request as `cancelled`,
drops a held server code, empties the slot and, during the key exchange,
asks the credential to end it. A cancel naming an earlier attempt, or after
the sign-in ended, changes nothing; one already connecting Google cannot be
cancelled.

```quint
pure def cancellable(phase: SignInPhase): bool = match phase { | Idle => false | Connecting => false | SignedIn => false | Reauthenticated => false | Failed(f) => false | _ => true }
pure def ownsCancel(s: SignIn, attempt: int): bool = cancellable(s.phase) and (attempt == s.attempt or (fallbackOf(s.phase) >= 1 and attempt == fallbackOf(s.phase)))
pure def abandonedOf(phase: SignInPhase): int = match phase { | Exchanging(e) => e.credentialAttempt | _ => 0 }
pure def canCancel(s: SignIn, attempt: int): bool = attempt >= 1 and attempt <= s.lastAttempt
pure def cancel(s: SignIn, attempt: int): SignInStep =
  if (not(ownsCancel(s, attempt))) unchanged(s)
  else { state: { ...endedState(Cancelled, s), phase: Idle, attempt: 0 },
    out: (if (s.open != 0) List(Settled({ request: s.open, attempt: s.attempt, verdict: Ended({ problem: Cancelled }) })) else List())
      .concat(if (abandonedOf(s.phase) >= 1) List(AbandonExchange({ abandoned: abandonedOf(s.phase) })) else List()) }
pure def stepCancelRetiresTheSlotOrNothing(before: SignIn, via: str, after: SignIn): bool =
  via == "cancel" implies (after == before or (cancellable(before.phase) and after.phase == Idle and after.lastAttempt == before.lastAttempt))
pure val weight_cancel = 2
pure def sometimesCancelled(s: SignIn): bool = s.phase == Idle and s.lastAttempt >= 1
```

### An attempt waiting for the person ends as expired when its deadline passes

The shell's timer names the attempt; an attempt waiting for an answer
waits for it.

```quint
pure def canExpire(s: SignIn, attempt: int): bool = attempt == s.attempt and (s.phase == CodeSent or s.phase == SecondFactor)
pure def expire(s: SignIn, attempt: int): SignIn = endedState(Expired, s)
pure def sometimesExpired(s: SignIn): bool = s.phase == Failed({ failure: Expired })
```

## Story: Re-authenticate the signed-in account

> As an account owner about to change billing, I want to confirm it is me
> with a fresh code or Google in the browser, so that the change is made
> only by the account signed in on this device.

### Re-authentication verifies only the signed-in account, by email code, SMS code or browser Google, and hands the session to the credential

The shell passes the credential's account. The picker is not offered: its
one call answers with a device key, not a session. A session for another
user ends the attempt as `wrong-account`; the matching one is handed to the
credential as its in-memory account session.

```quint
pure def canReauthenticate(s: SignIn, environment: Environment, method: SignInMethod, readiness: Readiness, device: DeviceFacts, account: C::Account): bool =
  canStart(s, environment, method, readiness, device) and method != Google({ mode: Picker }) and account.userId != ""
pure def reauthenticate(s: SignIn, environment: Environment, method: SignInMethod, readiness: Readiness, device: DeviceFacts, account: C::Account): SignIn =
  opened(environment, method, ReauthPurpose({ account: account }), s)
pure def alwaysReauthenticationStaysWithTheAccount(s: SignIn): bool = { val p = s.purpose  match p {
  | ReauthPurpose(r) => r.account.userId != "" and s.method != Google({ mode: Picker }) and s.phase != SignedIn and s.phase != Connecting
  | SignInPurpose => s.phase != Reauthenticated } }
pure def handsOwnAccount(e: SignInEffect, before: SignIn, after: SignIn): bool = match e {
  | HandSession(h) => before.purpose == ReauthPurpose({ account: h.account }) and after.phase == Reauthenticated | _ => true }
pure def stepSessionOnlyForTheSignedInAccount(before: SignIn, via: str, after: SignIn, out: List[SignInEffect]): bool = out.every(e => handsOwnAccount(e, before, after))
pure val weight_reauthenticate = 2
pure def sometimesReauthenticated(s: SignIn): bool = s.phase == Reauthenticated
pure def sometimesWrongAccountRefused(s: SignIn): bool = s.phase == Failed({ failure: WrongAccount })
```
