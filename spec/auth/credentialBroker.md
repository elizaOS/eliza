# Native credential broker admission and account fencing

The native agent plugin's `LocalCredentialBroker` binds to loopback and
accepts a private HTTP JSON request from the authenticated native client.
A consumer's runtime creates it in verified mode and supplies its guard for
verified account and task-key operations. It checks launch ownership before
and after verified work under the guard lock. The renderer has a distinct
request transport and never reaches the vault through this broker. The
[secure slots](./secureSlots.md) are the storage it fronts.

## Story: Read or exchange native credentials without exposing the vault to the renderer

> As a device owner, I want native code to read and replace my account
> credentials only through the private broker of the current launch, and
> the app view never to reach the vault.

### Wire admission and guarded account custody use separate evidence

The broker accepts authenticated POST requests at the private route.
It refuses browser-origin and transfer-encoding headers, duplicates
of Authorization or Content-Length, and invalid or oversize bodies.
Its maximum body bytes are 20,000 in legacy mode and 40,000 in verified
mode. Verified account and task-key requests require an open broker,
a configured guarded port, and matching launch ownership.
The pending enrollment store remains available to the authenticated
native client. Verified mode forbids legacy primary writes and clears.

```quint
type BrokerMode = LegacyPrimary | VerifiedPrimary
type BrokerOperation = ReadPrimary | WritePrimary | ClearPrimary | ReadVerified | ExchangeVerified | ReadPending | WritePending | ClearPending | ReadTaskKey | CreateTaskKey | RemoveTaskKey | ReadStrandedKey | CompleteStrandedKey
type BrokerAdmission = BrokerAllowed | ForbiddenWire | InvalidLength | UnavailablePort | RetiredLaunch
type CredentialEnvelope = { postCredentialRoute: bool, exactBearer: bool, forbiddenHeaders: bool, bodyLength: int }
type BrokerBinding = { mode: BrokerMode, accountConfigured: bool, taskKeysConfigured: bool, launchCurrent: bool, serverOpen: bool }
pure def taskOperation(op: BrokerOperation): bool =
  op == ReadTaskKey or op == CreateTaskKey or op == RemoveTaskKey or op == ReadStrandedKey or op == CompleteStrandedKey
pure def guardedAccount(binding: BrokerBinding, op: BrokerOperation): bool =
  op == ReadVerified or op == ExchangeVerified or (op == ReadPrimary and binding.mode == VerifiedPrimary)
pure def acceptsWire(envelope: CredentialEnvelope): bool =
  envelope.postCredentialRoute and envelope.exactBearer and not(envelope.forbiddenHeaders)
pure def brokerAdmission(binding: BrokerBinding, envelope: CredentialEnvelope, op: BrokerOperation): BrokerAdmission =
  if (not(acceptsWire(envelope))) ForbiddenWire
  else if (envelope.bodyLength < 0 or envelope.bodyLength > (if (binding.mode == VerifiedPrimary) 40000 else 20000)) InvalidLength
  else if (binding.mode == VerifiedPrimary and (op == WritePrimary or op == ClearPrimary)) UnavailablePort
  else if ((guardedAccount(binding, op) and not(binding.accountConfigured)) or (taskOperation(op) and not(binding.taskKeysConfigured))) UnavailablePort
  else if ((guardedAccount(binding, op) or taskOperation(op)) and (not(binding.serverOpen) or not(binding.launchCurrent))) RetiredLaunch
  else BrokerAllowed
pure val bindingValues = Set(
  {mode: VerifiedPrimary, accountConfigured: true, taskKeysConfigured: true, launchCurrent: true, serverOpen: true},
  {mode: VerifiedPrimary, accountConfigured: true, taskKeysConfigured: true, launchCurrent: false, serverOpen: false},
  {mode: LegacyPrimary, accountConfigured: false, taskKeysConfigured: false, launchCurrent: true, serverOpen: true}
)
pure val envelopeValues = Set(
  {postCredentialRoute: true, exactBearer: true, forbiddenHeaders: false, bodyLength: 200},
  {postCredentialRoute: true, exactBearer: true, forbiddenHeaders: true, bodyLength: 200},
  {postCredentialRoute: true, exactBearer: false, forbiddenHeaders: false, bodyLength: 200},
  {postCredentialRoute: true, exactBearer: true, forbiddenHeaders: false, bodyLength: 40001}
)
pure def lawNoStorageWithoutNativeWireAuthority(binding: BrokerBinding, envelope: CredentialEnvelope, op: BrokerOperation): bool =
  brokerAdmission(binding, envelope, op) == BrokerAllowed implies acceptsWire(envelope)
pure def lawGuardedOperationOwnsCurrentLaunch(binding: BrokerBinding, envelope: CredentialEnvelope, op: BrokerOperation): bool =
  brokerAdmission(binding, envelope, op) == BrokerAllowed and (guardedAccount(binding, op) or taskOperation(op)) implies
    binding.serverOpen and binding.launchCurrent
pure def lawVerifiedPrimaryRejectsLegacyMutation(binding: BrokerBinding, envelope: CredentialEnvelope, op: BrokerOperation): bool =
  binding.mode == VerifiedPrimary and (op == WritePrimary or op == ClearPrimary) implies brokerAdmission(binding, envelope, op) != BrokerAllowed
```

### Exact account exchange refuses a stale record and never reports through a retired launch

The native account port compares an opaque snapshot to current state.
A mismatch makes no mutation. A consumer's account-change callback runs
only on an actual exchange. Closing the broker or losing its guard
after a durable write leaves that write in place and suppresses the
caller response. The domain uses numeric identities for opaque
snapshot records, with zero denoting no account. It does not carry
secret values or emulate the authenticated store.

```quint
type AccountExchange = { storedIdentity: int, committed: bool, responseAllowed: bool }
pure def exchangeAccount(currentIdentity: int, expectedIdentity: int, replacementIdentity: int, admittedAndGuarded: bool, postGuard: bool): AccountExchange =
  if (not(admittedAndGuarded)) {storedIdentity: currentIdentity, committed: false, responseAllowed: false}
  else if (currentIdentity != expectedIdentity) {storedIdentity: currentIdentity, committed: false, responseAllowed: postGuard}
  else {storedIdentity: replacementIdentity, committed: true, responseAllowed: postGuard}
pure def lawExchangeNeedsExactRecord(currentIdentity: int, expectedIdentity: int, replacementIdentity: int, admittedAndGuarded: bool, postGuard: bool): bool =
  exchangeAccount(currentIdentity, expectedIdentity, replacementIdentity, admittedAndGuarded, postGuard).committed implies
    admittedAndGuarded and currentIdentity == expectedIdentity
pure def lawReplyNeedsPostGuard(currentIdentity: int, expectedIdentity: int, replacementIdentity: int, admittedAndGuarded: bool, postGuard: bool): bool =
  exchangeAccount(currentIdentity, expectedIdentity, replacementIdentity, admittedAndGuarded, postGuard).responseAllowed implies admittedAndGuarded and postGuard
```
