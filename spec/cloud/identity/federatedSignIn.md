# Google sign-in

Signing in with Google, the server half: in the browser with an
authorization code, or on the phone with its own Google account and a
one-time challenge. Sources: develop `packages/auth/src/server/api/routes/auth.ts`
(`/oauth/*`, `/oauth/google/native/*`), `oauth-app-error-return.ts`, the
Quint models `OAuthAppLinkRedemption.qnt` and `NativeGoogleAdmission.qnt`,
and the service half of the old `spec/auth/googleSignIn.md`. The device half
is `spec/os/signIn/flow.md`.

Routes under `/api/v1/auth/google/`: `GET authorize` (query `response_type,
client_id, environment, redirect_uri, code_challenge, code_challenge_method,
state`) redirects to Google; `GET callback` redirects to
`<redirect_uri>#code=<code>&state=<state>` or `#error=<error>&state=<state>`;
`POST exchange` `{code, redirectUri, clientId, codeVerifier}` answers as a
code sign-in does (`codeChallenges`); `POST native/challenge` `{clientId,
environment, redirectUri, codeChallenge, codeChallengeMethod}` answers
`{challengeId, nonce, serverClientId, expiresAt}`. The session route `POST
/api/v1/user/methods/google/challenge` opens a link challenge. A challenge is
answered inside `POST /api/v1/app-auth/mobile/google` (`nativeClients/deviceKeys`)
or `POST /api/v1/user/methods/google/link` (`signInMethods`).

One machine instance is one attempt row: a browser attempt or a native
challenge, never both. The shell draws state, code, challenge id and nonce at
random, stores only digests of the code and of the device's S256 challenge,
and passes every check in as an observation. Google's `email_verified` goes
unchanged to `accounts`' first sight. An unknown state, code or challenge id
is answered before this machine.

## Story: Sign in with Google in the browser

> As a person, I want to sign in with my Google account in the browser and
> come back to the app that sent me, so that only that app, holding its own
> verifier, can finish my sign-in, and only once.

### Authorize is admitted only with response_type code, S256, a state and the exact sign-in return of an enabled registration of this environment, and the attempt lives five minutes

A refused request is answered at once, stores nothing and is final: a
malformed one `400 invalid_request`, a client fault as `nativeClients/registry`
names it. With Google off the attempt ends before it is stored, answered
`503 provider_unavailable` reason `google_not_configured`.

```quint
import types.* from "../shared/types"
import oauth as O from "../../core/oauth"
import registry as N from "../nativeClients/registry"
import secondFactor as F from "./secondFactor"
type ResponseType = CodeResponse | OtherResponse
type PkceMethod = S256 | PlainMethod
type AuthorizeRequest = { responseType: ResponseType, method: PkceMethod, client: N::ClientCheck, hasState: bool }
type ReturnError = ErrAccessDenied | ErrAuthenticationFailed | ErrCallbackIncomplete | ErrIdentityIncomplete | ErrProviderUnavailable | ErrRedirectInvalid | ErrStateConsumed | ErrStateExpired | ErrStateInvalid | ErrTokenExchangeFailed
type Failure = NoFailure | FailedWith({ cause: ReturnError })
type ReturnTarget = AppReturnUrl | CloudPage
type AppReturn = NotReturned | ReturnsCode | ReturnsError({ error: ReturnError })
type SignInYield = SessionYield | SecondFactorYield | DeviceKeyYield | GoogleProofYield
type CodePhase = NoCode | CodeIssued({ redeemBy: Millis }) | CodeRedeemed({ redeemedAs: SignInYield }) | CodeExpired
type NativePurpose = NativeSignIn | NativeLink({ userId: str })
type NativePhase = NoChallenge | ChallengeOpen({ purpose: NativePurpose, openUntil: Millis }) | ChallengeUsed({ purpose: NativePurpose, usedAs: SignInYield }) | ChallengeExpired
type GoogleAttempt = { flow: O::OAuthFlow, stateExpiresAt: Millis, failure: Failure, target: ReturnTarget, returned: AppReturn, code: CodePhase, native: NativePhase, now: Millis }
type SignInEffect = FirstSightOfGoogle | BeginSession | BeginSecondFactor | MintDeviceKey
type AttemptStep = { state: GoogleAttempt, out: List[SignInEffect] }
pure val stateLifetime: Millis = 5 * millisPerMinute
pure val initial: GoogleAttempt = { flow: O::initial, stateExpiresAt: 0, failure: NoFailure, target: AppReturnUrl, returned: NotReturned, code: NoCode, native: NoChallenge, now: 0 }
pure def wellShaped(r: AuthorizeRequest): bool = r.responseType == CodeResponse and r.method == S256 and r.hasState
pure def authorizeAdmitted(r: AuthorizeRequest): bool = wellShaped(r) and r.client == N::ClientAdmitted
pure def authorizeRefusal(r: AuthorizeRequest): Refusal =
  if (not(wellShaped(r))) refuse(InvalidRequest)
  else if (r.client == N::ClientRefused({ fault: N::UnknownClient })) N::faultRefusal(N::UnknownClient)
  else if (r.client == N::ClientRefused({ fault: N::DisabledClient })) N::faultRefusal(N::DisabledClient)
  else N::faultRefusal(N::WrongRedirect)
pure def canBegin(a: GoogleAttempt, authorize: AuthorizeRequest): bool = a.flow.phase == O::FlowIdle and a.native == NoChallenge and authorizeAdmitted(authorize)
pure def begin(a: GoogleAttempt, supported: bool, authorize: AuthorizeRequest): GoogleAttempt =
  { ...a, flow: O::begin(a.flow, supported), stateExpiresAt: a.now + stateLifetime }
pure def canElapse(a: GoogleAttempt, elapsed: Millis): bool = elapsed > 0
pure def elapse(a: GoogleAttempt, elapsed: Millis): GoogleAttempt = { ...a, now: a.now + elapsed }
pure val elapsedValues = Set(1, 60000, 300000)
pure val authorizeValues: Set[AuthorizeRequest] = {
  val ok: AuthorizeRequest = { responseType: CodeResponse, method: S256, client: N::ClientAdmitted, hasState: true }
  Set(ok, { ...ok, method: PlainMethod }, { ...ok, hasState: false }, { ...ok, client: N::ClientRefused({ fault: N::WrongRedirect }) })
}
pure def lawAnAuthorizeRefusalIsFinal(authorize: AuthorizeRequest): bool =
  not(authorizeAdmitted(authorize)) implies (wellFormed(authorizeRefusal(authorize)) and not(retryableOf(authorizeRefusal(authorize))))
pure def sometimesAwaitingGoogle(a: GoogleAttempt): bool = a.flow.phase == O::AwaitingCallback and a.now < a.stateExpiresAt
```

### Every step of a browser attempt is a step of core's OAuth flow

So the attempt is stored before the Google URL is built, a callback consumes
it once and before Google's token exchange, and a failed write after a
failure keeps both causes (`spec/core/oauth/index.md`). Google's PKCE
verifier is always required. Nothing is compensated: storing the verified
identity is one row write.

```quint
pure def refinesO(a: GoogleAttempt): O::OAuthFlow = a.flow
pure def canCreateResult(a: GoogleAttempt): bool = O::canCreateResult(a.flow)
pure def createResult(a: GoogleAttempt, success: bool): GoogleAttempt = { ...a, flow: O::createResult(a.flow, success) }
pure def canStartProviderResult(a: GoogleAttempt): bool = O::canStartProviderResult(a.flow)
pure def startProviderResult(a: GoogleAttempt, success: bool): GoogleAttempt = { ...a, flow: O::startProviderResult(a.flow, success) }
pure def canWriteStart(a: GoogleAttempt): bool = O::canWriteStart(a.flow)
pure def writeStart(a: GoogleAttempt, write: O::FlowWrite): GoogleAttempt = { ...a, flow: O::writeStart(a.flow, write) }
pure def canBeginCallback(a: GoogleAttempt, verifierRequired: bool): bool = O::canBeginCallback(a.flow) and verifierRequired
pure def beginCallback(a: GoogleAttempt, verifierPresent: bool, verifierRequired: bool): GoogleAttempt = { ...a, flow: O::beginCallback(a.flow, verifierPresent, verifierRequired) }
pure def canCompensate(a: GoogleAttempt, supported: bool): bool = O::canCompensate(a.flow) and not(supported)
pure def compensate(a: GoogleAttempt, supported: bool, success: bool): GoogleAttempt = { ...a, flow: O::compensate(a.flow, supported, success) }
pure val verifierRequiredValues = Set(true)
pure val weight_createResult = 3
pure val weight_startProviderResult = 3
pure val weight_writeStart = 3
pure val weight_beginCallback = 3
```

### A callback returns a one-minute code only after Google's verified identity and the code are stored, and otherwise one error of the closed list

The callback takes the attempt only while its five minutes last. Google's
`error` answers `access_denied`, a callback without code or state
`oauth_callback_incomplete`, a lost Google verifier `oauth_state_invalid`,
an expired attempt `oauth_state_expired`, Google switched off since
`oauth_provider_unavailable`, a failed token exchange or profile read
`oauth_token_exchange_failed`, an identity without a subject
`oauth_identity_incomplete`, and a failed identity or attempt write
`oauth_authentication_failed`. A later callback for the same state answers
`lateCallbackError`. The list is closed and shared with os, which adds only
`app_link_unverified` (`returnPages`). A second factor travels in the code,
never in the return, so this cloud never returns develop's `mfa_required`.

A return withdrawn since authorize (the registration was disabled or
changed) is never visited: `oauth_redirect_invalid` is shown on a page of
the cloud.

```quint
type GoogleCallback = GoogleCode | GoogleDenied | GoogleIncomplete | ReturnWithdrawn
type GoogleAnswer = IdentityVerified | IdentityIncomplete | TokenExchangeFailed
pure val codeLifetime: Millis = 60 * millisPerSecond
pure def returnErrorCode(e: ReturnError): str =
  if (e == ErrAccessDenied) "access_denied" else if (e == ErrAuthenticationFailed) "oauth_authentication_failed"
  else if (e == ErrCallbackIncomplete) "oauth_callback_incomplete" else if (e == ErrIdentityIncomplete) "oauth_identity_incomplete"
  else if (e == ErrProviderUnavailable) "oauth_provider_unavailable" else if (e == ErrRedirectInvalid) "oauth_redirect_invalid"
  else if (e == ErrStateConsumed) "oauth_state_consumed" else if (e == ErrStateExpired) "oauth_state_expired"
  else if (e == ErrStateInvalid) "oauth_state_invalid" else "oauth_token_exchange_failed"
pure def callbackError(callback: GoogleCallback): ReturnError = if (callback == GoogleDenied) ErrAccessDenied else if (callback == GoogleIncomplete) ErrCallbackIncomplete else if (callback == ReturnWithdrawn) ErrRedirectInvalid else ErrStateInvalid
pure def causeOf(f: Failure): ReturnError = match f { | FailedWith(x) => x.cause | NoFailure => ErrAuthenticationFailed }
pure def canConsume(a: GoogleAttempt, pendingAndUnexpired: bool, inputError: bool, callback: GoogleCallback): bool =
  O::canConsume(a.flow) and pendingAndUnexpired == (a.now < a.stateExpiresAt) and inputError == (callback != GoogleCode)
pure def consume(a: GoogleAttempt, pendingAndUnexpired: bool, inputError: bool, providerInstalled: bool, callback: GoogleCallback): GoogleAttempt = {
  val flow = O::consume(a.flow, pendingAndUnexpired, inputError, providerInstalled)
  { ...a, flow: flow, target: if (callback == ReturnWithdrawn) CloudPage else AppReturnUrl,
    failure: if (flow.phase == O::FailureWritePending) FailedWith({ cause: callbackError(callback) }) else a.failure,
    returned: if (flow.phase != O::FlowThrown) a.returned else ReturnsError({ error: if (flow.consumed) ErrProviderUnavailable else ErrStateExpired }) }
}
pure def canProviderResult(a: GoogleAttempt, success: bool, hasAccount: bool, answer: GoogleAnswer): bool =
  O::canProviderResult(a.flow) and hasAccount and (success iff answer == IdentityVerified)
pure def providerResult(a: GoogleAttempt, success: bool, hasAccount: bool, answer: GoogleAnswer): GoogleAttempt =
  { ...a, flow: O::providerResult(a.flow, success, hasAccount), failure: if (success) a.failure else FailedWith({ cause: if (answer == IdentityIncomplete) ErrIdentityIncomplete else ErrTokenExchangeFailed }) }
pure def canAccountResult(a: GoogleAttempt): bool = O::canAccountResult(a.flow)
pure def accountResult(a: GoogleAttempt, success: bool): GoogleAttempt =
  { ...a, flow: O::accountResult(a.flow, success), failure: if (success) a.failure else FailedWith({ cause: ErrAuthenticationFailed }) }
pure def canWriteFailure(a: GoogleAttempt): bool = O::canWriteFailure(a.flow)
pure def writeFailure(a: GoogleAttempt, write: O::FlowWrite): GoogleAttempt = { ...a, flow: O::writeFailure(a.flow, write), returned: ReturnsError({ error: causeOf(a.failure) }) }
pure def canWriteSuccess(a: GoogleAttempt, selectedStatus: O::FlowState): bool = O::canWriteSuccess(a.flow) and selectedStatus == O::CompletedState
pure def writeSuccess(a: GoogleAttempt, write: O::FlowWrite, selectedStatus: O::FlowState): GoogleAttempt = {
  val issued = write == O::WriteAcknowledged
  { ...a, flow: O::writeSuccess(a.flow, write, selectedStatus), code: if (issued) CodeIssued({ redeemBy: a.now + codeLifetime }) else NoCode,
    returned: if (issued) ReturnsCode else ReturnsError({ error: ErrAuthenticationFailed }) }
}
pure def lateCallbackError(a: GoogleAttempt): ReturnError = if (a.flow.consumed) ErrStateConsumed else if (a.now >= a.stateExpiresAt) ErrStateExpired else ErrStateInvalid
pure val hasAccountValues = Set(true)
pure val selectedStatusValues = Set(O::CompletedState)
pure val weight_consume = 3
pure val weight_providerResult = 3
pure val weight_accountResult = 3
pure val weight_writeSuccess = 3
pure def alwaysACodeFollowsAVerifiedIdentity(a: GoogleAttempt): bool =
  ((a.code != NoCode) iff (a.returned == ReturnsCode))
  and (a.code != NoCode implies (a.flow.phase == O::FlowReturned and a.flow.consumed and a.flow.accountStored and a.target == AppReturnUrl))
  and ((a.flow.phase == O::ProviderPending or a.flow.phase == O::AccountPending or a.flow.phase == O::SuccessWritePending) implies (a.flow.consumed and a.target == AppReturnUrl))
  and (a.flow.phase == O::SuccessWritePending implies a.flow.accountStored)
pure def lawEveryReturnErrorHasItsOwnCode(e: ReturnError, other: ReturnError): bool = returnErrorCode(e) == returnErrorCode(other) implies e == other
pure def sometimesCodeReturned(a: GoogleAttempt): bool = a.returned == ReturnsCode
pure def sometimesDeniedByThePerson(a: GoogleAttempt): bool = a.returned == ReturnsError({ error: ErrAccessDenied })
pure def sometimesAttemptExpired(a: GoogleAttempt): bool = a.returned == ReturnsError({ error: ErrStateExpired })
pure def sometimesTokenExchangeFailed(a: GoogleAttempt): bool = a.returned == ReturnsError({ error: ErrTokenExchangeFailed })
pure def sometimesWithdrawnReturnShownOnTheCloud(a: GoogleAttempt): bool = a.target == CloudPage and a.returned == ReturnsError({ error: ErrRedirectInvalid })
```

### A code is redeemed once, while live, only with its own return and verifier, and starts a session or a second-factor challenge, never both

A wrong return or verifier is refused with `401 credential_proof_invalid`
and spends nothing, so a stolen code cannot burn the owner's sign-in; a
missing or redeemed code answers `401 authentication_required` reason
`credential_unknown`, an expired one reason `credential_expired`, none
retryable. The match runs `accounts`' first sight and then a session, or
`secondFactor`'s challenge when `afterFirstFactor` of the person's factors
asks for one (a new account has none).

```quint
type CodeBinding = BindingMatches | RedirectDiffers | VerifierDiffers
pure def codeLive(c: CodePhase, now: Millis): bool = match c { | CodeIssued(x) => now < x.redeemBy | _ => false }
pure def isRedeemed(c: CodePhase): bool = match c { | CodeRedeemed(x) => true | _ => false }
pure def effectsOf(y: SignInYield): List[SignInEffect] =
  if (y == SessionYield) List(FirstSightOfGoogle, BeginSession)
  else if (y == DeviceKeyYield) List(FirstSightOfGoogle, MintDeviceKey)
  else if (y == SecondFactorYield) List(FirstSightOfGoogle, BeginSecondFactor)
  else List()
pure def canExchange(a: GoogleAttempt): bool = codeLive(a.code, a.now)
pure def exchange(a: GoogleAttempt, binding: CodeBinding, factorOutcome: F::FirstFactorOutcome): AttemptStep = {
  val y = if (factorOutcome == F::SecondFactorRequired) SecondFactorYield else SessionYield
  if (binding == BindingMatches) { state: { ...a, code: CodeRedeemed({ redeemedAs: y }) }, out: effectsOf(y) } else { state: a, out: List() }
}
pure def codeRefusal(c: CodePhase, now: Millis): Refusal = match c {
  | CodeIssued(x) => if (now >= x.redeemBy) refuseFor(AuthenticationRequired, CredentialExpired) else refuse(CredentialProofInvalid)
  | CodeExpired => refuseFor(AuthenticationRequired, CredentialExpired)
  | _ => refuseFor(AuthenticationRequired, CredentialUnknown)
}
pure val weight_exchange = 3
pure val codeValues = Set(NoCode, CodeIssued({ redeemBy: 60000 }), CodeRedeemed({ redeemedAs: SessionYield }), CodeExpired)
pure val nowValues = Set(0, 60000)
pure def lawACodeRefusalIsFinal(code: CodePhase, now: Millis): bool = wellFormed(codeRefusal(code, now)) and not(retryableOf(codeRefusal(code, now)))
pure def stepACodeIsRedeemedOnceWhileLive(before: GoogleAttempt, via: str, after: GoogleAttempt, out: List[SignInEffect]): bool =
  ((not(isRedeemed(before.code)) and isRedeemed(after.code)) implies (via == "exchange" and codeLive(before.code, before.now)))
  and (isRedeemed(before.code) implies after.code == before.code)
  and ((via == "exchange" and out == List()) implies after == before)
pure def stepSignInStartsExactlyOneThing(before: GoogleAttempt, via: str, after: GoogleAttempt, out: List[SignInEffect]): bool =
  not(out.includes(BeginSecondFactor) and (out.includes(BeginSession) or out.includes(MintDeviceKey)))
  and not(out.includes(BeginSession) and out.includes(MintDeviceKey))
  and ((out.includes(BeginSession) or out.includes(MintDeviceKey) or out.includes(BeginSecondFactor)) iff out.includes(FirstSightOfGoogle))
pure def sometimesSignedInWithGoogle(a: GoogleAttempt): bool = a.code == CodeRedeemed({ redeemedAs: SessionYield })
pure def sometimesBrowserSecondFactor(a: GoogleAttempt): bool = a.code == CodeRedeemed({ redeemedAs: SecondFactorYield })
```

## Story: Sign in with the device's Google account

> As a person on a phone with a Google account, I want to pick that account
> instead of opening a browser, so that one tap signs me in, while a token
> taken from my phone or another app cannot.

### A native challenge needs S256, lives five minutes and is bound to a nonce, the client and the device's verifier

The route first admits the client with its sign-in return and native Google
(`nativeClients/registry`). A link challenge names the signed-in user who
opened it.

```quint
pure val nativeLifetime: Millis = 5 * millisPerMinute
pure def purposeFits(purpose: NativePurpose): bool = match purpose { | NativeLink(l) => l.userId != "" | NativeSignIn => true }
pure def canIssueNative(a: GoogleAttempt, purpose: NativePurpose, method: PkceMethod): bool =
  a.flow.phase == O::FlowIdle and a.native == NoChallenge and method == S256 and purposeFits(purpose)
pure def issueNative(a: GoogleAttempt, purpose: NativePurpose, method: PkceMethod): GoogleAttempt = { ...a, native: ChallengeOpen({ purpose: purpose, openUntil: a.now + nativeLifetime }) }
pure val purposeValues = Set(NativeSignIn, NativeLink({ userId: "user1" }))
pure val methodValues = Set(S256, PlainMethod)
pure def alwaysEveryProofIsShortLived(a: GoogleAttempt): bool = {
  val c = a.code
  val n = a.native
  a.stateExpiresAt <= a.now + stateLifetime
  and (match c { | CodeIssued(x) => x.redeemBy <= a.now + codeLifetime | _ => true })
  and (match n { | ChallengeOpen(x) => x.openUntil <= a.now + nativeLifetime | _ => true })
}
pure def alwaysOneRoute(a: GoogleAttempt): bool = a.native != NoChallenge implies (a.flow.phase == O::FlowIdle and a.code == NoCode)
```

### An ID token spends a live challenge once, only with the client, verifier, signature, issuer, audience and nonce all right, and a refused one spends nothing

The token's audience must be the server client id and its nonce the
challenge's, so a token never serves two challenges. A sign-in mints a
device key (`nativeClients/deviceKeys`, in the same transaction) or opens a
second-factor challenge; a link yields only the proof `signInMethods`
consumes. A missing or used challenge answers `401 authentication_required`
reason `credential_unknown`, an expired one reason `credential_expired`, and
every failed check `401 credential_proof_invalid` without saying which; none
is retryable.

```quint
type NativeProof = { clientMatches: bool, verifierMatches: bool, signatureOk: bool, issuerOk: bool, audienceOk: bool, nonceMatches: bool }
type NativeVerdict = NativeAccepted | NativeUnknown | NativeExpired | NativeProofWrong
pure def tokenValid(p: NativeProof): bool = p.signatureOk and p.issuerOk and p.audienceOk and p.nonceMatches
pure def nativeVerdict(n: NativePhase, now: Millis, p: NativeProof): NativeVerdict = match n {
  | ChallengeOpen(c) => if (now >= c.openUntil) NativeExpired else if (p.clientMatches and p.verifierMatches and tokenValid(p)) NativeAccepted else NativeProofWrong
  | ChallengeExpired => NativeExpired
  | _ => NativeUnknown
}
pure def nativeRefusal(v: NativeVerdict): Refusal =
  if (v == NativeExpired) refuseFor(AuthenticationRequired, CredentialExpired)
  else if (v == NativeProofWrong) refuse(CredentialProofInvalid)
  else refuseFor(AuthenticationRequired, CredentialUnknown)
pure def nativeYield(purpose: NativePurpose, factorOutcome: F::FirstFactorOutcome): SignInYield =
  match purpose { | NativeLink(l) => GoogleProofYield | NativeSignIn => if (factorOutcome == F::SecondFactorRequired) SecondFactorYield else DeviceKeyYield }
pure def isOpen(n: NativePhase): bool = match n { | ChallengeOpen(c) => true | _ => false }
pure def nativeLive(n: NativePhase, now: Millis): bool = match n { | ChallengeOpen(c) => now < c.openUntil | _ => false }
pure def isUsed(n: NativePhase): bool = match n { | ChallengeUsed(c) => true | _ => false }
pure def canPresentIdToken(a: GoogleAttempt): bool = isOpen(a.native)
pure def presentIdToken(a: GoogleAttempt, proof: NativeProof, factorOutcome: F::FirstFactorOutcome): AttemptStep = {
  val n = a.native
  if (nativeVerdict(n, a.now, proof) != NativeAccepted) { state: a, out: List() }
  else match n {
    | ChallengeOpen(c) => { state: { ...a, native: ChallengeUsed({ purpose: c.purpose, usedAs: nativeYield(c.purpose, factorOutcome) }) }, out: effectsOf(nativeYield(c.purpose, factorOutcome)) }
    | _ => { state: a, out: List() }
  }
}
pure def provesGoogleFor(a: GoogleAttempt, userId: str): bool = a.native == ChallengeUsed({ purpose: NativeLink({ userId: userId }), usedAs: GoogleProofYield })
pure val proofValues: Set[NativeProof] = {
  val right: NativeProof = { clientMatches: true, verifierMatches: true, signatureOk: true, issuerOk: true, audienceOk: true, nonceMatches: true }
  Set(right, { ...right, verifierMatches: false }, { ...right, nonceMatches: false }, { ...right, audienceOk: false })
}
pure val weight_presentIdToken = 3
pure def lawANativeRefusalIsFinal(v: NativeVerdict): bool = v != NativeAccepted implies (wellFormed(nativeRefusal(v)) and not(retryableOf(nativeRefusal(v))))
pure def stepAChallengeIsSpentOnceWhileLive(before: GoogleAttempt, via: str, after: GoogleAttempt, out: List[SignInEffect]): bool = {
  val spends = isOpen(before.native) and isUsed(after.native)
  (spends implies (via == "presentIdToken" and nativeLive(before.native, before.now)))
  and (isUsed(before.native) implies after.native == before.native)
  and ((via == "presentIdToken" and not(spends)) implies (after == before and out == List()))
}
pure def sometimesDeviceKeyMinted(a: GoogleAttempt): bool = a.native == ChallengeUsed({ purpose: NativeSignIn, usedAs: DeviceKeyYield })
pure def sometimesNativeSecondFactor(a: GoogleAttempt): bool = a.native == ChallengeUsed({ purpose: NativeSignIn, usedAs: SecondFactorYield })
pure def sometimesGoogleProven(a: GoogleAttempt): bool = provesGoogleFor(a, "user1")
```

### A code past its minute or a challenge past its five minutes is closed as expired

```quint
pure def isIssued(c: CodePhase): bool = match c { | CodeIssued(x) => true | _ => false }
pure def canExpireCode(a: GoogleAttempt): bool = isIssued(a.code) and not(codeLive(a.code, a.now))
pure def expireCode(a: GoogleAttempt): GoogleAttempt = { ...a, code: CodeExpired }
pure def sometimesCodeExpired(a: GoogleAttempt): bool = a.code == CodeExpired
pure def canExpireNative(a: GoogleAttempt): bool = isOpen(a.native) and not(nativeLive(a.native, a.now))
pure def expireNative(a: GoogleAttempt): GoogleAttempt = { ...a, native: ChallengeExpired }
pure def sometimesNativeExpired(a: GoogleAttempt): bool = a.native == ChallengeExpired
```

## Story: Connect mail and calendar from the same Google sheet

> As a person who signed in on the device with its Google account, I want
> that account to grant my mail and calendar right there, so that I never
> sign in to Google a second time, while a code for another Google account
> can never connect to mine.

### A native connect stores tokens only for the signed-in account's own Google identity and only the scopes Google granted

Right after the person picks the account, the device asks Google's
authorization sheet for mail and calendar, for that account and the cloud's
server client, with the scopes the mobile config lists, and sends the
one-use `serverAuthCode` it gets with the ID token in the same native
sign-in request. The cloud redeems it once the sign-in has opened the
account and answers `google.connected`; a refused connect never refuses the
sign-in. A device that already holds its device key sends the code later as
`POST /api/v1/eliza/google/connect/native` `{serverAuthCode}`; a browser
session cannot use that route, and an account without a Google sign-in is
refused before the code reaches Google and connects in the browser instead.
Either way the cloud redeems the code with its server client, only when
that is also the client the connection is kept for (a deployment with a
separate connect client connects only in the browser), and stores the
connection only when Google returned a refresh token and its verified
subject is the Google sign-in subject of the account. It stores reading mail
and reading the calendar as Google granted them, sending or trashing mail
only with reading mail, and changing the calendar only with reading it. A
connect that would store nothing is refused (`409
google_reconnect_required` on the connect route, `google.connected` false at
sign-in) and leaves any earlier connection as it was.

```quint
type NativeGoogleScopes = { readMail: bool, sendMail: bool, trashMail: bool, readCalendar: bool, writeCalendar: bool }
pure val noNativeGoogleScopes: NativeGoogleScopes = { readMail: false, sendMail: false, trashMail: false, readCalendar: false, writeCalendar: false }
pure def nativeConnectStores(signedInSubject: str, grantedSubject: str, refreshIssued: bool, granted: NativeGoogleScopes): NativeGoogleScopes =
  if (signedInSubject == "" or signedInSubject != grantedSubject or not(refreshIssued)) noNativeGoogleScopes
  else { readMail: granted.readMail, sendMail: granted.readMail and granted.sendMail, trashMail: granted.readMail and granted.trashMail,
         readCalendar: granted.readCalendar, writeCalendar: granted.readCalendar and granted.writeCalendar }
pure def nativeConnectStoresAny(stored: NativeGoogleScopes): bool = stored.readMail or stored.readCalendar
pure val grantedValues: Set[NativeGoogleScopes] = {
  val everything: NativeGoogleScopes = { readMail: true, sendMail: true, trashMail: true, readCalendar: true, writeCalendar: true }
  Set(everything, noNativeGoogleScopes, { ...noNativeGoogleScopes, sendMail: true, writeCalendar: true }, { ...noNativeGoogleScopes, readCalendar: true, trashMail: true },
      { ...noNativeGoogleScopes, readMail: true, sendMail: true, writeCalendar: true }, { ...everything, readCalendar: false })
}
pure def lawANativeConnectStoresOnlyTheSignedInAccountsGrantedScopes(signedInSubject: str, grantedSubject: str, refreshIssued: bool, granted: NativeGoogleScopes): bool = {
  val stored = nativeConnectStores(signedInSubject, grantedSubject, refreshIssued, granted)
  (nativeConnectStoresAny(stored) implies (signedInSubject != "" and signedInSubject == grantedSubject and refreshIssued))
  and (stored.readMail implies granted.readMail) and (stored.sendMail implies (granted.sendMail and stored.readMail))
  and (stored.trashMail implies (granted.trashMail and stored.readMail)) and (stored.readCalendar implies granted.readCalendar)
  and (stored.writeCalendar implies (granted.writeCalendar and stored.readCalendar))
  and (not(nativeConnectStoresAny(stored)) implies stored == noNativeGoogleScopes)
}
```
