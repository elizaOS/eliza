# Sessions

The one session issuer of the cloud. A sign-in starts a session family: a
15-minute access token and a refresh token, rotated together on every
refresh; the family ends 30 days after its sign-in. The shell maps a
presented token's digest to its family and generation; a digest with no row
answers `credential_unknown` before this machine. Tokens never enter the
model: the shell mints them, stores only their digests and hands them out
only in the sign-in and refresh answers. The device half is
`spec/os/signIn/credential.md`.

One machine instance is one family. The person's session epoch lives on the
account and enters every check as the observation `personEpoch`; a family
whose epoch differs from it is revoked. The shell reads it under the account
lock in the transaction that applies the step and never lowers it; the family
keeps the highest epoch it was checked against as `seenEpoch`, and a lower
observation is refused. Moving the person's epoch is the effect
`RevokePersonSessions`, applied to the account in that transaction. A
family's token digests, earlier generations included, are kept until
`refreshExpiresAt` whatever its phase, then dropped; a digest past that time
counts as absent.

## Story: Stay signed in

> As a person who signed in, I want my session to keep working without
> signing in again every few minutes, so that only a stolen refresh token, and
> never time alone, makes me sign in before the month is out.

### A sign-in starts one family whose refresh ends 30 days after the sign-in

The family takes the person's current epoch. A sign-in finished with a second
factor records `mfaAt`.

```quint
import types.* from "../shared/types"
import rateLimit as R from "../shared/rateLimit"
type FamilyPhase = Unissued | Live | Revoked | Reused
type Assurance = SingleFactor | MultiFactor
type Moment = Never | At({ ms: Millis })
type Family = { phase: FamilyPhase, generation: int, epoch: int, seenEpoch: int, authAt: Millis, issuedAt: Millis, accessExpiresAt: Millis, refreshExpiresAt: Millis, stepUpAt: Moment, mfaAt: Moment, now: Millis }
type SessionEffect = RevokePersonSessions({ toEpoch: int })
type FamilyStep = { state: Family, out: List[SessionEffect] }
pure val accessLifetime: Millis = 15 * millisPerMinute
pure val refreshLifetime: Millis = 30 * millisPerDay
pure val initial: Family = { phase: Unissued, generation: 0, epoch: 0, seenEpoch: 0, authAt: 0, issuedAt: 0, accessExpiresAt: 0, refreshExpiresAt: 0, stepUpAt: Never, mfaAt: Never, now: 0 }
pure def canSignIn(f: Family, personEpoch: int): bool = f.phase == Unissued and observes(f, personEpoch)
pure def signIn(f: Family, assurance: Assurance, personEpoch: int): Family = { ...f, phase: Live, generation: 1, epoch: personEpoch, seenEpoch: personEpoch, authAt: f.now, issuedAt: f.now, accessExpiresAt: f.now + accessLifetime, refreshExpiresAt: f.now + refreshLifetime, mfaAt: if (assurance == MultiFactor) At({ ms: f.now }) else Never }
pure def canElapse(f: Family, elapsed: Millis): bool = elapsed > 0
pure def elapse(f: Family, elapsed: Millis): Family = { ...f, now: f.now + elapsed }
pure val elapsedValues = Set(1, 900000, 3600001, 2591400000)
pure val personEpochValues = Set(0, 1)
pure def alwaysFamilyEndsThirtyDaysAfterSignIn(f: Family): bool = f.now >= 0 and (f.phase != Unissued implies (f.generation >= 1 and f.authAt <= f.issuedAt and f.issuedAt <= f.now and f.refreshExpiresAt == f.authAt + refreshLifetime))
```

### An access token never outlives 15 minutes from its issue or the end of its family

```quint
pure def alwaysAccessWithinLifetimes(f: Family): bool = f.phase != Unissued implies (f.accessExpiresAt <= f.issuedAt + accessLifetime and f.accessExpiresAt <= f.refreshExpiresAt)
pure def sometimesFamilyEndCapsAccess(f: Family): bool = f.phase == Live and f.accessExpiresAt < f.issuedAt + accessLifetime
```

### Only the current access token of a live family of the person's epoch is accepted

A refused session answers `401 authentication_required`. A token that was
never issued, or of a family past its end, is unknown; any token of a
revoked family is revoked; a token of an earlier generation of a live family
is unknown; a current token past its expiry is expired. So a revoked family
accepts nothing.

```quint
pure def isEnded(f: Family): bool = f.phase == Revoked or f.phase == Reused
pure def isRevoked(f: Family, personEpoch: int): bool = isEnded(f) or (f.phase == Live and f.epoch != personEpoch)
pure def sessionRefusal(presented: int, f: Family, personEpoch: int): RefusalReason =
  if (f.phase == Unissued or f.now >= f.refreshExpiresAt or presented < 1 or presented > f.generation) CredentialUnknown
  else if (isRevoked(f, personEpoch)) CredentialRevoked
  else if (presented != f.generation) CredentialUnknown
  else if (f.now >= f.accessExpiresAt) CredentialExpired
  else NoReason
pure def accepts(f: Family, presented: int, personEpoch: int): bool = sessionRefusal(presented, f, personEpoch) == NoReason
pure def isActive(f: Family, personEpoch: int): bool = accepts(f, f.generation, personEpoch)
pure def observes(f: Family, personEpoch: int): bool = personEpoch >= f.seenEpoch
pure val presentedValues = Set(0, 1, 2, 3)
pure def alwaysEpochNeverAhead(f: Family): bool = f.epoch <= f.seenEpoch
pure def sometimesAccessExpiredButRefreshable(f: Family): bool = f.phase == Live and f.now >= f.accessExpiresAt and f.now < f.refreshExpiresAt
```

### A refresh with the current refresh token rotates both tokens

The current refresh token of a live family of the person's epoch, before the
family ends, yields a new pair of the next generation; `authAt`, `stepUpAt`
and `mfaAt` carry over. Any other refresh that is not a theft is refused
`401 authentication_required` with `refreshRefusal`. A client address may
refresh 60 times a minute; over that it is answered `429 rate_limited`.

```quint
pure val refreshPerIp: R::RateLimit = R::perMinute("refreshPerIp", 60)
pure def isReuse(f: Family, presented: int): bool = (f.phase == Live or f.phase == Revoked) and presented >= 1 and presented < f.generation and f.now < f.refreshExpiresAt
pure def refreshRefusal(presented: int, f: Family, personEpoch: int): RefusalReason =
  if (f.phase == Unissued or f.now >= f.refreshExpiresAt or presented < 1 or presented > f.generation) CredentialUnknown
  else if (presented < f.generation or isRevoked(f, personEpoch)) CredentialRevoked
  else NoReason
pure def revokeAll(personEpoch: int): SessionEffect = RevokePersonSessions({ toEpoch: personEpoch + 1 })
pure def canRefresh(f: Family, presented: int, personEpoch: int): bool = observes(f, personEpoch) and (isReuse(f, presented) or refreshRefusal(presented, f, personEpoch) == NoReason)
pure def refresh(f: Family, presented: int, personEpoch: int): FamilyStep =
  if (isReuse(f, presented)) { state: { ...f, phase: Reused, seenEpoch: personEpoch + 1 }, out: List(revokeAll(personEpoch)) }
  else { state: { ...f, seenEpoch: personEpoch, generation: f.generation + 1, issuedAt: f.now, accessExpiresAt: if (f.now + accessLifetime < f.refreshExpiresAt) f.now + accessLifetime else f.refreshExpiresAt }, out: List() }
pure def stepRefreshRefusesTheOldPair(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "refresh" implies not(accepts(after, before.generation, after.seenEpoch))
pure def sometimesRotated(f: Family): bool = isActive(f, f.seenEpoch) and f.generation >= 2
```

### A spent refresh token presented again revokes every session of the person once

A refresh token of an earlier generation of a live or signed-out family,
before the family ends, is taken as theft: the family becomes Reused and the
person's epoch moves, so every session ends; device keys are not touched.
The theft answers `credential_revoked` after it revokes. A family already
taken as stolen answers `credential_revoked` and moves nothing.

```quint
pure def stepOnlyTheftRevokesEverySession(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "refresh" implies ((out.length() == 1) iff (before.phase != Reused and after.phase == Reused))
pure def sometimesReuseRevokedEverySession(f: Family): bool = f.phase == Reused
```

## Story: Sign out here, or end my other sessions

> As a person, I want signing out here to end this session only, and
> unlinking a sign-in method or deleting my account to end my other sessions
> at once, so that a lost device or a stolen token stops working the moment
> it matters.

### Logout ends only the presented family, and a second logout changes nothing

Logout is admitted by its own token check here, not by `requestAuth`'s
Session class: any digest row of the family, access or refresh, of any
generation, expired or not. It answers `204` and never moves the person's
epoch.

```quint
pure def canLogout(f: Family): bool = f.phase != Unissued
pure def logout(f: Family): Family = if (f.phase == Live) { ...f, phase: Revoked } else f
pure def stepLogoutEndsThisFamilyOnly(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "logout" implies (isEnded(after) and after.epoch == before.epoch and out == List())
pure def sometimesSignedOut(f: Family): bool = f.phase == Revoked
```

### Revoking the others keeps the calling session live

Unlinking a sign-in method revokes the others: the person's epoch moves by
one and the calling family takes the new one in the same transaction.
Account deletion emits `revokeAll` for the person without a family.

```quint
pure def canRevokeOthers(f: Family, personEpoch: int): bool = observes(f, personEpoch) and isActive(f, personEpoch)
pure def revokeOthers(f: Family, personEpoch: int): FamilyStep = { state: { ...f, epoch: personEpoch + 1, seenEpoch: personEpoch + 1 }, out: List(revokeAll(personEpoch)) }
pure def stepRevokeOthersKeepsTheCaller(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "revokeOthers" implies isActive(after, after.seenEpoch)
pure def sometimesCallerKeptAfterRevokingOthers(f: Family): bool = isActive(f, f.seenEpoch) and f.epoch == 2
```

### A revoked family stays revoked

No refresh, step-up or later logout revives a signed-out or stolen family.
A family left behind by an epoch move stays revoked too: a live family's
epoch is the highest it has observed, only `signIn` and `revokeOthers` set
it (the latter only forward, on an active family) and the observed epoch
never goes back.

```quint
pure def alwaysLiveFamilyHoldsItsEpoch(f: Family): bool = f.phase == Live implies f.epoch == f.seenEpoch
pure def stepRevokedStaysRevoked(before: Family, via: str, after: Family): bool =
  (isEnded(before) implies isEnded(after)) and after.seenEpoch >= before.seenEpoch
  and (after.epoch != before.epoch implies (via == "signIn" or (via == "revokeOthers" and after.epoch > before.epoch)))
```

## Story: Confirm it is me before a sensitive change

> As an account owner, I want a recent sign-in or step-up asked of me before
> a billing or sign-in method change, so that someone holding my unlocked
> device for a while cannot make it.

### A step-up marks the same session and leaves its token unchanged

`secondFactor` checks the code; a step-up is always a second factor, so this
records `stepUpAt` and `mfaAt` on the calling family and answers
`{stepUpAt, mfaAt}`.

```quint
pure def canRecordStepUp(f: Family, personEpoch: int): bool = observes(f, personEpoch) and isActive(f, personEpoch)
pure def recordStepUp(f: Family, personEpoch: int): Family = { ...f, seenEpoch: personEpoch, stepUpAt: At({ ms: f.now }), mfaAt: At({ ms: f.now }) }
pure def stepStepUpKeepsTheToken(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "recordStepUp" implies (accepts(after, before.generation, after.seenEpoch) and isSteppedUp(after))
```

### Freshness, step-up and a new sign-in are measured from the session's own sign-in and second-factor times

A session is fresh for 60 minutes after its sign-in or last step-up, stepped
up for 5 minutes after its last second factor, and new for 5 minutes after
its sign-in. These are read only of a session that `accepts`. `requestAuth`
admits the FreshSession class only for `isFresh` and the StepUp class only
for `isSteppedUp`; a second-factor sign-in counts as a step-up. Enrolling a
first factor needs `isNewlySignedIn`.

```quint
pure val freshWindow: Millis = 60 * millisPerMinute
pure val stepUpWindow: Millis = 5 * millisPerMinute
pure def within(m: Moment, now: Millis, span: Millis): bool = match m { | At(x) => x.ms >= now - span | Never => false }
pure def isFresh(f: Family): bool = f.authAt >= f.now - freshWindow or within(f.stepUpAt, f.now, freshWindow)
pure def isSteppedUp(f: Family): bool = within(f.mfaAt, f.now, stepUpWindow)
pure def isNewlySignedIn(f: Family): bool = f.authAt >= f.now - stepUpWindow
pure def sometimesFreshOnlyThroughStepUp(f: Family): bool = isActive(f, f.seenEpoch) and isFresh(f) and f.authAt < f.now - freshWindow
pure def sometimesStaleSession(f: Family): bool = isActive(f, f.seenEpoch) and not(isFresh(f))
pure def sometimesSteppedUpAtSignIn(f: Family): bool = isActive(f, f.seenEpoch) and isSteppedUp(f) and f.stepUpAt == Never
```

## Story: Admit a request only for a live credential of an active account

> As the account owner, I want protected routes to accept only my current
> credentials and enforce any recent sign-in or second-factor requirement.

### A protected route checks the account, current credential and required assurance

The transport parses the token, matches its digest in the store and reads the
account and credential in the same operation. A public route authenticates
no one. A provider callback verifies its signature at the route. A permitted
device credential serves device-facing services. Routes that name a browser
session, fresh session or second factor require a session, with the freshness
periods defined above. A missing, revoked or expired credential cannot pass. Device credential validity
is decided by `nativeClients/deviceKeys`; account, route and assurance checks
then use the principal without reinterpreting its credential timestamps.

```quint
type RequestAccountStatus = RequestAccountActive | RequestAccountInactive
type RequestCredentialKind = RequestSession | RequestDevice
type RouteClass = Public | ProviderSignature | ServiceAccess | SignedSession | FreshSession | StepUp
type CredentialView = { kind: RequestCredentialKind, found: bool, live: bool, expiresAt: Millis, issuedAt: Millis,
  revokedBefore: Millis, accountStatus: RequestAccountStatus, authAt: Millis, stepUpAt: Millis, mfaAt: Millis }
pure def credentialRefusal(view: CredentialView, now: Millis): RefusalReason =
  if (not(view.found)) CredentialUnknown
  else if (not(view.live) or view.issuedAt < view.revokedBefore or view.accountStatus != RequestAccountActive) CredentialRevoked
  else if (now >= view.expiresAt) CredentialExpired
  else NoReason
pure def routeNeedsSession(route: RouteClass): bool = Set(SignedSession, FreshSession, StepUp).contains(route)
type SessionRequestTimes = { authAt: Millis, stepUpAt: Millis, mfaAt: Millis }
type PrincipalCredential = DevicePrincipal | SessionPrincipal({ times: SessionRequestTimes })
type RequestPrincipal = { accountStatus: RequestAccountStatus, credential: PrincipalCredential }
pure def principalOf(view: CredentialView): RequestPrincipal = {
  accountStatus: view.accountStatus,
  credential: if (view.kind == RequestSession) SessionPrincipal({ times: { authAt: view.authAt, stepUpAt: view.stepUpAt, mfaAt: view.mfaAt } }) else DevicePrincipal
}
pure def requestHasAssurance(sessionTimes: SessionRequestTimes, route: RouteClass, now: Millis): bool =
  if (route == FreshSession) sessionTimes.authAt >= now - freshWindow or (sessionTimes.stepUpAt > 0 and sessionTimes.stepUpAt >= now - freshWindow)
  else if (route == StepUp) sessionTimes.mfaAt > 0 and sessionTimes.mfaAt >= now - stepUpWindow
  else true
type RequestAdmission = AnonymousRequest | CredentialAccepted | RequestRefused({ refusal: Refusal })
pure def admitPrincipal(principal: RequestPrincipal, route: RouteClass, now: Millis): RequestAdmission = {
  val credential = principal.credential
  if (route == Public or route == ProviderSignature) AnonymousRequest
  else if (principal.accountStatus != RequestAccountActive) RequestRefused({ refusal: refuseFor(AuthenticationRequired, CredentialRevoked) })
  else match credential {
    | DevicePrincipal => if (routeNeedsSession(route)) RequestRefused({ refusal: refuseFor(AuthenticationRequired, CredentialUnknown) }) else CredentialAccepted
    | SessionPrincipal(session) => if (requestHasAssurance(session.times, route, now)) CredentialAccepted else RequestRefused({ refusal: refuse(FreshSessionRequired) })
  }
}
pure def admitRequest(view: CredentialView, route: RouteClass, now: Millis): RequestAdmission = {
  val reason = credentialRefusal(view, now)
  if (route == Public or route == ProviderSignature) AnonymousRequest
  else if (reason != NoReason) RequestRefused({ refusal: refuseFor(AuthenticationRequired, reason) })
  else admitPrincipal(principalOf(view), route, now)
}
pure val activeRequest: CredentialView = { kind: RequestSession, found: true, live: true, expiresAt: 900000, issuedAt: 1,
  revokedBefore: 0, accountStatus: RequestAccountActive, authAt: 1, stepUpAt: 1, mfaAt: 1 }
pure val viewValues = Set(activeRequest, { ...activeRequest, found: false }, { ...activeRequest, live: false },
  { ...activeRequest, accountStatus: RequestAccountInactive }, { ...activeRequest, kind: RequestDevice })
pure val principalValues = viewValues.map(view => principalOf(view))
pure val sessionTimesValues = viewValues.map(view => { authAt: view.authAt, stepUpAt: view.stepUpAt, mfaAt: view.mfaAt })
pure def lawSessionRequestAdmissionIsUnchanged(view: CredentialView, route: RouteClass, now: Millis): bool = {
  val reason = credentialRefusal(view, now)
  val sessionTimes = { authAt: view.authAt, stepUpAt: view.stepUpAt, mfaAt: view.mfaAt }
  val before = if (route == Public or route == ProviderSignature) AnonymousRequest
    else if (reason != NoReason) RequestRefused({ refusal: refuseFor(AuthenticationRequired, reason) })
    else if (not(requestHasAssurance(sessionTimes, route, now))) RequestRefused({ refusal: refuse(FreshSessionRequired) })
    else CredentialAccepted
  view.kind == RequestSession implies admitRequest(view, route, now) == before
}
pure def lawPrincipalKeepsAccountAndRoutePolicy(principal: RequestPrincipal, route: RouteClass, now: Millis): bool =
  admitPrincipal(principal, route, now) == CredentialAccepted implies
    (principal.accountStatus == RequestAccountActive and (routeNeedsSession(route) implies principal.credential != DevicePrincipal))
pure def lawOnlyAnActiveCredentialReachesProtectedRoutes(view: CredentialView, route: RouteClass, now: Millis): bool =
  admitRequest(view, route, now) == CredentialAccepted implies credentialRefusal(view, now) == NoReason
```
