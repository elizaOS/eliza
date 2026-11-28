# Sessions

The one session issuer of the cloud. A sign-in starts a session family: a
15-minute access token and a refresh token, rotated together on every
refresh; a browser family ends 30 days after its sign-in. A tablet's
native shell holds a second kind of family, a device lease bound to one
device key, which only mail and calendar routes admit and which stays
signed in as long as it is refreshed within 90 days. The shell maps a
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
factor records `mfaAt`. This end applies to a browser family only; a device
lease ends 90 days after its last refresh instead (Story: Keep a tablet
signed in to mail and calendar).

```quint
import types.* from "../shared/types"
import rateLimit as R from "../shared/rateLimit"
import registry as N from "../nativeClients/registry"
type FamilyPhase = Unissued | Offered | Live | Revoked | Reused
type FamilyKind = BrowserFamily | DeviceLease({ grantKey: str })
type Rotation = Settled | Offering({ offeredAt: Millis, answers: int })
type Assurance = SingleFactor | MultiFactor
type Moment = Never | At({ ms: Millis })
type Family = { kind: FamilyKind, phase: FamilyPhase, generation: int, rotation: Rotation, epoch: int, seenEpoch: int, authAt: Millis, issuedAt: Millis, accessExpiresAt: Millis, refreshExpiresAt: Millis, stepUpAt: Moment, mfaAt: Moment, now: Millis }
type SessionEffect = RevokePersonSessions({ toEpoch: int }) | EndLeaseAndGrant({ grantKey: str })
type FamilyStep = { state: Family, out: List[SessionEffect] }
pure val accessLifetime: Millis = 15 * millisPerMinute
pure val refreshLifetime: Millis = 30 * millisPerDay
pure val initial: Family = { kind: BrowserFamily, phase: Unissued, generation: 0, rotation: Settled, epoch: 0, seenEpoch: 0, authAt: 0, issuedAt: 0, accessExpiresAt: 0, refreshExpiresAt: 0, stepUpAt: Never, mfaAt: Never, now: 0 }
pure def isLease(f: Family): bool = f.kind != BrowserFamily
pure def canSignIn(f: Family, personEpoch: int): bool = f.phase == Unissued and observes(f, personEpoch)
pure def signIn(f: Family, assurance: Assurance, personEpoch: int): Family = { ...f, phase: Live, generation: 1, epoch: personEpoch, seenEpoch: personEpoch, authAt: f.now, issuedAt: f.now, accessExpiresAt: f.now + accessLifetime, refreshExpiresAt: f.now + refreshLifetime, mfaAt: if (assurance == MultiFactor) At({ ms: f.now }) else Never }
pure def canElapse(f: Family, elapsed: Millis): bool = elapsed > 0
pure def elapse(f: Family, elapsed: Millis): Family = { ...f, now: f.now + elapsed }
pure val elapsedValues = Set(1, 900000, 3600001, 2591400000, 7776000000)
pure val personEpochValues = Set(0, 1)
pure def alwaysFamilyEndsThirtyDaysAfterSignIn(f: Family): bool = f.now >= 0 and (f.phase != Unissued implies (f.generation >= 1 and f.authAt <= f.issuedAt and f.issuedAt <= f.now and (isLease(f) or f.refreshExpiresAt == f.authAt + refreshLifetime)))
```

### An access token never outlives 15 minutes from its issue or the end of its family

```quint
pure def alwaysAccessWithinLifetimes(f: Family): bool = f.phase != Unissued implies (f.accessExpiresAt <= f.issuedAt + accessLifetime and f.accessExpiresAt <= f.refreshExpiresAt)
pure def sometimesFamilyEndCapsAccess(f: Family): bool = f.phase == Live and f.accessExpiresAt < f.issuedAt + accessLifetime
```

### Only the current access token of a live family of the person's epoch is accepted

A refused session answers `401 authentication_required`. A token that was
never issued, of a lease not yet acknowledged, or of a family past its end
is unknown. Ordinary request authentication looks up the current access
token, and also the offered access token for a lease. The lookup excludes
earlier generations, whose digests are kept for logout and refresh reuse
checks. A located token of a revoked family is revoked. A current token
past its expiry is expired. A lease's offered access token also ends after
its own 15 minutes.

```quint
pure def isEnded(f: Family): bool = f.phase == Revoked or f.phase == Reused
pure def isRevoked(f: Family, personEpoch: int): bool = isEnded(f) or (f.phase == Live and f.epoch != personEpoch)
pure def offeredGeneration(f: Family): int = { val r = f.rotation  match r { | Offering(o) => f.generation + 1 | Settled => f.generation } }
pure def offeredAccessEnd(f: Family): Millis = { val r = f.rotation  match r { | Offering(o) => o.offeredAt + accessLifetime | Settled => f.accessExpiresAt } }
pure def accessEnd(f: Family, presented: int): Millis = if (presented == f.generation) f.accessExpiresAt else offeredAccessEnd(f)
pure def sessionRefusal(presented: int, f: Family, personEpoch: int): RefusalReason =
  if (f.phase == Unissued or f.phase == Offered or f.now >= f.refreshExpiresAt or presented < 1 or presented > offeredGeneration(f)) CredentialUnknown
  else if (isRevoked(f, personEpoch)) CredentialRevoked
  else if (presented < f.generation) CredentialUnknown
  else if (f.now >= accessEnd(f, presented)) CredentialExpired
  else NoReason
pure def accepts(f: Family, presented: int, personEpoch: int): bool = sessionRefusal(presented, f, personEpoch) == NoReason
pure def isActive(f: Family, personEpoch: int): bool = accepts(f, f.generation, personEpoch)
pure def observes(f: Family, personEpoch: int): bool = personEpoch >= f.seenEpoch
pure val presentedValues = Set(0, 1, 2, 3)
pure def alwaysEpochNeverAhead(f: Family): bool = f.epoch <= f.seenEpoch
pure def sometimesAccessExpiredButRefreshable(f: Family): bool = f.phase == Live and f.now >= f.accessExpiresAt and f.now < f.refreshExpiresAt
```

### A refresh with the current refresh token rotates both tokens

The current refresh token of a live browser family of the person's epoch,
before the family ends, yields a new pair of the next generation; `authAt`,
`stepUpAt` and `mfaAt` carry over. A device lease rotates in two phases
instead (Story: Keep a tablet signed in to mail and calendar). Any other refresh that is not a theft is refused
`401 authentication_required` with `refreshRefusal`. A client address may
refresh 60 times a minute; over that it is answered `429 rate_limited`.

```quint
pure val refreshPerIp: R::RateLimit = R::perMinute("refreshPerIp", 60)
pure def isReuse(f: Family, presented: int): bool = (f.phase == Live or f.phase == Revoked) and presented >= 1 and presented < f.generation and f.now < f.refreshExpiresAt
pure def refreshRefusal(presented: int, f: Family, personEpoch: int): RefusalReason =
  if (f.phase == Unissued or f.phase == Offered or f.now >= f.refreshExpiresAt or presented < 1 or presented > offeredGeneration(f)) CredentialUnknown
  else if (presented < f.generation or isRevoked(f, personEpoch)) CredentialRevoked
  else NoReason
pure def revokeAll(personEpoch: int): SessionEffect = RevokePersonSessions({ toEpoch: personEpoch + 1 })
pure def canRefresh(f: Family, presented: int, personEpoch: int): bool = observes(f, personEpoch) and (isReuse(f, presented) or refreshRefusal(presented, f, personEpoch) == NoReason)
pure def refresh(f: Family, presented: int, personEpoch: int): FamilyStep =
  if (isLease(f)) leaseRefresh(presented, f, personEpoch)
  else if (isReuse(f, presented)) { state: { ...f, phase: Reused, seenEpoch: personEpoch + 1 }, out: List(revokeAll(personEpoch)) }
  else { state: { ...f, seenEpoch: personEpoch, generation: f.generation + 1, issuedAt: f.now, accessExpiresAt: if (f.now + accessLifetime < f.refreshExpiresAt) f.now + accessLifetime else f.refreshExpiresAt }, out: List() }
pure def refusesPair(f: Family, generation: int): bool =
  not(accepts(f, generation, f.seenEpoch)) and refreshRefusal(generation, f, f.seenEpoch) != NoReason
pure def stepRefreshRefusesTheOldPair(before: Family, via: str, after: Family, out: List[SessionEffect]): bool =
  (via == "refresh" and not(isLease(before))) implies refusesPair(after, before.generation)
pure def sometimesRotated(f: Family): bool = isActive(f, f.seenEpoch) and f.generation >= 2
```

### A spent refresh token presented again revokes every session of the person once

A refresh token of an earlier generation of a live or signed-out browser
family, before the family ends, is taken as theft: the family becomes Reused
and the person's epoch moves, so every session ends; device keys are not
touched. The theft answers `credential_revoked` after it revokes. A family
already taken as stolen answers `credential_revoked` and moves nothing. A
device lease's theft ends only that device (Story: Keep a tablet signed in
to mail and calendar).

```quint
pure def stepOnlyTheftRevokesEverySession(before: Family, via: str, after: Family, out: List[SessionEffect]): bool =
  (via == "refresh" and not(isLease(before))) implies (
    if (before.phase != Reused and after.phase == Reused)
      out == List(RevokePersonSessions({ toEpoch: after.seenEpoch })) and after.seenEpoch > before.seenEpoch
    else out == List())
pure def sometimesReuseRevokedEverySession(f: Family): bool = not(isLease(f)) and f.phase == Reused
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
pure def logout(f: Family): Family = if (f.phase == Live or f.phase == Offered) { ...f, phase: Revoked, rotation: Settled } else f
pure def stepLogoutEndsThisFamilyOnly(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "logout" implies (isEnded(after) and after.epoch == before.epoch and out == List())
pure def sometimesSignedOut(f: Family): bool = f.phase == Revoked
```

### Revoking the others keeps the calling session live

Unlinking a sign-in method or ending the other sessions revokes the others:
the person's epoch moves by one and the calling family takes the new one in
the same transaction. Account deletion emits `revokeAll` for the person
without a family. Device leases are the person's sessions too, so both end
every lease; only a browser family can be the caller.

```quint
pure def canRevokeOthers(f: Family, personEpoch: int): bool = not(isLease(f)) and observes(f, personEpoch) and isActive(f, personEpoch)
pure def revokeOthers(f: Family, personEpoch: int): FamilyStep = { state: { ...f, epoch: personEpoch + 1, seenEpoch: personEpoch + 1 }, out: List(revokeAll(personEpoch)) }
pure def stepRevokeOthersKeepsTheCaller(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "revokeOthers" implies isActive(after, after.seenEpoch)
pure def sometimesCallerKeptAfterRevokingOthers(f: Family): bool = isActive(f, f.seenEpoch) and f.epoch == 2
```

### A revoked family stays revoked

No refresh, step-up or later logout revives a signed-out or stolen family.
A family left behind by an epoch move stays revoked too: a live family's
epoch is the highest it has observed, only `signIn`, `offerLease` and
`revokeOthers` set it (the last only forward, on an active family) and the
observed epoch never goes back.

```quint
pure def alwaysLiveFamilyHoldsItsEpoch(f: Family): bool = f.phase == Live implies f.epoch == f.seenEpoch
pure def stepRevokedStaysRevoked(before: Family, via: str, after: Family): bool =
  (isEnded(before) implies isEnded(after)) and after.seenEpoch >= before.seenEpoch
  and (after.epoch != before.epoch implies (via == "signIn" or via == "offerLease" or (via == "revokeOthers" and after.epoch > before.epoch)))
```

## Story: Confirm it is me before a sensitive change

> As an account owner, I want a recent sign-in or step-up asked of me before
> a billing or sign-in method change, so that someone holding my unlocked
> device for a while cannot make it.

### A step-up marks the same session and leaves its token unchanged

`secondFactor` checks the code; a step-up is always a second factor, so this
records `stepUpAt` and `mfaAt` on the calling family and answers
`{stepUpAt, mfaAt}`. A device lease is never stepped up.

```quint
pure def canRecordStepUp(f: Family, personEpoch: int): bool = not(isLease(f)) and observes(f, personEpoch) and isActive(f, personEpoch)
pure def recordStepUp(f: Family, personEpoch: int): Family = { ...f, seenEpoch: personEpoch, stepUpAt: At({ ms: f.now }), mfaAt: At({ ms: f.now }) }
pure def stepStepUpKeepsTheToken(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "recordStepUp" implies (accepts(after, before.generation, after.seenEpoch) and isSteppedUp(after))
```

### Freshness, step-up and a new sign-in are measured from the session's own sign-in and second-factor times

A session is fresh for 60 minutes after its sign-in or last step-up, stepped
up for 5 minutes after its last second factor, and new for 5 minutes after
its sign-in. A device lease is single-factor and never fresh, stepped up or
new, whatever its times. These are read only of a session that `accepts`. `requestAuth`
admits the FreshSession class only for `isFresh` and the StepUp class only
for `isSteppedUp`; a second-factor sign-in counts as a step-up. Enrolling a
first factor needs `isNewlySignedIn`.

```quint
pure val freshWindow: Millis = 60 * millisPerMinute
pure val stepUpWindow: Millis = 5 * millisPerMinute
pure def within(m: Moment, now: Millis, span: Millis): bool = match m { | At(x) => x.ms >= now - span | Never => false }
pure def isFresh(f: Family): bool = not(isLease(f)) and (f.authAt >= f.now - freshWindow or within(f.stepUpAt, f.now, freshWindow))
pure def isSteppedUp(f: Family): bool = not(isLease(f)) and within(f.mfaAt, f.now, stepUpWindow)
pure def isNewlySignedIn(f: Family): bool = not(isLease(f)) and f.authAt >= f.now - stepUpWindow
pure def sometimesFreshOnlyThroughStepUp(f: Family): bool = isActive(f, f.seenEpoch) and isFresh(f) and f.authAt < f.now - freshWindow
pure def sometimesStaleSession(f: Family): bool = isActive(f, f.seenEpoch) and not(isFresh(f))
pure def sometimesSteppedUpAtSignIn(f: Family): bool = isActive(f, f.seenEpoch) and isSteppedUp(f) and f.stepUpAt == Never
```

## Story: Keep a tablet signed in to mail and calendar

> As a device owner, I want my device to stay signed in to mail and
> calendar like a phone app does, without asking me to sign in again
> every week. The assistant must never use its own key to read or send
> my mail. The device signs out only when I sign out or remove the
> account, the device is revoked, or a secret is stolen.

A device lease is a session family bound to one device grant. Only the
tablet's native shell holds its secrets, in the secure-store slots that hold
the device key: a refresh `eliza_lease_refresh_` + 54 base64url and an access
token `eliza_lease_` + 43 base64url. The distinct prefixes let the shell
classify a bearer without a lookup; the web page and the on-device agent
never see either. A lease is issued only inside the device's PKCE-protected
exchange (`nativeClients/deviceKeys`), so a holder of the device key alone
can never mint one. `POST /api/v1/app-auth/mobile/lease`, with `Authorization:
Bearer <lease refresh>`, answers `{access, accessExpiresIn, refresh,
refreshExpiresIn}`; `DELETE` on the same path ends the lease alone, which
works with an expired key. Revoking the person's devices
(`nativeClients/deviceKeys`, `revokeAll`) ends every lease of the person in
the same transaction, so a revoked tablet's lease neither rotates nor renews. Devices signed in before leases existed get one at
their next sign-in; no migration invents one.

### A device's sign-in offers one lease bound to its key, and its acknowledgement makes the lease live

The exchange that mints the key offers the lease, with only its refresh
token, in the same transaction; the acknowledgement of the key makes it
live. The lease is single-factor and takes the person's current epoch, and
an epoch moved before the acknowledgement leaves it unusable. A lease that is
never acknowledged ends with its grant.

```quint
pure val leaseIdleLifetime: Millis = N::maxCredentialTtl
pure def leaseGrant(f: Family): str = { val k = f.kind  match k { | DeviceLease(l) => l.grantKey | BrowserFamily => "" } }
pure def canOfferLease(f: Family, grantKey: str, personEpoch: int): bool = f.phase == Unissued and grantKey != "" and observes(f, personEpoch)
pure def offerLease(f: Family, grantKey: str, personEpoch: int): Family =
  { ...f, kind: DeviceLease({ grantKey: grantKey }), phase: Offered, generation: 1, rotation: Settled, epoch: personEpoch, seenEpoch: personEpoch,
    authAt: f.now, issuedAt: f.now, accessExpiresAt: f.now, refreshExpiresAt: f.now + leaseIdleLifetime, stepUpAt: Never, mfaAt: Never }
pure def canActivateLease(f: Family, personEpoch: int): bool = f.phase == Offered and observes(f, personEpoch) and f.epoch == personEpoch and f.now < f.refreshExpiresAt
pure def activateLease(f: Family, personEpoch: int): Family = { ...f, phase: Live, seenEpoch: personEpoch }
pure val grantKeyValues = Set("g1", "g2")
pure val weight_offerLease = 4
pure def alwaysOnlyALeaseIsOffered(f: Family): bool = (f.phase == Offered implies (isLease(f) and f.generation == 1 and f.rotation == Settled)) and (isLease(f) implies (f.phase != Unissued and leaseGrant(f) != "" and f.mfaAt == Never and f.stepUpAt == Never))
pure def sometimesLeaseLive(f: Family): bool = isLease(f) and f.phase == Live
```

### A lease's refresh ends 90 days after its last refresh, with no end counted from its sign-in

Each refresh with a current secret sets the end to 90 days later, the
longest key lifetime a client may register (`registry`), so a tablet in use
never signs out by time alone. A lease that goes 90 days without a refresh
ends, and the tablet signs in again.

```quint
pure def alwaysALeaseEndsNinetyDaysAfterItsLastRefresh(f: Family): bool =
  isLease(f) implies (f.authAt + leaseIdleLifetime <= f.refreshExpiresAt and f.refreshExpiresAt <= f.now + leaseIdleLifetime)
pure def sometimesLeaseLapsedAfterNinetyIdleDays(f: Family): bool = isLease(f) and f.phase == Live and f.now >= f.refreshExpiresAt
pure def sometimesLeaseOutlivedThirtyDays(f: Family): bool = isActive(f, f.seenEpoch) and isLease(f) and f.now > f.authAt + refreshLifetime
```

### A lease refresh offers the next pair, and the current pair stays valid until the offered one is first used

A refresh with the current generation answers the next pair as offered. The
current generation stays valid until a secret of the offered pair is first
admitted, either as a live access token or as a refresh token. That first
use commits the offered pair and ends both secrets of the previous pair.
A rotation request with the offered refresh commits it and offers the pair
after it. A key renewal with the offered refresh commits it even if that
pair's access token expired. The shell locks the account before classifying
a digest as current, offered or spent, and keeps that lock until the step
and the digest changes are complete. `authAt` carries over, and a lease is
never stepped up.

```quint
pure def answersOf(f: Family): int = { val r = f.rotation  match r { | Offering(o) => o.answers | Settled => 0 } }
pure def offeredAtOf(f: Family): Millis = { val r = f.rotation  match r { | Offering(o) => o.offeredAt | Settled => f.issuedAt } }
pure def committedAt(at: Millis, f: Family): Family =
  { ...f, generation: f.generation + 1, issuedAt: at, accessExpiresAt: if (at + accessLifetime < f.refreshExpiresAt) at + accessLifetime else f.refreshExpiresAt, rotation: Settled }
pure def leaseRefresh(presented: int, f: Family, personEpoch: int): FamilyStep = {
  val kept = if (presented == f.generation) f else committedAt(offeredAtOf(f), f)
  val answers = if (presented == f.generation) answersOf(f) + 1 else 1
  if (isReuse(f, presented)) { state: { ...f, phase: Reused, rotation: Settled, seenEpoch: personEpoch }, out: List(EndLeaseAndGrant({ grantKey: leaseGrant(f) })) }
  else { state: { ...kept, seenEpoch: personEpoch, refreshExpiresAt: f.now + leaseIdleLifetime, rotation: Offering({ offeredAt: f.now, answers: answers }) }, out: List() }
}
type LeaseSecret = OfferedAccess | OfferedRefresh
pure def canUseOffered(f: Family, personEpoch: int, secret: LeaseSecret): bool =
  isLease(f) and f.rotation != Settled and observes(f, personEpoch) and (
    if (secret == OfferedAccess) accepts(f, offeredGeneration(f), personEpoch)
    else refreshRefusal(offeredGeneration(f), f, personEpoch) == NoReason)
pure def useOffered(f: Family, personEpoch: int, secret: LeaseSecret): Family = { ...committedAt(offeredAtOf(f), f), seenEpoch: personEpoch }
pure val secretValues = Set(OfferedAccess, OfferedRefresh)
pure val weight_refresh = 3
pure def alwaysOnlyALiveLeaseOffersAPair(f: Family): bool = { val r = f.rotation  match r {
  | Offering(o) => isLease(f) and f.phase == Live and f.issuedAt <= o.offeredAt and o.offeredAt <= f.now and o.answers >= 1
  | Settled => true
} }
pure def stepALeaseKeepsItsCurrentPairUntilTheOfferedOneIsUsed(before: Family, via: str, after: Family, out: List[SessionEffect]): bool =
  ((via == "refresh" and isLease(before) and after.phase == Live) implies
    (offeredGeneration(after) == after.generation + 1 and accepts(after, after.generation + 1, after.seenEpoch)
      and (after.generation == before.generation or (before.rotation != Settled and after.generation == before.generation + 1))))
  and (via == "useOffered" implies (after.generation == offeredGeneration(before) and after.rotation == Settled))
pure def stepACommittedLeaseRefusesTheOldPair(before: Family, via: str, after: Family, out: List[SessionEffect]): bool =
  (isLease(before) and after.generation > before.generation) implies refusesPair(after, before.generation)
pure def lawAnExpiredOfferedAccessTokenCannotCommit(f: Family, personEpoch: int): bool =
  f.now >= offeredAccessEnd(f) implies not(canUseOffered(f, personEpoch, OfferedAccess))
pure def sometimesAnOfferedRefreshCanCommitAfterAccessExpires(f: Family): bool =
  f.now >= offeredAccessEnd(f) and canUseOffered(f, f.seenEpoch, OfferedRefresh)
pure def sometimesLeaseRotationCommitted(f: Family): bool = isActive(f, f.seenEpoch) and isLease(f) and f.generation >= 2
```

### A lost refresh reply is asked again with the same refresh, which offers the next pair afresh

Presenting the current refresh again before the offered pair is used is not
theft: the shell mints the offered pair again and replaces its digests, so a
reply lost on the way to the tablet never strands it and never signs it out.

```quint
pure def stepAReOfferKeepsTheGeneration(before: Family, via: str, after: Family, out: List[SessionEffect]): bool =
  (via == "refresh" and isLease(before) and before.rotation != Settled and after.phase == Live and after.generation == before.generation)
    implies (out == List() and answersOf(after) == answersOf(before) + 1
      and after.accessExpiresAt == before.accessExpiresAt and after.issuedAt == before.issuedAt
      and refreshRefusal(after.generation, after, after.seenEpoch) == NoReason)
pure def sometimesLeaseReOfferedAfterALostReply(f: Family): bool = isActive(f, f.seenEpoch) and isLease(f) and answersOf(f) >= 2
```

### A spent lease refresh presented after its rotation committed ends that device's lease and key only

A refresh of an earlier generation than the current one, before the lease
ends, is theft: the lease becomes Reused and its device grant ends with it
(`EndLeaseAndGrant`, ended by `LeaseReused` in `nativeClients/deviceKeys`),
and the shell logs a security event naming the grant. Unlike a browser
family's theft it does not move the person's epoch. The refresh lived only in
that device's secure store and is never sent to a browser, so the theft
implicates that device alone; ending its key and lease removes everything a
thief could reach through it; two-phase rotation removes the lost reply as an
innocent cause; and a person-wide revocation would let one tablet's fault
sign its owner out of every browser and phone.

```quint
pure def stepALeaseTheftEndsOnlyItsDevice(before: Family, via: str, after: Family, out: List[SessionEffect]): bool =
  (via == "refresh" and isLease(before)) implies (after.epoch == before.epoch and (
    if (before.phase != Reused and after.phase == Reused)
      out == List(EndLeaseAndGrant({ grantKey: leaseGrant(before) }))
    else out == List()))
pure def sometimesLeaseTheftEndedOnlyThatDevice(f: Family): bool = isLease(f) and f.phase == Reused and f.epoch == f.seenEpoch
```

### A renewed key takes over its lease

When the device's renewed key is acknowledged, the lease moves to the new
grant in the same transaction that ends the old key, so the lease always
names the one grant whose key the device holds.

```quint
pure def canMoveLease(f: Family, grantKey: str): bool = isLease(f) and f.phase == Live and grantKey != "" and grantKey != leaseGrant(f)
pure def moveLease(f: Family, grantKey: str): Family = { ...f, kind: DeviceLease({ grantKey: grantKey }) }
pure def stepOnlyARenewalMovesALease(before: Family, via: str, after: Family): bool =
  (isLease(before) and leaseGrant(after) != leaseGrant(before)) implies via == "moveLease"
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
type RequestCredentialKind = RequestSession | RequestDevice | RequestLease
type RouteClass = Public | ProviderSignature | ServiceAccess | SignedSession | FreshSession | StepUp | MailAccess
type CredentialView = { kind: RequestCredentialKind, found: bool, live: bool, expiresAt: Millis, issuedAt: Millis,
  revokedBefore: Millis, accountStatus: RequestAccountStatus, authAt: Millis, stepUpAt: Millis, mfaAt: Millis }
pure def credentialRefusal(view: CredentialView, now: Millis): RefusalReason =
  if (not(view.found)) CredentialUnknown
  else if (not(view.live) or view.issuedAt < view.revokedBefore or view.accountStatus != RequestAccountActive) CredentialRevoked
  else if (now >= view.expiresAt) CredentialExpired
  else NoReason
pure def routeNeedsSession(route: RouteClass): bool = Set(SignedSession, FreshSession, StepUp).contains(route)
type SessionRequestTimes = { authAt: Millis, stepUpAt: Millis, mfaAt: Millis }
type PrincipalCredential = DevicePrincipal | LeasePrincipal | SessionPrincipal({ times: SessionRequestTimes })
type RequestPrincipal = { accountStatus: RequestAccountStatus, credential: PrincipalCredential }
pure def principalOf(view: CredentialView): RequestPrincipal = {
  accountStatus: view.accountStatus,
  credential: if (view.kind == RequestSession) SessionPrincipal({ times: { authAt: view.authAt, stepUpAt: view.stepUpAt, mfaAt: view.mfaAt } })
    else if (view.kind == RequestLease) LeasePrincipal else DevicePrincipal
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
    | DevicePrincipal => if (route == MailAccess) RequestRefused({ refusal: refuseFor(AccessDenied, DeviceKeyNotAllowed) })
        else if (routeNeedsSession(route)) RequestRefused({ refusal: refuseFor(AuthenticationRequired, CredentialUnknown) }) else CredentialAccepted
    | LeasePrincipal => if (route == MailAccess) CredentialAccepted else RequestRefused({ refusal: refuse(AccessDenied) })
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
  { ...activeRequest, accountStatus: RequestAccountInactive }, { ...activeRequest, kind: RequestDevice }, { ...activeRequest, kind: RequestLease })
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

A standalone deployment serving the original device endpoints can configure
a 32-byte base64 `DEVICE_LEASE_SEAL_KEY`. With it, an interrupted initial
exchange can recover the same key and lease with the original unacknowledged
proof. An interrupted renewal returns the same pending successor to that
lease. Acknowledgment or expiry clears the saved response. An installation
without that optional binding can continue to issue its original device keys.
The existing native configuration response advertises `mailLease` for the
registered standalone browser sign-in client when that binding is valid.
The canonical mobile endpoints use the deployment's existing sealing keyring.

### A mail or calendar route admits a session or a device lease, and refuses the device key

The Google status, accounts, and Google mail and calendar content reads use
MailAccess. Connecting or disconnecting a provider and changing mail or
calendar require a signed-in browser session. An active account's
device key there is refused `403 access_denied` with reason `device_key_not_allowed`: the
on-device agent holds that key and reads untrusted mail, so it can never read
or send mail with it. A device lease passes only a MailAccess route; on any
other route it is refused `403 access_denied`, so inference, speech,
billing, app sign-in, keys and password backup keep their device-key
admission. A lease view is live when its family accepts the presented
generation at the person's epoch, the account is active, and its bound grant
is not ended and of the person's current device epoch; the key's expiry does
not end the lease. The native one-tap `connect/native` stays a device-key
route. On the Grace Google mount (`deployment`), which answers before the
server table, the recorded device key may also disconnect its own owner's
connection, and never another account's.

```quint
pure def lawADeviceKeyNeverPassesAMailRoute(principal: RequestPrincipal, now: Millis): bool =
  principal.credential == DevicePrincipal implies admitPrincipal(principal, MailAccess, now) ==
    (if (principal.accountStatus == RequestAccountActive) RequestRefused({ refusal: refuseFor(AccessDenied, DeviceKeyNotAllowed) })
     else RequestRefused({ refusal: refuseFor(AuthenticationRequired, CredentialRevoked) }))
pure def lawALeasePassesOnlyAMailRoute(principal: RequestPrincipal, route: RouteClass, now: Millis): bool =
  (principal.credential == LeasePrincipal and admitPrincipal(principal, route, now) == CredentialAccepted) implies route == MailAccess
pure def lawASessionPassesAMailRoute(principal: RequestPrincipal, now: Millis): bool =
  (principal.accountStatus == RequestAccountActive and principal.credential != DevicePrincipal and principal.credential != LeasePrincipal) implies admitPrincipal(principal, MailAccess, now) == CredentialAccepted
```
