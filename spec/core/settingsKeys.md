# Settings key and envelope lifecycle

The source is `packages/core/src/settings.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`.
Keys below are identities of host-supplied key material. Encryption,
randomness, hash derivation, hex parsing and authenticated decryption are
external cryptographic operations whose concrete adapter tests remain
required before implementation acceptance.

## Story: Keep persisted settings decryptable under the selected key

As an operator, I retain a private salt for persisted settings and observe
an explicit failure when production has an unset or publicly known salt.
The development fallback is one random key per process.

### Production rejects unset and public salts on refresh

`getSalt` caches successful resolution for 300000 milliseconds. Cache
clearing rereads the environment and preserves the process-local random
key. A host changing key material must migrate existing ciphertext.

```quint
type SaltKind = UnsetSalt | PublicSalt | PrivateSalt
type KeyResult = NoResult | KeyReady | KeyRejected
type KeyCache = { production: bool, configured: SaltKind, privateId: int, ephemeralId: int, cachedId: int, cachedAt: int, now: int, result: KeyResult, warningLogged: bool, warningCount: int }
pure val initial: KeyCache = { production: false, configured: UnsetSalt, privateId: 0, ephemeralId: 0, cachedId: 0, cachedAt: 0, now: 0, result: NoResult, warningLogged: false, warningCount: 0 }
pure def cacheValid(k: KeyCache): bool = k.cachedId > 0 and k.now - k.cachedAt < 300000
pure def canConfigure(k: KeyCache, production: bool, kind: SaltKind, keyId: int): bool = (kind == PrivateSalt implies keyId > 0)
pure def configure(k: KeyCache, production: bool, kind: SaltKind, keyId: int): KeyCache = { ...k, production: production, configured: kind, privateId: if (kind == PrivateSalt) keyId else 0 }
pure def canReadKey(k: KeyCache, freshId: int): bool = freshId > 0
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
```

### A configured private salt always has a positive key identity

Discovered by the proof: a state claiming private configuration with no
private key would allow a refresh to report an absent key as ready.
Configuration requires the private identity before admitting that state.

```quint
pure def alwaysPrivateConfigurationHasKey(k: KeyCache): bool = k.configured == PrivateSalt implies k.privateId > 0
pure def stepEphemeralKeySurvivesCacheClear(before: KeyCache, via: str, after: KeyCache): bool = via == "clearCache" implies after.ephemeralId == before.ephemeralId
pure def stepEphemeralKeyStableWithinProcess(before: KeyCache, after: KeyCache): bool = before.ephemeralId > 0 implies after.ephemeralId == before.ephemeralId
pure def sometimesProductionRejectsDefault(k: KeyCache): bool = k.production and k.configured == PublicSalt and k.result == KeyRejected
pure def sometimesPrivateKeySelected(k: KeyCache): bool = k.result == KeyReady and k.configured == PrivateSalt and k.cachedId == k.privateId
pure def sometimesDevelopmentKeySelected(k: KeyCache): bool = not(k.production) and k.result == KeyReady and k.ephemeralId > 0 and k.cachedId == k.ephemeralId
```

### Recognized ciphertext fails explicitly when authentication or decryption fails

New encryption uses AES-256-GCM with a 12-byte IV, 16-byte tag and the
`elizaos:settings:v2` authenticated data. Supported legacy CBC envelopes
remain readable. Recognized envelopes are preserved on encryption.
Non-envelopes remain plaintext on reading. Authentication failure carries
`SETTING_DECRYPTION_FAILED` and its original cause.

```quint
type EnvelopeKind = Plaintext | LegacyCbc | AuthenticatedGcm
type DecryptionResult = OriginalText | DecryptedText | SettingDecryptionFailed
pure def encryptionRequired(kind: EnvelopeKind): bool = kind == Plaintext
pure def decryptionResult(kind: EnvelopeKind, cryptoSucceeded: bool): DecryptionResult =
  if (kind == Plaintext) OriginalText else if (cryptoSucceeded) DecryptedText else SettingDecryptionFailed
pure def lawRecognizedCiphertextIsNotDoubleEncrypted(kind: EnvelopeKind): bool = kind != Plaintext implies not(encryptionRequired(kind))
pure def lawFailedCiphertextNeverBecomesText(kind: EnvelopeKind): bool = kind != Plaintext implies decryptionResult(kind, false) == SettingDecryptionFailed
```

### The ephemeral-key warning is emitted once until explicit cache clearing

A cache hit never warns. Refreshing an unset or public development salt
warns only when the warning latch is clear. Clearing resets the latch but
keeps the process key. Production rejection does not emit this warning.

```quint
pure def alwaysWarningCountNonnegative(k: KeyCache): bool = k.warningCount >= 0
pure def stepWarningsOnlyIncreaseOnDevelopmentFallback(before: KeyCache, via: str, after: KeyCache): bool =
  (after.warningCount == before.warningCount or after.warningCount == before.warningCount + 1) and
  (after.warningCount > before.warningCount implies via == "readKey" and not(cacheValid(before)) and not(before.production) and before.configured != PrivateSalt and not(before.warningLogged))
pure def sometimesWarningResets(k: KeyCache): bool = k.warningCount > 0 and not(k.warningLogged) and k.cachedId == 0 and k.ephemeralId > 0
```
