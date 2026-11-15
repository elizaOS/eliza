# Registered native clients

A native client is an installed application registered with the deployment
by package identifier, environment and exact callback. It signs a person in
through the browser, receives a one-time code, exchanges it for a key and
acknowledges the key before using it, then renews the key without the
browser until an absolute cap. The registry is the deployment's own record
of native clients and depends on no hosted-application record. The device
half of this protocol is [native enrollment](../auth/native/enrollment.md)
and [Android key renewal](../auth/native/android/keyRenewal.md). Ported from
the develop models `MobileAppClientRegistration` (with
`AndroidAssociationPublication`), `MobileClientCompatibility`,
`MobileAppCredential`, `MobileAppGrantCleanup` and `MobileAppKeyRenewal`.

## Story: Admit only a registered native client

> As an operator, I register each native client once, and every sign-in
> entry point admits only that registration, with its exact callback and
> environment, so that no other application can obtain a key in its name.

### Every entry point admits a client only from an enabled, exact registration

Configuration, credential exchange, renewal, the hosted callback and the
published app-association statement all read the same registration from the
primary database. It must be present and enabled, enabled exactly (an unset
flag is not enabled), in a valid environment, with a valid exact callback
and a valid code lifetime. Exchange and renewal also require the grant to
match the client. Only the association statement requires a valid Android
association, so a broken association never revokes existing credentials.
A database outage refuses.

```quint
type Entrypoint = RegistrationEntry | CredentialEntry | RenewalEntry | CallbackEntry | AssociationEntry
type ClientPolicy = { databaseAvailable: bool, clientPresent: bool, clientEnabled: bool, enabledExactly: bool, environmentValid: bool, callbackValid: bool, exactCallbackAllowed: bool, ttlValid: bool, grantMatches: bool, associationValid: bool }
pure def clientAdmitted(policy: ClientPolicy, entry: Entrypoint): bool =
  policy.databaseAvailable and policy.clientPresent and policy.clientEnabled and policy.enabledExactly and policy.environmentValid and policy.callbackValid and policy.exactCallbackAllowed and policy.ttlValid
  and ((entry == CredentialEntry or entry == RenewalEntry) implies policy.grantMatches)
  and (entry == AssociationEntry implies policy.associationValid)
pure val validPolicy: ClientPolicy = { databaseAvailable: true, clientPresent: true, clientEnabled: true, enabledExactly: true, environmentValid: true, callbackValid: true, exactCallbackAllowed: true, ttlValid: true, grantMatches: true, associationValid: true }
pure val policyValues = Set(validPolicy, { ...validPolicy, clientEnabled: false }, { ...validPolicy, grantMatches: false }, { ...validPolicy, associationValid: false }, { ...validPolicy, databaseAvailable: false }, { ...validPolicy, enabledExactly: false })
pure def lawDisabledClientRefusedEverywhere(policy: ClientPolicy, entry: Entrypoint): bool = not(policy.clientEnabled) implies not(clientAdmitted(policy, entry))
pure def lawRenewalNeedsMatchingGrant(policy: ClientPolicy): bool = not(policy.grantMatches) implies not(clientAdmitted(policy, RenewalEntry))
pure def lawBrokenAssociationKeepsCredentials(policy: ClientPolicy): bool = clientAdmitted({ ...policy, associationValid: false }, CredentialEntry) == clientAdmitted({ ...policy, associationValid: true }, CredentialEntry)
```

### The association statement publishes exactly each signer's own relations

A client may be signed by more than one certificate, each with its own
relations (handling links, sharing credentials). The published statement
keeps those pairs; it never grants one signer's relation to another.

```quint
type Relation = HandleLinks | ShareCredentials
type SignerRelations = { signer: str, handlesLinks: bool, sharesCredentials: bool }
type AssociationPair = { signer: str, relation: Relation }
pure def pairsOf(x: SignerRelations): List[AssociationPair] =
  (if (x.handlesLinks) List({ signer: x.signer, relation: HandleLinks }) else List()).concat(if (x.sharesCredentials) List({ signer: x.signer, relation: ShareCredentials }) else List())
pure def associationStatement(signers: List[SignerRelations]): List[AssociationPair] = signers.foldl(List(), (acc, x) => acc.concat(pairsOf(x)))
pure val signersValues = Set(
  List({ signer: "s1", handlesLinks: true, sharesCredentials: false }, { signer: "s2", handlesLinks: false, sharesCredentials: true }),
  List({ signer: "s1", handlesLinks: true, sharesCredentials: false }, { signer: "s2", handlesLinks: true, sharesCredentials: false }),
  List({ signer: "s1", handlesLinks: false, sharesCredentials: false }))
pure def lawStatementKeepsSignerPairs(signers: List[SignerRelations]): bool =
  associationStatement(signers).every(pair => signers.some(x => x.signer == pair.signer and ((pair.relation == HandleLinks and x.handlesLinks) or (pair.relation == ShareCredentials and x.sharesCredentials))))
```

### A renamed client is accepted only through one explicit alias of the same authority

An installed client may still present a former registration name. It is
accepted only when the current registration declares that alias, is
enabled, binds the same signing authority, and the alias does not chain to
another alias.

```quint
type AliasEvidence = { declared: bool, enabled: bool, sameBinding: bool, chained: bool }
pure def aliasAccepted(a: AliasEvidence): bool = a.declared and a.enabled and a.sameBinding and not(a.chained)
pure val aValues = Set({ declared: true, enabled: true, sameBinding: true, chained: false }, { declared: false, enabled: true, sameBinding: true, chained: false }, { declared: true, enabled: true, sameBinding: false, chained: false }, { declared: true, enabled: true, sameBinding: true, chained: true })
pure def lawAliasNeverChains(a: AliasEvidence): bool = a.chained implies not(aliasAccepted(a))
```

## Story: Sign a native client in and keep its key renewed

> As a person using a native client, I approve the sign-in once in the
> browser; the client gets one key, which it acknowledges before use, and
> renews it in the background until the sign-in's absolute limit, while
> signing out or a revocation from my account ends every key of that
> sign-in.

### A code is exchanged only by its exact client before it expires, and mints one key

The browser approval issues a one-time code and stamps the sign-in time.
Exchange requires the exact client, redirect, environment, code, state and
PKCE verifier (one piece of evidence here) and a code that has not expired.
The first exchange mints the key and stores it encrypted; a repeated
exchange before acknowledgement reveals the same key again and never mints
a second one.

```quint
type GrantStatus = GrantPending | GrantExchanged | GrantAcknowledged | GrantVoid | GrantDeleted
type KeyStatus = KeyMinted | KeyActive | KeyRevoked | KeyDeleted
type Grant = { id: int, status: GrantStatus, from: int, issuedAt: int, start: int, cipher: bool, reveals: int, redeemedAt: int }
type Key = { id: int, status: KeyStatus, expires: int, start: int, activated: bool }
type SignIn = { clock: int, ownerOk: bool, clientOk: bool, ended: bool, approved: bool, grants: List[Grant], keys: List[Key] }
pure val codeTtl = 1
pure val keyTtl = 3
pure val cap = 4
pure val lastStepWindow = 1
pure val initial: SignIn = { clock: 0, ownerOk: true, clientOk: true, ended: false, approved: false, grants: List(), keys: List() }
pure val noGrant: Grant = { id: 0, status: GrantVoid, from: 0, issuedAt: 0, start: 0, cipher: false, reveals: 0, redeemedAt: 0 }
pure val noKey: Key = { id: 0, status: KeyDeleted, expires: 0, start: 0, activated: false }
pure def grantOf(s: SignIn, g: int): Grant = s.grants.select(x => x.id == g).nthOr(0, noGrant)
pure def keyOf(s: SignIn, k: int): Key = s.keys.select(x => x.id == k).nthOr(0, noKey)
pure def hasKey(s: SignIn, k: int): bool = s.keys.some(x => x.id == k)
pure def putGrant(s: SignIn, g: Grant): List[Grant] = s.grants.listMap(x => if (x.id == g.id) g else x)
pure def putKey(s: SignIn, k: Key): List[Key] = s.keys.listMap(x => if (x.id == k.id) k else x)
pure def usable(s: SignIn, k: int): bool = keyOf(s, k).status == KeyActive and s.clock < keyOf(s, k).expires
pure def signInStart(s: SignIn): int = grantOf(s, 1).start
pure val gValues = Set(1, 2, 3)
pure val kValues = Set(1, 2, 3)
pure def canTick(s: SignIn): bool = true
pure def tick(s: SignIn): SignIn = { ...s, clock: s.clock + 1 }
pure def canApproveInBrowser(s: SignIn): bool = not(s.approved) and s.ownerOk and s.clientOk
pure def approveInBrowser(s: SignIn): SignIn = { ...s, approved: true, grants: List({ id: 1, status: GrantPending, from: 0, issuedAt: s.clock, start: s.clock, cipher: false, reveals: 0, redeemedAt: 0 }) }
pure def canExchange(s: SignIn, g: int): bool = {
  val grant = grantOf(s, g)
  grant.id == g and (grant.status == GrantPending or grant.status == GrantExchanged) and s.clock < grant.issuedAt + codeTtl and s.clientOk
}
pure def exchange(s: SignIn, g: int): SignIn = {
  val grant = grantOf(s, g)
  if (grant.status == GrantPending)
    { ...s, grants: putGrant(s, { ...grant, status: GrantExchanged, cipher: true, reveals: 1 }), keys: s.keys.append({ id: g, status: KeyMinted, expires: grant.issuedAt + codeTtl, start: grant.start, activated: false }) }
  else { ...s, grants: putGrant(s, { ...grant, reveals: grant.reveals + 1 }) }
}
pure def alwaysOneKeyPerGrant(s: SignIn): bool = s.keys.every(k => s.keys.select(o => o.id == k.id).length() == 1 and s.grants.some(g => g.id == k.id))
pure def alwaysRevealedGrantHasItsKey(s: SignIn): bool = s.grants.every(g => g.reveals > 0 implies (g.status != GrantPending and hasKey(s, g.id)))
pure def sometimesExchangeReplayedSameKey(s: SignIn): bool = s.grants.some(g => g.reveals >= 2) and s.keys.length() == 1
```

### A key becomes usable only when its client acknowledges it, which erases the stored copy

Acknowledgement requires the exact proof, an unexpired code, the client
enabled and the owner still in the organization; a renewal's code also
requires the key it renews to be usable still. It activates the key until
the earlier of its lifetime and the sign-in's cap, and erases the encrypted
copy, so the key is never revealed again.

```quint
pure def canAcknowledge(s: SignIn, g: int): bool = {
  val grant = grantOf(s, g)
  grant.id == g and grant.status == GrantExchanged and s.clock < grant.issuedAt + codeTtl and s.clientOk and s.ownerOk and not(s.ended) and (grant.from == 0 or usable(s, grant.from))
}
pure def acknowledge(s: SignIn, g: int): SignIn = {
  val grant = grantOf(s, g)
  val lifetime = if (s.clock + keyTtl < grant.start + cap) s.clock + keyTtl else grant.start + cap
  { ...s, grants: putGrant(s, { ...grant, status: GrantAcknowledged, cipher: false, redeemedAt: s.clock }), keys: putKey(s, { ...keyOf(s, g), status: KeyActive, expires: lifetime, activated: true }) }
}
pure def alwaysActiveKeyHasReceipt(s: SignIn): bool = s.keys.every(k => k.status == KeyActive implies grantOf(s, k.id).status == GrantAcknowledged)
pure def alwaysReceiptErasesStoredCopy(s: SignIn): bool = s.grants.every(g => (g.status == GrantAcknowledged or g.status == GrantDeleted) implies not(g.cipher))
pure def alwaysNoKeyOutlivesCap(s: SignIn): bool = s.keys.every(k => k.activated implies k.expires <= k.start + cap)
```

### A renewal issues one successor code from a usable key, counted from the original sign-in

An active key asks for a successor code without the browser while the
client and owner are still admitted, before the cap, and only when its own
lifetime ends before the cap. The successor keeps the original sign-in
time, so no code is issued and no key lives past the cap. A newer request
voids a code still in flight for the same key. A key that was already
renewed and asks again has been copied: the whole sign-in ends.

```quint
pure def renewed(s: SignIn, k: int): bool = s.grants.some(g => g.from == k and g.status == GrantAcknowledged)
pure def canRequestRenewal(s: SignIn, k: int): bool =
  usable(s, k) and s.clientOk and s.ownerOk and s.clock <= keyOf(s, k).start + cap and keyOf(s, k).expires < keyOf(s, k).start + cap
pure def revokeAll(s: SignIn): List[Key] = s.keys.listMap(k => if (k.status == KeyActive or k.status == KeyMinted) { ...k, status: KeyRevoked } else k)
pure def requestRenewal(s: SignIn, k: int): SignIn =
  if (renewed(s, k)) { ...s, keys: revokeAll(s), ended: true }
  else {
    val voided = s.grants.listMap(g => if (g.from == k and (g.status == GrantPending or g.status == GrantExchanged)) { ...g, status: GrantVoid, cipher: false } else g)
    { ...s, grants: voided.append({ id: s.grants.length() + 1, status: GrantPending, from: k, issuedAt: s.clock, start: keyOf(s, k).start, cipher: false, reveals: 0, redeemedAt: 0 }) }
  }
pure def alwaysSignInTimeNeverMoves(s: SignIn): bool = s.grants.every(g => g.start == signInStart(s)) and s.keys.every(k => k.start == signInStart(s))
pure def alwaysNoCodeAfterCap(s: SignIn): bool = s.grants.every(g => g.issuedAt <= g.start + cap)
pure def alwaysOneLiveSuccessor(s: SignIn): bool = s.keys.every(k => s.grants.select(g => g.from == k.id and (g.status == GrantPending or g.status == GrantExchanged or g.status == GrantAcknowledged)).length() <= 1)
pure def sometimesRenewedKeyInUse(s: SignIn): bool = s.keys.some(k => k.id > 1 and k.status == KeyActive) and keyOf(s, 1).status == KeyRevoked and not(s.ended)
pure def sometimesCopiedKeyEndsSignIn(s: SignIn): bool = s.ended and renewed(s, 1)
```

### Revoking a key ends the sign-in unless it is the last step of a renewal

A key revokes itself after its successor is acknowledged: by naming that
successor, or naming none within a short window after the
acknowledgement, it ends only itself. Any other self-revocation is a sign
out and ends every key of the sign-in, a successor someone else obtained
included. Only an active key can revoke itself. The owner revoking the
device ends every key too; the owner leaving or the client being disabled
stops any further acknowledgement and renewal.

```quint
pure def lastStep(s: SignIn, k: int, names: int): bool = s.grants.some(g => g.from == k and g.status == GrantAcknowledged and (names == g.id or (names == 0 and s.clock < g.redeemedAt + lastStepWindow)))
pure def canSelfRevoke(s: SignIn, k: int, names: int): bool = keyOf(s, k).status == KeyActive
pure def selfRevoke(s: SignIn, k: int, names: int): SignIn =
  if (lastStep(s, k, names)) { ...s, keys: putKey(s, { ...keyOf(s, k), status: KeyRevoked }) } else { ...s, keys: revokeAll(s), ended: true }
pure val namesValues = Set(0, 1, 2, 3)
pure def canOwnerRevoke(s: SignIn): bool = s.keys.some(k => k.status == KeyActive)
pure def ownerRevoke(s: SignIn): SignIn = { ...s, keys: revokeAll(s), ended: true }
pure def canOwnerLeaves(s: SignIn): bool = s.ownerOk
pure def ownerLeaves(s: SignIn): SignIn = { ...s, ownerOk: false }
pure def canClientStops(s: SignIn): bool = s.clientOk
pure def clientStops(s: SignIn): SignIn = { ...s, clientOk: false }
pure def alwaysEndedSignInHasNoKey(s: SignIn): bool = s.ended implies s.keys.every(k => k.status != KeyActive)
pure def sometimesSignedOut(s: SignIn): bool = s.ended and s.keys.length() >= 2
```

### Cleanup removes an expired grant without ending a key that is still alive

An unacknowledged grant whose code expired is deleted with any key it
minted. An acknowledged grant is removed only once its key has expired too,
so cleanup never ends a live key early.

```quint
pure def grantExpired(s: SignIn, g: Grant): bool =
  if (g.status == GrantAcknowledged) s.clock >= keyOf(s, g.id).expires else s.clock >= g.issuedAt + codeTtl
pure def canReap(s: SignIn, g: int): bool = grantOf(s, g).id == g and grantOf(s, g).status != GrantDeleted and grantExpired(s, grantOf(s, g))
pure def reap(s: SignIn, g: int): SignIn =
  { ...s, grants: putGrant(s, { ...grantOf(s, g), status: GrantDeleted, cipher: false }), keys: if (hasKey(s, g)) putKey(s, { ...keyOf(s, g), status: KeyDeleted }) else s.keys }
pure def alwaysCleanupKeepsLiveKeys(s: SignIn): bool = s.keys.every(k => (k.status == KeyDeleted and k.activated) implies s.clock >= k.expires)
pure def sometimesUnacknowledgedGrantReaped(s: SignIn): bool = s.grants.some(g => g.status == GrantDeleted and g.redeemedAt == 0) and s.keys.some(k => k.status == KeyDeleted and not(k.activated))
```
