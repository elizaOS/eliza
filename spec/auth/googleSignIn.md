# Google sign-in

A person signs in with Google from a registered application. The trusted
host starts an attempt with its own state and S256 PKCE verifier and opens
the authorize URL. Google returns to the identity service, which issues a
short-lived App Link code bound to the verifier, the redirect and the
tenant. The device hands the return to the host, which checks the state and
exchanges the code with its verifier at `POST /auth/oauth/exchange`. The
service redeems a code once, under a short lock, before it answers with a
session or an MFA challenge. Times are in seconds.

Ported from develop `packages/auth/quint/OAuthAppLinkRedemption.qnt` (the
exchange route) and `NativeGoogleAdmission.qnt` (the host's admission of the
return and its cancellation fence). MFA completion is in [MFA](./mfa.md);
the durable credential that follows a session is in
[native enrollment](./native/enrollment.md).

## Story: Sign in with Google through the browser or the device account picker

> As a person, I want to sign in with my Google account from the application
> I am using, so that only that application, holding its own verifier, can
> finish my sign-in, exactly once.

### Authorize requires S256 PKCE, an allowlisted redirect and a known tenant

The attempt's state lives five minutes.

```quint
type CodeChallengeMethod = S256 | PlainChallenge
type AuthorizeRequest = { method: CodeChallengeMethod, redirectAllowlisted: bool, tenantKnown: bool }
pure def authorizeAccepted(request: AuthorizeRequest): bool = request.method == S256 and request.redirectAllowlisted and request.tenantKnown
pure val stateLifetime = 300
pure def lawPlainChallengeRefused(request: AuthorizeRequest): bool = request.method == PlainChallenge implies not(authorizeAccepted(request))
pure def lawUnlistedRedirectRefused(request: AuthorizeRequest): bool = not(request.redirectAllowlisted) implies not(authorizeAccepted(request))
```

### A native Google ID token is accepted only for an audience the tenant's app client lists

The token's signature, issuer and expiry are checked by the verifier and
supplied as evidence.

```quint
type IdTokenEvidence = { signatureValid: bool, issuerIsGoogle: bool, unexpired: bool, audienceListed: bool }
pure def idTokenAccepted(token: IdTokenEvidence): bool = token.signatureValid and token.issuerIsGoogle and token.unexpired and token.audienceListed
pure def lawForeignAudienceRefused(token: IdTokenEvidence): bool = not(token.audienceListed) implies not(idTokenAccepted(token))
pure val tokenValues = Set(
  { signatureValid: true, issuerIsGoogle: true, unexpired: true, audienceListed: true },
  { signatureValid: true, issuerIsGoogle: true, unexpired: true, audienceListed: false },
  { signatureValid: true, issuerIsGoogle: true, unexpired: false, audienceListed: true })
```

### The host starts one attempt at a time with its own state and verifier

The service issues at most one App Link code for an attempt, bound to its
verifier, redirect and tenant. The code's store lifetime may outlast its
payload expiry; both are checked.

```quint
type AttemptPhase = NoAttempt | AwaitingReturn | Exchanging | AttemptSpent | MfaAdmitted | SignedIn
type ReturnForm = MalformedReturn | MalformedCode | FailureLink | CodeReturned
type HostResult = NothingYet | ReturnBusy | ReturnUnavailable | ReturnMalformed | StateMismatch | CodeMalformed | GoogleSignInFailed | ExchangeDispatched | ExchangeFailed | ReplyAfterCancel | CancelRequested | CancelSettled
type Lane = SessionLane | MfaLane
type Binding = AllBindingsMatch | WrongVerifier | WrongRedirect | WrongTenant | PolicyRefusal
type RedemptionPhase = Peeked | Validated | Locked | CodeConsumed | CodeMissing | RedemptionRefused | LockBusy | GrantedSession | GrantedMfa
type Redemption = { id: int, binding: Binding, phase: RedemptionPhase, fromHost: bool }
type GoogleSignIn = {
  now: int, attempt: int, phase: AttemptPhase, attemptExpiresAt: int, verifierLive: bool, epoch: int, ticket: int,
  exchangeInFlight: bool, cancelling: bool, exchanges: List[int], lastResult: HostResult,
  codeFor: int, lane: Lane, codePresent: bool, payloadExpiresAt: int, storeExpiresAt: int,
  lockOwner: int, spentBy: int, spentAt: int, redemptions: List[Redemption], nextRedemption: int
}
pure val initial: GoogleSignIn = {
  now: 0, attempt: 0, phase: NoAttempt, attemptExpiresAt: 0, verifierLive: false, epoch: 0, ticket: 0,
  exchangeInFlight: false, cancelling: false, exchanges: List(), lastResult: NothingYet,
  codeFor: 0, lane: SessionLane, codePresent: false, payloadExpiresAt: 0, storeExpiresAt: 0,
  lockOwner: 0, spentBy: 0, spentAt: -1, redemptions: List(), nextRedemption: 1
}
pure val codeLifetime = 60
pure def canStartAttempt(s: GoogleSignIn, request: AuthorizeRequest): bool =
  authorizeAccepted(request) and not(s.exchangeInFlight) and not(s.cancelling) and s.lockOwner == 0
pure def startAttempt(s: GoogleSignIn, request: AuthorizeRequest): GoogleSignIn =
  { ...s, attempt: s.attempt + 1, phase: AwaitingReturn, attemptExpiresAt: s.now + stateLifetime, verifierLive: true, lastResult: NothingYet,
    codeFor: 0, codePresent: false, spentBy: 0, spentAt: -1, redemptions: List(), nextRedemption: 1 }
pure val requestValues = Set({ method: S256, redirectAllowlisted: true, tenantKnown: true }, { method: PlainChallenge, redirectAllowlisted: true, tenantKnown: true })
pure def canProviderApproves(s: GoogleSignIn, lane: Lane, storeSlack: int): bool = s.phase == AwaitingReturn and s.codeFor != s.attempt and storeSlack >= 0
pure def providerApproves(s: GoogleSignIn, lane: Lane, storeSlack: int): GoogleSignIn =
  { ...s, codeFor: s.attempt, lane: lane, codePresent: true, payloadExpiresAt: s.now + codeLifetime, storeExpiresAt: s.now + codeLifetime + storeSlack }
pure val storeSlackValues = Set(0, 1)
pure def canElapse(s: GoogleSignIn, seconds: int): bool = seconds > 0
pure def elapse(s: GoogleSignIn, seconds: int): GoogleSignIn = { ...s, now: s.now + seconds }
pure val secondsValues = Set(1, 60, 300)
pure def sometimesSignedIn(s: GoogleSignIn): bool = s.phase == SignedIn
```

### A return with a different state or a malformed shape is refused and leaves the attempt intact

A matched return is single use: a failure link ends the attempt with
`google_sign_in_failed`, a malformed code spends it, and a returned code is
exchanged once with the attempt's own verifier, which the host then forgets.

```quint
pure def returnRefusal(s: GoogleSignIn, returnedAttempt: int, form: ReturnForm): HostResult =
  if (s.exchangeInFlight or s.cancelling) ReturnBusy
  else if (s.phase != AwaitingReturn or s.now >= s.attemptExpiresAt) ReturnUnavailable
  else if (form == MalformedReturn) ReturnMalformed
  else if (returnedAttempt != s.attempt) StateMismatch
  else NothingYet
pure def codeLive(s: GoogleSignIn): bool = s.codeFor == s.attempt and s.codePresent and s.now < s.storeExpiresAt
pure def deviceReturns(s: GoogleSignIn, returnedAttempt: int, form: ReturnForm): GoogleSignIn = {
  val refusal = returnRefusal(s, returnedAttempt, form)
  if (refusal != NothingYet) { ...s, lastResult: refusal }
  else if (form == FailureLink) { ...s, phase: NoAttempt, verifierLive: false, lastResult: GoogleSignInFailed }
  else if (form == MalformedCode) { ...s, phase: AttemptSpent, verifierLive: false, lastResult: CodeMalformed }
  else { ...s, phase: Exchanging, verifierLive: false, exchangeInFlight: true, ticket: s.epoch, exchanges: s.exchanges.append(s.attempt), lastResult: ExchangeDispatched,
    redemptions: s.redemptions.append({ id: s.nextRedemption, binding: AllBindingsMatch, phase: if (codeLive(s)) Peeked else RedemptionRefused, fromHost: true }), nextRedemption: s.nextRedemption + 1 }
}
pure val returnedAttemptValues = Set(1, 2)
pure def alwaysRefusedReturnKeepsAttempt(s: GoogleSignIn): bool =
  (s.phase == AwaitingReturn implies (s.verifierLive and not(s.exchanges.includes(s.attempt)) and not(s.exchangeInFlight))) and s.exchanges.every(a => a >= 1 and a <= s.attempt) and
  ((s.lastResult == StateMismatch or s.lastResult == ReturnMalformed) implies (s.phase == AwaitingReturn and s.verifierLive and not(s.exchanges.includes(s.attempt))))
pure def alwaysMatchedFailureSpendsWithoutExchange(s: GoogleSignIn): bool =
  (s.lastResult == GoogleSignInFailed or s.lastResult == CodeMalformed) implies (not(s.verifierLive) and not(s.exchanges.includes(s.attempt)) and s.phase != AwaitingReturn)
pure def alwaysOneExchangePerAttempt(s: GoogleSignIn): bool =
  s.exchanges.every(a => s.exchanges.select(b => b == a).length() == 1) and (s.exchangeInFlight implies (not(s.verifierLive) and s.exchanges.includes(s.attempt)))
pure def sometimesMismatchKeepsIssuedCode(s: GoogleSignIn): bool = s.lastResult == StateMismatch and s.codeFor == s.attempt and s.codePresent
pure def sometimesFailureLinkEndsAttempt(s: GoogleSignIn): bool = s.lastResult == GoogleSignInFailed
```

### An App Link code is redeemed once, only with its bound verifier, redirect and tenant, before the response

Anyone may present the code. The service reads it, checks every binding and
the payload expiry, takes a short lock, and consumes the code (checking the
store lifetime again) before it replies. A presenter with a wrong binding
spends nothing, and a contender for the lock is refused as busy. The model
lets an outside presenter try an attempt's code while it has fewer than two
redemptions, and numbers each attempt's redemptions from one, so the service
can finish every redemption, the host's included.

```quint
pure def canPresentCode(s: GoogleSignIn, binding: Binding): bool = s.codeFor > 0 and s.redemptions.length() < 2
pure def presentCode(s: GoogleSignIn, binding: Binding): GoogleSignIn =
  { ...s, redemptions: s.redemptions.append({ id: s.nextRedemption, binding: binding, phase: if (codeLive(s)) Peeked else RedemptionRefused, fromHost: false }), nextRedemption: s.nextRedemption + 1 }
pure val bindingValues = Set(AllBindingsMatch, WrongVerifier, WrongRedirect)
pure val noRedemption: Redemption = { id: 0, binding: PolicyRefusal, phase: RedemptionRefused, fromHost: false }
pure def redemption(s: GoogleSignIn, id: int): Redemption = s.redemptions.select(r => r.id == id).nthOr(0, noRedemption)
pure def withPhase(s: GoogleSignIn, id: int, phase: RedemptionPhase): List[Redemption] = s.redemptions.listMap(r => if (r.id == id) { ...r, phase: phase } else r)
pure def canValidate(s: GoogleSignIn, id: int): bool = redemption(s, id).phase == Peeked
pure def validate(s: GoogleSignIn, id: int): GoogleSignIn =
  { ...s, redemptions: withPhase(s, id, if (s.now < s.payloadExpiresAt and redemption(s, id).binding == AllBindingsMatch) Validated else RedemptionRefused) }
pure def canAcquire(s: GoogleSignIn, id: int): bool = redemption(s, id).phase == Validated
pure def acquire(s: GoogleSignIn, id: int): GoogleSignIn =
  if (s.lockOwner == 0) { ...s, lockOwner: id, redemptions: withPhase(s, id, Locked) } else { ...s, redemptions: withPhase(s, id, LockBusy) }
pure def canConsumeCode(s: GoogleSignIn, id: int): bool = redemption(s, id).phase == Locked and s.lockOwner == id
pure def consumeCode(s: GoogleSignIn, id: int): GoogleSignIn =
  if (codeLive(s)) { ...s, codePresent: false, spentBy: id, spentAt: s.now, redemptions: withPhase(s, id, CodeConsumed) }
  else { ...s, codePresent: false, redemptions: withPhase(s, id, CodeMissing) }
pure def canReply(s: GoogleSignIn, id: int): bool = (redemption(s, id).phase == CodeConsumed or redemption(s, id).phase == CodeMissing) and s.lockOwner == id
pure def reply(s: GoogleSignIn, id: int): GoogleSignIn =
  { ...s, lockOwner: 0, redemptions: withPhase(s, id, if (redemption(s, id).phase == CodeMissing) RedemptionRefused else if (s.lane == MfaLane) GrantedMfa else GrantedSession) }
pure val idValues = Set(1, 2, 3)
pure val weight_validate = 4
pure val weight_acquire = 4
pure val weight_consumeCode = 4
pure val weight_reply = 4
pure val weight_hostReceivesReply = 4
pure val weight_deviceReturns = 3
pure val weight_providerApproves = 3
pure def granted(entry: Redemption): bool = entry.phase == GrantedSession or entry.phase == GrantedMfa
pure def holdsLock(entry: Redemption): bool = entry.phase == Locked or entry.phase == CodeConsumed or entry.phase == CodeMissing
pure def alwaysOneLockOwnerWithMatchingBindings(s: GoogleSignIn): bool =
  s.redemptions.every(r => (holdsLock(r) iff s.lockOwner == r.id) and (s.lockOwner == r.id implies r.binding == AllBindingsMatch)) and (s.lockOwner == 0 or s.redemptions.some(r => r.id == s.lockOwner))
pure def alwaysAtMostOneGrant(s: GoogleSignIn): bool = s.redemptions.select(r => granted(r)).length() <= 1
pure def alwaysGrantFollowsLiveConsume(s: GoogleSignIn): bool =
  s.redemptions.every(r => (granted(r) or r.phase == CodeConsumed) implies (s.spentBy == r.id and r.binding == AllBindingsMatch and not(s.codePresent) and s.spentAt >= 0 and s.spentAt < s.storeExpiresAt))
pure def alwaysGrantUsesIssuedLane(s: GoogleSignIn): bool =
  s.redemptions.every(r => (r.phase == GrantedSession implies s.lane == SessionLane) and (r.phase == GrantedMfa implies s.lane == MfaLane))
pure def alwaysWrongBindingSpendsNothing(s: GoogleSignIn): bool =
  s.redemptions.every(r => r.binding != AllBindingsMatch implies s.spentBy != r.id) and s.redemptions.every(r => r.id > 0 and r.id < s.nextRedemption)
pure def sometimesContenderRefusedAsBusy(s: GoogleSignIn): bool = s.redemptions.some(r => r.phase == LockBusy) and s.redemptions.some(r => granted(r))
pure def sometimesWrongBindingThenOwnerRedeems(s: GoogleSignIn): bool = s.redemptions.some(r => r.binding != AllBindingsMatch and r.phase == RedemptionRefused) and s.redemptions.some(r => granted(r) and r.fromHost)
```

### The host adopts the exchange reply only in the attempt epoch it was dispatched in

Cancel advances the epoch and clears the attempt at once; a reply that
arrives later ends nothing more than the cancelled exchange, so it can
neither restore the attempt nor admit an MFA challenge. Cancellation settles
only after the exchange in flight has answered.

```quint
pure def hostRedemption(s: GoogleSignIn): Redemption = s.redemptions.select(r => r.fromHost).nthOr(0, noRedemption)
pure def settledForHost(entry: Redemption): bool = granted(entry) or entry.phase == RedemptionRefused or entry.phase == LockBusy
pure def canHostReceivesReply(s: GoogleSignIn): bool = s.exchangeInFlight and settledForHost(hostRedemption(s))
pure def hostReceivesReply(s: GoogleSignIn): GoogleSignIn = {
  val r = hostRedemption(s)
  if (s.ticket != s.epoch) { ...s, exchangeInFlight: false, phase: NoAttempt, lastResult: ReplyAfterCancel }
  else if (r.phase == GrantedMfa) { ...s, exchangeInFlight: false, phase: MfaAdmitted, lastResult: ExchangeDispatched }
  else if (r.phase == GrantedSession) { ...s, exchangeInFlight: false, phase: SignedIn, lastResult: ExchangeDispatched }
  else { ...s, exchangeInFlight: false, phase: AttemptSpent, lastResult: ExchangeFailed }
}
pure def canCancel(s: GoogleSignIn): bool = not(s.cancelling)
pure def cancel(s: GoogleSignIn): GoogleSignIn =
  { ...s, epoch: s.epoch + 1, phase: if (s.exchangeInFlight) Exchanging else NoAttempt, verifierLive: false, cancelling: true, lastResult: CancelRequested }
pure def canFinishCancel(s: GoogleSignIn): bool = s.cancelling and not(s.exchangeInFlight)
pure def finishCancel(s: GoogleSignIn): GoogleSignIn = { ...s, cancelling: false, phase: NoAttempt, lastResult: CancelSettled }
pure def alwaysAdmissionNeedsCurrentEpoch(s: GoogleSignIn): bool =
  ((s.phase == MfaAdmitted or s.phase == SignedIn) implies (s.ticket == s.epoch and not(s.cancelling))) and (s.lastResult == ReplyAfterCancel implies (s.phase == NoAttempt and not(s.verifierLive)))
pure def alwaysCancellingHoldsNoVerifier(s: GoogleSignIn): bool = s.cancelling implies (not(s.verifierLive) and s.phase != MfaAdmitted and s.phase != SignedIn)
pure def sometimesMfaAdmitted(s: GoogleSignIn): bool = s.phase == MfaAdmitted
pure def sometimesReplyAfterCancel(s: GoogleSignIn): bool = s.lastResult == ReplyAfterCancel
```

### An exchange in flight and a cancellation both settle

```quint
pure val fair_validate = "weak"
pure val fair_acquire = "weak"
pure val fair_consumeCode = "weak"
pure val fair_reply = "weak"
pure val fair_hostReceivesReply = "weak"
pure val fair_finishCancel = "weak"
pure def leadsToExchangeSettles(s: GoogleSignIn, later: GoogleSignIn): bool = s.exchangeInFlight implies not(later.exchangeInFlight)
pure def leadsToCancelSettles(s: GoogleSignIn, later: GoogleSignIn): bool = s.cancelling implies not(later.cancelling)
```
