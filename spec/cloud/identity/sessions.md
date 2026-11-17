# Sessions

The one session issuer of the cloud. A sign-in starts a session family: a
15-minute access token and a refresh token, rotated together on every
refresh; the family ends 30 days after its sign-in. The shell maps a
presented token's digest to its family and generation; a digest with no row
answers `credential_unknown` before this machine. Tokens never enter the
model: the shell mints them, stores only their digests and hands them out
only in the sign-in and refresh answers. No client decodes a token: expiry
and assurance come from the answer body. The device half is
`spec/os/signIn/credential.md`.

One machine instance is one family row. The person's session epoch lives on
the user row and enters every check as the observation `personEpoch`; a
family whose epoch differs from it is revoked. Moving the person's epoch is
the effect `RevokePersonSessions`, which the shell applies to the user row in
the same transaction. A family's digest rows, earlier generations included,
are kept until the family is ended or past `refreshExpiresAt`, then dropped.

## Story: Stay signed in

> As a person who signed in, I want my session to keep working without
> signing in again every few minutes, so that only a stolen refresh token, and
> never time alone, makes me sign in before the month is out.

### A sign-in starts one family whose refresh ends 30 days after the sign-in

The family takes the person's current epoch. A sign-in finished with a second
factor records `mfaAt`.

```quint
import types.* from "../shared/types"
type FamilyPhase = Unissued | Live | Revoked | Reused
type Assurance = SingleFactor | MultiFactor
type Moment = Never | At({ ms: Millis })
type Family = { phase: FamilyPhase, generation: int, epoch: int, authAt: Millis, issuedAt: Millis, accessExpiresAt: Millis, refreshExpiresAt: Millis, stepUpAt: Moment, mfaAt: Moment, now: Millis }
type SessionEffect = RevokePersonSessions({ toEpoch: int })
type FamilyStep = { state: Family, out: List[SessionEffect] }
pure val accessLifetime: Millis = 15 * millisPerMinute
pure val refreshLifetime: Millis = 30 * millisPerDay
pure val initial: Family = { phase: Unissued, generation: 0, epoch: 0, authAt: 0, issuedAt: 0, accessExpiresAt: 0, refreshExpiresAt: 0, stepUpAt: Never, mfaAt: Never, now: 0 }
pure def canSignIn(f: Family, assurance: Assurance): bool = f.phase == Unissued
pure def signIn(f: Family, assurance: Assurance, personEpoch: int): Family = { ...f, phase: Live, generation: 1, epoch: personEpoch, authAt: f.now, issuedAt: f.now, accessExpiresAt: f.now + accessLifetime, refreshExpiresAt: f.now + refreshLifetime, mfaAt: if (assurance == MultiFactor) At({ ms: f.now }) else Never }
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

### Only the current access token of a live family of the person's epoch is accepted, and a refusal names why

A refused session answers `401 authentication_required`. A token that was
never issued is unknown; any token of a revoked family is revoked; a token of
an earlier generation of a live family is unknown; a current token past its
expiry is expired.

```quint
pure def isEnded(f: Family): bool = f.phase == Revoked or f.phase == Reused
pure def isRevoked(f: Family, personEpoch: int): bool = isEnded(f) or (f.phase == Live and f.epoch != personEpoch)
pure def sessionRefusal(presented: int, f: Family, personEpoch: int): RefusalReason =
  if (f.phase == Unissued or presented < 1 or presented > f.generation) CredentialUnknown
  else if (isRevoked(f, personEpoch)) CredentialRevoked
  else if (presented != f.generation) CredentialUnknown
  else if (f.now >= f.accessExpiresAt) CredentialExpired
  else NoReason
pure def accepts(f: Family, presented: int, personEpoch: int): bool = sessionRefusal(presented, f, personEpoch) == NoReason
pure def isActive(f: Family, personEpoch: int): bool = accepts(f, f.generation, personEpoch)
pure val presentedValues = Set(0, 1, 2, 3)
pure def lawRefusalIsNamed(presented: int, f: Family, personEpoch: int): bool = not(accepts(f, presented, personEpoch)) implies wellFormed(refuseFor(AuthenticationRequired, sessionRefusal(presented, f, personEpoch)))
pure def lawRevokedAcceptsNothing(presented: int, f: Family, personEpoch: int): bool = isRevoked(f, personEpoch) implies not(accepts(f, presented, personEpoch))
pure def sometimesAccessExpiredButRefreshable(f: Family): bool = f.phase == Live and f.now >= f.accessExpiresAt and f.now < f.refreshExpiresAt
```

### A refresh rotates both tokens, and a spent refresh token presented again revokes every session of the person

The current refresh token of a live family of the person's epoch, before the
family ends, yields a new pair of the next generation; `authAt`, `stepUpAt`
and `mfaAt` carry over. The answer is `{accessToken, accessExpiresAt,
refreshToken, refreshExpiresAt, stepUpAt, mfaAt}`. A refresh token of an
earlier generation of any issued family, signed out or not, is taken as
theft: the family becomes Reused and the person's epoch moves, so every
session ends; device keys are not touched. Every other refresh is refused
`401 authentication_required` with `refreshRefusal`; the theft answers
`credential_revoked` after it revokes.

```quint
pure def isReuse(f: Family, presented: int): bool = f.phase != Unissued and presented >= 1 and presented < f.generation
pure def refreshRefusal(presented: int, f: Family, personEpoch: int): RefusalReason =
  if (f.phase == Unissued or presented < 1 or presented > f.generation) CredentialUnknown
  else if (presented < f.generation or isRevoked(f, personEpoch)) CredentialRevoked
  else if (f.now >= f.refreshExpiresAt) CredentialExpired
  else NoReason
pure def revokeAll(personEpoch: int): SessionEffect = RevokePersonSessions({ toEpoch: personEpoch + 1 })
pure def canRefresh(f: Family, presented: int, personEpoch: int): bool = isReuse(f, presented) or refreshRefusal(presented, f, personEpoch) == NoReason
pure def refresh(f: Family, presented: int, personEpoch: int): FamilyStep =
  if (isReuse(f, presented)) { state: { ...f, phase: Reused }, out: List(revokeAll(personEpoch)) }
  else { state: { ...f, generation: f.generation + 1, issuedAt: f.now, accessExpiresAt: if (f.now + accessLifetime < f.refreshExpiresAt) f.now + accessLifetime else f.refreshExpiresAt }, out: List() }
pure def lawRefreshRefusalIsNamed(presented: int, f: Family, personEpoch: int): bool = refreshRefusal(presented, f, personEpoch) != NoReason implies wellFormed(refuseFor(AuthenticationRequired, refreshRefusal(presented, f, personEpoch)))
pure def stepRefreshRefusesTheOldPair(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "refresh" implies not(accepts(after, before.generation, after.epoch))
pure def stepOnlyTheftRevokesEverySession(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "refresh" implies ((after.phase == Reused) iff (out.length() == 1))
pure def sometimesRotated(f: Family): bool = isActive(f, f.epoch) and f.generation >= 2
pure def sometimesReuseRevokedEverySession(f: Family): bool = f.phase == Reused
```

## Story: Sign out here, or end my other sessions

> As a person, I want signing out here to end this session only, and
> unlinking a sign-in method or deleting my account to end my other sessions
> at once, so that a lost device or a stolen token stops working the moment
> it matters.

### Logout ends only the presented family, and a second logout changes nothing

Logout takes the family's refresh token of any generation or its access
token, expired or not, and answers `204`. It never moves the person's epoch.

```quint
pure def canLogout(f: Family): bool = f.phase != Unissued
pure def logout(f: Family): Family = if (f.phase == Live) { ...f, phase: Revoked } else f
pure def stepLogoutEndsThisFamilyOnly(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "logout" implies (isEnded(after) and after.epoch == before.epoch and out == List())
pure def sometimesSignedOut(f: Family): bool = f.phase == Revoked
```

### Revoking the others moves the person's epoch and keeps the calling session

Unlinking a sign-in method revokes the others: the person's epoch moves and
the calling family takes the new one in the same transaction. Account
deletion emits `revokeAll` for the person without a family. A sign-in after
either starts a live family.

```quint
pure def canRevokeOthers(f: Family, personEpoch: int): bool = isActive(f, personEpoch)
pure def revokeOthers(f: Family, personEpoch: int): FamilyStep = { state: { ...f, epoch: personEpoch + 1 }, out: List(revokeAll(personEpoch)) }
pure def stepRevokeOthersKeepsTheCaller(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "revokeOthers" implies (isActive(after, after.epoch) and out == List(RevokePersonSessions({ toEpoch: after.epoch })))
pure def sometimesSignedInAfterRevokeAll(f: Family): bool = isActive(f, f.epoch) and f.epoch >= 1 and f.generation == 1
```

### An ended family stays ended

No refresh, step-up or later logout revives a signed-out or stolen family. A
family left behind by an epoch move stays revoked too: only `revokeOthers`
and `signIn` change a family's epoch, and both need a current one.

```quint
pure def stepRevokedStaysRevoked(before: Family, after: Family): bool = isEnded(before) implies isEnded(after)
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
pure def canRecordStepUp(f: Family, personEpoch: int): bool = isActive(f, personEpoch)
pure def recordStepUp(f: Family, personEpoch: int): Family = { ...f, stepUpAt: At({ ms: f.now }), mfaAt: At({ ms: f.now }) }
pure def stepStepUpKeepsTheToken(before: Family, via: str, after: Family, out: List[SessionEffect]): bool = via == "recordStepUp" implies (accepts(after, before.generation, after.epoch) and isSteppedUp(after))
```

### A session is fresh for 60 minutes after a sign-in or step-up, stepped up for 5 minutes after a second factor, and new for 5 minutes after its sign-in

These are read only of a session that `accepts`. `requestAuth` admits the
FreshSession class only for `isFresh` and the StepUp class only for
`isSteppedUp`; a second-factor sign-in counts as a step-up. Enrolling a first
factor needs `isNewlySignedIn`.

```quint
pure val freshWindow: Millis = 60 * millisPerMinute
pure val stepUpWindow: Millis = 5 * millisPerMinute
pure def within(m: Moment, now: Millis, span: Millis): bool = match m { | At(x) => x.ms >= now - span | Never => false }
pure def isFresh(f: Family): bool = f.authAt >= f.now - freshWindow or within(f.stepUpAt, f.now, freshWindow)
pure def isSteppedUp(f: Family): bool = within(f.mfaAt, f.now, stepUpWindow)
pure def isNewlySignedIn(f: Family): bool = f.authAt >= f.now - stepUpWindow
pure def sometimesFreshOnlyThroughStepUp(f: Family): bool = isActive(f, f.epoch) and isFresh(f) and f.authAt < f.now - freshWindow
pure def sometimesStaleSession(f: Family): bool = isActive(f, f.epoch) and not(isFresh(f))
pure def sometimesSteppedUpAtSignIn(f: Family): bool = isActive(f, f.epoch) and isSteppedUp(f) and f.stepUpAt == Never
```
