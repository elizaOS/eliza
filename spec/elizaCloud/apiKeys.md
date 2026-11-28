# Cloud API keys

The owner can mint a new Eliza Cloud API key from chat under their active
session. Reserved provisioner prefixes are rejected before any network call,
the plain key is shown once and never retained in durable state, and minting
invalidates cached account snapshots.

## Story: Mint a Cloud API key safely from chat

> As the owner, I want to create an Eliza Cloud API key by name from chat,
> with reserved prefixes refused upfront, the secret shown only once, and my
> cached account summary refreshed immediately.

### Reserved or invalid API key names are refused before network dispatch

A requested key name must be non-empty, within 64 characters, and must not
begin with the reserved `agent-sandbox:` prefix.

```quint
pure def apiKeyNameAllowed(nameLength: int, reservedPrefix: bool): bool =
  nameLength > 0 and nameLength <= 64 and not(reservedPrefix)
pure val nameLengthValues: Set[int] = Set(0, 1, 16, 64, 65)
pure def lawReservedPrefixRefused(nameLength: int): bool =
  not(apiKeyNameAllowed(nameLength, true))
pure def lawEmptyNameRefused(reservedPrefix: bool): bool =
  not(apiKeyNameAllowed(0, reservedPrefix))
```

### Minting requires an active session, reveals the secret once, and invalidates cached snapshots

Only an authenticated session may mint a key. Each mint increments the account
cache version so subsequent provider reads fetch fresh state, and acknowledging
the one-time reply clears the transient plain-key flag. Signing out clears any
active reveal and increments the cache version without rewinding the epoch.

```quint
type KeyMintSession = {
  accountId: str,
  epoch: int,
  cacheVersion: int,
  lastMintedKeyId: str,
  plainKeyRevealed: bool
}
pure val initial: KeyMintSession = {
  accountId: "",
  epoch: 0,
  cacheVersion: 0,
  lastMintedKeyId: "",
  plainKeyRevealed: false
}
pure def canBindKeySession(s: KeyMintSession, accountId: str, epoch: int): bool =
  accountId != "" and epoch > s.epoch
pure def bindKeySession(s: KeyMintSession, accountId: str, epoch: int): KeyMintSession =
  { accountId: accountId, epoch: epoch, cacheVersion: s.cacheVersion + 1, lastMintedKeyId: "", plainKeyRevealed: false }
pure def canMintApiKey(s: KeyMintSession, keyId: str, sessionAuthorized: bool, nameAllowed: bool): bool =
  s.accountId != "" and keyId != "" and sessionAuthorized and nameAllowed and not(s.plainKeyRevealed)
pure def mintApiKey(s: KeyMintSession, keyId: str, sessionAuthorized: bool, nameAllowed: bool): KeyMintSession =
  { ...s, cacheVersion: s.cacheVersion + 1, lastMintedKeyId: keyId, plainKeyRevealed: true }
pure def canAcknowledgePlainKey(s: KeyMintSession): bool =
  s.plainKeyRevealed
pure def acknowledgePlainKey(s: KeyMintSession): KeyMintSession =
  { ...s, plainKeyRevealed: false }
pure def canClearKeySession(s: KeyMintSession): bool =
  s.accountId != ""
pure def clearKeySession(s: KeyMintSession): KeyMintSession =
  { accountId: "", epoch: s.epoch, cacheVersion: s.cacheVersion + 1, lastMintedKeyId: "", plainKeyRevealed: false }
pure def alwaysSignedOutHasNoPlainKey(s: KeyMintSession): bool =
  s.accountId == "" implies not(s.plainKeyRevealed)
pure def alwaysCacheVersionNonNegative(s: KeyMintSession): bool =
  s.cacheVersion >= 0
pure def stepMintInvalidatesCache(before: KeyMintSession, after: KeyMintSession): bool =
  before.lastMintedKeyId != after.lastMintedKeyId implies after.cacheVersion > before.cacheVersion
pure def stepKeyEpochNeverRewinds(before: KeyMintSession, after: KeyMintSession): bool =
  before.epoch <= after.epoch
pure def sometimesKeyMintedAndCleared(s: KeyMintSession): bool =
  s.lastMintedKeyId != "" and not(s.plainKeyRevealed)
pure val eval_witness_sometimesKeyMintedAndCleared = (
  ("bindKeySession", "owner", 1),
  ("mintApiKey", "key-1", true, true),
  ("acknowledgePlainKey")
)
pure val accountIdValues: Set[str] = Set("", "owner", "other")
pure val keyIdValues: Set[str] = Set("", "key-1", "key-2")
pure val epochValues: Set[int] = Set(0, 1, 2, 3)
```
