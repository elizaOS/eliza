# Sessions

The one session issuer of the cloud. A sign-in (email or SMS code, Google,
second factor) starts a session family: an opaque access token that lives 15
minutes and a refresh token, both rotated together on every refresh. The family
ends 30 days after its sign-in, however often it is refreshed. Sources are
develop `packages/auth/src/server` (refresh rotation, reuse detection, the
per-user revocation line, `auth/revocation.ts`) and the server half of the old
`spec/auth/sessions.md`; the cloud's second issuer (`steward-refresh`) is
collapsed into this one. The device half (one in-memory account session,
single-flight refresh) is `spec/os/signIn/credential.md`.

One machine follows one family together with its person's session epoch. The
shell mints tokens of `eliza_session_` + 43 and `eliza_refresh_` + 54 base64url
characters, stores only their SHA-256 digests with the family and generation
they belong to, and turns a presented token into that generation; a digest
with no row answers `credential_unknown` before this machine is reached. No
client decodes a token: expiry and assurance come from the answer body
(`accessExpiresAt`, `refreshExpiresAt`, `stepUpAt`, `mfaAt`). Every constant is
a named value here and every check enters as a parameter, so an importer
defines no opaque function or constant.

## Story: Stay signed in

> As a person who signed in, I want my session to keep working without
> signing in again every few minutes, so that only a stolen refresh token, and
> never time alone, makes me sign in before the month is out.

### A sign-in starts one family whose refresh ends 30 days after the sign-in

The family takes the person's current session epoch. A sign-in finished with a
second factor records `mfaAt`.

```quint
import types.* from "../shared/types"
type FamilyPhase = Unissued | Live | Revoked
type Assurance = SingleFactor | MultiFactor
type Moment = Never | At({ ms: Millis })
type Family = { phase: FamilyPhase, generation: int, epoch: int, sessionEpoch: int, authAt: Millis, issuedAt: Millis, accessExpiresAt: Millis, refreshExpiresAt: Millis, stepUpAt: Moment, mfaAt: Moment, now: Millis }
pure val accessLifetime: Millis = 15 * millisPerMinute
pure val refreshLifetime: Millis = 30 * millisPerDay
pure val initial: Family = { phase: Unissued, generation: 0, epoch: 0, sessionEpoch: 0, authAt: 0, issuedAt: 0, accessExpiresAt: 0, refreshExpiresAt: 0, stepUpAt: Never, mfaAt: Never, now: 0 }
pure def canSignIn(f: Family, assurance: Assurance): bool = f.phase == Unissued
pure def signIn(f: Family, assurance: Assurance): Family = { ...f, phase: Live, generation: 1, epoch: f.sessionEpoch, authAt: f.now, issuedAt: f.now, accessExpiresAt: f.now + accessLifetime, refreshExpiresAt: f.now + refreshLifetime, mfaAt: if (assurance == MultiFactor) At({ ms: f.now }) else Never }
pure def canElapse(f: Family, elapsed: Millis): bool = elapsed > 0
pure def elapse(f: Family, elapsed: Millis): Family = { ...f, now: f.now + elapsed }
pure val elapsedValues = Set(1, 900000, 3600001, 2591400000)
```

### An access token never outlives 15 minutes from its issue or the end of its family

```quint
pure def alwaysAccessWithinLifetimes(f: Family): bool = f.now >= 0 and (f.phase != Unissued implies (f.generation >= 1 and f.authAt <= f.issuedAt and f.issuedAt <= f.now and f.accessExpiresAt <= f.issuedAt + accessLifetime and f.accessExpiresAt <= f.refreshExpiresAt and f.refreshExpiresAt == f.authAt + refreshLifetime))
pure def sometimesFamilyEndCapsAccess(f: Family): bool = f.phase == Live and f.accessExpiresAt < f.issuedAt + accessLifetime
```

### Only the current access token of a live family of the current epoch is accepted, and a refusal names why

A family is revoked when it was signed out or its epoch is behind the
person's. A refused session answers `401 authentication_required` with the
reason given here; a token of an earlier generation is unknown.

```quint
pure def isRevoked(f: Family): bool = f.phase == Revoked or (f.phase == Live and f.epoch < f.sessionEpoch)
pure def isActive(f: Family): bool = f.phase == Live and f.epoch == f.sessionEpoch and f.now < f.accessExpiresAt
pure def accepts(f: Family, presented: int): bool = isActive(f) and presented == f.generation
pure def sessionRefusal(presented: int, f: Family): RefusalReason =
  if (isRevoked(f)) CredentialRevoked
  else if (f.phase == Unissued or presented != f.generation) CredentialUnknown
  else if (f.now >= f.accessExpiresAt) CredentialExpired
  else NoReason
pure def alwaysEpochNeverAhead(f: Family): bool = f.epoch >= 0 and f.epoch <= f.sessionEpoch
pure def sometimesAccessExpiredButRefreshable(f: Family): bool = f.phase == Live and f.epoch == f.sessionEpoch and f.now >= f.accessExpiresAt and f.now < f.refreshExpiresAt
```

### A refresh rotates both tokens, and a spent refresh token presented again revokes every session of the person

The current refresh token, before the family ends and while its epoch is
current, yields a new access and refresh token of the next generation; the
old pair is refused from then on. A token of an earlier generation is taken as
theft: the family is revoked and the person's epoch moves, so every other
session ends too. Device keys are not touched. `authAt`, `stepUpAt` and
`mfaAt` carry over to the new tokens.

```quint
pure def canRefresh(f: Family, presented: int): bool = f.phase == Live and presented >= 1 and presented <= f.generation and (presented < f.generation or (f.epoch == f.sessionEpoch and f.now < f.refreshExpiresAt))
pure def refresh(f: Family, presented: int): Family =
  if (presented == f.generation) { ...f, generation: f.generation + 1, issuedAt: f.now, accessExpiresAt: if (f.now + accessLifetime < f.refreshExpiresAt) f.now + accessLifetime else f.refreshExpiresAt }
  else { ...f, phase: Revoked, sessionEpoch: f.sessionEpoch + 1 }
pure val presentedValues = Set(1, 2, 3)
pure def stepRefreshRotatesOrRevokesAll(before: Family, via: str, after: Family): bool = via == "refresh" implies ((after.generation == before.generation + 1 and after.phase == Live and after.issuedAt == before.now) or (after.phase == Revoked and after.sessionEpoch > before.sessionEpoch))
pure def sometimesRotated(f: Family): bool = isActive(f) and f.generation >= 2
pure def sometimesReuseRevokedEverySession(f: Family): bool = f.phase == Revoked and f.generation >= 2 and f.sessionEpoch > f.epoch
```

## Story: Sign out here, or everywhere

> As a person, I want signing out here to end this session only, and a
> revocation of all my sessions to take effect at once, so that a lost
> device or a stolen token stops working the moment I act.

### Logout revokes only the presented family

The other families of the person keep their epoch.

```quint
pure def canLogout(f: Family): bool = f.phase == Live
pure def logout(f: Family): Family = { ...f, phase: Revoked }
pure def sometimesSignedOutHereOnly(f: Family): bool = f.phase == Revoked and f.sessionEpoch == 0
```

### Revoking all ends every session of the person, and revoking the others keeps the caller

`revokeAll` is used by account deletion and the operator; `revokeOthers` by
unlinking a sign-in method, in one transaction that moves the person's epoch
and gives the calling family the new one. A sign-in after either starts a
family that is live.

```quint
pure def canRevokeAll(f: Family): bool = true
pure def revokeAll(f: Family): Family = { ...f, sessionEpoch: f.sessionEpoch + 1 }
pure def canRevokeOthers(f: Family): bool = isActive(f)
pure def revokeOthers(f: Family): Family = { ...f, sessionEpoch: f.sessionEpoch + 1, epoch: f.sessionEpoch + 1 }
pure def stepRevokeAllEndsThisFamily(before: Family, via: str, after: Family): bool = via == "revokeAll" implies (after.phase == Unissued or isRevoked(after))
pure def stepRevokeOthersKeepsTheCaller(before: Family, via: str, after: Family): bool = via == "revokeOthers" implies (isActive(after) and after.sessionEpoch > before.sessionEpoch)
pure def sometimesSignedInAfterRevokeAll(f: Family): bool = isActive(f) and f.sessionEpoch >= 1 and f.generation == 1
```

### A revoked session stays revoked

No refresh, step-up or later revocation revives a family once it was signed
out or its epoch fell behind.

```quint
pure def stepRevokedStaysRevoked(before: Family, after: Family): bool = isRevoked(before) implies isRevoked(after)
```

## Story: Confirm it is me before a sensitive change

> As an account owner, I want a recent sign-in or step-up asked of me before
> a billing or sign-in method change, so that someone holding my unlocked
> device for a while cannot make it.

### A step-up marks the same session and leaves its token unchanged

`secondFactor` checks the code; this records `stepUpAt` (and `mfaAt` for a
second factor) on the calling family and answers `{stepUpAt, mfaAt}`.

```quint
pure def canRecordStepUp(f: Family, assurance: Assurance): bool = isActive(f)
pure def recordStepUp(f: Family, assurance: Assurance): Family = { ...f, stepUpAt: At({ ms: f.now }), mfaAt: if (assurance == MultiFactor) At({ ms: f.now }) else f.mfaAt }
pure def stepStepUpKeepsTheToken(before: Family, via: str, after: Family): bool = via == "recordStepUp" implies (after.generation == before.generation and after.accessExpiresAt == before.accessExpiresAt and after.stepUpAt == At({ ms: before.now }))
```

### A session is fresh for 60 minutes after a sign-in or step-up, and stepped up for 5 minutes after a step-up

`requestAuth` admits the FreshSession class only for `isFresh` and the StepUp
class only for `isSteppedUp`; enrolling a first factor needs `isNewlySignedIn`.

```quint
pure val freshWindow: Millis = 60 * millisPerMinute
pure val stepUpWindow: Millis = 5 * millisPerMinute
pure def within(m: Moment, now: Millis, window: Millis): bool = match m { | At(x) => x.ms >= now - window | Never => false }
pure def isFresh(f: Family): bool = isActive(f) and (f.authAt >= f.now - freshWindow or within(f.stepUpAt, f.now, freshWindow))
pure def isSteppedUp(f: Family): bool = isActive(f) and within(f.stepUpAt, f.now, stepUpWindow)
pure def isNewlySignedIn(f: Family): bool = isActive(f) and f.authAt >= f.now - stepUpWindow
pure def sometimesFreshOnlyThroughStepUp(f: Family): bool = isFresh(f) and f.authAt < f.now - freshWindow
pure def sometimesStaleSession(f: Family): bool = isActive(f) and not(isFresh(f))
```
