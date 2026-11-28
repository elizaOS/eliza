# Device credential

Custody of the device key the cloud issues (`spec/cloud/nativeClients/deviceKeys.md`:
connect, token, ack, renew, self-revoke; keys of the registration's lifetime,
renewed only through the lease), of the device lease that signs this device
in to mail and calendar (a `DeviceLease` session family of
`spec/cloud/identity/sessions.md`, bound to the active key) and of the one
in-memory account session. The sign-in flow (`./flow.md`) runs the exchange.
The shell gives the active device key to the resident agent. It keeps lease
secrets, codes, PKCE verifiers and session tokens native, outside the page
and the agent. The page receives the public credential identifier. The
model sees versions, accounts, times and outcomes. The shell keeps keys and lease refresh secrets
in secure store slots (`../android/secureStore.md`) prefixed with the
deployment's authority digest, and this machine's state, except the session
and the lease's access token, durably beside them. Times are epoch
milliseconds. `Announce`, `SignedOutNotice` and `ExpiredNotice` go to the
agent service; the shell acts on `VerifyAccount` and `RenewKey`.

## Story: Keep me signed in without a second copy of my key

> As a person who signed in on this device, I want one key kept for me and
> handed to my agent once, and a lost reply or an older sign-in never to
> undo a newer one, so that my agent keeps working without asking me again.

### A sign-in reserves the next generation, and only the newest sign-in's answers are taken

Each answer names the generation of the sign-in it belongs to. An answer of
an older generation is discarded. A new sign-in, a key renewal, a sign-out
or a reset starts a new generation; nothing else changes it.

```quint
import types.* from "../../cloud/shared/types"
import sessions as Iss from "../../cloud/identity/sessions"
import secureStore as S from "../android/secureStore"
type Account = { userId: str, organizationId: str }
type Custody = SignedOut | Active({ version: int, credentialId: str, account: Account, keyExpiresAt: Millis }) | Expired({ account: Account })
type LeaseOffer = NoOffer | Offered({ refreshExpiresAt: Millis }) | Renewal
type Attempt = NoAttempt | Exchanging({ attempt: int }) | Renewing({ attempt: int })
  | Acknowledging({ attempt: int, version: int, credentialId: str, account: Account, lapsesAt: Millis, lease: LeaseOffer })
type Duty = { version: int, lapsesAt: Millis, tries: int, lease: bool, successor: str }
type Refresh = NotRefreshing | Refreshing({ waiters: int })
type AccountSession = NoSession | Session({ version: int, until: Millis, accessExpiresAt: Millis, refresh: Refresh })
type DeviceLease = NoLease | Lease({ version: int, refreshExpiresAt: Millis, accessExpiresAt: Millis, refresh: Refresh, renewAt: Millis })
type DeviceCredential = { now: Millis, generation: int, lastVersion: int, custody: Custody, attempt: Attempt, duties: List[Duty], session: AccountSession, lease: DeviceLease }
type CredentialNotice = Announce({ version: int, account: Account }) | SignedOutNotice | ExpiredNotice | VerifyAccount | RefreshAccountSession | RefreshLease | RenewKey
type CredentialStep = { state: DeviceCredential, out: List[CredentialNotice] }
pure val initial: DeviceCredential = { now: 0, generation: 0, lastVersion: 0, custody: SignedOut, attempt: NoAttempt, duties: List(), session: NoSession, lease: NoLease }
pure val noAccount: Account = { userId: "", organizationId: "" }
pure def attemptOf(s: DeviceCredential): int = { val p = s.attempt  match p { | Exchanging(e) => e.attempt | Renewing(r) => r.attempt | Acknowledging(k) => k.attempt | NoAttempt => 0 } }
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
  after.generation == before.generation + (if (via == "beginSignIn" or via == "beginRenewal" or via == "signOut" or via == "reset") 1 else 0)
```

### A minted key is kept only after the secure store reads it back, and a lost token reply is asked again with the same code

The token answer carries the credential id, the account (`user.id`,
`organizationId`), the key's expiry and, from a cloud that issues one, the
lease (`lease: { refresh, refreshExpiresIn }`), offered with the key. The
shell writes the key, and the lease's refresh secret, to slots of the new
version, never over the active key, and reads them back before it reports
the answer; only a `Written` outcome gives the key a new version and moves
on to the acknowledgement. Any other outcome, or no
answer, leaves the exchange where it was: the shell asks `token` again with
the same one-time code and PKCE verifier, and the cloud answers the same
credential from its sealed copy until it is acknowledged. There is no
device request-id replay. An acknowledgement may come up to the code's
five-minute deadline later, so a key awaiting it may live that much past
the expiry the token answer gave. It retains the nonempty credential id
from that token answer until the attempt ends.

```quint
pure val ackWindow: Millis = 5 * millisPerMinute
pure def offerFits(s: DeviceCredential, lease: LeaseOffer): bool = match lease { | Offered(o) => o.refreshExpiresAt > s.now | NoOffer => true | Renewal => false }
pure def canTokenAnswered(s: DeviceCredential, attempt: int, credentialId: str, account: Account, keyExpiresAt: Millis, lease: LeaseOffer): bool =
  (s.attempt == Exchanging({ attempt: attempt }) or (s.attempt == Renewing({ attempt: attempt }) and lease == NoOffer and account == accountOf(s)))
    and offerFits(s, lease) and credentialId != "" and account.userId != "" and account.organizationId != "" and keyExpiresAt > s.now
pure def tokenAnswered(s: DeviceCredential, attempt: int, credentialId: str, account: Account, keyExpiresAt: Millis, lease: LeaseOffer, stored: S::ExchangeOutcome): DeviceCredential =
  if (stored == S::Written) { ...s, lastVersion: s.lastVersion + 1,
    attempt: Acknowledging({ attempt: attempt, version: s.lastVersion + 1, credentialId: credentialId, account: account, lapsesAt: keyExpiresAt + ackWindow,
      lease: if (s.attempt == Renewing({ attempt: attempt })) Renewal else lease }) }
  else s
pure val leaseValues = Set(NoOffer, Offered({ refreshExpiresAt: 7776000000 }))
pure val credentialIdValues = Set("c1", "c2")
pure val accountValues = Set({ userId: "u1", organizationId: "o1" }, { userId: "u2", organizationId: "o2" }, { userId: "", organizationId: "o1" })
pure val keyExpiresAtValues = Set(120000, 2592000000)
pure val storedValues = Set(S::Written, S::Unconfirmed, S::Failed)
pure val weight_tokenAnswered = 6
pure def mintedActive(c: Custody, lastVersion: int): bool = match c { | Active(a) => a.version >= 1 and a.version <= lastVersion | _ => true }
pure def mintedPending(p: Attempt, lastVersion: int, active: int): bool = match p { | Acknowledging(k) => k.version >= 1 and k.version == lastVersion and active < k.version and k.credentialId != "" | _ => true }
pure def alwaysKeysAreMintedInOrder(s: DeviceCredential): bool = mintedActive(s.custody, s.lastVersion) and mintedPending(s.attempt, s.lastVersion, activeVersion(s))
pure def sometimesAwaitingAcknowledgement(s: DeviceCredential): bool = pendingVersion(s) >= 1
```

### A key becomes active only when the cloud acknowledges it, and each new key is announced once

The acknowledgement (`{status: "acknowledged", credentialId, expiresAt}`)
of the newest sign-in, for the credential its token answer named, installs
that key as the active one with the expiry the answer gives. The lease
offered with it becomes the device's lease, due to renew the key when half
of that life is gone. A renewal keeps the refresh secret and expiry bound to
the new key, and ends the old key's access token and in-flight readers.
A key it replaces leaves with a revoke duty, together with its lease unless
a renewal kept it, and the account session of the old key is discarded. The
new key is announced once with its account; the agent service pushes it to
a running agent of the same account, or restarts the agent on the new
account's directory.

```quint
pure def canAcknowledged(s: DeviceCredential, attempt: int, credentialId: str, keyExpiresAt: Millis): bool = {
  val p = s.attempt
  match p { | Acknowledging(k) => k.attempt == attempt and k.credentialId == credentialId and keyExpiresAt > s.now | _ => false }
}
pure def leaseVersionOf(l: DeviceLease): int = match l { | Lease(x) => x.version | NoLease => 0 }
pure def offeredLease(offer: LeaseOffer, kept: DeviceLease, version: int, renewAt: Millis): DeviceLease = match offer {
  | Offered(o) => Lease({ version: version, refreshExpiresAt: o.refreshExpiresAt, accessExpiresAt: 0, refresh: NotRefreshing, renewAt: renewAt })
  | Renewal => match kept { | Lease(x) => Lease({ ...x, version: version, accessExpiresAt: 0, refresh: NotRefreshing, renewAt: renewAt }) | NoLease => NoLease }
  | NoOffer => NoLease
}
pure def acknowledged(s: DeviceCredential, attempt: int, credentialId: str, keyExpiresAt: Millis): CredentialStep = {
  val p = s.attempt
  match p {
    | Acknowledging(k) => { state: { ...s, custody: Active({ version: k.version, credentialId: k.credentialId, account: k.account, keyExpiresAt: keyExpiresAt }),
        attempt: NoAttempt, session: NoSession, lease: offeredLease(k.lease, s.lease, k.version, s.now + (keyExpiresAt - s.now) / 2),
        duties: s.duties.concat(keyDuty(s.custody, if (k.lease == Renewal) NoLease else s.lease, signOutAttempts, k.credentialId)) }, out: List(Announce({ version: k.version, account: k.account })) }
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
pure def stepAReplacedKeyNamesItsSuccessor(before: DeviceCredential, via: str, after: DeviceCredential): bool =
  (via == "acknowledged" and activeVersion(before) >= 1 and activeVersion(after) != activeVersion(before)) implies
    after.duties.some(d => d.version == activeVersion(before) and d.successor == credentialIdOf(after) and d.successor != "")
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
not retried. While a renewed key awaits acknowledgement, any of these asks
the shell to ask about that acknowledgement again (`RenewKey`) and nothing
else: an acknowledgement whose reply was lost has already ended the old key
on the cloud, so the old key's `401` is the renewal landing, not a sign-out.
Otherwise `credential_expired` on a key that holds a lease asks the shell
to renew the key through the lease (`RenewKey`), unless a sign-in or
renewal is already under way; on a key without a lease it keeps the account
and the local data and asks for a new sign-in. `credential_revoked` or
`credential_unknown` from `GET /api/v1/user` signs out and clears the stored
credential and its lease, owing no revoke; from any other request it only
asks the shell to read `GET /api/v1/user`. A `401` for a key already
replaced changes nothing.

```quint
pure def canRejected(s: DeviceCredential, version: int, reason: RefusalReason): bool = version >= 1 and activeVersion(s) == version and isCredentialReason(reason)
type RejectedOn = AccountRead | OtherRequest
pure def rejected(s: DeviceCredential, version: int, reason: RefusalReason, on: RejectedOn): CredentialStep =
  if (isRenewal(s.attempt) and pendingVersion(s) >= 1) { state: { ...s, session: NoSession }, out: List(RenewKey) }
  else if (reason == CredentialExpired and leaseVersionOf(s.lease) == version) { state: { ...s, session: NoSession }, out: if (s.attempt == NoAttempt) List(RenewKey) else List() }
  else if (reason == CredentialExpired) { state: { ...s, custody: Expired({ account: accountOf(s) }), session: NoSession, lease: NoLease }, out: List(ExpiredNotice) }
  else if (on == AccountRead) { state: { ...s, custody: SignedOut, session: NoSession, lease: NoLease, attempt: if (isRenewal(s.attempt)) NoAttempt else s.attempt }, out: List(SignedOutNotice) }
  else { state: s, out: List(VerifyAccount) }
pure val versionValues = Set(1, 2)
pure val reasonValues = Set(CredentialExpired, CredentialRevoked, CredentialUnknown, NoReason)
pure def sometimesExpired(s: DeviceCredential): bool = s.custody == Expired({ account: accountOf(s) }) and accountOf(s).userId != ""
pure def sometimesSignedOutByCloud(s: DeviceCredential): bool = s.custody == SignedOut and s.lastVersion >= 1 and s.generation == 1 and s.duties == List()
```

### The lease belongs to the active key, and its access token lives at most a quarter hour, in memory only

The lease is the device's only credential for mail and calendar
(`./cloudRequests.md`); the agent never holds it. Its refresh secret stays
valid for the idle lifetime the cloud gives (`refreshExpiresAt`, ninety days
after its last rotation), with no absolute cap, and its access token for at
most fifteen minutes (`Iss::accessLifetime`). Sign-out, reset, a new key
from another sign-in and a revoked or unknown key end the lease with the key;
a restart forgets only its access token.

```quint
pure def leaseUsable(s: DeviceCredential): bool = { val held = s.lease  match held { | Lease(x) => s.now < x.accessExpiresAt | NoLease => false } }
pure def alwaysLeaseBelongsToTheActiveKey(s: DeviceCredential): bool = { val held = s.lease  match held {
  | Lease(x) => x.version >= 1 and x.version == activeVersion(s) and x.accessExpiresAt <= s.now + Iss::accessLifetime
  | NoLease => true } }
pure def sometimesSignedInWithALease(s: DeviceCredential): bool = isSignedIn(s) and leaseVersionOf(s.lease) == activeVersion(s)
```

### A lease reader starts a refresh only when none is in flight, and a rotated secret is used only once the secure store reads it back

A reader whose access token has expired asks the shell to send
`POST /api/v1/app-auth/mobile/lease` with the refresh secret
(`RefreshLease`), or joins the refresh in flight. The answer rotates both
secrets: the shell writes the new refresh secret over the lease's slot and
reads it back, and only a `Written` outcome takes the new pair. The cloud
keeps the old secret valid until the new one is first presented, so a lost
or unwritten answer leaves the device on the old secret, and a later refresh
is answered with the same new pair; presenting an older secret after the new
one is theft, which ends this device's key and lease. No answer keeps the
lease for the next reader. A refresh answer can only change the key version
that started it. Renewal ends the previous refresh so the next reader can
start again. A refresh that the shell cannot finish counts as unanswered
for its own version.

```quint
type LeaseAnswer = LeaseRotated({ accessExpiresAt: Millis, refreshExpiresAt: Millis, stored: S::ExchangeOutcome }) | LeaseUnanswered
pure def leaseRefreshOf(l: DeviceLease): Refresh = match l { | Lease(x) => x.refresh | NoLease => NotRefreshing }
pure def isLeaseRefreshing(s: DeviceCredential): bool = leaseRefreshOf(s.lease) != NotRefreshing
pure def canReadLease(s: DeviceCredential): bool = s.lease != NoLease and not(leaseUsable(s))
pure def readLease(s: DeviceCredential): CredentialStep = {
  val held = s.lease
  val joined = waitersOf(leaseRefreshOf(s.lease)) + 1
  match held {
    | Lease(x) => { state: { ...s, lease: Lease({ ...x, refresh: Refreshing({ waiters: joined }) }) }, out: if (joined == 0) List(RefreshLease) else List() }
    | NoLease => { state: s, out: List() }
  } }
pure def canLeaseRefreshAnswered(s: DeviceCredential, version: int): bool =
  isLeaseRefreshing(s) and leaseVersionOf(s.lease) == version
pure def leaseRefreshAnswered(s: DeviceCredential, version: int, rotation: LeaseAnswer): DeviceCredential = {
  val held = s.lease
  if (not(canLeaseRefreshAnswered(s, version))) s else match held {
    | Lease(x) => match rotation {
        | LeaseRotated(r) => if (r.stored == S::Written and r.accessExpiresAt > s.now and r.refreshExpiresAt > s.now)
            { ...s, lease: Lease({ ...x, refreshExpiresAt: r.refreshExpiresAt, refresh: NotRefreshing,
                accessExpiresAt: if (r.accessExpiresAt < s.now + Iss::accessLifetime) r.accessExpiresAt else s.now + Iss::accessLifetime }) }
          else { ...s, lease: Lease({ ...x, refresh: NotRefreshing }) }
        | LeaseUnanswered => { ...s, lease: Lease({ ...x, refresh: NotRefreshing }) }
      }
    | NoLease => s
  } }
pure def lawAnOldLeaseRefreshLeavesTheCurrentLeaseAlone(s: DeviceCredential, version: int, rotation: LeaseAnswer): bool =
  (leaseVersionOf(s.lease) != version) implies leaseRefreshAnswered(s, version, rotation) == s
pure val rotationValues = Set(LeaseRotated({ accessExpiresAt: 9000000000, refreshExpiresAt: 7776000000, stored: S::Written }),
  LeaseRotated({ accessExpiresAt: 9000000000, refreshExpiresAt: 7776000000, stored: S::Unconfirmed }), LeaseUnanswered)
pure val weight_readLease = 3
pure def stepOneLeaseRefreshInFlight(before: DeviceCredential, via: str, after: DeviceCredential, out: List[CredentialNotice]): bool =
  out.includes(RefreshLease) implies (not(isLeaseRefreshing(before)) and isLeaseRefreshing(after))
pure def alwaysLeaseWaitersAreCounted(s: DeviceCredential): bool = isLeaseRefreshing(s) implies waitersOf(leaseRefreshOf(s.lease)) >= 0
pure def sometimesLeaseRotated(s: DeviceCredential): bool = leaseUsable(s)
pure def sometimesLeaseReadersShareOneRefresh(s: DeviceCredential): bool = waitersOf(leaseRefreshOf(s.lease)) >= 1
```

### A revoked or unknown lease signs the device out completely, and an expired one keeps the account

A `401` with a credential reason for the lease's refresh secret, from a
refresh, a renewal or a revoke, ends the lease. `credential_revoked` or
`credential_unknown` signs the device out: the key, and a renewal under way,
leave with a revoke duty, so the device is never left able to reach the
cloud without mail. `credential_expired` (ninety days without a refresh)
keeps the account and the local data and asks for a new sign-in, owing the
key. A sign-in under way is kept: it is how the person comes back. A `401`
for the lease's access token only discards that token, so the next reader
refreshes and the refresh decides.

```quint
type LeaseUse = RefreshUse | AccessUse
pure def isRenewal(p: Attempt): bool = match p { | Renewing(r) => true | Acknowledging(k) => k.lease == Renewal | _ => false }
pure def canLeaseRejected(s: DeviceCredential, version: int, reason: RefusalReason): bool =
  version >= 1 and leaseVersionOf(s.lease) == version and isCredentialReason(reason)
pure def leaseRejected(s: DeviceCredential, version: int, reason: RefusalReason, presented: LeaseUse): CredentialStep = {
  val held = s.lease
  val left = { ...s, attempt: if (isRenewal(s.attempt)) NoAttempt else s.attempt, session: NoSession, lease: NoLease,
    duties: s.duties.concat(keyDuty(s.custody, NoLease, signOutAttempts, "")).concat(if (isRenewal(s.attempt)) pendingDuty(s.attempt, signOutAttempts) else List()) }
  match held {
    | Lease(x) => if (presented == AccessUse) { state: { ...s, lease: Lease({ ...x, accessExpiresAt: 0 }) }, out: List() }
        else if (reason == CredentialExpired) { state: { ...left, custody: Expired({ account: accountOf(s) }) }, out: List(ExpiredNotice) }
        else { state: { ...left, custody: SignedOut }, out: List(SignedOutNotice) }
    | NoLease => { state: s, out: List() }
  } }
pure def sometimesSignedOutByTheLease(s: DeviceCredential): bool = s.custody == SignedOut and s.lease == NoLease and s.generation == 1 and s.duties.length() >= 1
```

### Only the lease renews the key, and a renewed key keeps the account and the lease

The key itself can never renew itself, so a copied key lapses with its
lifetime. While the device holds a lease and no sign-in or renewal is under
way, the shell asks `POST /api/v1/app-auth/mobile/renew` with the lease's
refresh secret: after any lease refresh or at a daily job once half the
key's life is gone (`renewDue`), and at once when the cloud says the key
expired (`RenewKey`). The answer is a new key of the same account, kept and
acknowledged as a sign-in's is; the acknowledgement moves the lease to it
and the replaced key leaves with a revoke duty. A renewed key whose
acknowledgement went unanswered is asked about again at the next start, lease
refresh or `RenewKey`, before any new renewal, so a lost reply never strands
the device. A renewal the cloud refuses ends as a refused sign-in does.
Starting a renewal changes nothing else: the active key, the duties and the
account session stay as they were until the successor is acknowledged.

```quint
pure def renewAtOf(l: DeviceLease): Millis = match l { | Lease(x) => x.renewAt | NoLease => 0 }
pure def canBeginRenewal(s: DeviceCredential): bool = isSignedIn(s) and s.attempt == NoAttempt and leaseVersionOf(s.lease) == activeVersion(s)
pure def beginRenewal(s: DeviceCredential): DeviceCredential = { ...s, generation: s.generation + 1, attempt: Renewing({ attempt: s.generation + 1 }) }
pure def renewDue(s: DeviceCredential): bool = canBeginRenewal(s) and s.now >= renewAtOf(s.lease)
pure def isRenewing(p: Attempt): bool = match p { | Renewing(r) => true | _ => false }
pure def stepARenewalStartsOnlyFromTheLease(before: DeviceCredential, via: str, after: DeviceCredential): bool =
  (isRenewing(after.attempt) and not(isRenewing(before.attempt))) implies (via == "beginRenewal" and canBeginRenewal(before))
pure def stepARenewalKeepsTheActiveKey(before: DeviceCredential, via: str, after: DeviceCredential): bool =
  via == "beginRenewal" implies (after.custody == before.custody and after.duties == before.duties and after.session == before.session)
pure def alwaysARenewalKeepsTheAccount(s: DeviceCredential): bool = isRenewal(s.attempt) implies (isSignedIn(s) and leaseVersionOf(s.lease) == activeVersion(s))
pure def sometimesRenewing(s: DeviceCredential): bool = offerOf(s.attempt) == Renewal
pure def sometimesKeyRenewedByTheLease(s: DeviceCredential): bool =
  activeVersion(s) >= 2 and leaseVersionOf(s.lease) == activeVersion(s) and s.duties.some(d => d.version == activeVersion(s) - 1 and not(d.lease))
```

## Story: Sign out or reset cleanly

> As a person, I want signing out or resetting the device to end my key at
> the cloud even when I am offline, and never to end a key I still use.

### Every key that leaves the device while the cloud may still accept it is owed a revoke, stored in the same step

A duty names the key's version, whether its lease left with it, and when
the later of the two lapses. If an acknowledged key replaced it, the duty
also names the acknowledged key's credential id. The shell retains a
successor already stored before the mail-lease upgrade. It saves the duty
before removing the key and lease from their slots, under one lock. It
sends `DELETE /api/v1/app-auth/mobile/lease` with the owed lease's refresh
secret and `DELETE /api/v1/api-keys/current` with the owed key. The key request
carries `X-Renewed-Credential-Id` when the duty names a successor. The cloud
uses it for a pre-lease renewal chain only. Sign-out, reset and cancellation
duties name no successor. Sign-out and reset end the active key and its lease.
They also end a key awaiting acknowledgement and the lease offered with it,
so the device can owe several duties. A key the cloud said is expired, revoked or unknown is owed
nothing, a key still held is never owed, and a lease a renewal kept never
leaves with the key it replaced.

```quint
pure val signOutAttempts = 3
pure val resetAttempts = 1
pure def later(a: Millis, b: Millis): Millis = if (a > b) a else b
pure def leaseLapse(l: DeviceLease, version: int): Millis = match l { | Lease(x) => if (x.version == version) x.refreshExpiresAt else 0 | NoLease => 0 }
pure def offerLapse(offer: LeaseOffer): Millis = match offer { | Offered(o) => o.refreshExpiresAt | _ => 0 }
pure def keyDuty(c: Custody, l: DeviceLease, tries: int, successor: str): List[Duty] = match c {
  | Active(a) => List({ version: a.version, lapsesAt: later(a.keyExpiresAt, leaseLapse(l, a.version)), tries: tries, lease: leaseVersionOf(l) == a.version, successor: successor })
  | _ => List() }
pure def pendingDuty(p: Attempt, tries: int): List[Duty] = match p {
  | Acknowledging(k) => List({ version: k.version, lapsesAt: later(k.lapsesAt, offerLapse(k.lease)), tries: tries, lease: offerLapse(k.lease) > 0, successor: "" })
  | _ => List() }
pure def owes(s: DeviceCredential, version: int): bool = s.duties.some(d => d.version == version)
pure def owesLease(s: DeviceCredential, version: int): bool = s.duties.some(d => d.version == version and d.lease)
pure def endedBy(tries: int, s: DeviceCredential): CredentialStep =
  { state: { ...s, generation: s.generation + 1, custody: SignedOut, attempt: NoAttempt, session: NoSession, lease: NoLease,
      duties: s.duties.concat(keyDuty(s.custody, s.lease, tries, "")).concat(pendingDuty(s.attempt, tries)) },
    out: if (s.custody == SignedOut) List() else List(SignedOutNotice) }
pure def signOut(s: DeviceCredential): CredentialStep = endedBy(signOutAttempts, s)
pure def reset(s: DeviceCredential): CredentialStep = endedBy(resetAttempts, s)
pure def alwaysDutiesNameRetiredKeys(s: DeviceCredential): bool =
  s.duties.every(d => d.version >= 1 and d.version <= s.lastVersion and d.tries >= 0 and d.tries <= signOutAttempts
    and d.version != activeVersion(s) and d.version != pendingVersion(s))
pure def stepAKeyLeavesOnlyWithItsDuty(before: DeviceCredential, via: str, after: DeviceCredential, out: List[CredentialNotice]): bool =
  ((activeVersion(before) >= 1 and activeVersion(after) != activeVersion(before) and via != "rejected") implies owes(after, activeVersion(before)))
    and ((pendingVersion(before) >= 1 and pendingVersion(after) == 0 and via != "acknowledged") implies owes(after, pendingVersion(before)))
pure def offerOf(p: Attempt): LeaseOffer = match p { | Acknowledging(k) => k.lease | _ => NoOffer }
pure def stepALeaseLeavesOnlyWithItsDuty(before: DeviceCredential, via: str, after: DeviceCredential): bool =
  (leaseVersionOf(before.lease) >= 1 and leaseVersionOf(after.lease) != leaseVersionOf(before.lease) and via != "rejected" and via != "leaseRejected"
    and not(via == "acknowledged" and offerOf(before.attempt) == Renewal and leaseVersionOf(after.lease) == pendingVersion(before)))
    implies owesLease(after, leaseVersionOf(before.lease))
pure def sometimesSeveralDutiesOwed(s: DeviceCredential): bool = s.duties.length() >= 2
pure def stepAnEndedKeyNamesNoSuccessor(before: DeviceCredential, via: str, after: DeviceCredential): bool =
  (via == "signOut" or via == "reset" or via == "signInEnded" or via == "beginSignIn" or via == "beginRenewal") implies
    after.duties.select(d => d.successor != "").length() == before.duties.select(d => d.successor != "").length()
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

### A mail lease upgrade can only replace the active key for the same account

The host offers `upgradeMailLease` only when the user chooses to sign in
again for mail and calendar. The device binds the attempt to its current key
version, user and organization. It checks the owner using the host's browser
sign-in or native Google picker and ends the attempt if Google verifies a
different account. The native picker upgrade requests identity alone.
Neither the owner nor the key version comes from the renderer. A new key can
replace the old one only after acknowledgement of a newer pending grant for
that same owner with an unexpired lease offer. The host can cancel its current
upgrade with `cancelMailLeaseUpgrade`. A cancelled or stale attempt
cannot replace the key. A rejected pending grant is retired through the
existing revoke duties. The previous key continues to serve its routes.

```quint
type MailLeaseUpgrade = { version: int, account: Account }
pure def mailLeaseUpgradeAdmits(s: DeviceCredential, expected: MailLeaseUpgrade): bool =
  expected.version >= 1 and activeVersion(s) == expected.version and accountOf(s) == expected.account and s.lease == NoLease
pure def freshMailLeaseOffer(offer: LeaseOffer, now: Millis): bool = match offer {
  | Offered(o) => o.refreshExpiresAt > now
  | _ => false
}
pure def mailLeaseUpgradeMayAcknowledge(s: DeviceCredential, expected: MailLeaseUpgrade): bool = {
  val pending = s.attempt
  mailLeaseUpgradeAdmits(s, expected) and (match pending {
    | Acknowledging(p) =>
      p.version > expected.version and p.account == expected.account and p.lapsesAt > s.now and freshMailLeaseOffer(p.lease, s.now)
    | _ => false
  })
}
pure def mailLeaseUpgradeAcknowledged(expected: MailLeaseUpgrade, attempt: int, credentialId: str, keyExpiresAt: Millis, s: DeviceCredential): CredentialStep =
  if (mailLeaseUpgradeMayAcknowledge(s, expected) and canAcknowledged(s, attempt, credentialId, keyExpiresAt))
    acknowledged(s, attempt, credentialId, keyExpiresAt)
  else { state: if (canSignInEnded(s, attempt)) signInEnded(s, attempt) else s, out: List() }
pure def lawMailLeaseUpgradeKeepsTheOwner(s: DeviceCredential, expected: MailLeaseUpgrade, attempt: int, credentialId: str, keyExpiresAt: Millis): bool = {
  val after = mailLeaseUpgradeAcknowledged(expected, attempt, credentialId, keyExpiresAt, s)
  accountOf(after.state) == accountOf(s) and (after.out != List() implies leaseVersionOf(after.state.lease) >= 1)
}
pure val expectedValues = Set({ version: 1, account: { userId: "u1", organizationId: "o1" } },
  { version: 2, account: { userId: "u1", organizationId: "o2" } })
```

### A restart keeps the custody, a key awaiting acknowledgement and every duty, and forgets only work in flight

An exchange or renewal without a stored key, the account session and the
lease's access token are lost with the process; the cloud never makes an
unacknowledged key usable. A stored key awaiting acknowledgement is asked
about again, and the lease is kept for its refresh secret.
The device keeps a marker with an explicit mail upgrade. The upgrade does
not resume on restart. An outstanding browser callback cannot be adopted,
and any stored pending grant from that upgrade is retired before reuse.

```quint
pure def restLease(l: DeviceLease): DeviceLease = match l { | Lease(x) => Lease({ ...x, accessExpiresAt: 0, refresh: NotRefreshing }) | NoLease => NoLease }
pure def restart(s: DeviceCredential): DeviceCredential =
  { ...s, attempt: if (pendingVersion(s) >= 1) s.attempt else NoAttempt, session: NoSession, lease: restLease(s.lease), duties: s.duties.listMap(d => { ...d, tries: startAttempts }) }
pure def restartMailLeaseUpgrade(markedAttempt: int, s: DeviceCredential): DeviceCredential = {
  val restored = restart(s)
  if (canSignInEnded(restored, markedAttempt)) signInEnded(restored, markedAttempt) else restored
}
pure def lawRestartRetiresAMarkedPendingMailUpgrade(s: DeviceCredential, markedAttempt: int): bool = {
  val restored = restartMailLeaseUpgrade(markedAttempt, s)
  (markedAttempt == attemptOf(s) and pendingVersion(s) >= 1) implies
    (restored.attempt == NoAttempt and restored.custody == s.custody and
      restored.duties.some(d => d.version == pendingVersion(s)))
}
pure val markedAttemptValues = attemptValues
pure def stepRestartKeepsCustody(before: DeviceCredential, via: str, after: DeviceCredential): bool =
  via == "restart" implies (after.custody == before.custody and after.generation == before.generation and pendingVersion(after) == pendingVersion(before)
    and after.duties.length() == before.duties.length() and leaseVersionOf(after.lease) == leaseVersionOf(before.lease))
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
  { ...s, session: Session({ version: activeVersion(s), until: until, accessExpiresAt: if (accessExpiresAt < until) accessExpiresAt else until, refresh: NotRefreshing }) }
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

### A reader starts a refresh only when none is in flight, and later readers wait for it

A reader of an expired access token asks the shell to send
`POST /api/v1/auth/refresh` (`RefreshAccountSession`) or joins the refresh
in flight: the cloud takes a spent refresh token as theft and ends every
session of the person. A refresh never reaches past the session's hour. No
answer keeps the session for the next reader; a refusal discards it.

```quint
type RefreshAnswer = Refreshed({ accessExpiresAt: Millis }) | RefreshUnanswered | RefreshRefused
pure def refreshOf(x: AccountSession): Refresh = match x { | Session(t) => t.refresh | NoSession => NotRefreshing }
pure def waitersOf(r: Refresh): int = match r { | Refreshing(w) => w.waiters | NotRefreshing => -1 }
pure def isRefreshing(s: DeviceCredential): bool = refreshOf(s.session) != NotRefreshing
pure def canReadSession(s: DeviceCredential): bool = s.session != NoSession and not(sessionUsable(s))
pure def readSession(s: DeviceCredential): CredentialStep = {
  val x = s.session
  val joined = waitersOf(refreshOf(s.session)) + 1
  match x {
    | Session(t) => { state: { ...s, session: Session({ ...t, refresh: Refreshing({ waiters: joined }) }) },
        out: if (joined == 0) List(RefreshAccountSession) else List() }
    | NoSession => { state: s, out: List() }
  } }
pure def canRefreshAnswered(s: DeviceCredential): bool = isRefreshing(s)
pure def refreshAnswered(s: DeviceCredential, answer: RefreshAnswer): DeviceCredential = {
  val x = s.session
  match x {
    | Session(t) => match answer {
        | Refreshed(r) => { ...s, session: Session({ ...t, accessExpiresAt: if (r.accessExpiresAt < t.until) r.accessExpiresAt else t.until, refresh: NotRefreshing }) }
        | RefreshUnanswered => { ...s, session: Session({ ...t, refresh: NotRefreshing }) }
        | RefreshRefused => { ...s, session: NoSession }
      }
    | NoSession => s
  } }
pure val answerValues = Set(Refreshed({ accessExpiresAt: 2000000 }), RefreshUnanswered, RefreshRefused)
pure val weight_readSession = 3
pure def stepOneRefreshInFlight(before: DeviceCredential, via: str, after: DeviceCredential, out: List[CredentialNotice]): bool =
  out.includes(RefreshAccountSession) implies (not(isRefreshing(before)) and isRefreshing(after))
pure def alwaysRefreshWaitersAreCounted(s: DeviceCredential): bool = isRefreshing(s) implies waitersOf(refreshOf(s.session)) >= 0
pure def sometimesReadersShareOneRefresh(s: DeviceCredential): bool = waitersOf(refreshOf(s.session)) >= 1
```
