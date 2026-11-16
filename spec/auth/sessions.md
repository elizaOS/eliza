# Sessions

A sign-in starts a session family: a short-lived access token and a refresh
token. Refreshing rotates the refresh token, and a rotated token presented
again is taken as theft, which revokes the whole family. Logout revokes the
presented session, and revoke-all ends every session of a person. A client
holding one session refreshes it once, however many reads overlap.

[Agent host access](../agent/host/access.md) verifies sessions with these rules.

## Story: Stay signed in and sign out everywhere

> As a person, I want to stay signed in without signing in again every few
> minutes, and I want signing out, here or everywhere, to take effect at
> once, even against someone who copied my refresh token.

### An access token never outlives its lifetime or the session maximum

```quint
type TokenStatus = ActiveToken | RotatedToken | RevokedToken
type RefreshToken = { id: int, family: int, status: TokenStatus }
type SessionFamily = { id: int, user: int, startedAt: int, revoked: bool }
type AccessToken = { id: int, family: int, issuedAt: int, expiresAt: int }
type ClientOutcome = ClientIdle | ClientRefreshed | ClientKeptCredential | ClientSignedOutByServer | ClientSignedOut
type Sessions = {
  now: int, nextId: int, families: List[SessionFamily], refreshTokens: List[RefreshToken], accessTokens: List[AccessToken],
  reuseDetected: List[int], revokedBefore: int -> int,
  clientRefreshToken: int, clientAccess: int, clientInFlight: int, clientWaiters: int, clientOutcome: ClientOutcome
}
pure val initial: Sessions = {
  now: 0, nextId: 1, families: List(), refreshTokens: List(), accessTokens: List(), reuseDetected: List(), revokedBefore: Map(),
  clientRefreshToken: 0, clientAccess: 0, clientInFlight: 0, clientWaiters: 0, clientOutcome: ClientIdle
}
pure val accessLifetime = 900
pure val sessionMaximum = 2592000
pure val noFamily: SessionFamily = { id: 0, user: 0, startedAt: 0, revoked: true }
pure def familyOf(s: Sessions, id: int): SessionFamily = s.families.select(f => f.id == id).nthOr(0, noFamily)
pure def accessExpiry(now: int, startedAt: int): int = if (now + accessLifetime <= startedAt + sessionMaximum) now + accessLifetime else startedAt + sessionMaximum
pure def canSignIn(s: Sessions, user: int): bool = user > 0
pure def signIn(s: Sessions, user: int): SessionChange = audited(s.families,
  { ...s, nextId: s.nextId + 3,
    families: s.families.append({ id: s.nextId, user: user, startedAt: s.now, revoked: false }),
    refreshTokens: s.refreshTokens.append({ id: s.nextId + 1, family: s.nextId, status: ActiveToken }),
    accessTokens: s.accessTokens.append({ id: s.nextId + 2, family: s.nextId, issuedAt: s.now, expiresAt: accessExpiry(s.now, s.now) }),
    clientRefreshToken: if (user == 1) s.nextId + 1 else s.clientRefreshToken, clientAccess: if (user == 1) s.nextId + 2 else s.clientAccess,
    clientOutcome: if (user == 1) ClientIdle else s.clientOutcome })
pure val userValues = Set(1, 2)
pure def canElapse(s: Sessions, seconds: int): bool = seconds > 0
pure def elapse(s: Sessions, seconds: int): Sessions = { ...s, now: s.now + seconds }
pure val secondsValues = Set(60, 900, 2591500, 2592000)
pure def alwaysAccessWithinLifetimes(s: Sessions): bool =
  s.accessTokens.every(a => a.expiresAt <= a.issuedAt + accessLifetime and a.expiresAt <= familyOf(s, a.family).startedAt + sessionMaximum and s.families.some(f => f.id == a.family))
pure def sometimesSessionMaximumShortensAccess(s: Sessions): bool = s.accessTokens.some(a => a.expiresAt < a.issuedAt + accessLifetime)
```

### A refresh token rotates on use, and reuse of a rotated token revokes its session family

A family has at most one usable refresh token. Refresh is refused once the
session maximum has passed or the family is revoked.

```quint
pure val noRefreshToken: RefreshToken = { id: 0, family: 0, status: RevokedToken }
pure def refreshTokenOf(s: Sessions, id: int): RefreshToken = s.refreshTokens.select(t => t.id == id).nthOr(0, noRefreshToken)
pure def revokeFamilies(s: Sessions, doomed: List[int]): List[RefreshToken] = s.refreshTokens.listMap(t => if (doomed.includes(t.family)) { ...t, status: RevokedToken } else t)
pure def revokedFamilies(s: Sessions, doomed: List[int]): List[SessionFamily] = s.families.listMap(f => if (doomed.includes(f.id)) { ...f, revoked: true } else f)
pure def rotates(s: Sessions, id: int): bool = {
  val t = refreshTokenOf(s, id)
  val f = familyOf(s, t.family)
  t.status == ActiveToken and not(f.revoked) and s.now < f.startedAt + sessionMaximum
}
pure def refreshed(id: int, s: Sessions): Sessions = {
  val t = refreshTokenOf(s, id)
  val f = familyOf(s, t.family)
  if (rotates(s, id))
    { ...s, nextId: s.nextId + 2,
      refreshTokens: s.refreshTokens.listMap(r => if (r.id == id) { ...r, status: RotatedToken } else r).append({ id: s.nextId, family: t.family, status: ActiveToken }),
      accessTokens: s.accessTokens.append({ id: s.nextId + 1, family: t.family, issuedAt: s.now, expiresAt: accessExpiry(s.now, f.startedAt) }) }
  else if (t.status == RotatedToken and not(f.revoked))
    { ...s, families: revokedFamilies(s, List(t.family)), refreshTokens: revokeFamilies(s, List(t.family)), reuseDetected: s.reuseDetected.append(t.family) }
  else s
}
pure def canRefresh(s: Sessions, token: int): bool = s.refreshTokens.some(t => t.id == token)
pure def refresh(s: Sessions, token: int): SessionChange = audited(s.families, refreshed(token, s))
pure val tokenValues = Set(2, 5, 7, 8)
pure def alwaysOneUsableRefreshTokenPerFamily(s: Sessions): bool =
  s.families.every(f => s.refreshTokens.select(t => t.family == f.id and t.status == ActiveToken).length() <= 1 and (f.revoked implies not(s.refreshTokens.some(t => t.family == f.id and t.status == ActiveToken))))
pure def alwaysReuseRevokesTheFamily(s: Sessions): bool = s.reuseDetected.every(id => familyOf(s, id).revoked and s.families.some(f => f.id == id))
pure def sometimesRotated(s: Sessions): bool = s.refreshTokens.some(t => t.status == RotatedToken) and s.families.some(f => not(f.revoked))
pure def sometimesReuseDetected(s: Sessions): bool = s.reuseDetected.length() > 0
```

### Logout revokes the presented session, and revoke-all revokes every session of the person

```quint
pure def canLogout(s: Sessions, token: int): bool = s.refreshTokens.some(t => t.id == token)
pure def loggedOut(token: int, s: Sessions): Sessions = {
  val family = refreshTokenOf(s, token).family
  { ...s, families: revokedFamilies(s, List(family)), refreshTokens: revokeFamilies(s, List(family)) }
}
pure def logout(s: Sessions, token: int): SessionChange = audited(s.families, loggedOut(token, s))
pure def canRevokeAll(s: Sessions, user: int): bool = user > 0
pure def revokeAll(s: Sessions, user: int): SessionChange = {
  val doomed = s.families.select(f => f.user == user).listMap(f => f.id)
  audited(s.families, { ...s, families: revokedFamilies(s, doomed), refreshTokens: revokeFamilies(s, doomed), revokedBefore: s.revokedBefore.put(user, s.nextId) })
}
pure def alwaysRevokeAllCoversEarlierSessions(s: Sessions): bool =
  s.families.every(f => f.id < s.revokedBefore.getOr(f.user, 0) implies f.revoked) and s.families.every(f => f.id < s.nextId)
pure def sometimesSignedInAgainAfterRevokeAll(s: Sessions): bool = s.families.some(f => not(f.revoked) and s.revokedBefore.getOr(f.user, 0) > 0 and f.id >= s.revokedBefore.getOr(f.user, 0))
```

### Revocation is visible to every verifier before the revoke call returns

The verifier reads the family's revocation on every request, so no access
token of a revoked family is accepted in the state the revoke leaves.

```quint
pure def accepts(s: Sessions, access: int): bool =
  s.accessTokens.some(a => a.id == access and s.now < a.expiresAt and s.families.some(f => f.id == a.family and not(f.revoked)))
pure def stepRevocationVisibleOnReturn(before: Sessions, via: str, after: Sessions): bool =
  (via == "logout" or via == "revokeAll" or via == "refresh") implies after.accessTokens.every(a => familyOf(after, a.family).revoked implies not(accepts(after, a.id)))
pure def sometimesRevokedWhileAccessUnexpired(s: Sessions): bool = s.accessTokens.some(a => s.now < a.expiresAt and familyOf(s, a.family).revoked)
```

### Overlapping client reads share one pending refresh

A read with a usable access token needs no refresh. A read that finds it
expired starts one refresh or joins the one in flight. A transient failure
keeps the credential for the next read; a refused refresh signs the client
out, and a client sign-out stays final even when a pending refresh answers
later.

```quint
pure def clientUsable(s: Sessions): bool = s.clientAccess > 0 and accepts(s, s.clientAccess)
pure def canClientRead(s: Sessions): bool = s.clientRefreshToken > 0
pure def clientRead(s: Sessions): Sessions =
  if (clientUsable(s)) s
  else if (s.clientInFlight > 0) { ...s, clientWaiters: s.clientWaiters + 1 }
  else { ...s, clientInFlight: 1 }
pure def canClientRefreshSettles(s: Sessions, transient: bool): bool = s.clientInFlight > 0
pure def clientRefreshSettles(s: Sessions, transient: bool): SessionChange = audited(s.families, clientSettled(transient, s))
pure def clientSettled(transient: bool, s: Sessions): Sessions =
  if (s.clientRefreshToken == 0) { ...s, clientInFlight: 0, clientWaiters: 0 }
  else if (transient) { ...s, clientInFlight: 0, clientWaiters: 0, clientOutcome: ClientKeptCredential }
  else if (rotates(s, s.clientRefreshToken)) { ...refreshed(s.clientRefreshToken, s), clientRefreshToken: s.nextId, clientAccess: s.nextId + 1, clientInFlight: 0, clientWaiters: 0, clientOutcome: ClientRefreshed }
  else { ...refreshed(s.clientRefreshToken, s), clientRefreshToken: 0, clientAccess: 0, clientInFlight: 0, clientWaiters: 0, clientOutcome: ClientSignedOutByServer }
pure def canClientSignOut(s: Sessions): bool = s.clientRefreshToken > 0
pure def clientSignOut(s: Sessions): SessionChange = audited(s.families, { ...loggedOut(s.clientRefreshToken, s), clientRefreshToken: 0, clientAccess: 0, clientOutcome: ClientSignedOut })
pure def alwaysOneClientRefreshInFlight(s: Sessions): bool = s.clientInFlight >= 0 and s.clientInFlight <= 1 and (s.clientWaiters > 0 implies s.clientInFlight == 1)
pure def alwaysSignOutStaysFinal(s: Sessions): bool = (s.clientOutcome == ClientSignedOut or s.clientOutcome == ClientSignedOutByServer) implies (s.clientRefreshToken == 0 and s.clientAccess == 0)
pure def alwaysTransientFailureKeepsCredential(s: Sessions): bool = s.clientOutcome == ClientKeptCredential implies s.clientRefreshToken > 0
pure def sometimesOverlappingReadsShareRefresh(s: Sessions): bool = s.clientWaiters >= 1 and s.clientInFlight == 1
pure def sometimesClientRefreshed(s: Sessions): bool = s.clientOutcome == ClientRefreshed
pure def sometimesSignOutDuringRefresh(s: Sessions): bool = s.clientOutcome == ClientSignedOut and s.clientInFlight == 1
```

### Every sign-in and every revocation is written to the audit log

A step that starts a session family or revokes one emits one entry for the
[audit log](./audit.md).

```quint
type AuditEntry = SessionStarted | SessionsRevoked
type SessionChange = { state: Sessions, out: List[AuditEntry] }
pure def revokedCount(families: List[SessionFamily]): int = families.select(f => f.revoked).length()
pure def audited(familiesBefore: List[SessionFamily], changed: Sessions): SessionChange = {
  val started: List[AuditEntry] = if (changed.families.length() > familiesBefore.length()) List(SessionStarted) else List()
  val revoked: List[AuditEntry] = if (revokedCount(changed.families) > revokedCount(familiesBefore)) List(SessionsRevoked) else List()
  { state: changed, out: started.concat(revoked) }
}
pure def stepSessionChangeIsAudited(before: Sessions, after: Sessions, out: List[AuditEntry]): bool =
  (after.families.length() > before.families.length() implies out.includes(SessionStarted)) and
    (revokedCount(after.families) > revokedCount(before.families) implies out.includes(SessionsRevoked))
```
