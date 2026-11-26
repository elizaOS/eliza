# Browser sign-in return

A browser Google sign-in leaves the app for the system browser and comes
back through an App Link. The native sign-in keeps one durable pending
record for it in the secure store slot (`../android/secureStore.md`): the
registered client whose callback it is, a random state (the model's
`nonce`), the PKCE verifier (shell only), the credential generation the
attempt reserved, and an expiry ten minutes after it was written. The
credential machine (`./credential.md`) owns the generation: a sign-in, a
sign-out and a reset each start a new one. The sign-in flow
(`./flow.md`) runs the exchange a return is handed to. Codes, states and
verifiers stay in the Java shell; the model sees clients, nonces,
generations and times. A sign-in callback and a failure-return link are
taken natively before the link pipeline (`../android/deepLinks.md`)
captures anything, so neither reaches the renderer.

## Story: Complete a browser sign-in only for the client that started it

> As a person signing in with Google in the browser, I want the result to
> reach the sign-in I started, once, even when Android restarted the app
> meanwhile, and never after I signed out or started something else.

### Only a registered client with a valid origin, PKCE proof and verified App Link starts a browser sign-in

Starting reserves the next credential generation (`C::beginSignIn`) and
writes the pending record for that client in the same step. A start that
fails a check records nothing. A new start replaces the record and the
attempt before it; its write also settles an unconfirmed retirement,
because it overwrites the slot.

```quint
import credential as C from "./credential"
import deepLinks as D from "../android/deepLinks"
type Client = int
type Pending = { client: Client, nonce: int, generation: int, expiresAt: int }
type PendingRecord = NoRecord | Record(Pending)
type ReturnOwner = LiveOwner | AdoptedOwner
type BrowserAttempt = NoBrowserAttempt | Waiting({ client: Client, nonce: int }) | Handed({ client: Client, generation: int, owner: ReturnOwner })
type Retirement = RetirementSettled | RetirementUnconfirmed
type StartChecks = { registered: bool, originValid: bool, proofValid: bool, appLinkVerified: bool }
type BrowserReturns = { credential: C::DeviceCredential, links: D::DeepLinks, record: PendingRecord, attempt: BrowserAttempt, retirement: Retirement }
pure val initial: BrowserReturns = { credential: C::initial, links: D::initial, record: NoRecord, attempt: NoBrowserAttempt, retirement: RetirementSettled }
pure val pendingLifetime: int = 10 * 60 * 1000
pure val noPending: Pending = { client: 0, nonce: 0, generation: 0, expiresAt: 0 }
pure def pendingOf(r: PendingRecord): Pending = match r {
  | Record(p) => { client: p.client, nonce: p.nonce, generation: p.generation, expiresAt: p.expiresAt }
  | NoRecord => noPending }
pure def isWaiting(a: BrowserAttempt): bool = match a { | Waiting(w) => true | _ => false }
pure def isHanded(a: BrowserAttempt): bool = match a { | Handed(h) => true | _ => false }
pure def startAdmitted(checks: StartChecks): bool = checks.registered and checks.originValid and checks.proofValid and checks.appLinkVerified
pure def canStart(s: BrowserReturns, client: Client, nonce: int, checks: StartChecks): bool = client >= 1 and nonce >= 1 and startAdmitted(checks)
pure def start(s: BrowserReturns, client: Client, nonce: int, checks: StartChecks): BrowserReturns = {
  val c = C::beginSignIn(s.credential)
  { ...s, credential: c, attempt: Waiting({ client: client, nonce: nonce }), retirement: RetirementSettled,
    record: Record({ client: client, nonce: nonce, generation: c.generation, expiresAt: s.credential.now + pendingLifetime }) }
}
pure val clientValues = Set(1, 2)
pure val nonceValues = Set(1, 2)
pure val passedChecks: StartChecks = { registered: true, originValid: true, proofValid: true, appLinkVerified: true }
pure val checksValues = Set(passedChecks, { ...passedChecks, registered: false }, { ...passedChecks, appLinkVerified: false })
pure def alwaysRecordNamesAReservedGeneration(s: BrowserReturns): bool =
  s.credential.generation >= 0 and (s.record != NoRecord implies (pendingOf(s.record).generation >= 1 and pendingOf(s.record).generation <= s.credential.generation))
```

### A waiting attempt holds its own live record under the newest generation

While this process waits for the browser, the slot holds this attempt's
record, unexpired, and no credential action has been reserved since it
started.

```quint
pure def alwaysWaitingAttemptHoldsItsLiveRecord(s: BrowserReturns): bool = {
  val a = s.attempt
  val p = pendingOf(s.record)
  match a {
    | Waiting(w) => s.record != NoRecord and p.client == w.client and p.nonce == w.nonce and p.generation == s.credential.generation
        and s.credential.now < p.expiresAt and s.credential.attempt == C::Exchanging({ attempt: s.credential.generation })
    | _ => true
  } }
```

### A return is handed to the exchange once, for its bound client, while its record is live and its generation is the newest

A return is considered only when its client and state match the record;
any other return is ignored and burns nothing. It is admitted for the
attempt waiting for it, or adopted by a process with no sign-in of its own
(below), and only while the record is unexpired and carries the current
generation. An admitted return burns the record by compare-and-delete
under that generation before any network request, so a repeated return
finds nothing; a burned record hands the result, a code or an error, to
the flow's exchange under the record's generation. A return that is not
admitted changes nothing, and the screen is told the sign-in is
incomplete.

```quint
type BurnOutcome = Burned | BurnUnconfirmed
pure def adoptable(s: BrowserReturns): bool = s.attempt == NoBrowserAttempt and s.credential.attempt == C::NoAttempt
pure def returnAdmitted(s: BrowserReturns): bool = {
  val p = pendingOf(s.record)
  s.record != NoRecord and p.generation == s.credential.generation and s.credential.now < p.expiresAt
    and (s.attempt == Waiting({ client: p.client, nonce: p.nonce }) or adoptable(s))
}
pure def endSignIn(generation: int, c: C::DeviceCredential): C::DeviceCredential =
  if (C::canSignInEnded(c, generation)) C::signInEnded(c, generation) else c
pure def canReturned(s: BrowserReturns, client: Client, nonce: int, burn: BurnOutcome): bool =
  s.retirement == RetirementSettled and s.record != NoRecord and pendingOf(s.record).client == client and pendingOf(s.record).nonce == nonce
pure def returned(s: BrowserReturns, client: Client, nonce: int, burn: BurnOutcome): BrowserReturns = {
  val p = pendingOf(s.record)
  if (not(returnAdmitted(s))) s
  else if (burn == Burned) { ...s, record: NoRecord, credential: { ...s.credential, attempt: C::Exchanging({ attempt: p.generation }) },
    attempt: Handed({ client: p.client, generation: p.generation, owner: if (isWaiting(s.attempt)) LiveOwner else AdoptedOwner }) }
  else { ...s, attempt: NoBrowserAttempt, retirement: RetirementUnconfirmed, credential: endSignIn(p.generation, s.credential) }
}
pure val weight_returned = 4
pure def alwaysHandedReturnRunsUnderTheNewestGeneration(s: BrowserReturns): bool = {
  val a = s.attempt
  match a {
    | Handed(h) => s.record == NoRecord and h.generation == s.credential.generation and s.credential.attempt == C::Exchanging({ attempt: h.generation })
    | _ => true
  } }
pure def stepHandOffOnlyForTheBoundLiveRecord(before: BrowserReturns, after: BrowserReturns): bool = {
  val a = after.attempt
  val p = pendingOf(before.record)
  match a {
    | Handed(h) => before.attempt == after.attempt or (before.retirement == RetirementSettled and before.record != NoRecord
        and p.client == h.client and p.generation == h.generation and p.generation == before.credential.generation
        and before.credential.now < p.expiresAt and ((h.owner == LiveOwner) iff isWaiting(before.attempt)))
    | _ => true
  } }
pure def sometimesLiveReturnHanded(s: BrowserReturns): bool = s.attempt == Handed({ client: 1, generation: 1, owner: LiveOwner })
```

### A record expires ten minutes after it was written, and an expired record is never exchanged

The waiting attempt ends when its record expires. The record stays in the
slot until a new start, sign-out or reset replaces it.

```quint
pure def canElapse(s: BrowserReturns, ms: int): bool = C::canElapse(s.credential, ms)
pure def elapse(s: BrowserReturns, ms: int): BrowserReturns = {
  val c = C::elapse(s.credential, ms)
  val p = pendingOf(s.record)
  val ends = isWaiting(s.attempt) and c.now >= p.expiresAt
  { ...s, credential: if (ends) endSignIn(p.generation, c) else c, attempt: if (ends) NoBrowserAttempt else s.attempt }
}
pure val msValues = Set(60000, 1000000)
pure def sometimesExpiredRecordKept(s: BrowserReturns): bool =
  s.attempt == NoBrowserAttempt and s.record != NoRecord and s.credential.now >= pendingOf(s.record).expiresAt
```

### After process death a return is adopted only if no credential action was reserved since its record was written

Android may end the app while the browser is in front. A new process
keeps the record, the generation and the credential's custody, and loses
the attempt it was waiting with. A return there is adopted only while no
sign-in runs and the record's generation is still the newest; adoption
reserves nothing. Another sign-in ends the browser attempt and leaves the
record behind it stale; a sign-out or reset also removes the record. A
credential action after the hand-off wins: the credential discards the
older exchange's answers.

```quint
type CredentialAction = AnotherSignIn | SignOutAction | ResetAction
pure def credentialActed(s: BrowserReturns, kind: CredentialAction): BrowserReturns = {
  val c = if (kind == AnotherSignIn) C::beginSignIn(s.credential)
    else if (kind == SignOutAction) C::signOut(s.credential).state else C::reset(s.credential).state
  { ...s, credential: c, attempt: NoBrowserAttempt, record: if (kind == AnotherSignIn) s.record else NoRecord,
    retirement: if (kind == AnotherSignIn) s.retirement else RetirementSettled }
}
pure def relaunched(withLink: bool, s: BrowserReturns): BrowserReturns =
  { ...s, credential: C::restart(s.credential), links: D::launch(s.links, withLink), attempt: NoBrowserAttempt, retirement: RetirementSettled }
pure def processRestarted(s: BrowserReturns): BrowserReturns = relaunched(false, s)
pure def sometimesAdoptedReturnHanded(s: BrowserReturns): bool = {
  val a = s.attempt
  match a { | Handed(h) => h.owner == AdoptedOwner | _ => false } }
pure def sometimesRecordOutlivedByNewerAction(s: BrowserReturns): bool =
  s.record != NoRecord and pendingOf(s.record).generation < s.credential.generation and s.credential.now < pendingOf(s.record).expiresAt
```

### A burn storage cannot confirm keeps the record and blocks every exchange until a retirement is confirmed

When the secure store cannot confirm the burn, the record stays, the
attempt ends with `storage` and nothing is exchanged. No return is
considered while the retirement is unconfirmed. A compare-and-delete the
store confirms, with no attempt running, lifts it; so do a new start, a
sign-out, a reset and the end of the process, which held it only in
memory. A new process may then adopt the kept record under the rules
above, since its code was never exchanged.

```quint
pure def canRetired(s: BrowserReturns, burn: BurnOutcome): bool = s.retirement == RetirementUnconfirmed and s.attempt == NoBrowserAttempt
pure def retired(s: BrowserReturns, burn: BurnOutcome): BrowserReturns =
  if (burn == Burned) { ...s, record: NoRecord, retirement: RetirementSettled } else s
pure def alwaysUnconfirmedRetirementBlocksExchange(s: BrowserReturns): bool =
  s.retirement == RetirementUnconfirmed implies (s.attempt == NoBrowserAttempt and s.record != NoRecord)
pure def sometimesUnconfirmedBurnKeptRecord(s: BrowserReturns): bool = s.retirement == RetirementUnconfirmed and pendingOf(s.record).generation == s.credential.generation
```

### The callback is one exported activity with its own exact App Link filter

The release check admits the callback only through one filter of the
expected enabled, exported activity with `autoVerify`, VIEW, DEFAULT and
BROWSABLE, whose data is exactly HTTPS, the registered host and the
callback path: no path prefix or pattern, no other authority. Facts of
two filters never combine. Android's live domain verification is the
start's `appLinkVerified`.

```quint
type CallbackFilter = { exported: bool, autoVerify: bool, viewBrowsable: bool, schemes: Set[str], hosts: Set[str], paths: Set[str], extraData: bool }
pure def sameValues(a: Set[str], b: Set[str]): bool = a.subseteq(b) and b.subseteq(a)
pure def callbackFilterAdmits(f: CallbackFilter, host: str, path: str): bool =
  f.exported and f.autoVerify and f.viewBrowsable and not(f.extraData)
    and sameValues(f.schemes, Set("https")) and sameValues(f.hosts, Set(host)) and sameValues(f.paths, Set(path))
pure def manifestHasCallback(filters: List[CallbackFilter], host: str, path: str): bool = filters.some(f => callbackFilterAdmits(f, host, path))
pure val exactFilter: CallbackFilter = { exported: true, autoVerify: true, viewBrowsable: true, schemes: Set("https"),
  hosts: Set("login.example"), paths: Set("/callback"), extraData: false }
pure val fValues = Set(exactFilter, { ...exactFilter, hosts: Set("login.example", "other.example") }, { ...exactFilter, autoVerify: false },
  { ...exactFilter, hosts: Set("other.example") }, { ...exactFilter, paths: Set("/callback", "/other") })
pure val gValues = fValues
pure val hostValues = Set("login.example", "other.example")
pure val pathValues = Set("/callback", "/other")
pure def lawAnExtraHostOrPathNeverAdmits(f: CallbackFilter, host: str, path: str): bool =
  (f.hosts.exists(other => other != host) or f.paths.exists(other => other != path)) implies not(callbackFilterAdmits(f, host, path))
pure def lawFactsOfTwoFiltersNeverCombine(f: CallbackFilter, g: CallbackFilter, host: str, path: str): bool =
  (not(sameValues(f.hosts, Set(host))) and not(g.autoVerify)) implies not(manifestHasCallback(List(f, g), host, path))
```

## Story: Come back to the app after a failed browser sign-in

> As a person whose browser sign-in failed on the cloud's page, I want its
> link to bring the app back as it was, without anything from that page
> reaching the app.

### A failure-return link is consumed before the renderer and resumes the app with an empty main intent, also on a cold start

The failure page returns on the registered callback hosts' exact failure
path. Every link Android matches to that route by its decoded host and
path, including malformed variants with user info, a port or an encoded
path, is consumed: its data, clip data and extras are dropped and its
query is never read, so it carries no credential and starts no exchange.
The app resumes with an empty main intent; on a cold start that intent
launches the process. Any other link goes to the link pipeline as usual.

```quint
pure def failureReturned(s: BrowserReturns, cold: bool): BrowserReturns = if (cold) relaunched(false, s) else s
pure def linkFollowed(s: BrowserReturns, cold: bool): BrowserReturns = if (cold) relaunched(true, s) else { ...s, links: D::capture(s.links) }
pure def stepSignInLinksNeverReachTheRenderer(before: BrowserReturns, via: str, after: BrowserReturns): bool =
  ((via == "returned" or via == "failureReturned" or via == "processRestarted") implies
    (after.links.captured == before.links.captured and after.links.pending == before.links.pending))
  and (via == "failureReturned" implies (after.record == before.record and after.credential.generation == before.credential.generation
    and after.credential.custody == before.credential.custody))
pure def sometimesLinkCapturedBesideWaitingSignIn(s: BrowserReturns): bool = isWaiting(s.attempt) and s.links.pending > 0
```

## Story: Reconnect a signed-in device for mail and calendar

> As a device owner signed in before mail leases existed, I want to sign in
> again for mail and calendar without losing my current device account.

`CloudDeviceAccount` exposes the upgrade state to its consumer host. The host
shows the prompt on its existing account surfaces and starts Google sign-in
when the owner chooses to continue. It may use the native Google account
picker with a registered challenge and nonce, or the registered browser
return. The existing native registration
configuration must advertise the mail lease before a new attempt starts or a
returned proof is exchanged. Without that capability the owner can continue to
open hosted mail and calendar in the browser. The state contains no token.

### Only the current owner can complete the upgrade, and cancellation keeps the current device account

The native shell keeps the existing credential and binds the active attempt
to it. Repeated requests leave the active attempt in place. A browser return
uses the existing App Link, state, and PKCE checks. The native picker result
uses the native Google challenge, nonce, and PKCE checks and belongs to the
same pending attempt. The native shell accepts a replacement
only for the same account and organization and with a mail lease. A
cancellation affects only the active upgrade. A stale return,
a different owner, or a response without a lease leaves the old credential
in place.

```quint
type UpgradeKey = { owner: C::Account, version: int }
type StandaloneUpgrade = StandaloneSignedOut | LegacyDeviceKey(UpgradeKey)
  | UpgradeAuthenticating({ prior: UpgradeKey, attempt: int })
  | UpgradeAcknowledging({ prior: UpgradeKey, replacement: UpgradeKey })
  | UpgradedDeviceKey({ active: UpgradeKey, retired: UpgradeKey })
type UpgradeExchange = NoLeaseReply | LeaseReply(UpgradeKey)
type UpgradePrompt = NoUpgradePrompt | UpgradeRequired | UpgradeSignInPending | UpgradeAcknowledgmentPending
pure val priorValues: Set[UpgradeKey] = Set(
  { owner: { userId: "first", organizationId: "home" }, version: 1 },
  { owner: { userId: "first", organizationId: "home" }, version: 2 },
  { owner: { userId: "first", organizationId: "other" }, version: 2 },
  { owner: { userId: "second", organizationId: "home" }, version: 2 })
pure val replacementValues = priorValues
pure val keyValues = priorValues
pure def legacyDeviceKey(key: UpgradeKey): StandaloneUpgrade =
  LegacyDeviceKey({ owner: key.owner, version: key.version })
pure def upgradePrompt(s: StandaloneUpgrade): UpgradePrompt = match s {
  | LegacyDeviceKey(_) => UpgradeRequired
  | UpgradeAuthenticating(_) => UpgradeSignInPending
  | UpgradeAcknowledging(_) => UpgradeAcknowledgmentPending
  | _ => NoUpgradePrompt
}
pure def beginStandaloneUpgrade(s: StandaloneUpgrade, attempt: int): StandaloneUpgrade = match s {
  | LegacyDeviceKey(k) => UpgradeAuthenticating({ prior: { owner: k.owner, version: k.version }, attempt: attempt })
  | _ => s
}
pure def cancelStandaloneUpgrade(s: StandaloneUpgrade, attempt: int): StandaloneUpgrade = match s {
  | UpgradeAuthenticating(p) => if (p.attempt == attempt) legacyDeviceKey(p.prior) else s
  | _ => s
}
pure def stageStandaloneUpgrade(s: StandaloneUpgrade, attempt: int, response: UpgradeExchange): StandaloneUpgrade = match s {
  | UpgradeAuthenticating(p) => if (p.attempt != attempt) s else match response {
      | NoLeaseReply => legacyDeviceKey(p.prior)
      | LeaseReply(k) => if (k.owner == p.prior.owner and k.version != p.prior.version)
          UpgradeAcknowledging({ prior: p.prior, replacement: { owner: k.owner, version: k.version } }) else legacyDeviceKey(p.prior)
    }
  | _ => s
}
pure def lawCancelingAnUpgradeKeepsTheCurrentKey(prior: UpgradeKey, attempt: int): bool =
  cancelStandaloneUpgrade(beginStandaloneUpgrade(legacyDeviceKey(prior), attempt), attempt) == legacyDeviceKey(prior)
pure def lawAnUpgradeRequiresAReplacementKeyForTheSameOwner(prior: UpgradeKey, replacement: UpgradeKey, attempt: int): bool =
  (upgradePrompt(stageStandaloneUpgrade(UpgradeAuthenticating({ prior: prior, attempt: attempt }), attempt,
    LeaseReply({ owner: replacement.owner, version: replacement.version })))
    == UpgradeAcknowledgmentPending) iff (replacement.owner == prior.owner and replacement.version != prior.version)
```

### The old key retires after the replacement is acknowledged and saved

A lease-bearing key is staged in the native acknowledgment record. A
refusal leaves the old key in place. If the reply is lost or the replacement
write cannot be confirmed, the shell keeps enough information to resume.
After the replacement is saved, the shell records its duty to revoke the
old key before it clears the acknowledgment record. Recovering after that
save only completes the retirement duty.

```quint
type UpgradeAck = UpgradeAckPending | UpgradeAckRefused | UpgradeAckSaved
pure def finishStandaloneUpgrade(s: StandaloneUpgrade, ackResult: UpgradeAck): StandaloneUpgrade = match s {
  | UpgradeAcknowledging(p) => match ackResult {
      | UpgradeAckPending => s
      | UpgradeAckRefused => legacyDeviceKey(p.prior)
      | UpgradeAckSaved => UpgradedDeviceKey({ active: p.replacement, retired: p.prior })
    }
  | _ => s
}
pure def lawStandaloneUpgradeRetiresTheOldKeyOnlyAfterSaving(prior: UpgradeKey, replacement: UpgradeKey, ackResult: UpgradeAck): bool =
  (finishStandaloneUpgrade(UpgradeAcknowledging({ prior: prior, replacement: replacement }), ackResult)
    == UpgradedDeviceKey({ active: replacement, retired: prior })) iff (ackResult == UpgradeAckSaved)
```
