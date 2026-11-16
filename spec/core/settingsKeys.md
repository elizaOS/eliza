# Settings key and envelope lifecycle

The source is `settings.ts`. Keys below are identities of host-supplied key
material. Encryption, randomness, hash derivation, hex parsing and
authenticated decryption are external cryptographic operations at the
shell boundary.

## Story: Keep persisted settings decryptable under the selected key

> As an operator, I want persisted settings encrypted under my private salt
> and an explicit failure when production has an unset or public salt, so
> that secrets stay decryptable by me and by no one else.

The development fallback is one random key per process, so a restart
cannot read what an earlier process stored under it, while a configured
private key reads back after any number of restarts.

### Production rejects unset and public salts on refresh

`getSalt` caches successful resolution for 300000 milliseconds and selects
the private salt when one is configured, else the process-local random key.
Cache clearing rereads the environment and preserves that random key for
the life of the process. A change of environment invalidates the cached
key. A host changing key material must migrate existing ciphertext.

```quint
type SaltKind = UnsetSalt | PublicSalt | PrivateSalt
type KeyResult = NoResult | KeyReady | KeyRejected
type KeyCache = { production: bool, configured: SaltKind, privateId: int, ephemeralId: int, cachedId: int, cachedAt: int, now: int, result: KeyResult, warningLogged: bool, warningCount: int, storedId: int, retiredIds: Set[int], restarts: int }
pure val initial: KeyCache = { production: false, configured: UnsetSalt, privateId: 0, ephemeralId: 0, cachedId: 0, cachedAt: 0, now: 0, result: NoResult, warningLogged: false, warningCount: 0, storedId: 0, retiredIds: Set(), restarts: 0 }
pure def cacheValid(k: KeyCache): bool = k.cachedId > 0 and k.now - k.cachedAt < 300000
pure def canConfigure(k: KeyCache, production: bool, kind: SaltKind, keyId: int): bool = (kind == PrivateSalt implies keyId > 0 and keyId != k.ephemeralId and not(k.retiredIds.contains(keyId)))
pure def configure(k: KeyCache, production: bool, kind: SaltKind, keyId: int): KeyCache = { ...k, production: production, configured: kind, privateId: if (kind == PrivateSalt) keyId else 0, cachedId: 0, result: NoResult }
pure def canReadKey(k: KeyCache, freshId: int): bool = freshId > 0 and freshId != k.privateId and not(k.retiredIds.contains(freshId))
pure def readKey(k: KeyCache, freshId: int): KeyCache = {
  val ephemeral = if (k.ephemeralId > 0) k.ephemeralId else freshId
  if (cacheValid(k)) { ...k, result: KeyReady }
  else if (k.production and k.configured != PrivateSalt) { ...k, result: KeyRejected }
  else { ...k, ephemeralId: if (k.configured == PrivateSalt) k.ephemeralId else ephemeral, cachedId: if (k.configured == PrivateSalt) k.privateId else ephemeral, cachedAt: k.now, result: KeyReady, warningLogged: k.warningLogged or k.configured != PrivateSalt, warningCount: k.warningCount + (if (not(k.warningLogged) and k.configured != PrivateSalt) 1 else 0) }
}
pure def clearCache(k: KeyCache): KeyCache = { ...k, cachedId: 0, result: NoResult, warningLogged: false }
pure def canSetClock(k: KeyCache, now: int): bool = now >= 0
pure def setClock(k: KeyCache, now: int): KeyCache = { ...k, now: now }
pure val nowValues = Set(0, 1, 299999, 300000, 300001)
pure val keyIdValues = Set(1, 2)
pure val freshIdValues = Set(3, 4)
pure def alwaysKeyIdentity(k: KeyCache): bool = k.privateId >= 0 and k.ephemeralId >= 0 and k.cachedId >= 0 and (k.result == KeyReady implies k.cachedId > 0)
pure def stepEphemeralKeyStableWithinProcess(before: KeyCache, via: str, after: KeyCache): bool = via != "restart" and (before.ephemeralId > 0 or via == "clearCache") implies after.ephemeralId == before.ephemeralId
pure def sometimesProductionRejectsDefault(k: KeyCache): bool = k.production and k.configured == PublicSalt and k.result == KeyRejected
pure def sometimesPrivateKeySelected(k: KeyCache): bool = k.result == KeyReady and k.configured == PrivateSalt and k.cachedId == k.privateId
pure def sometimesDevelopmentKeySelected(k: KeyCache): bool = not(k.production) and k.result == KeyReady and k.ephemeralId > 0 and k.cachedId == k.ephemeralId
```

### In production a ready key is always the configured private key

Production never yields the process key: a ready key there is the private
salt that is configured now, whatever an earlier configuration cached.

```quint
pure def alwaysProductionKeyIsPrivate(k: KeyCache): bool =
  k.production and k.result == KeyReady implies k.configured == PrivateSalt and k.cachedId == k.privateId
```

### A stored setting reads back only under the key that stored it

A setting is stored under the ready key. A restart starts a new process
with no cached key and retires the process key, which no later process
ever selects again, while the configured private salt carries over.

```quint
pure def canStoreSetting(k: KeyCache): bool = k.result == KeyReady
pure def storeSetting(k: KeyCache): KeyCache = { ...k, storedId: k.cachedId }
pure def canRestart(k: KeyCache): bool = true
pure def restart(k: KeyCache): KeyCache =
  { ...k, retiredIds: if (k.ephemeralId > 0) k.retiredIds.union(Set(k.ephemeralId)) else k.retiredIds, ephemeralId: 0, cachedId: 0, cachedAt: 0, result: NoResult, warningLogged: false, restarts: k.restarts + 1 }
pure def readsStored(k: KeyCache): bool = k.storedId > 0 and k.result == KeyReady and k.cachedId == k.storedId
pure def alwaysEarlierProcessKeyNeverReads(k: KeyCache): bool = k.result == KeyReady implies not(k.retiredIds.contains(k.cachedId))
pure def stepRestartKeepsConfiguredKey(before: KeyCache, via: str, after: KeyCache): bool =
  via == "restart" implies after.configured == before.configured and after.privateId == before.privateId and after.storedId == before.storedId
pure def sometimesConfiguredKeyReadsAfterRestart(k: KeyCache): bool = k.restarts > 0 and k.configured == PrivateSalt and readsStored(k)
pure def sometimesProcessKeyLostAfterRestart(k: KeyCache): bool = k.restarts > 0 and k.retiredIds.contains(k.storedId) and k.result == KeyReady and not(readsStored(k))
```

### A configured private salt always has a positive key identity

A state claiming private configuration with no
private key would allow a refresh to report an absent key as ready.
Configuration requires the private identity before admitting that state.

```quint
pure def alwaysPrivateConfigurationHasKey(k: KeyCache): bool = k.configured == PrivateSalt implies k.privateId > 0
```

### Recognized ciphertext fails explicitly when authentication or decryption fails

New encryption uses AES-256-GCM with a 12-byte IV, 16-byte tag and the
`elizaos:settings:v2` authenticated data. Supported legacy CBC envelopes
remain readable. Encrypting plaintext yields a GCM envelope, and encrypting a
recognized envelope preserves it, so encryption never wraps ciphertext twice.
Non-envelopes remain plaintext on reading. Authentication failure carries
`SETTING_DECRYPTION_FAILED` and its original cause.

```quint
type EnvelopeKind = Plaintext | LegacyCbc | AuthenticatedGcm
type DecryptionResult = OriginalText | DecryptedText | SettingDecryptionFailed
pure def encryptedEnvelope(kind: EnvelopeKind): EnvelopeKind = if (kind == Plaintext) AuthenticatedGcm else kind
pure def decryptionResult(kind: EnvelopeKind, cryptoSucceeded: bool): DecryptionResult =
  if (kind == Plaintext) OriginalText else if (cryptoSucceeded) DecryptedText else SettingDecryptionFailed
pure def lawEncryptionIsIdempotentAndDecryptable(kind: EnvelopeKind): bool = encryptedEnvelope(encryptedEnvelope(kind)) == encryptedEnvelope(kind) and decryptionResult(encryptedEnvelope(kind), true) == DecryptedText
pure def lawFailedCiphertextNeverBecomesText(kind: EnvelopeKind): bool = kind != Plaintext implies decryptionResult(kind, false) == SettingDecryptionFailed
```

### The ephemeral-key warning is emitted once until explicit cache clearing

A cache hit never warns. Refreshing an unset or public development salt
warns only when the warning latch is clear. Clearing resets the latch but
keeps the process key. Production rejection does not emit this warning.

```quint
pure def stepWarningsOnlyIncreaseOnDevelopmentFallback(before: KeyCache, via: str, after: KeyCache): bool =
  (after.warningCount == before.warningCount or after.warningCount == before.warningCount + 1) and
  (after.warningCount > before.warningCount implies via == "readKey" and not(cacheValid(before)) and not(before.production) and before.configured != PrivateSalt and not(before.warningLogged))
pure def sometimesWarningResets(k: KeyCache): bool = k.warningCount > 0 and not(k.warningLogged) and k.cachedId == 0 and k.ephemeralId > 0
```
