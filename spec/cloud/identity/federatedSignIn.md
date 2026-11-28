# Google sign-in

Signing in with Google, the server half: in the browser with a one-time
code, or on the phone with its own Google account and a one-time challenge.
The server lives in `packages/cloud-worker/src/identity/federated.vibe`
and the device half is [the sign-in flow](../../os/signIn/flow.md).
Under `/api/v1/auth/google/`, `GET authorize`
redirects to Google; `GET callback` redirects to
`<redirect_uri>#code=<code>&state=<state>` or `#error=<error>&state=<state>`;
`POST exchange` `{code, redirectUri, clientId, codeVerifier}` answers as a
code sign-in does (`codeChallenges`); `POST native/challenge`, and `POST
/api/v1/user/methods/google/challenge` for a link, answer `{challengeId,
nonce, serverClientId, expiresAt}`. A challenge is answered inside `POST
/api/v1/app-auth/mobile/google` (`nativeClients/deviceKeys`) or `POST
/api/v1/user/methods/google/link` (`signInMethods`).

One machine instance is one attempt row: a browser attempt or a native
challenge, never both. The shell draws state, code, challenge ID and nonce
at random. It stores digests of the provider state, code and nonce, with
the challenge ID as its row key. It passes each check into the model as an observation. An
unknown state, code or challenge ID is answered before this machine.
Google's `email_verified` goes unchanged to `accounts`' first sight.

## Story: Sign in with Google in the browser

> As a person, I want to sign in with my Google account in the browser and
> come back to the app that sent me, so that only that app, holding its own
> verifier, can finish my sign-in, and only once.

### Authorize is admitted only with response_type code, S256, a state and the exact sign-in return of an enabled registration of this environment, and the attempt lives five minutes

A refused request stores nothing and is final: `400 invalid_request`, or the
client fault of `nativeClients/registry`. With Google off the attempt ends
unstored, `503 provider_unavailable` reason `google_not_configured`.

```quint
import types.* from "../shared/types"
import oauth as O from "../../core/oauth"
import registry as N from "../nativeClients/registry"
import secondFactor as F from "./secondFactor"
import rateLimit as R from "../shared/rateLimit"
type ResponseType = CodeResponse | OtherResponse
type PkceMethod = S256 | PlainMethod
type AuthorizeRequest = { responseType: ResponseType, method: PkceMethod, client: N::ClientCheck, hasState: bool }
type ReturnError = ErrAccessDenied | ErrAuthenticationFailed | ErrCallbackIncomplete | ErrIdentityIncomplete | ErrProviderUnavailable | ErrRedirectInvalid | ErrStateConsumed | ErrStateExpired | ErrStateInvalid | ErrTokenExchangeFailed
type Failure = NoFailure | FailedWith({ cause: ReturnError })
type ReturnTarget = AppReturnUrl | CloudPage
type AppReturn = NotReturned | ReturnsCode | ReturnsError({ error: ReturnError })
type SignInYield = SessionYield | SecondFactorYield | DeviceKeyYield | GoogleProofYield
type CodePhase = NoCode | CodeIssued({ redeemBy: Millis }) | CodeRedeemed({ redeemedAs: SignInYield }) | CodeExpired
type NativeBackupBinding = { requestDigest: str, subject: str }
type NativePurpose = NativeSignIn | NativeLink({ userId: str }) | NativeBackup({ binding: NativeBackupBinding })
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

So the attempt is stored before the Google URL, a callback consumes it once
before the token exchange, and a failed write after a failure keeps both
causes. Google's verifier is always required; nothing is compensated.

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

Google's `error` answers `access_denied`; a callback without code or state
`oauth_callback_incomplete`; a lost Google verifier `oauth_state_invalid`;
an expired attempt `oauth_state_expired`; Google switched off since
`oauth_provider_unavailable`; a failed token exchange or profile read
`oauth_token_exchange_failed`; an identity without a subject
`oauth_identity_incomplete`; a failed write `oauth_authentication_failed`; a
later callback for the same state `lateCallbackError`. The list is closed and
shared with os, which adds only `app_link_unverified`. A second factor
travels in the code, so `mfa_required` is never returned. A return withdrawn
since authorize is never visited: `oauth_redirect_invalid` shows on a cloud page.

```quint
type GoogleCallback = GoogleCode | GoogleDenied | GoogleIncomplete | ReturnWithdrawn
type GoogleAnswer = IdentityVerified | IdentityIncomplete | TokenExchangeFailed
pure val codeLifetime: Millis = 60 * millisPerSecond
pure def returnErrorCode(e: ReturnError): str =
  if (e == ErrAccessDenied) "access_denied" else if (e == ErrAuthenticationFailed) "oauth_authentication_failed" else if (e == ErrCallbackIncomplete) "oauth_callback_incomplete"
  else if (e == ErrIdentityIncomplete) "oauth_identity_incomplete" else if (e == ErrProviderUnavailable) "oauth_provider_unavailable" else if (e == ErrRedirectInvalid) "oauth_redirect_invalid"
  else if (e == ErrStateConsumed) "oauth_state_consumed" else if (e == ErrStateExpired) "oauth_state_expired" else if (e == ErrStateInvalid) "oauth_state_invalid" else "oauth_token_exchange_failed"
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

A wrong return or verifier is refused `401 credential_proof_invalid` and
spends nothing, so a stolen code cannot burn the owner's sign-in; a missing
or redeemed code answers `401 authentication_required` reason
`credential_unknown`, an expired one `credential_expired`, none retryable. A
match runs `accounts`' first sight, then a session, or `secondFactor`'s
challenge when `afterFirstFactor` asks for one.

```quint
type CodeBinding = BindingMatches | RedirectDiffers | VerifierDiffers
pure def codeLive(c: CodePhase, now: Millis): bool = match c { | CodeIssued(x) => now < x.redeemBy | _ => false }
pure def isRedeemed(c: CodePhase): bool = match c { | CodeRedeemed(x) => true | _ => false }
pure def effectsOf(y: SignInYield): List[SignInEffect] =
  if (y == SessionYield) List(FirstSightOfGoogle, BeginSession) else if (y == DeviceKeyYield) List(FirstSightOfGoogle, MintDeviceKey)
  else if (y == SecondFactorYield) List(FirstSightOfGoogle, BeginSecondFactor) else List()
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

### A client address may call the Google sign-in routes 30 times a minute, and over that is refused before anything is stored

`authorize`, `callback`, `exchange` and `native/challenge` share one window
per client address, checked with `shared/rateLimit` before the attempt row
is read or written; a browser sign-in spends three of them and a native one
spends one. Over the limit a call answers `429 rate_limited` with the
window's end, and nothing is stored or sent to Google.

```quint
pure val googleSignInPerIp: R::RateLimit = R::perMinute("googleSignInPerIp", 30)
```

## Story: Sign in with the device's Google account

> As a person on a phone with a Google account, I want to pick that account
> instead of opening a browser, so that one tap signs me in, while a token
> taken from my phone or another app cannot.

### A native challenge needs S256, opens only on an unused attempt row, and lives five minutes

The client is first admitted with its sign-in return and native Google
(`nativeClients/registry`); the row keeps the nonce, client and verifier
digest, and a link challenge names the signed-in user who opened it. A
backup challenge additionally names its device-bound recovery request and
the current account’s Google subject.

```quint
pure val nativeLifetime: Millis = 5 * millisPerMinute
pure def validNativeBackupBinding(binding: NativeBackupBinding): bool = binding.requestDigest != "" and binding.subject != ""
pure def purposeFits(purpose: NativePurpose): bool = match purpose {
  | NativeLink(l) => l.userId != ""
  | NativeBackup(b) => validNativeBackupBinding(b.binding)
  | NativeSignIn => true
}
pure def canIssueNative(a: GoogleAttempt, purpose: NativePurpose, method: PkceMethod): bool =
  a.flow.phase == O::FlowIdle and a.native == NoChallenge and method == S256 and purposeFits(purpose)
pure def issueNative(a: GoogleAttempt, purpose: NativePurpose, method: PkceMethod): GoogleAttempt = { ...a, native: ChallengeOpen({ purpose: purpose, openUntil: a.now + nativeLifetime }) }
pure val backupBinding: NativeBackupBinding = { requestDigest: "registered-backup-request", subject: "google-owner" }
pure val purposeValues = Set(NativeSignIn, NativeLink({ userId: "user1" }), NativeBackup({ binding: backupBinding }))
pure val methodValues = Set(S256, PlainMethod)
pure def alwaysOneRoute(a: GoogleAttempt): bool = a.native != NoChallenge implies (a.flow.phase == O::FlowIdle and a.code == NoCode)
```

### An ID token spends a live challenge once, only with the client, verifier, signature, issuer, audience and nonce all right, and a refused one spends nothing

The audience must be the server client id and the nonce the challenge's, so
a token never serves two challenges. A sign-in mints a device key
(`nativeClients/deviceKeys`, same transaction) or opens a second-factor
challenge; a link yields only the proof `signInMethods` consumes. A missing
or used challenge answers `401 authentication_required` reason
`credential_unknown`, an expired one `credential_expired`, any failed check
`401 credential_proof_invalid` without saying which; none is retryable.

```quint
type NativeProof = { clientMatches: bool, verifierMatches: bool, signatureOk: bool, issuerOk: bool, audienceOk: bool, nonceMatches: bool }
type NativeVerdict = NativeAccepted | NativeUnknown | NativeExpired | NativeProofWrong
pure def tokenValid(p: NativeProof): bool = p.signatureOk and p.issuerOk and p.audienceOk and p.nonceMatches
pure def nativeProofVerdict(n: NativePhase, now: Millis, p: NativeProof): NativeVerdict = match n {
  | ChallengeOpen(c) => if (now >= c.openUntil) NativeExpired else if (p.clientMatches and p.verifierMatches and tokenValid(p)) NativeAccepted else NativeProofWrong
  | ChallengeExpired => NativeExpired
  | _ => NativeUnknown
}
pure def isNativeBackup(purpose: NativePurpose): bool = match purpose { | NativeBackup(_) => true | _ => false }
pure def nativeVerdict(n: NativePhase, now: Millis, p: NativeProof): NativeVerdict = match n {
  | ChallengeOpen(c) => if (isNativeBackup(c.purpose)) NativeProofWrong else nativeProofVerdict(n, now, p)
  | _ => nativeProofVerdict(n, now, p)
}
pure def nativeRefusal(v: NativeVerdict): Refusal =
  if (v == NativeExpired) refuseFor(AuthenticationRequired, CredentialExpired)
  else if (v == NativeProofWrong) refuse(CredentialProofInvalid) else refuseFor(AuthenticationRequired, CredentialUnknown)
pure def nativeYield(purpose: NativePurpose, factorOutcome: F::FirstFactorOutcome): SignInYield =
  match purpose { | NativeLink(l) => GoogleProofYield | NativeBackup(_) => GoogleProofYield | NativeSignIn => if (factorOutcome == F::SecondFactorRequired) SecondFactorYield else DeviceKeyYield }
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
  (spends implies ((via == "presentIdToken" or via == "presentNativeBackup") and nativeLive(before.native, before.now)))
  and (isUsed(before.native) implies after.native == before.native)
  and (((via == "presentIdToken" or via == "presentNativeBackup") and not(spends)) implies (after == before and out == List()))
}
pure def sometimesDeviceKeyMinted(a: GoogleAttempt): bool = a.native == ChallengeUsed({ purpose: NativeSignIn, usedAs: DeviceKeyYield })
pure def sometimesNativeSecondFactor(a: GoogleAttempt): bool = a.native == ChallengeUsed({ purpose: NativeSignIn, usedAs: SecondFactorYield })
pure def sometimesGoogleProven(a: GoogleAttempt): bool = provesGoogleFor(a, "user1")
```

### No attempt, code or challenge outlives its lifetime, and a code or challenge past it is closed as expired

```quint
pure def alwaysEveryProofIsShortLived(a: GoogleAttempt): bool = {
  val c = a.code
  val n = a.native
  a.stateExpiresAt <= a.now + stateLifetime
  and (match c { | CodeIssued(x) => x.redeemBy <= a.now + codeLifetime | _ => true })
  and (match n { | ChallengeOpen(x) => x.openUntil <= a.now + nativeLifetime | _ => true })
}
pure def isIssued(c: CodePhase): bool = match c { | CodeIssued(x) => true | _ => false }
pure def canExpireCode(a: GoogleAttempt): bool = isIssued(a.code) and not(codeLive(a.code, a.now))
pure def expireCode(a: GoogleAttempt): GoogleAttempt = { ...a, code: CodeExpired }
pure def sometimesCodeExpired(a: GoogleAttempt): bool = a.code == CodeExpired
pure def canExpireNative(a: GoogleAttempt): bool = isOpen(a.native) and not(nativeLive(a.native, a.now))
pure def expireNative(a: GoogleAttempt): GoogleAttempt = { ...a, native: ChallengeExpired }
pure def sometimesNativeExpired(a: GoogleAttempt): bool = a.native == ChallengeExpired
```

## Story: Confirm a shared password backup with the device’s Google account

> As the owner of a signed-in device, I want to confirm the specific backup
> action in native UI and prove that I still control the same Google account.

### A backup challenge yields only a proof for its current device and confirmed recovery action

The challenge belongs to the registered client, environment and return, the
current acknowledged device grant, its account and organization, and one
recovery purpose, state and backup PKCE challenge. The shell admits that
device and registration before opening the challenge, binds these facts in
one canonical request digest, and checks them again using the current device
credential when the proof is presented. The attempt records the account
owner so [account erasure](./deletion.md) removes it. The verified Google
subject must equal the subject recorded for that same account. Native
confirmation is for the bound recovery action. The usual Google PKCE,
issuer, audience, signature, nonce and expiration checks also apply.
The client match also checks the signed Google authorized presenter against
the Android OAuth clients registered for the app. The audience remains
the Cloud server client. Existing sign-in and link proofs keep their
own checks.

Only the backup presenter can spend a backup challenge. The successful
outcome is a Google proof for the bound request. It has no sign-in, linking,
device enrollment, second factor or provider authorization effects.

```quint
type NativeBackupPresenter = { binding: NativeBackupBinding, deviceCurrent: bool, confirmed: bool }
pure def nativeBackupVerdict(n: NativePhase, now: Millis, p: NativeProof, presenter: NativeBackupPresenter): NativeVerdict = {
  val proof = nativeProofVerdict(n, now, p)
  if (proof != NativeAccepted) proof
  else match n {
    | ChallengeOpen(c) =>
      if (c.purpose == NativeBackup({ binding: presenter.binding }) and validNativeBackupBinding(presenter.binding)
        and presenter.deviceCurrent and presenter.confirmed) NativeAccepted else NativeProofWrong
    | _ => NativeUnknown
  }
}
pure def canPresentNativeBackup(a: GoogleAttempt): bool = {
  val phase = a.native
  match phase {
    | ChallengeOpen(c) => isNativeBackup(c.purpose)
    | _ => false
  }
}
pure def presentNativeBackup(a: GoogleAttempt, proof: NativeProof, presenter: NativeBackupPresenter): AttemptStep =
  if (nativeBackupVerdict(a.native, a.now, proof, presenter) != NativeAccepted) { state: a, out: List() }
  else { state: { ...a, native: ChallengeUsed({ purpose: NativeBackup({ binding: presenter.binding }), usedAs: GoogleProofYield }) }, out: List() }
pure val presenterValues: Set[NativeBackupPresenter] = {
  val right: NativeBackupPresenter = { binding: backupBinding, deviceCurrent: true, confirmed: true }
  Set(right, { ...right, binding: { ...backupBinding, requestDigest: "other-request" } },
    { ...right, binding: { ...backupBinding, subject: "other-google-owner" } },
    { ...right, deviceCurrent: false }, { ...right, confirmed: false })
}
pure def lawBackupProofRequiresItsCurrentConfirmedBinding(proof: NativeProof, presenter: NativeBackupPresenter): bool = {
  val challenge = ChallengeOpen({ purpose: NativeBackup({ binding: backupBinding }), openUntil: nativeLifetime })
  nativeVerdict(challenge, 0, proof) == NativeProofWrong
  and ((nativeBackupVerdict(challenge, 0, proof, presenter) == NativeAccepted) iff
    (nativeProofVerdict(challenge, 0, proof) == NativeAccepted and presenter.binding == backupBinding and presenter.deviceCurrent and presenter.confirmed))
}
pure def alwaysBackupHasNoSignInYield(a: GoogleAttempt): bool = {
  val phase = a.native
  match phase {
    | ChallengeUsed(c) => isNativeBackup(c.purpose) implies c.usedAs == GoogleProofYield
    | _ => true
  }
}
pure def sometimesNativeBackupProven(a: GoogleAttempt): bool =
  a.native == ChallengeUsed({ purpose: NativeBackup({ binding: backupBinding }), usedAs: GoogleProofYield })
```

## Story: Connect mail and calendar from the same Google sheet

> As a person who signed in on the device with its Google account, I want
> that account to grant my mail and calendar right there, so that I never
> sign in to Google a second time, while a code for another Google account
> can never connect to mine.

### A native connect stores tokens only for the signed-in account's own Google identity and only the selected scopes Google granted

An enrolled device continuing its native sign-in sends Google's one-use
`serverAuthCode` for the account it signed in with. The cloud redeems it.
After a second factor the request
uses the device's acknowledged key, and the cloud finds its native app
registration from that key. The connection is stored only when
Google returned a refresh token and Google's verified subject is the Google
sign-in subject of the account, which an account without a Google sign-in
lacks. On the Grace Google mount ([deployment](../deployment.md)) a
request may name the five permissions the owner selected; a request that
names none of them selects every permission, and one that names only some
of them is refused `400 invalid_request` before the attempt counts or a code
reaches Google. The server table's enrolled native connect names no
permissions and selects every one. Standalone linking follows the
[managed connection](../services/google/connection.md) rule. A stored connection has reading
mail exactly when it was selected and Google granted it, and reading the
calendar exactly when it was selected and Google granted it. It never holds
a permission the request did not select, even one Google granted. Sending or
trashing mail needs reading mail, and changing the calendar needs reading it.
A connect that would store nothing stores no scope at all. A signed-in
account can submit six native connect attempts in the ten minutes following
its first attempt. Excess attempts are refused before a code reaches Google.

```quint
type NativeGoogleScopes = { readMail: bool, sendMail: bool, trashMail: bool, readCalendar: bool, writeCalendar: bool }
pure val nativeConnectAttempts = 6
pure val nativeConnectWindowSeconds = 600
pure val noNativeGoogleScopes: NativeGoogleScopes = { readMail: false, sendMail: false, trashMail: false, readCalendar: false, writeCalendar: false }
pure val everyNativeGoogleScope: NativeGoogleScopes = { readMail: true, sendMail: true, trashMail: true, readCalendar: true, writeCalendar: true }
pure def nativeConnectStores(signedInSubject: str, grantedSubject: str, refreshIssued: bool, selected: NativeGoogleScopes, granted: NativeGoogleScopes): NativeGoogleScopes = {
  val readMail = selected.readMail and granted.readMail
  val readCalendar = selected.readCalendar and granted.readCalendar
  if (signedInSubject == "" or signedInSubject != grantedSubject or not(refreshIssued)) noNativeGoogleScopes
  else { readMail: readMail, sendMail: readMail and selected.sendMail and granted.sendMail, trashMail: readMail and selected.trashMail and granted.trashMail,
         readCalendar: readCalendar, writeCalendar: readCalendar and selected.writeCalendar and granted.writeCalendar }
}
pure val nativeSelectionFields = 5
pure def nativeConnectSelectionNamed(namedFields: int): bool = namedFields == 0 or namedFields == nativeSelectionFields
pure def nativeConnectSelection(namedFields: int, named: NativeGoogleScopes): NativeGoogleScopes =
  if (namedFields == nativeSelectionFields) named else everyNativeGoogleScope
pure def nativeConnectStoresAny(stored: NativeGoogleScopes): bool = stored.readMail or stored.readCalendar
pure val grantedValues: Set[NativeGoogleScopes] = tuples(Set(true, false), Set(true, false), Set(true, false), Set(true, false), Set(true, false))
  .map(g => { readMail: g._1, sendMail: g._2, trashMail: g._3, readCalendar: g._4, writeCalendar: g._5 })
pure val selectedValues: Set[NativeGoogleScopes] = grantedValues
pure val namedValues: Set[NativeGoogleScopes] = grantedValues
pure val namedFieldsValues = 0.to(nativeSelectionFields)
pure val signedInSubjectValues = Set("", "sub1", "sub2")
pure val grantedSubjectValues = Set("", "sub1", "sub2")
pure def lawANativeConnectStoresOnlyTheSignedInAccountsGrantedScopes(signedInSubject: str, grantedSubject: str, refreshIssued: bool, selected: NativeGoogleScopes, granted: NativeGoogleScopes): bool = {
  val stored = nativeConnectStores(signedInSubject, grantedSubject, refreshIssued, selected, granted)
  (nativeConnectStoresAny(stored) implies (signedInSubject != "" and signedInSubject == grantedSubject and refreshIssued))
  and (stored.readMail implies granted.readMail) and (stored.sendMail implies (granted.sendMail and stored.readMail))
  and (stored.trashMail implies (granted.trashMail and stored.readMail)) and (stored.readCalendar implies granted.readCalendar)
  and (stored.writeCalendar implies (granted.writeCalendar and stored.readCalendar))
  and (not(nativeConnectStoresAny(stored)) implies stored == noNativeGoogleScopes)
  and ((signedInSubject != "" and signedInSubject == grantedSubject and refreshIssued)
    implies (stored.readMail == (selected.readMail and granted.readMail) and stored.readCalendar == (selected.readCalendar and granted.readCalendar)))
}
pure def lawANativeConnectNeverStoresAnUnselectedScope(signedInSubject: str, grantedSubject: str, refreshIssued: bool, selected: NativeGoogleScopes, granted: NativeGoogleScopes): bool = {
  val stored = nativeConnectStores(signedInSubject, grantedSubject, refreshIssued, selected, granted)
  (stored.readMail implies selected.readMail) and (stored.sendMail implies selected.sendMail) and (stored.trashMail implies selected.trashMail)
  and (stored.readCalendar implies selected.readCalendar) and (stored.writeCalendar implies selected.writeCalendar)
}
pure def lawARequestNamingNoSelectionSelectsEveryScope(namedFields: int, named: NativeGoogleScopes): bool =
  (nativeConnectSelectionNamed(namedFields) iff (namedFields == 0 or namedFields == nativeSelectionFields))
  and (namedFields == 0 implies nativeConnectSelection(namedFields, named) == everyNativeGoogleScope)
  and (namedFields == nativeSelectionFields implies nativeConnectSelection(namedFields, named) == named)
pure def lawSelectingEveryScopeStoresWhatGoogleGranted(signedInSubject: str, grantedSubject: str, refreshIssued: bool, granted: NativeGoogleScopes): bool = {
  val stored = nativeConnectStores(signedInSubject, grantedSubject, refreshIssued, everyNativeGoogleScope, granted)
  (signedInSubject != "" and signedInSubject == grantedSubject and refreshIssued) implies
    stored == { readMail: granted.readMail, sendMail: granted.readMail and granted.sendMail, trashMail: granted.readMail and granted.trashMail,
                readCalendar: granted.readCalendar, writeCalendar: granted.readCalendar and granted.writeCalendar }
}
```
