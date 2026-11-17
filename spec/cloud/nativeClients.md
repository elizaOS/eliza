# Registered native clients

A native client is an installed application registered with the deployment
by package identifier, environment and exact callback. It signs a person in
through the browser, or through the device's own account picker when the
hosted auth service verifies that identity, receives a one-time code with
its key, acknowledges the key before using it, then renews the key without
the browser until an absolute cap. The registry is the deployment's own record
of native clients and depends on no hosted-application record. The device
half of this protocol is [native enrollment](../auth/native/enrollment.md)
and [Android key renewal](../auth/native/android/keyRenewal.md).

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
A database outage refuses. An installed client may still present a former
registration name; it is accepted only when the current registration
declares that alias, is enabled and binds the same signing authority, and
the alias does not chain to another alias.

```quint
type Entrypoint = RegistrationEntry | CredentialEntry | RenewalEntry | CallbackEntry | AssociationEntry
type ClientPolicy = { databaseAvailable: bool, clientPresent: bool, clientEnabled: bool, enabledExactly: bool, environmentValid: bool, callbackValid: bool, exactCallbackAllowed: bool, ttlValid: bool, grantMatches: bool, associationValid: bool }
pure def clientAdmitted(policy: ClientPolicy, entry: Entrypoint): bool =
  policy.databaseAvailable and policy.clientPresent and policy.clientEnabled and policy.enabledExactly and policy.environmentValid and policy.callbackValid and policy.exactCallbackAllowed and policy.ttlValid
  and ((entry == CredentialEntry or entry == RenewalEntry) implies policy.grantMatches)
  and (entry == AssociationEntry implies policy.associationValid)
pure val validPolicy: ClientPolicy = { databaseAvailable: true, clientPresent: true, clientEnabled: true, enabledExactly: true, environmentValid: true, callbackValid: true, exactCallbackAllowed: true, ttlValid: true, grantMatches: true, associationValid: true }
pure val policyValues = Set(validPolicy, { ...validPolicy, clientEnabled: false }, { ...validPolicy, grantMatches: false }, { ...validPolicy, associationValid: false }, { ...validPolicy, databaseAvailable: false }, { ...validPolicy, enabledExactly: false })
type AliasEvidence = { declared: bool, enabled: bool, sameBinding: bool, chained: bool }
pure def aliasAccepted(a: AliasEvidence): bool = a.declared and a.enabled and a.sameBinding and not(a.chained)
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

## Story: Sign a native client in and keep its key renewed

> As a person using a native client, I approve the sign-in once, in the
> browser or in my device's account picker; the client gets one key, which
> it acknowledges before use, and
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
type SignIn = { clock: int, ownerOk: bool, clientOk: bool, ended: bool, approved: bool, native: bool, grants: List[Grant], keys: List[Key] }
pure val codeTtl = 1
pure val keyTtl = 3
pure val cap = 4
pure val lastStepWindow = 1
pure val initial: SignIn = { clock: 0, ownerOk: true, clientOk: true, ended: false, approved: false, native: false, grants: List(), keys: List() }
pure val noGrant: Grant = { id: 0, status: GrantVoid, from: 0, issuedAt: 0, start: 0, cipher: false, reveals: 0, redeemedAt: 0 }
pure val noKey: Key = { id: 0, status: KeyDeleted, expires: 0, start: 0, activated: false }
pure def grantOf(s: SignIn, g: int): Grant = s.grants.select(x => x.id == g).nthOr(0, noGrant)
pure def keyOf(s: SignIn, k: int): Key = s.keys.select(x => x.id == k).nthOr(0, noKey)
pure def hasKey(s: SignIn, k: int): bool = s.keys.some(x => x.id == k)
pure def putGrant(s: SignIn, updated: Grant): List[Grant] = s.grants.listMap(x => if (x.id == updated.id) updated else x)
pure def putKey(s: SignIn, updated: Key): List[Key] = s.keys.listMap(x => if (x.id == updated.id) updated else x)
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

### No code or key exists before the person approves the sign-in, in the browser or by a verified native identity

A sign-in is approved in one of two ways. In the browser, approval issues
a one-time code that the client then exchanges. In the device's account
picker, the client sends, in one request, its registration binding, PKCE
verifier and the identity the picker returned for a challenge the hosted
auth service issued; the service verifies that identity and consumes the
challenge once, and only then does the cloud issue the code and exchange
it at once, returning the key, still inactive until acknowledged, with the
code to acknowledge it. A refused identity, a reused challenge or an
unregistered client leaves the sign-in empty. Either way there is one first
code and one key, and nothing before the approval.

```quint
pure def canSignInNatively(s: SignIn, identityVerified: bool, challengeFresh: bool): bool = not(s.approved) and s.ownerOk and s.clientOk and identityVerified and challengeFresh
pure def signInNatively(s: SignIn, identityVerified: bool, challengeFresh: bool): SignIn =
  { ...s, approved: true, native: true,
    grants: List({ id: 1, status: GrantExchanged, from: 0, issuedAt: s.clock, start: s.clock, cipher: true, reveals: 1, redeemedAt: 0 }),
    keys: List({ id: 1, status: KeyMinted, expires: s.clock + codeTtl, start: s.clock, activated: false }) }
pure def sometimesNativeSignInAcknowledged(s: SignIn): bool = s.native and keyOf(s, 1).status == KeyActive
pure def alwaysUnapprovedSignInIsEmpty(s: SignIn): bool = not(s.approved) implies (s.grants.length() == 0 and s.keys.length() == 0)
```

### A native sign-in that carries a server authorization code links the Google grant in the same exchange, and no other sign-in links one

The account picker may also return a one-time server authorization code
for the mail and calendar scopes the client asked for. Sent with the
native sign-in, it is redeemed in the same request, and the answer names
the [Google connection](./managedGoogle/connection.md) it linked beside the
key. The code links the grant only when Google is configured for the
deployment, the code belongs to the same Google account as the verified
identity, the person owns the organization, and Google accepts the code
with the scopes asked for. Otherwise the answer says why nothing was
linked, and the key is issued all the same: a failed link never fails the
sign-in. A sign-in refused for its identity, its challenge or its client
redeems nothing, and a sign-in without the code links no grant, so a
person who declined those scopes keeps a key with no Google access.

```quint
type NativeSignInAnswer = { keyIssued: bool, googleLinked: bool }
pure def nativeSignInAnswer(admitted: bool, identityVerified: bool, challengeFresh: bool, serverAuthCode: bool, codeLinkable: bool): NativeSignInAnswer =
  { keyIssued: admitted and identityVerified and challengeFresh, googleLinked: admitted and identityVerified and challengeFresh and serverAuthCode and codeLinkable }
pure def lawGoogleLinksOnlyWithItsKeyAndALinkableCode(admitted: bool, identityVerified: bool, challengeFresh: bool, serverAuthCode: bool, codeLinkable: bool): bool =
  nativeSignInAnswer(admitted, identityVerified, challengeFresh, serverAuthCode, codeLinkable).googleLinked iff
    (nativeSignInAnswer(admitted, identityVerified, challengeFresh, serverAuthCode, codeLinkable).keyIssued and serverAuthCode and codeLinkable)
pure def lawAFailedLinkNeverFailsTheSignIn(admitted: bool, identityVerified: bool, challengeFresh: bool, serverAuthCode: bool, codeLinkable: bool): bool =
  nativeSignInAnswer(admitted, identityVerified, challengeFresh, serverAuthCode, codeLinkable).keyIssued == nativeSignInAnswer(admitted, identityVerified, challengeFresh, false, false).keyIssued
pure def lawARefusedSignInRedeemsNothing(admitted: bool, identityVerified: bool, challengeFresh: bool, serverAuthCode: bool, codeLinkable: bool): bool =
  not(admitted and identityVerified and challengeFresh) implies nativeSignInAnswer(admitted, identityVerified, challengeFresh, serverAuthCode, codeLinkable) == { keyIssued: false, googleLinked: false }
```

### Each code has its own number, from one up to the number of codes issued

```quint
pure def alwaysEachCodeHasItsOwnNumber(s: SignIn): bool = s.grants.every(g => g.id >= 1 and g.id <= s.grants.length() and s.grants.select(o => o.id == g.id).length() == 1)
```

### A pending code has minted no key, and an exchanged code has been revealed

```quint
pure def alwaysPendingGrantHasNoKey(s: SignIn): bool = s.grants.every(g => (g.status == GrantPending implies not(hasKey(s, g.id))) and (g.status == GrantExchanged implies g.reveals > 0))
```

### A key becomes usable only when its client acknowledges it, which erases the stored copy

Acknowledgement requires the exact proof, an unexpired code, the client
enabled and the owner still in the organization; a renewal's code also
requires the key it renews to be usable still. It activates the key until
the earlier of its lifetime and the sign-in's cap, and erases the encrypted
copy, so the key is never revealed again. A key is activated only by the
acknowledgement of its own code, which stays acknowledged until cleanup
deletes it.

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
pure def alwaysActivatedKeyWasAcknowledged(s: SignIn): bool =
  s.keys.every(k => k.activated implies (grantOf(s, k.id).status == GrantAcknowledged or grantOf(s, k.id).status == GrantDeleted))
```

### A renewal issues one successor code from a usable key, counted from the original sign-in

An active key asks for a successor code without the browser while the
client and owner are still admitted, before the cap, and only when its own
lifetime ends before the cap. The successor keeps the original sign-in
time, so no code is issued and no key lives past the cap. A newer request
voids a code still in flight for the same key. A key that was already
renewed and asks again has been copied: the whole sign-in ends. A
successor code always names a key that exists.

```quint
pure def renewed(s: SignIn, k: int): bool = s.grants.some(g => g.from == k and g.status == GrantAcknowledged)
pure def canRequestRenewal(s: SignIn, k: int): bool =
  usable(s, k) and s.clientOk and s.ownerOk and s.clock <= keyOf(s, k).start + cap and keyOf(s, k).expires < keyOf(s, k).start + cap
pure def revokeAll(s: SignIn): List[Key] = s.keys.listMap(k => if (k.status == KeyActive or k.status == KeyMinted) { ...k, status: KeyRevoked } else k)
pure def successorGrants(s: SignIn, k: int): List[Grant] =
  s.grants.listMap(g => if (g.from == k and (g.status == GrantPending or g.status == GrantExchanged)) { ...g, status: GrantVoid, cipher: false } else g)
    .append({ id: s.grants.length() + 1, status: GrantPending, from: k, issuedAt: s.clock, start: keyOf(s, k).start, cipher: false, reveals: 0, redeemedAt: 0 })
pure def requestRenewal(s: SignIn, k: int): SignIn =
  if (renewed(s, k)) { ...s, keys: revokeAll(s), ended: true } else { ...s, grants: successorGrants(s, k) }
pure def alwaysSignInTimeNeverMoves(s: SignIn): bool = s.grants.every(g => g.start == signInStart(s)) and s.keys.every(k => k.start == signInStart(s))
pure def alwaysSuccessorNamesAKey(s: SignIn): bool = s.grants.every(g => g.from == 0 or hasKey(s, g.from))
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
pure def grantExpired(s: SignIn, grant: Grant): bool =
  if (grant.status == GrantAcknowledged) s.clock >= keyOf(s, grant.id).expires else s.clock >= grant.issuedAt + codeTtl
pure def canReap(s: SignIn, g: int): bool = grantOf(s, g).id == g and grantOf(s, g).status != GrantDeleted and grantExpired(s, grantOf(s, g))
pure def reap(s: SignIn, g: int): SignIn =
  { ...s, grants: putGrant(s, { ...grantOf(s, g), status: GrantDeleted, cipher: false }), keys: if (hasKey(s, g)) putKey(s, { ...keyOf(s, g), status: KeyDeleted }) else s.keys }
pure def alwaysCleanupKeepsLiveKeys(s: SignIn): bool = s.keys.every(k => (k.status == KeyDeleted and k.activated) implies s.clock >= k.expires)
pure def sometimesUnacknowledgedGrantReaped(s: SignIn): bool = s.grants.some(g => g.status == GrantDeleted and g.redeemedAt == 0) and s.keys.some(k => k.status == KeyDeleted and not(k.activated))
```

## Story: Tell a native client exactly why its request was refused

> As the developer of a native client, I want every refusal of a sign-in,
> exchange, acknowledgement or renewal to carry a stable code, a status and
> whether trying again can help, so that the client retries only an outage
> and never a request that can never succeed.

### A protocol refusal is never retryable, and only a dependency outage is

Each request body is parsed strictly: a body that is not JSON, misses a
field, has a field of the wrong shape or length, or carries any property
the request does not define is `invalid_request` (400). A wrong
acknowledgement proof (key, code or credential that do not belong
together) is `credential_proof_invalid` (401); an unknown or disabled client
is `invalid_client` (401); a mismatched binding, an unknown code or a wrong
verifier is 400; an expired code is 410 and a code already completed 409; a
missing server configuration is 503. Every one of these is answered with
`retryable: false`. Only a failure of a service the request depends on is
`temporarily_unavailable` (503) with `retryable: true`.

```quint
type AppAuthRefusal = InvalidRequest | CredentialProofInvalid | InvalidClient | BindingMismatch | InvalidAuthorizationCode | InvalidCodeVerifier | AuthorizationCodeExpired | AuthorizationComplete | ServerConfigurationError | DependencyUnavailable
type RefusalAnswer = { status: int, retryable: bool }
pure def refusalAnswer(refusal: AppAuthRefusal): RefusalAnswer =
  if (refusal == DependencyUnavailable) { status: 503, retryable: true }
  else if (refusal == ServerConfigurationError) { status: 503, retryable: false }
  else if (refusal == CredentialProofInvalid or refusal == InvalidClient) { status: 401, retryable: false }
  else if (refusal == AuthorizationCodeExpired) { status: 410, retryable: false }
  else if (refusal == AuthorizationComplete) { status: 409, retryable: false }
  else { status: 400, retryable: false }
type RequestBody = { json: bool, fieldsValid: bool, extraProperties: bool }
pure val bodyValues = Set({ json: true, fieldsValid: true, extraProperties: false }, { json: true, fieldsValid: true, extraProperties: true }, { json: false, fieldsValid: false, extraProperties: false }, { json: true, fieldsValid: false, extraProperties: false })
pure def bodyRefusal(body: RequestBody): bool = not(body.json) or not(body.fieldsValid) or body.extraProperties
pure def lawOnlyAnOutageIsRetryable(refusal: AppAuthRefusal): bool = refusalAnswer(refusal).retryable iff refusal == DependencyUnavailable
pure def lawWrongProofIsUnauthenticated(refusal: AppAuthRefusal): bool = refusal == CredentialProofInvalid implies refusalAnswer(refusal) == { status: 401, retryable: false }
pure def lawMalformedBodyIsAnInvalidRequest(refusal: AppAuthRefusal): bool = refusal == InvalidRequest implies refusalAnswer(refusal) == { status: 400, retryable: false }
pure def lawAnExtraPropertyRefusesTheBody(body: RequestBody): bool = body.extraProperties implies bodyRefusal(body)
```

### A key lives thirty days unless its registration sets a lifetime from one to ninety days, and a code five minutes

A code, and so the window to exchange and acknowledge it, lasts five
minutes. A key's lifetime is its registration's configured lifetime, or
thirty days when the registration sets none; a configured lifetime shorter
than one day or longer than ninety days makes the registration invalid, so
no client is admitted under it. A renewed key never outlives the
sign-in's cap of one hundred and eighty days.

```quint
pure val daySeconds = 86400
pure val codeLifetimeSeconds = 300
pure val defaultKeyLifetimeSeconds = 2592000
pure val minimumKeyLifetimeSeconds = 86400
pure val maximumKeyLifetimeSeconds = 7776000
pure val renewalCapSeconds = 15552000
pure def codeExpiresAt(issuedAt: int): int = issuedAt + codeLifetimeSeconds
pure val issuedAtValues = Set(0, 15000000)
pure def lawACodeLastsFiveMinutes(issuedAt: int): bool = codeExpiresAt(issuedAt) == issuedAt + 5 * 60
pure def keyLifetimeSeconds(configured: int): int = if (configured == 0) defaultKeyLifetimeSeconds else configured
pure def lifetimeValid(configured: int): bool = configured == 0 or (configured >= minimumKeyLifetimeSeconds and configured <= maximumKeyLifetimeSeconds)
pure def keyEndsAt(acknowledgedAt: int, signInStart: int, configured: int): int =
  if (acknowledgedAt + keyLifetimeSeconds(configured) < signInStart + renewalCapSeconds) acknowledgedAt + keyLifetimeSeconds(configured) else signInStart + renewalCapSeconds
pure val configuredValues = Set(0, 3600, 86400, 2592000, 7776000, 7862400)
pure val acknowledgedAtValues = Set(0, 15000000)
pure val signInStartValues = Set(0)
pure def lawUnsetLifetimeIsThirtyDays(configured: int): bool = configured == 0 implies keyLifetimeSeconds(configured) == 30 * daySeconds
pure def lawConfiguredLifetimeStaysInRange(configured: int): bool =
  lifetimeValid(configured) implies (keyLifetimeSeconds(configured) >= daySeconds and keyLifetimeSeconds(configured) <= 90 * daySeconds)
pure def lawOutOfRangeLifetimeAdmitsNoClient(configured: int): bool =
  not(lifetimeValid(configured)) implies not(clientAdmitted({ ...validPolicy, ttlValid: lifetimeValid(configured) }, CredentialEntry))
pure def lawNoKeyOutlivesTheRenewalCap(acknowledgedAt: int, signInStart: int, configured: int): bool =
  keyEndsAt(acknowledgedAt, signInStart, configured) <= signInStart + renewalCapSeconds
```
