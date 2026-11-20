# Device keys

One device's key, from the approval that issues its one-time code to the
end of the key. A signed-in session connects a registered client (`POST
/api/v1/app-auth/connect`) and gets a code `emac_` + 64 hex that lives five
minutes; the device exchanges it with its PKCE verifier (`POST
/api/v1/app-auth/mobile/token`) for a key `eliza_mobile_` + 64 hex, and
acknowledges the key once it has stored it (`POST
/api/v1/app-auth/mobile/ack`). Only an acknowledged key is ever accepted, and
it is never renewed: a new sign-in gives a new key. `DELETE
/api/v1/api-keys/current` ends the presenting key. The device's own Google
account does connect and exchange in one call (`POST
/api/v1/app-auth/mobile/google`). The device half is
`spec/os/signIn/credential.md`.

One machine instance is one grant row. The shell draws the code, the key and
the credential id at random, stores only digests and a sealed copy of the
key (`Sealed` with purpose `DeviceKeyCopy`), and hands the key out only in
the token and native sign-in answers; the key never enters the model. A code
digest with no row answers `401 authentication_required` reason
`credential_unknown` before this machine. The person's device epoch lives on
the account and enters each check as the observation `deviceEpoch`, read
under the account lock; the shell never lowers it. The optional device name
(1 to 80 characters) and the scopes are stored with the grant and checked by
the Effect Schema. Sources are develop
`packages/cloud/shared/src/lib/services/mobile-app-auth.ts`,
`packages/cloud/api/v1/app-auth/**`, `api/v1/api-keys/current` and the Quint
models `MobileAppCredential` and `MobileAppGrantCleanup`.

## Story: Sign a device in and keep its key

> As a person signing in on my phone, I want the app to get one key that only
> it can collect, and a lost reply never to cost me the sign-in or leave a
> second key behind, so that my device keeps working for the client's whole
> key lifetime.

### A signed-in session connects a registered client with S256 and a state, and gets a code that lives five minutes

Connect is a Session route: a device key cannot connect another device. The
client is admitted with its sign-in return (`registry`), and the grant takes
the registration's key lifetime and the person's current device epoch.

```quint
import types.* from "../shared/types"
import rateLimit as R from "../shared/rateLimit"
import registry as N from "./registry"
import sessions as Iss from "../identity/sessions"
import federatedSignIn as G from "../identity/federatedSignIn"
type EndCause = NeverExchanged | NeverAcknowledged | SelfRevoked
type GrantPhase = Unissued | CodeIssued | Exchanged | Active({ ackedAt: Millis, keyExpiresAt: Millis }) | Expired | Ended({ endedBy: EndCause })
type GoogleLink = NoServerCode | WithServerCode
type GrantOrigin = NotConnected | Connected | NativeGoogle({ serverCode: GoogleLink })
type Grant = { phase: GrantPhase, origin: GrantOrigin, codeExpiresAt: Millis, credentialTtl: Millis, credentialId: str, epoch: int, now: Millis }
type GrantEffect = MintSealedKey | AnswerFromSealedCopy | EraseSealedCopy | LinkGoogle
type GrantStep = { state: Grant, out: List[GrantEffect] }
type CodeRequest = { client: N::ClientCheck, method: G::PkceMethod, hasState: bool }
pure val codeLifetime: Millis = 5 * millisPerMinute
pure val initial: Grant = { phase: Unissued, origin: NotConnected, codeExpiresAt: 0, credentialTtl: 0, credentialId: "", epoch: 0, now: 0 }
pure def codeRequestFits(r: CodeRequest): bool = r.client == N::ClientAdmitted and r.method == G::S256 and r.hasState
pure def ttlFits(ttl: Millis): bool = ttl >= N::minCredentialTtl and ttl <= N::maxCredentialTtl
pure def canConnect(g: Grant, view: Iss::CredentialView, codeRequest: CodeRequest, credentialTtl: Millis): bool =
  g.phase == Unissued and Iss::admitRequest(view, Iss::SignedSession, g.now) == Iss::CredentialAccepted and codeRequestFits(codeRequest) and ttlFits(credentialTtl)
pure def connect(g: Grant, view: Iss::CredentialView, codeRequest: CodeRequest, credentialTtl: Millis, deviceEpoch: int): Grant =
  { ...g, phase: CodeIssued, origin: Connected, codeExpiresAt: g.now + codeLifetime, credentialTtl: credentialTtl, epoch: deviceEpoch }
pure def canElapse(g: Grant, elapsed: Millis): bool = elapsed > 0
pure def elapse(g: Grant, elapsed: Millis): Grant = { ...g, now: g.now + elapsed }
pure val codeRequestValues: Set[CodeRequest] = {
  val ok: CodeRequest = { client: N::ClientAdmitted, method: G::S256, hasState: true }
  Set(ok, { ...ok, method: G::PlainMethod }, { ...ok, client: N::ClientRefused({ fault: N::DisabledClient }) })
}
pure val credentialTtlValues = Set(N::minCredentialTtl, N::defaultCredentialTtl)
pure val deviceEpochValues = Set(0, 1)
pure val elapsedValues = Set(1, 300000, 2592000000)
pure val weight_connect = 3
pure def alwaysAGrantKeepsItsClientsLifetimes(g: Grant): bool =
  g.now >= 0 and ((g.phase == Unissued) iff (g.origin == NotConnected))
  and (g.phase != Unissued implies (g.codeExpiresAt <= g.now + codeLifetime and ttlFits(g.credentialTtl)))
```

### The device's own Google account signs in with one call that connects and exchanges at once, or asks for the second factor

The client is admitted with its sign-in return and native Google
(`registry`), and the challenge is spent by `federatedSignIn` in the same
transaction. A person with a second factor gets `{status: "mfa_required",
challengeId, methods, expiresAt}` and nothing is issued; after the factor the
app connects with the new session. Otherwise the answer is `{status:
"signed_in"}` with the token answer, `secret`, `tokenType: "Bearer"`,
`scopes`, `acknowledgementRequired: true`, the `code` to acknowledge with,
`accountCreated`, `identity` and `google`. A server auth code links the
Google connection (`services/google/connection`) in the same request; its
outcome fills only `google`, so a failed link never fails the sign-in.

```quint
type NativeOutcome = NativeSignedIn | NativeMfaRequired | NativeRefused({ refusal: Refusal })
pure def clientRefusal(client: N::ClientCheck): Refusal =
  if (client == N::ClientRefused({ fault: N::UnknownClient })) N::faultRefusal(N::UnknownClient)
  else if (client == N::ClientRefused({ fault: N::DisabledClient })) N::faultRefusal(N::DisabledClient)
  else N::faultRefusal(N::WrongRedirect)
pure def codeRequestRefusal(r: CodeRequest): Refusal = if (r.client != N::ClientAdmitted) clientRefusal(r.client) else refuse(InvalidRequest)
pure def nativeOutcome(codeRequest: CodeRequest, nativeGoogle: N::NativeGoogleCheck, verdict: G::NativeVerdict, yielded: G::SignInYield): NativeOutcome =
  if (not(codeRequestFits(codeRequest))) NativeRefused({ refusal: codeRequestRefusal(codeRequest) })
  else if (nativeGoogle != N::NativeGoogleOpen) NativeRefused({ refusal: N::nativeGoogleRefusal(nativeGoogle) })
  else if (verdict != G::NativeAccepted) NativeRefused({ refusal: G::nativeRefusal(verdict) })
  else if (yielded == G::SecondFactorYield) NativeMfaRequired
  else if (yielded == G::DeviceKeyYield) NativeSignedIn
  else NativeRefused({ refusal: refuse(InvalidRequest) })
pure def canSignInNatively(g: Grant, codeRequest: CodeRequest, nativeGoogle: N::NativeGoogleCheck, verdict: G::NativeVerdict, yielded: G::SignInYield, credentialTtl: Millis, credentialId: str): bool =
  g.phase == Unissued and nativeOutcome(codeRequest, nativeGoogle, verdict, yielded) == NativeSignedIn and ttlFits(credentialTtl) and credentialId != ""
pure def signInNatively(g: Grant, codeRequest: CodeRequest, nativeGoogle: N::NativeGoogleCheck, verdict: G::NativeVerdict, yielded: G::SignInYield, serverCode: GoogleLink, credentialTtl: Millis, credentialId: str, deviceEpoch: int): GrantStep =
  { state: { ...g, phase: Exchanged, origin: NativeGoogle({ serverCode: serverCode }), codeExpiresAt: g.now + codeLifetime, credentialTtl: credentialTtl, credentialId: credentialId, epoch: deviceEpoch },
    out: if (serverCode == WithServerCode) List(MintSealedKey, LinkGoogle) else List(MintSealedKey) }
pure val nativeGoogleValues = Set(N::NativeGoogleOpen, N::GoogleNotOffered)
pure val verdictValues = Set(G::NativeAccepted, G::NativeProofWrong)
pure val yieldedValues = Set(G::DeviceKeyYield, G::SecondFactorYield)
pure val credentialIdValues = Set("k1", "k2")
pure val weight_signInNatively = 3
pure def lawANativeRefusalIsFinal(codeRequest: CodeRequest, nativeGoogle: N::NativeGoogleCheck, verdict: G::NativeVerdict, yielded: G::SignInYield): bool = {
  val o = nativeOutcome(codeRequest, nativeGoogle, verdict, yielded)
  match o { | NativeRefused(x) => wellFormed(x.refusal) and not(retryableOf(x.refusal)) | _ => true }
}
pure def sometimesNativeKeyWithGoogle(g: Grant): bool = isLive(g) and g.origin == NativeGoogle({ serverCode: WithServerCode })
```

### A code is exchanged only with its own client, return, state and verifier before its deadline, and mints one key

The first exchange mints the key, keeps a sealed copy and answers
`{credentialId, secret, tokenType, expiresAt, expiresIn, scopes,
acknowledgementRequired: true, acknowledgeBy}`; `expiresAt` there is the
earliest the key can end, since its lifetime runs from the acknowledgement.
Exchanging again before the acknowledgement answers the same credential from
the sealed copy, so a lost reply is asked again with the same code and
verifier. A wrong return, state or verifier is `401 credential_proof_invalid`
and spends nothing; a code past its deadline is `credential_expired`, one
whose person's device keys were revoked since `credential_revoked`, and a
spent code `credential_unknown`.

```quint
type GrantOutcome = Granted | GrantRefused({ refusal: Refusal })
type TokenAnswer = { credentialId: str, expiresAt: Millis, acknowledgeBy: Millis }
pure def isCodePending(g: Grant): bool = g.phase == CodeIssued or g.phase == Exchanged
pure def revokedSince(g: Grant, deviceEpoch: int): bool = deviceEpoch > g.epoch
pure def refusedFor(reason: RefusalReason): GrantOutcome = GrantRefused({ refusal: refuseFor(AuthenticationRequired, reason) })
pure def lapsed(g: Grant): bool = g.phase == Ended({ endedBy: NeverExchanged }) or g.phase == Ended({ endedBy: NeverAcknowledged })
pure def tokenOutcome(g: Grant, client: N::ClientCheck, binding: G::CodeBinding, deviceEpoch: int): GrantOutcome =
  if (client != N::ClientAdmitted) GrantRefused({ refusal: clientRefusal(client) })
  else if (not(isCodePending(g))) refusedFor(if (lapsed(g)) CredentialExpired else CredentialUnknown)
  else if (g.now >= g.codeExpiresAt) refusedFor(CredentialExpired)
  else if (revokedSince(g, deviceEpoch)) refusedFor(CredentialRevoked)
  else if (binding != G::BindingMatches) GrantRefused({ refusal: refuse(CredentialProofInvalid) })
  else Granted
pure def canToken(g: Grant, client: N::ClientCheck, binding: G::CodeBinding, credentialId: str, deviceEpoch: int): bool =
  tokenOutcome(g, client, binding, deviceEpoch) == Granted and credentialId != ""
pure def token(g: Grant, client: N::ClientCheck, binding: G::CodeBinding, credentialId: str, deviceEpoch: int): GrantStep =
  if (g.phase == CodeIssued) { state: { ...g, phase: Exchanged, credentialId: credentialId }, out: List(MintSealedKey) }
  else { state: g, out: List(AnswerFromSealedCopy) }
pure def tokenAnswer(g: Grant): TokenAnswer = { credentialId: g.credentialId, expiresAt: g.now + g.credentialTtl, acknowledgeBy: g.codeExpiresAt }
pure val clientValues = Set(N::ClientAdmitted, N::ClientRefused({ fault: N::WrongRedirect }))
pure val weight_token = 3
pure def hasCredential(g: Grant): bool = g.phase != Unissued and g.phase != CodeIssued and g.phase != Ended({ endedBy: NeverExchanged })
pure def alwaysACredentialExistsExactlyOnceExchanged(g: Grant): bool = hasCredential(g) iff g.credentialId != ""
```

### Until the acknowledgement, the sealed copy is the only way a key is answered again, and nothing mints a second key

Only the first exchange or the native sign-in mints the key and seals it; a
repeated exchange answers from the copy and changes nothing; the
acknowledgement or the grant lapsing erases it. So an acknowledged key is
never revealed again, and a credential keeps its id.

```quint
pure def stepTheSealedCopyLivesOnlyUntilTheAcknowledgement(before: Grant, via: str, after: Grant, out: List[GrantEffect]): bool =
  (out.includes(MintSealedKey) iff (before.phase != Exchanged and after.phase == Exchanged))
  and (out.includes(EraseSealedCopy) iff (before.phase == Exchanged and after.phase != Exchanged))
  and (out.includes(AnswerFromSealedCopy) implies (before.phase == Exchanged and after == before))
  and (before.credentialId != "" implies after.credentialId == before.credentialId)
pure def sometimesAwaitingAcknowledgement(g: Grant): bool = g.phase == Exchanged and g.origin == Connected
```

### A key becomes usable only when acknowledged before its code's deadline, and then lives the client's key lifetime

The acknowledgement proves the code, verifier, credential id and key
(`proofMatches`), names the client of its grant, and answers `{status:
"acknowledged", credentialId, expiresAt, scopes}`; a repeated one with the
right proof while the key is live answers the same and changes nothing. A
wrong proof is `401 credential_proof_invalid`. A key not acknowledged in time
is never usable.

```quint
type AckAnswer = { credentialId: str, expiresAt: Millis }
pure def ackOutcome(g: Grant, client: N::ClientCheck, proofMatches: bool, deviceEpoch: int): GrantOutcome = {
  val p = g.phase
  if (client != N::ClientAdmitted) GrantRefused({ refusal: clientRefusal(client) })
  else match p {
    | Exchanged => if (g.now >= g.codeExpiresAt) refusedFor(CredentialExpired) else if (revokedSince(g, deviceEpoch)) refusedFor(CredentialRevoked)
        else if (proofMatches) Granted else GrantRefused({ refusal: refuse(CredentialProofInvalid) })
    | Active(a) => if (revokedSince(g, deviceEpoch)) refusedFor(CredentialRevoked) else if (g.now >= a.keyExpiresAt) refusedFor(CredentialExpired)
        else if (proofMatches) Granted else GrantRefused({ refusal: refuse(CredentialProofInvalid) })
    | CodeIssued => if (g.now >= g.codeExpiresAt) refusedFor(CredentialExpired) else GrantRefused({ refusal: refuse(CredentialProofInvalid) })
    | Ended(e) => refusedFor(if (e.endedBy == SelfRevoked) CredentialRevoked else CredentialExpired)
    | Expired => refusedFor(CredentialExpired)
    | Unissued => refusedFor(CredentialUnknown)
  }
}
pure def canAck(g: Grant, client: N::ClientCheck, proofMatches: bool, deviceEpoch: int): bool = ackOutcome(g, client, proofMatches, deviceEpoch) == Granted
pure def ack(g: Grant, client: N::ClientCheck, proofMatches: bool, deviceEpoch: int): GrantStep =
  if (g.phase == Exchanged) { state: { ...g, phase: Active({ ackedAt: g.now, keyExpiresAt: g.now + g.credentialTtl }) }, out: List(EraseSealedCopy) }
  else { state: g, out: List() }
pure def ackAnswer(g: Grant): AckAnswer = { val p = g.phase  { credentialId: g.credentialId, expiresAt: match p { | Active(a) => a.keyExpiresAt | _ => 0 } } }
pure def isActivePhase(g: Grant): bool = { val p = g.phase  match p { | Active(a) => true | _ => false } }
pure def isLive(g: Grant): bool = { val p = g.phase  match p { | Active(a) => g.now < a.keyExpiresAt | _ => false } }
pure val weight_ack = 3
pure def alwaysAKeyWasAcknowledgedInTime(g: Grant): bool = {
  val p = g.phase
  match p { | Active(a) => a.ackedAt < g.codeExpiresAt and a.ackedAt <= g.now and a.keyExpiresAt == a.ackedAt + g.credentialTtl | _ => true }
}
pure def stepOnlyAnAcknowledgementActivatesAKey(before: Grant, via: str, after: Grant): bool =
  (isActivePhase(after) and not(isActivePhase(before))) implies (via == "ack" and before.phase == Exchanged and before.now < before.codeExpiresAt)
pure def lawEveryExchangeAndAcknowledgementRefusalIsFinal(g: Grant, client: N::ClientCheck, binding: G::CodeBinding, proofMatches: bool, deviceEpoch: int): bool = {
  val t = tokenOutcome(g, client, binding, deviceEpoch)
  val k = ackOutcome(g, client, proofMatches, deviceEpoch)
  (match t { | GrantRefused(x) => wellFormed(x.refusal) and not(retryableOf(x.refusal)) | Granted => true })
  and (match k { | GrantRefused(y) => wellFormed(y.refusal) and not(retryableOf(y.refusal)) | Granted => true })
}
pure val gValues: Set[Grant] = {
  val live: Grant = { phase: Active({ ackedAt: 0, keyExpiresAt: 86400000 }), origin: Connected, codeExpiresAt: 300000, credentialTtl: 86400000, credentialId: "k1", epoch: 0, now: 0 }
  Set(live, { ...live, phase: Exchanged }, { ...live, phase: Expired }, { ...live, phase: Ended({ endedBy: SelfRevoked }) }, { ...live, phase: CodeIssued, credentialId: "" }, { ...live, epoch: 1 })
}
pure def sometimesKeyActive(g: Grant): bool = isLive(g) and g.origin == Connected
```

### A client address may exchange or acknowledge ten times a minute

The native sign-in counts against the exchange limit. Over the limit the
answer is `429 rate_limited` from `rateLimit`, before any grant is read.

```quint
pure val tokenPerIp: R::RateLimit = R::perMinute("deviceKeyTokenPerIp", 10)
pure val ackPerIp: R::RateLimit = R::perMinute("deviceKeyAckPerIp", 10)
```

## Story: Sign a device out

> As a person, I want signing out on a device to end its key at once, and
> support to end every key of mine when I lose a device or delete my
> account, so that a lost or old device stops working the moment it matters.

### A key is accepted only while acknowledged, unexpired and of the person's current device epoch

`requestAuth` refuses every other key `401 authentication_required`: an
unacknowledged or lapsed key is unknown, a key signed out or issued before
the person's current device epoch is revoked, and an acknowledged key past
its lifetime is expired. The shell answers `credential_unknown` for a key
whose row is gone.

```quint
pure def keyRefusal(g: Grant, now: Millis, deviceEpoch: int): RefusalReason = {
  val p = g.phase
  match p {
    | Active(a) => if (revokedSince(g, deviceEpoch)) CredentialRevoked else if (now >= a.keyExpiresAt) CredentialExpired else NoReason
    | Expired => if (revokedSince(g, deviceEpoch)) CredentialRevoked else CredentialExpired
    | Ended(e) => if (e.endedBy == SelfRevoked) CredentialRevoked else CredentialUnknown
    | _ => CredentialUnknown
  }
}
pure def lawNoLaterEpochRevivesAKey(g: Grant, now: Millis, deviceEpoch: int, laterEpoch: int): bool =
  (laterEpoch >= deviceEpoch and keyRefusal(g, now, deviceEpoch) == CredentialRevoked) implies keyRefusal(g, now, laterEpoch) == CredentialRevoked
```

### Signing out ends only the presenting key

`DELETE /api/v1/api-keys/current`, admitted by the key itself, answers `204`;
a repeat answers `401 credential_revoked`, which the device takes as done.

```quint
pure def canSelfRevoke(g: Grant, deviceEpoch: int): bool = keyRefusal(g, g.now, deviceEpoch) == NoReason
pure def selfRevoke(g: Grant, deviceEpoch: int): Grant = { ...g, phase: Ended({ endedBy: SelfRevoked }) }
pure def sometimesSignedOut(g: Grant): bool = g.phase == Ended({ endedBy: SelfRevoked })
```

### Ending every key of a person moves the person's device epoch, which revokes every key issued before it

The operator's `account revoke-devices` and account deletion emit
`revokeAll` and apply it to the account in their own transaction; sessions
are revoked separately (`identity/sessions`). A grant still waiting for its
exchange or acknowledgement is refused as well.

```quint
type DeviceKeysRevoked = { toDeviceEpoch: int }
pure def revokeAll(deviceEpoch: int): DeviceKeysRevoked = { toDeviceEpoch: deviceEpoch + 1 }
pure def lawRevokeAllEndsEveryEarlierKey(g: Grant, now: Millis, deviceEpoch: int, client: N::ClientCheck, binding: G::CodeBinding, proofMatches: bool): bool = {
  val toEpoch = revokeAll(deviceEpoch).toDeviceEpoch
  g.epoch <= deviceEpoch implies (keyRefusal(g, now, toEpoch) != NoReason and tokenOutcome(g, client, binding, toEpoch) != Granted and ackOutcome(g, client, proofMatches, toEpoch) != Granted)
}
```

## Story: Keep no grant longer than it can be used

> As the operator, I want unused codes and keys that were never collected
> cleared away, and no sweep ever to end a key someone is still using, so
> that the store holds no idle secrets and no device is signed out by
> housekeeping.

### Cleanup ends a lapsed code or an unacknowledged grant, and closes an expired key, never a live one

A grant past its code deadline without an acknowledgement ends, its sealed
copy erased; an acknowledged key past its lifetime closes as expired. The
shell may then delete the row. Only signing out ends a live key, and a closed
grant never reopens.

```quint
pure def canLapse(g: Grant): bool = isCodePending(g) and g.now >= g.codeExpiresAt
pure def lapse(g: Grant): GrantStep =
  if (g.phase == Exchanged) { state: { ...g, phase: Ended({ endedBy: NeverAcknowledged }) }, out: List(EraseSealedCopy) }
  else { state: { ...g, phase: Ended({ endedBy: NeverExchanged }) }, out: List() }
pure def canExpire(g: Grant): bool = { val p = g.phase  match p { | Active(a) => g.now >= a.keyExpiresAt | _ => false } }
pure def expire(g: Grant): Grant = { ...g, phase: Expired }
pure def isClosed(g: Grant): bool = { val p = g.phase  match p { | Expired => true | Ended(e) => true | _ => false } }
pure def stepOnlySigningOutEndsALiveKey(before: Grant, via: str, after: Grant): bool =
  ((isLive(before) and not(isActivePhase(after))) implies via == "selfRevoke") and (isClosed(before) implies after.phase == before.phase)
pure def sometimesNeverAcknowledged(g: Grant): bool = g.phase == Ended({ endedBy: NeverAcknowledged })
pure def sometimesCodeLapsed(g: Grant): bool = g.phase == Ended({ endedBy: NeverExchanged })
pure def sometimesKeyExpired(g: Grant): bool = g.phase == Expired
```
