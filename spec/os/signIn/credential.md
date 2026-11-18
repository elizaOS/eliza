# Device credential

Custody of the device key the cloud issues (`spec/cloud/nativeClients/deviceKeys.md`:
connect, token, ack, self-revoke; 30-day keys, never renewed) and of the one
in-memory account session (`spec/cloud/identity/sessions.md`). The sign-in
flow (`./flow.md`) runs the exchange. Key values, codes, PKCE verifiers and
session tokens stay in the Java shell; the model sees versions, accounts,
times and outcomes. The shell keeps keys in secure store slots
(`../android/secureStore.md`) prefixed with the deployment's authority
digest, and this machine's state, except the session, durably beside them.
Times are epoch milliseconds. `Announce`, `SignedOutNotice` and
`ExpiredNotice` go to the agent service; the shell acts on `VerifyAccount`.

## Story: Keep me signed in without a second copy of my key

> As a person who signed in on this device, I want one key kept for me and
> handed to my agent once, and a lost reply or an older sign-in never to
> undo a newer one, so that my agent keeps working without asking me again.

### A sign-in reserves the next generation, and only the newest sign-in's answers are taken

Each answer names the generation of the sign-in it belongs to. An answer of
an older generation is discarded. A new sign-in, a sign-out or a reset
starts a new generation; nothing else changes it.

```quint
import types.* from "../../cloud/shared/types"
import sessions as Iss from "../../cloud/identity/sessions"
import secureStore as S from "../android/secureStore"
type Account = { userId: str, organizationId: str }
type Custody = SignedOut | Active({ version: int, credentialId: str, account: Account, keyExpiresAt: Millis }) | Expired({ account: Account })
type Attempt = NoAttempt | Exchanging({ attempt: int }) | Acknowledging({ attempt: int, version: int, credentialId: str, account: Account, lapsesAt: Millis })
type Duty = { version: int, lapsesAt: Millis, tries: int }
type AccountSession = NoSession | Session({ version: int, until: Millis, accessExpiresAt: Millis, refreshing: bool, waiters: int })
type DeviceCredential = { now: Millis, generation: int, lastVersion: int, custody: Custody, attempt: Attempt, duties: List[Duty], session: AccountSession }
type CredentialNotice = Announce({ version: int, account: Account }) | SignedOutNotice | ExpiredNotice | VerifyAccount
type CredentialStep = { state: DeviceCredential, out: List[CredentialNotice] }
pure val initial: DeviceCredential = { now: 0, generation: 0, lastVersion: 0, custody: SignedOut, attempt: NoAttempt, duties: List(), session: NoSession }
pure val noAccount: Account = { userId: "", organizationId: "" }
pure def attemptOf(s: DeviceCredential): int = { val p = s.attempt  match p { | Exchanging(e) => e.attempt | Acknowledging(k) => k.attempt | NoAttempt => 0 } }
pure def activeVersion(s: DeviceCredential): int = { val c = s.custody  match c { | Active(a) => a.version | _ => 0 } }
pure def pendingVersion(s: DeviceCredential): int = { val p = s.attempt  match p { | Acknowledging(k) => k.version | _ => 0 } }
pure def accountOf(s: DeviceCredential): Account = { val c = s.custody  match c { | Active(a) => a.account | Expired(e) => e.account | SignedOut => noAccount } }
pure def credentialIdOf(s: DeviceCredential): str = { val c = s.custody  match c { | Active(a) => a.credentialId | _ => "" } }
pure def isSignedIn(s: DeviceCredential): bool = activeVersion(s) >= 1
pure def beginSignIn(s: DeviceCredential): DeviceCredential =
  { ...s, generation: s.generation + 1, attempt: Exchanging({ attempt: s.generation + 1 }), duties: s.duties.concat(pendingDuty(s.attempt, signOutAttempts)) }
pure val attemptValues = Set(1, 2)
pure val weight_beginSignIn = 2
pure def alwaysCountersAreNatural(s: DeviceCredential): bool = s.now >= 0 and s.generation >= 0 and s.lastVersion >= 0
pure def alwaysSignInIsTheNewestAction(s: DeviceCredential): bool = s.attempt == NoAttempt or (attemptOf(s) == s.generation and s.generation >= 1)
pure def stepGenerationCountsOwnerActions(before: DeviceCredential, via: str, after: DeviceCredential): bool =
  after.generation == before.generation + (if (via == "beginSignIn" or via == "signOut" or via == "reset") 1 else 0)
```

### A minted key is kept only after the secure store reads it back, and a lost token reply is asked again with the same code

The token answer carries the credential id, the account (`user.id`,
`organizationId`) and the key's expiry. The shell writes the key to a slot
of its own, never over the active key, and reads it back before it reports
the answer; only a `Written` outcome gives the key a new version and moves
on to the acknowledgement. Any other outcome, or no
answer, leaves the exchange where it was: the shell asks `token` again with
the same one-time code and PKCE verifier, and the cloud answers the same
credential from its sealed copy until it is acknowledged. There is no
device request-id replay. An acknowledgement may come up to the code's
five-minute deadline later, so a key awaiting it may live that much past
the expiry the token answer gave.

```quint
pure val ackWindow: Millis = 5 * millisPerMinute
pure def canTokenAnswered(s: DeviceCredential, attempt: int, credentialId: str, account: Account, keyExpiresAt: Millis): bool =
  s.attempt == Exchanging({ attempt: attempt }) and credentialId != "" and account.userId != "" and account.organizationId != "" and keyExpiresAt > s.now
pure def tokenAnswered(s: DeviceCredential, attempt: int, credentialId: str, account: Account, keyExpiresAt: Millis, stored: S::ExchangeOutcome): DeviceCredential =
  if (stored == S::Written) { ...s, lastVersion: s.lastVersion + 1,
    attempt: Acknowledging({ attempt: attempt, version: s.lastVersion + 1, credentialId: credentialId, account: account, lapsesAt: keyExpiresAt + ackWindow }) }
  else s
pure val credentialIdValues = Set("c1", "c2")
pure val accountValues = Set({ userId: "u1", organizationId: "o1" }, { userId: "u2", organizationId: "o2" }, { userId: "", organizationId: "o1" })
pure val keyExpiresAtValues = Set(120000, 2592000000)
pure val storedValues = Set(S::Written, S::Unconfirmed, S::Failed)
pure val weight_tokenAnswered = 6
pure def mintedActive(c: Custody, lastVersion: int): bool = match c { | Active(a) => a.version >= 1 and a.version <= lastVersion | _ => true }
pure def mintedPending(p: Attempt, lastVersion: int, active: int): bool = match p { | Acknowledging(k) => k.version >= 1 and k.version == lastVersion and active < k.version | _ => true }
pure def alwaysKeysAreMintedInOrder(s: DeviceCredential): bool = mintedActive(s.custody, s.lastVersion) and mintedPending(s.attempt, s.lastVersion, activeVersion(s))
pure def sometimesAwaitingAcknowledgement(s: DeviceCredential): bool = pendingVersion(s) >= 1
```

### A key becomes active only when the cloud acknowledges it, and each new key is announced once

The acknowledgement (`{status: "acknowledged", credentialId, expiresAt}`)
of the newest sign-in, for the credential its token answer named, installs
that key as the active one with the expiry the answer gives. A key it replaces leaves with a revoke duty, and
the account session of the old key is discarded. The new key is announced
once with its account; the agent service pushes it to a running agent of
the same account, or restarts the agent on the new account's directory.

```quint
pure def canAcknowledged(s: DeviceCredential, attempt: int, credentialId: str, keyExpiresAt: Millis): bool = {
  val p = s.attempt
  match p { | Acknowledging(k) => k.attempt == attempt and k.credentialId == credentialId and keyExpiresAt > s.now | _ => false }
}
pure def acknowledged(s: DeviceCredential, attempt: int, credentialId: str, keyExpiresAt: Millis): CredentialStep = {
  val p = s.attempt
  match p {
    | Acknowledging(k) => { state: { ...s, custody: Active({ version: k.version, credentialId: k.credentialId, account: k.account, keyExpiresAt: keyExpiresAt }), attempt: NoAttempt, session: NoSession,
        duties: s.duties.concat(keyDuty(s.custody, signOutAttempts)) }, out: List(Announce({ version: k.version, account: k.account })) }
    | _ => { state: s, out: List() }
  } }
pure val weight_acknowledged = 6
pure def isAnnounce(n: CredentialNotice): bool = match n { | Announce(a) => true | _ => false }
pure def stepEachNewKeyIsAnnouncedOnce(before: DeviceCredential, via: str, after: DeviceCredential, out: List[CredentialNotice]): bool =
  if (activeVersion(after) >= 1 and activeVersion(after) != activeVersion(before))
    via == "acknowledged" and activeVersion(after) == pendingVersion(before) and out == List(Announce({ version: activeVersion(after), account: accountOf(after) }))
  else not(out.some(n => isAnnounce(n)))
pure def sometimesSignedIn(s: DeviceCredential): bool = isSignedIn(s) and s.attempt == NoAttempt
pure def sometimesNewKeyReplacedOld(s: DeviceCredential): bool = activeVersion(s) >= 2 and owes(s, 1)
```

### A cancelled or refused sign-in leaves the active key as it was

The flow ends its own sign-in when the person cancels it, or when the cloud
refuses its token or its acknowledgement (`401 credential_proof_invalid`,
or a code past its deadline). A key it already stored is discarded with a
revoke duty, because a lost acknowledgement may have made it live.

```quint
pure def canSignInEnded(s: DeviceCredential, attempt: int): bool = s.attempt != NoAttempt and attemptOf(s) == attempt
pure def signInEnded(s: DeviceCredential, attempt: int): DeviceCredential =
  { ...s, attempt: NoAttempt, duties: s.duties.concat(pendingDuty(s.attempt, signOutAttempts)) }
pure def sometimesKeptKeyAfterEndedSignIn(s: DeviceCredential): bool = isSignedIn(s) and s.generation >= 2 and s.attempt == NoAttempt and owes(s, s.lastVersion)
```

### An expired key keeps the account, and only the account read signs out on a revoked or unknown key

A `401` for the active key arrives here with its reason, from any cloud
request of the device (`cloudRequests`, `cloudSpeech`, the agent), and is
not retried. `credential_expired` keeps the account and the local data and
asks for a new sign-in. `credential_revoked` or `credential_unknown` from
`GET /api/v1/user` signs out and clears the stored credential, owing no
revoke; from any other request it only asks the shell to read
`GET /api/v1/user`. A `401` for a key already replaced changes nothing.

```quint
pure def canRejected(s: DeviceCredential, version: int, reason: RefusalReason): bool = version >= 1 and activeVersion(s) == version and isCredentialReason(reason)
type RejectedOn = AccountRead | OtherRequest
pure def rejected(s: DeviceCredential, version: int, reason: RefusalReason, on: RejectedOn): CredentialStep =
  if (reason == CredentialExpired) { state: { ...s, custody: Expired({ account: accountOf(s) }), session: NoSession }, out: List(ExpiredNotice) }
  else if (on == AccountRead) { state: { ...s, custody: SignedOut, session: NoSession }, out: List(SignedOutNotice) }
  else { state: s, out: List(VerifyAccount) }
pure val versionValues = Set(1, 2)
pure val reasonValues = Set(CredentialExpired, CredentialRevoked, CredentialUnknown, NoReason)
pure def sometimesExpired(s: DeviceCredential): bool = s.custody == Expired({ account: accountOf(s) }) and accountOf(s).userId != ""
pure def sometimesSignedOutByCloud(s: DeviceCredential): bool = s.custody == SignedOut and s.lastVersion >= 1 and s.generation == 1 and s.duties == List()
```

## Story: Sign out or reset cleanly

> As a person, I want signing out or resetting the device to end my key at
> the cloud even when I am offline, and never to end a key I still use.

### Every key that leaves the device while the cloud may still accept it is owed a revoke, stored in the same step

A duty names the key's version and when it lapses. The shell stores the
duty before it removes the key from its slot, under one lock, and sends
`DELETE /api/v1/api-keys/current` with the owed key; the cloud ends that
key only. Sign-out and reset end the active key and a key awaiting
acknowledgement; several duties may be owed. A key the cloud said is
expired, revoked or unknown is owed nothing, and a key still held is never
owed.

```quint
pure val signOutAttempts = 3
pure val resetAttempts = 1
pure def keyDuty(c: Custody, tries: int): List[Duty] = match c { | Active(a) => List({ version: a.version, lapsesAt: a.keyExpiresAt, tries: tries }) | _ => List() }
pure def pendingDuty(p: Attempt, tries: int): List[Duty] = match p { | Acknowledging(k) => List({ version: k.version, lapsesAt: k.lapsesAt, tries: tries }) | _ => List() }
pure def owes(s: DeviceCredential, version: int): bool = s.duties.some(d => d.version == version)
pure def endedBy(tries: int, s: DeviceCredential): CredentialStep =
  { state: { ...s, generation: s.generation + 1, custody: SignedOut, attempt: NoAttempt, session: NoSession,
      duties: s.duties.concat(keyDuty(s.custody, tries)).concat(pendingDuty(s.attempt, tries)) },
    out: if (s.custody == SignedOut) List() else List(SignedOutNotice) }
pure def signOut(s: DeviceCredential): CredentialStep = endedBy(signOutAttempts, s)
pure def reset(s: DeviceCredential): CredentialStep = endedBy(resetAttempts, s)
pure def alwaysDutiesNameRetiredKeys(s: DeviceCredential): bool =
  s.duties.every(d => d.version >= 1 and d.version <= s.lastVersion and d.tries >= 0 and d.tries <= signOutAttempts
    and d.version != activeVersion(s) and d.version != pendingVersion(s))
pure def stepAKeyLeavesOnlyWithItsDuty(before: DeviceCredential, via: str, after: DeviceCredential, out: List[CredentialNotice]): bool =
  ((activeVersion(before) >= 1 and activeVersion(after) != activeVersion(before) and via != "rejected") implies owes(after, activeVersion(before)))
    and ((pendingVersion(before) >= 1 and pendingVersion(after) == 0 and via != "acknowledged") implies owes(after, pendingVersion(before)))
pure def sometimesSeveralDutiesOwed(s: DeviceCredential): bool = s.duties.length() >= 2
```

### A duty is asked up to three times in this process and once at each later start, until the cloud answers or the key lapses

A sign-out asks at once and twice more; a reset asks once, and its local
wipe never waits for the answer. A `2xx` or `401` answer settles the duty;
no answer uses one try. Each start gives every owed duty one more try. A
duty is dropped once its key has lapsed.

```quint
pure val startAttempts = 1
pure def canRevokeAnswered(s: DeviceCredential, version: int): bool = s.duties.some(d => d.version == version and d.tries > 0)
type RevokeReply = RevokeSettled | RevokeUnanswered
pure def revokeAnswered(s: DeviceCredential, version: int, reply: RevokeReply): DeviceCredential =
  { ...s, duties: if (reply == RevokeSettled) s.duties.select(d => d.version != version)
    else s.duties.listMap(d => if (d.version == version and d.tries > 0) { ...d, tries: d.tries - 1 } else d) }
pure def canElapse(s: DeviceCredential, ms: Millis): bool = ms > 0
pure def elapse(s: DeviceCredential, ms: Millis): DeviceCredential =
  { ...s, now: s.now + ms, duties: s.duties.select(d => d.lapsesAt > s.now + ms), session: sessionAt(s.now + ms, s.session) }
pure val msValues = Set(60000, 1000000, 3600000)
pure def sometimesSignedOutWhileKeyStillOwed(s: DeviceCredential): bool = s.custody == SignedOut and s.duties.some(d => d.tries == startAttempts)
```

### A restart keeps the custody, a key awaiting acknowledgement and every duty, and forgets only work in flight

An exchange without a stored key and the account session are lost with the
process; the cloud never makes an unacknowledged key usable. A stored key
awaiting acknowledgement is asked about again.

```quint
pure def restart(s: DeviceCredential): DeviceCredential =
  { ...s, attempt: if (pendingVersion(s) >= 1) s.attempt else NoAttempt, session: NoSession, duties: s.duties.listMap(d => { ...d, tries: startAttempts }) }
pure def stepRestartKeepsCustody(before: DeviceCredential, via: str, after: DeviceCredential): bool =
  via == "restart" implies (after.custody == before.custody and after.generation == before.generation and pendingVersion(after) == pendingVersion(before) and after.duties.length() == before.duties.length())
```

## Story: Confirm it is me before a billing change

> As an account owner, I want a billing or account change confirmed by a
> recent sign-in of my own account, held only briefly and only in memory,
> so that someone holding my unlocked device cannot make it later.

### An account session is held in memory only for the active key's account, for at most one hour

The flow's `reauthenticate` verifies the signed-in account and hands over
the session answer (`accessExpiresAt` from the body; no token is decoded).
A session of another account is refused. The session is bound to the
active key, ends one hour after it was granted (the cloud's fresh window),
and is discarded on sign-out, a new key, a restart, or a `401` on a route
sent with it. Routes the consumer marks session-only are sent only with a
usable session.

```quint
pure def sessionAt(now: Millis, x: AccountSession): AccountSession = match x { | Session(t) => if (now >= t.until) NoSession else x | NoSession => NoSession }
pure def canGrantSession(s: DeviceCredential, account: Account, accessExpiresAt: Millis): bool = isSignedIn(s) and accountOf(s) == account and accessExpiresAt > s.now
pure def grantSession(s: DeviceCredential, account: Account, accessExpiresAt: Millis): DeviceCredential = {
  val until = s.now + Iss::freshWindow
  { ...s, session: Session({ version: activeVersion(s), until: until, accessExpiresAt: if (accessExpiresAt < until) accessExpiresAt else until, refreshing: false, waiters: 0 }) }
}
pure def canDropSession(s: DeviceCredential): bool = s.session != NoSession
pure def dropSession(s: DeviceCredential): DeviceCredential = { ...s, session: NoSession }
pure def sessionUsable(s: DeviceCredential): bool = { val held = s.session  match held { | Session(t) => s.now < t.accessExpiresAt | NoSession => false } }
pure val accessExpiresAtValues = Set(900000, 7200000)
pure val weight_grantSession = 3
pure def alwaysSessionBelongsToTheActiveKey(s: DeviceCredential): bool = { val held = s.session  match held {
  | Session(t) => t.version >= 1 and t.version == activeVersion(s) and s.now < t.until and t.until <= s.now + Iss::freshWindow and t.accessExpiresAt <= t.until
  | NoSession => true } }
pure def sometimesSessionUsable(s: DeviceCredential): bool = sessionUsable(s)
```

### Overlapping readers share one pending refresh

A reader of an expired access token starts the refresh
(`POST /api/v1/auth/refresh`) or waits for the one in flight: the cloud
takes a spent refresh token as theft and ends every session of the person.
A refresh never reaches past the session's hour. No answer keeps the
session for the next reader; a refusal discards it.

```quint
type RefreshAnswer = Refreshed({ accessExpiresAt: Millis }) | RefreshUnanswered | RefreshRefused
pure def canReadSession(s: DeviceCredential): bool = s.session != NoSession and not(sessionUsable(s))
pure def readSession(s: DeviceCredential): DeviceCredential = {
  val x = s.session
  match x {
    | Session(t) => { ...s, session: if (t.refreshing) Session({ ...t, waiters: t.waiters + 1 }) else Session({ ...t, refreshing: true }) }
    | NoSession => s
  } }
pure def canRefreshAnswered(s: DeviceCredential): bool = { val held = s.session  match held { | Session(t) => t.refreshing | NoSession => false } }
pure def refreshAnswered(s: DeviceCredential, answer: RefreshAnswer): DeviceCredential = {
  val x = s.session
  match x {
    | Session(t) => match answer {
        | Refreshed(r) => { ...s, session: Session({ ...t, accessExpiresAt: if (r.accessExpiresAt < t.until) r.accessExpiresAt else t.until, refreshing: false, waiters: 0 }) }
        | RefreshUnanswered => { ...s, session: Session({ ...t, refreshing: false, waiters: 0 }) }
        | RefreshRefused => { ...s, session: NoSession }
      }
    | NoSession => s
  } }
pure val answerValues = Set(Refreshed({ accessExpiresAt: 2000000 }), RefreshUnanswered, RefreshRefused)
pure val weight_readSession = 3
pure def alwaysOneRefreshInFlight(s: DeviceCredential): bool = { val held = s.session  match held { | Session(t) => t.waiters >= 0 and (t.waiters >= 1 implies t.refreshing) | NoSession => true } }
pure def sometimesReadersShareOneRefresh(s: DeviceCredential): bool = { val held = s.session  match held { | Session(t) => t.waiters >= 1 | NoSession => false } }
```
