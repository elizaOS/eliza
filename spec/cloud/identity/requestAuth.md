# Request authentication

Who is calling, for every route of the cloud. Each route has one class, and
the class says what credential it needs:

| Class | Admits | Routes |
|---|---|---|
| Public | anyone; no credential is read | health, public service document, plans, entitlement keys, sign-in starts, return pages |
| Signature | anyone; the route verifies the provider's signature | the payment provider's webhook |
| Key or Session | a live device key or session | inference (with `/models`), speech, maps, Google native connect, billing reads (invoices too), checkout start and confirm, redeem, account read, referrals, self-revoke |
| Mail | a live session or device lease, never a device key | Google status, accounts, connect, disconnect and sign-in sessions; Gmail; inbox; calendar |
| Session | a live session | sign-in methods, factors, step-up send, connect |
| Fresh | a live session signed in or stepped up within 60 minutes | cancel, undo, upgrade, downgrade, payment continuation, portal |
| Step-up | a live session with a second factor within 5 minutes | unlink a method, change factors |
| Session family | an issued token for the same family | sign out here |

The Grace Google mount (`deployment`) answers its own paths before this
table. There a recorded device key may also connect natively and disconnect
its own owner's Google connection, and never another account's.

The session-family route checks an issued access or refresh token in its
header or body through the [session logout rules](./sessions.md). Its
digest selects the family for revocation. The admission model below covers
the other route classes and supplies a caller for their protected work.

These admission classes read their credential from
`Authorization: Bearer <token>`. The shell sorts the token by its shape: a
session token (`eliza_session_` + 43 base64url, `identity/sessions`), a
device lease's access token (`eliza_lease_` + 43 base64url, the same
`identity/sessions`) or a device key (`eliza_mobile_` + 64 hex,
`nativeClients/deviceKeys`); anything else, or no header, presents nothing. It matches the token's digest in the
store and reads the account's status and both revocation epochs in the same
store operation, and passes them here as the `Standing`. The token itself
never enters the model. The device half, which decides what a refusal means
on the device, is os `signIn/credential.md`. The source is develop
`packages/cloud/shared/src/lib/auth/` and `packages/cloud/api/src/bootstrap-app.ts`.

## Story: Admit a request only for a live credential of an active account

> As an account owner, I want the cloud to serve a request only for a
> credential of mine that is still live, and a billing or sign-in change
> only after I recently confirmed it is me, so that a lost device, a stolen
> token or a closed account stops working at once.

### Public and signed routes authenticate no one, and every other route needs a credential

```quint
import types.* from "../shared/types"
import rateLimit as R from "../shared/rateLimit"
import accounts as A from "./accounts"
import sessions as S from "./sessions"
import deviceKeys as Dk from "../nativeClients/deviceKeys"
import deployment as D from "../deployment"
type RouteClass = PublicRoute | SignatureRoute | KeyOrSessionRoute | MailRoute | SessionRoute | FreshRoute | StepUpRoute
type SessionLookup = NoFamily | FamilyRow({ family: S::Family, generation: int })
type KeyLookup = NoGrant | GrantRow({ grant: Dk::Grant })
type Presented = NoCredential | SessionBearer({ familyLookup: SessionLookup }) | KeyBearer({ window: R::Window, grantLookup: KeyLookup })
  | LeaseBearer({ window: R::Window, familyLookup: SessionLookup, grantLookup: KeyLookup })
type Standing = { status: A::AccountStatus, personEpoch: int, deviceEpoch: int }
type Admission = Anonymous | Caller({ kind: CredentialKind, expiresAt: Millis }) | Denied({ refusal: Refusal })
pure def isProtected(route: RouteClass): bool = route != PublicRoute and route != SignatureRoute
pure def isAnonymous(a: Admission): bool = match a { | Anonymous => true | _ => false }
pure def lawOnlyPublicAndSignedRoutesAuthenticateNoOne(route: RouteClass, presented: Presented, standing: Standing, now: Millis): bool =
  isAnonymous(admit(route, presented, standing, now)) iff not(isProtected(route))
```

### Every refusal is well formed, and a missing or unknown credential is refused 401 with credential_unknown

A device takes the reason as the custody owner's input: `credential_expired`
for a credential past its end, `credential_revoked` for one signed out,
revoked by an epoch move or of an account that is not Active, and
`credential_unknown` for anything else. The reason of a session is
`S::sessionRefusal`'s and of a device key `Dk::keyRefusal`'s.

```quint
pure def deniedFor(reason: RefusalReason): Admission = Denied({ refusal: refuseFor(AuthenticationRequired, reason) })
pure def admit(route: RouteClass, presented: Presented, standing: Standing, now: Millis): Admission =
  if (not(isProtected(route))) Anonymous
  else match presented {
    | NoCredential => deniedFor(CredentialUnknown)
    | SessionBearer(x) => sessionAdmission(route, x.familyLookup, standing, now)
    | KeyBearer(y) => keyAdmission(route, y.window, y.grantLookup, standing, now)
    | LeaseBearer(z) => leaseAdmission(route, z.window, z.familyLookup, z.grantLookup, standing, now)
  }
pure def lawEveryRefusalIsWellFormed(route: RouteClass, presented: Presented, standing: Standing, now: Millis): bool = {
  val a = admit(route, presented, standing, now)
  match a { | Denied(x) => wellFormed(x.refusal) | _ => true }
}
pure def lawAMissingOrUnknownCredentialIsUnknown(route: RouteClass, window: R::Window, standing: Standing, now: Millis): bool =
  (isProtected(route) and R::admitsAll(keyIngress(window), now)) implies (
    admit(route, NoCredential, standing, now) == deniedFor(CredentialUnknown)
    and admit(route, SessionBearer({ familyLookup: NoFamily }), standing, now) == deniedFor(CredentialUnknown)
    and admit(route, KeyBearer({ window: window, grantLookup: NoGrant }), standing, now) == deniedFor(CredentialUnknown)
    and admit(route, LeaseBearer({ window: window, familyLookup: NoFamily, grantLookup: NoGrant }), standing, now) == deniedFor(CredentialUnknown))
```

### A device key is limited to 120 requests a minute before it is looked up

The subject is a keyed digest of the presented key, never the key. A device
lease's access token is limited the same way, before its family is read. Over the
limit the answer is `429 rate_limited` with its retry time, and `503` when
the limiter cannot count; either way the key's row is not read.

```quint
pure val keyIngressLimit: R::RateLimit = R::perMinute("deviceKeyIngress", 120)
pure def keyIngress(window: R::Window): List[R::Check] = List({ window: window, rule: keyIngressLimit })
pure def keyAdmission(route: RouteClass, window: R::Window, lookup: KeyLookup, standing: Standing, now: Millis): Admission =
  if (not(R::admitsAll(keyIngress(window), now))) Denied({ refusal: R::groupRefusal(keyIngress(window), now) })
  else match lookup {
    | NoGrant => deniedFor(CredentialUnknown)
    | GrantRow(x) => grantAdmission(route, x.grant, standing, now)
  }
pure def lawAKeyOverItsLimitIsRefusedWhateverItsRow(route: RouteClass, window: R::Window, lookup: KeyLookup, otherLookup: KeyLookup, standing: Standing, now: Millis): bool =
  (isProtected(route) and not(R::admitsAll(keyIngress(window), now))) implies (
    admit(route, KeyBearer({ window: window, grantLookup: lookup }), standing, now) == admit(route, KeyBearer({ window: window, grantLookup: otherLookup }), standing, now)
    and admit(route, KeyBearer({ window: window, grantLookup: lookup }), standing, now) == Denied({ refusal: R::groupRefusal(keyIngress(window), now) }))
```

### A refused credential never yields a caller

A session is live when `sessions` accepts its presented generation at the
person's session epoch; a device key when it is acknowledged, unexpired and
of the person's current device epoch. Either needs an Active account. An
admitted caller carries its credential kind and the end of its credential,
which is after now: the access token's end for a session, the key's for a
device key.

```quint
pure def isActiveAccount(standing: Standing): bool = standing.status == A::Active
pure def sessionAdmission(route: RouteClass, familyLookup: SessionLookup, standing: Standing, now: Millis): Admission =
  match familyLookup {
    | NoFamily => deniedFor(CredentialUnknown)
    | FamilyRow(x) => familyAdmission(route, x.family, x.generation, standing, now)
  }
pure def grantAdmission(route: RouteClass, grant: Dk::Grant, standing: Standing, now: Millis): Admission = {
  val reason = Dk::keyRefusal(grant, now, standing.deviceEpoch)
  if (reason != NoReason) deniedFor(reason)
  else if (not(isActiveAccount(standing))) deniedFor(CredentialRevoked)
  else if (needsSession(route)) Denied({ refusal: refuse(AccessDenied) })
  else if (route == MailRoute) Denied({ refusal: refuseFor(AccessDenied, DeviceKeyNotAllowed) })
  else Caller({ kind: DeviceKeyCredential, expiresAt: Dk::ackAnswer(grant).expiresAt })
}
pure def liveFamily(family: S::Family, generation: int, standing: Standing, now: Millis): bool =
  S::accepts({ ...family, now: now }, generation, standing.personEpoch)
pure def liveGrant(grant: Dk::Grant, standing: Standing, now: Millis): bool =
  Dk::isLive({ ...grant, now: now }) and not(Dk::revokedSince(grant, standing.deviceEpoch))
pure def liveLookup(familyLookup: SessionLookup, standing: Standing, now: Millis): bool =
  match familyLookup { | FamilyRow(x) => not(S::isLease(x.family)) and liveFamily(x.family, x.generation, standing, now) | NoFamily => false }
pure def liveKeyLookup(lookup: KeyLookup, standing: Standing, now: Millis): bool =
  match lookup { | GrantRow(x) => liveGrant(x.grant, standing, now) | NoGrant => false }
pure def isLiveCredential(presented: Presented, standing: Standing, now: Millis): bool =
  isActiveAccount(standing) and match presented {
    | SessionBearer(x) => liveLookup(x.familyLookup, standing, now)
    | KeyBearer(y) => R::admitsAll(keyIngress(y.window), now) and liveKeyLookup(y.grantLookup, standing, now)
    | LeaseBearer(z) => R::admitsAll(keyIngress(z.window), now) and liveLeaseLookup(z.familyLookup, z.grantLookup, standing, now)
    | NoCredential => false
  }
pure def lawARefusedCredentialNeverYieldsACaller(route: RouteClass, presented: Presented, standing: Standing, now: Millis): bool = {
  val a = admit(route, presented, standing, now)
  match a { | Caller(x) => isLiveCredential(presented, standing, now) and x.expiresAt > now | _ => true }
}
pure def lawAnInactiveAccountIsRevoked(route: RouteClass, presented: Presented, standing: Standing, now: Millis): bool =
  (isProtected(route) and not(isActiveAccount(standing)) and isLiveCredential(presented, { ...standing, status: A::Active }, now))
    implies admit(route, presented, standing, now) == deniedFor(CredentialRevoked)
```

### A failed credential or revocation lookup is an outage, never a credential refusal

The store operation that matches the token's digest and reads the account's
status and revocation epochs can fail. Then nothing is known about the
credential: the request is refused `503 service_unavailable`, retryable, with
a retry time five seconds on, and never `401 authentication_required`. A
device that took the outage for a credential verdict would discard a live
session or device key and sign the person out while the store is down.

```quint
type LookupRead = LookupAnswered({ presented: Presented, standing: Standing }) | LookupFailed
pure val lookupRetryMs: Millis = 5000
pure def lookupOutage(now: Millis): Admission = Denied({ refusal: refuseUntil(ServiceUnavailable, now + lookupRetryMs) })
pure def admitLookup(route: RouteClass, read: LookupRead, now: Millis): Admission =
  if (not(isProtected(route))) Anonymous
  else match read {
    | LookupAnswered(x) => admit(route, x.presented, x.standing, now)
    | LookupFailed => lookupOutage(now)
  }
pure def isCredentialRefusal(a: Admission): bool = match a { | Denied(x) => x.refusal.code == AuthenticationRequired | _ => false }
pure def lawAFailedLookupIsAnOutageNeverACredentialRefusal(route: RouteClass, now: Millis): bool = {
  val a = admitLookup(route, LookupFailed, now)
  isProtected(route) implies (a == lookupOutage(now) and not(isCredentialRefusal(a))
    and match a { | Denied(x) => wellFormed(x.refusal) and retryableOf(x.refusal) | _ => false })
}
pure def lawAnAnsweredLookupIsAdmittedAsBefore(route: RouteClass, presented: Presented, standing: Standing, now: Millis): bool =
  admitLookup(route, LookupAnswered({ presented: presented, standing: standing }), now) == admit(route, presented, standing, now)
```

### Session, fresh and step-up routes admit only a session, and only with the assurance they name

A live device key on such a route is refused `403 access_denied`, so a
device never takes it for a signed-out key. A live session that is not fresh
enough is refused `428 fresh_session_required`, which asks for a step-up
rather than a new sign-in. Freshness and step-up are `S::isFresh` and
`S::isSteppedUp` at the request's time.

```quint
pure def needsSession(route: RouteClass): bool = Set(SessionRoute, FreshRoute, StepUpRoute).contains(route)
pure def hasAssurance(route: RouteClass, f: S::Family): bool =
  if (route == FreshRoute) S::isFresh(f) else if (route == StepUpRoute) S::isSteppedUp(f) else true
pure def familyAdmission(route: RouteClass, family: S::Family, generation: int, standing: Standing, now: Millis): Admission = {
  val f = { ...family, now: now }
  val reason = if (S::isLease(f)) CredentialUnknown else S::sessionRefusal(generation, f, standing.personEpoch)
  if (reason != NoReason) deniedFor(reason)
  else if (not(isActiveAccount(standing))) deniedFor(CredentialRevoked)
  else if (not(hasAssurance(route, f))) Denied({ refusal: refuse(FreshSessionRequired) })
  else Caller({ kind: SessionCredential, expiresAt: f.accessExpiresAt })
}
pure def lawSessionRoutesAdmitOnlyAssuredSessions(route: RouteClass, family: S::Family, generation: int, standing: Standing, now: Millis): bool = {
  val a = admit(route, SessionBearer({ familyLookup: FamilyRow({ family: family, generation: generation }) }), standing, now)
  val live = liveFamily(family, generation, standing, now) and isActiveAccount(standing)
  val assured = hasAssurance(route, { ...family, now: now })
  (needsSession(route) and live and not(S::isLease(family))) implies (a == (if (assured) Caller({ kind: SessionCredential, expiresAt: family.accessExpiresAt }) else Denied({ refusal: refuse(FreshSessionRequired) })))
}
pure def lawADeviceKeyNeverPassesASessionRoute(route: RouteClass, presented: Presented, standing: Standing, now: Millis): bool = {
  val a = admit(route, presented, standing, now)
  needsSession(route) implies match a { | Caller(x) => x.kind == SessionCredential | _ => true }
}
pure val signedIn: S::Family = { kind: S::BrowserFamily, phase: S::Live, generation: 1, rotation: S::Settled, epoch: 0, seenEpoch: 0, authAt: 0, issuedAt: 0, accessExpiresAt: 900000,
  refreshExpiresAt: 2592000000, stepUpAt: S::Never, mfaAt: S::Never, now: 0 }
pure val leased: S::Family = { ...signedIn, kind: S::DeviceLease({ grantKey: "g1" }), generation: 2, rotation: S::Offering({ offeredAt: 3600000, answers: 1 }),
  issuedAt: 0, accessExpiresAt: 900000, refreshExpiresAt: 7779600000 }
pure val familyValues: Set[S::Family] = Set(signedIn, { ...signedIn, mfaAt: S::At({ ms: 0 }) }, { ...signedIn, phase: S::Revoked },
  { ...signedIn, generation: 2, issuedAt: 3600000, accessExpiresAt: 4500000 }, leased, { ...leased, phase: S::Revoked })
pure val generationValues = Set(1, 2)
pure val nowValues = Set(1000, 4000000)
pure val keyed: Dk::Grant = { phase: Dk::Active({ ackedAt: 0, keyExpiresAt: 86400000 }), origin: Dk::Connected,
  client: Dk::BoundClient({ clientId: "app.one", environment: D::Staging, signInReturn: { origin: "https://www.staging.example.com", path: "/apps/conformance-1/sign-in" } }), codeExpiresAt: 300000,
  credentialTtl: 86400000, credentialId: "k1", epoch: 0, now: 0 }
pure val lookupValues: Set[KeyLookup] = Set(NoGrant, GrantRow({ grant: keyed }), GrantRow({ grant: { ...keyed, phase: Dk::Expired } }))
pure val otherLookupValues: Set[KeyLookup] = Set(NoGrant, GrantRow({ grant: keyed }))
pure val fullWindow: R::Window = { start: 0, end: 60000, count: 120, ceiling: 120, clock: 0, last: R::Admitted }
pure val windowValues: Set[R::Window] = Set(R::initial, fullWindow)
pure val standingValues: Set[Standing] = Set({ status: A::Active, personEpoch: 0, deviceEpoch: 0 },
  { status: A::Active, personEpoch: 1, deviceEpoch: 1 }, { status: A::Deleting, personEpoch: 0, deviceEpoch: 0 })
pure val presentedValues: Set[Presented] = Set(NoCredential,
  SessionBearer({ familyLookup: NoFamily }), SessionBearer({ familyLookup: FamilyRow({ family: signedIn, generation: 1 }) }),
  SessionBearer({ familyLookup: FamilyRow({ family: { ...signedIn, mfaAt: S::At({ ms: 0 }) }, generation: 1 }) }),
  SessionBearer({ familyLookup: FamilyRow({ family: { ...signedIn, generation: 2, issuedAt: 3600000, accessExpiresAt: 4500000 }, generation: 2 }) }),
  KeyBearer({ window: R::initial, grantLookup: GrantRow({ grant: keyed }) }), KeyBearer({ window: fullWindow, grantLookup: GrantRow({ grant: keyed }) }),
  KeyBearer({ window: R::initial, grantLookup: NoGrant }),
  LeaseBearer({ window: R::initial, familyLookup: FamilyRow({ family: leased, generation: 2 }), grantLookup: GrantRow({ grant: keyed }) }),
  LeaseBearer({ window: R::initial, familyLookup: FamilyRow({ family: leased, generation: 3 }), grantLookup: GrantRow({ grant: { ...keyed, phase: Dk::Expired } }) }),
  LeaseBearer({ window: R::initial, familyLookup: FamilyRow({ family: leased, generation: 3 }), grantLookup: GrantRow({ grant: { ...keyed, epoch: 1 } }) }),
  LeaseBearer({ window: fullWindow, familyLookup: FamilyRow({ family: leased, generation: 2 }), grantLookup: GrantRow({ grant: keyed }) }),
  LeaseBearer({ window: R::initial, familyLookup: FamilyRow({ family: signedIn, generation: 1 }), grantLookup: GrantRow({ grant: keyed }) }))
```

### A mail or calendar route admits a session or a device lease, and never the device key

A live device key on a Mail route is refused `403 access_denied` with reason
`device_key_not_allowed`: the on-device agent holds the key and reads
untrusted mail, so it never reaches mail with it. A device lease is accepted
only when its family is live, the presented generation is the current or the
offered one and its access token has not expired (`S::sessionRefusal`), the
family's epoch is the person's session epoch, the account is active, and its
bound grant is not ended and of the person's current device epoch; the key's
own expiry does not end the lease. Refusals use the credential reasons of a
session. A device lease passes no other route: anywhere else it is refused
`403 access_denied`. The caller's credential ends with the presented access
token. These are the server table's routes; on the Grace Google mount
(`deployment`) the recorded device key may also connect natively and
disconnect only its own owner's connection, never another account's.

```quint
pure def grantEnded(g: Dk::Grant): bool = Dk::isClosed(g) and g.phase != Dk::Expired
pure def boundGrantRefusal(grantLookup: KeyLookup, standing: Standing): RefusalReason =
  match grantLookup {
    | NoGrant => CredentialRevoked
    | GrantRow(x) => if (Dk::revokedSince(x.grant, standing.deviceEpoch) or grantEnded(x.grant)) CredentialRevoked else NoReason
  }
pure def leaseFamilyAdmission(route: RouteClass, family: S::Family, generation: int, grantLookup: KeyLookup, standing: Standing, now: Millis): Admission = {
  val f = { ...family, now: now }
  val reason = if (not(S::isLease(f))) CredentialUnknown else S::sessionRefusal(generation, f, standing.personEpoch)
  val bound = boundGrantRefusal(grantLookup, standing)
  if (reason != NoReason) deniedFor(reason)
  else if (bound != NoReason) deniedFor(bound)
  else if (not(isActiveAccount(standing))) deniedFor(CredentialRevoked)
  else if (route != MailRoute) Denied({ refusal: refuse(AccessDenied) })
  else Caller({ kind: LeaseCredential, expiresAt: S::accessEnd(f, generation) })
}
pure def leaseAdmission(route: RouteClass, window: R::Window, familyLookup: SessionLookup, grantLookup: KeyLookup, standing: Standing, now: Millis): Admission =
  if (not(R::admitsAll(keyIngress(window), now))) Denied({ refusal: R::groupRefusal(keyIngress(window), now) })
  else match familyLookup {
    | NoFamily => deniedFor(CredentialUnknown)
    | FamilyRow(x) => leaseFamilyAdmission(route, x.family, x.generation, grantLookup, standing, now)
  }
pure def liveLeaseLookup(familyLookup: SessionLookup, grantLookup: KeyLookup, standing: Standing, now: Millis): bool =
  match familyLookup {
    | FamilyRow(x) => S::isLease(x.family) and S::accepts({ ...x.family, now: now }, x.generation, standing.personEpoch) and boundGrantRefusal(grantLookup, standing) == NoReason
    | NoFamily => false
  }
pure def isCallerOfKind(a: Admission, kind: CredentialKind): bool = match a { | Caller(x) => x.kind == kind | _ => false }
pure def lawADeviceKeyNeverPassesAMailRoute(presented: Presented, standing: Standing, now: Millis): bool =
  not(isCallerOfKind(admit(MailRoute, presented, standing, now), DeviceKeyCredential))
pure def lawALeasePassesOnlyAMailRoute(route: RouteClass, presented: Presented, standing: Standing, now: Millis): bool =
  isCallerOfKind(admit(route, presented, standing, now), LeaseCredential) implies route == MailRoute
pure def lawALiveKeyOnAMailRouteIsToldItIsNotAllowed(window: R::Window, lookup: KeyLookup, standing: Standing, now: Millis): bool = {
  val presented = KeyBearer({ window: window, grantLookup: lookup })
  isLiveCredential(presented, standing, now) implies admit(MailRoute, presented, standing, now) == Denied({ refusal: refuseFor(AccessDenied, DeviceKeyNotAllowed) })
}
```
