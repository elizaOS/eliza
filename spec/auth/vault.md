# Device vault

The agent keeps its own secrets (keys it generates, tokens it is given)
encrypted in a vault on the device, under a master key taken from the
operating system's keychain or a configured key source, never from a
plaintext setting. Each profile's secrets are kept apart. The vault treats
a failed read as a failure, never as an empty slot, so it never replaces a
key it merely could not read, and it acknowledges a write only after
reading the written value back.

Wallets and signing are not part of Eliza. Key derivation is in
[key management](./kms.md).

## Story: Keep secrets encrypted on the device and read them back exactly

> As the agent, I want my secrets stored encrypted and returned exactly as
> written, so that a disk or keychain hiccup never makes me forget a key,
> mint a different one, or report a write that did not land.

### The master key comes from the keychain or a configured key source, never from a plaintext setting

```quint
type MasterKeySource = OsKeychain | ConfiguredKeySource | PlaintextSetting
type KeyState = VaultLocked | VaultUnlocked | UnlockRefused
type SlotName = { profile: str, name: str }
type VaultEntry = { profile: str, name: str, value: int }
type VaultResult = NoVaultCall | SecretRead | SecretAbsent | ReadFailed | Generated | WriteAcknowledged | WriteFailed | RollbackFailed | Unlocked | KeySourceRefused
type Vault = {
  key: KeyState, source: MasterKeySource, entries: List[VaultEntry], checkedAbsent: List[SlotName], readFailures: List[SlotName], generated: List[SlotName],
  pending: List[VaultEntry], previous: List[VaultEntry], acked: List[VaultEntry], lastProfile: str, result: VaultResult
}
pure val initial: Vault = {
  key: VaultLocked, source: OsKeychain, entries: List({ profile: "default", name: "agent-key", value: 1 }), checkedAbsent: List(), readFailures: List(), generated: List(),
  pending: List(), previous: List(), acked: List(), lastProfile: "", result: NoVaultCall
}
pure def canUnlock(s: Vault, source: MasterKeySource): bool = s.key != VaultUnlocked
pure def unlock(s: Vault, source: MasterKeySource): Vault =
  if (source == PlaintextSetting) { ...s, key: UnlockRefused, source: source, result: KeySourceRefused } else { ...s, key: VaultUnlocked, source: source, result: Unlocked }
pure def alwaysNoPlaintextMasterKey(s: Vault): bool = s.key == VaultUnlocked implies s.source != PlaintextSetting
pure def sometimesPlaintextRefused(s: Vault): bool = s.result == KeySourceRefused
```

### A failed read is never taken as absence and never leads to a new key

A slot is generated only after a read that succeeded and found it empty,
with no failed read since.

```quint
pure def slotOf(profile: str, name: str): SlotName = { profile: profile, name: name }
pure def hasEntry(s: Vault, profile: str, name: str): bool = s.entries.some(e => e.profile == profile and e.name == name)
pure def canReadSecret(s: Vault, profile: str, name: str, fails: bool): bool = s.key == VaultUnlocked
pure def readSecret(s: Vault, profile: str, name: str, fails: bool): Vault = {
  val slot = slotOf(profile, name)
  if (fails) { ...s, readFailures: s.readFailures.select(x => x != slot).append(slot), checkedAbsent: s.checkedAbsent.select(x => x != slot), lastProfile: profile, result: ReadFailed }
  else if (hasEntry(s, profile, name)) { ...s, readFailures: s.readFailures.select(x => x != slot), lastProfile: profile, result: SecretRead }
  else { ...s, readFailures: s.readFailures.select(x => x != slot), checkedAbsent: s.checkedAbsent.select(x => x != slot).append(slot), lastProfile: profile, result: SecretAbsent }
}
pure def canGenerateSecret(s: Vault, profile: str, name: str, value: int): bool =
  s.key == VaultUnlocked and s.checkedAbsent.includes(slotOf(profile, name)) and not(s.readFailures.includes(slotOf(profile, name))) and not(hasEntry(s, profile, name)) and s.pending.length() == 0
pure def generateSecret(s: Vault, profile: str, name: str, value: int): Vault =
  { ...s, generated: s.generated.append(slotOf(profile, name)), checkedAbsent: s.checkedAbsent.select(x => x != slotOf(profile, name)), lastProfile: profile, result: Generated,
    previous: s.entries, entries: s.entries.append({ profile: profile, name: name, value: value }), pending: List({ profile: profile, name: name, value: value }) }
pure val profileValues = Set("default", "work")
pure val nameValues = Set("agent-key")
pure val valueValues = Set(2, 3)
pure def stepGenerationFollowsACleanEmptyRead(before: Vault, via: str, after: Vault): bool =
  via == "generateSecret" implies after.generated.select(g => not(before.generated.includes(g))).every(g => before.checkedAbsent.includes(g) and not(before.readFailures.includes(g)) and not(hasEntry(before, g.profile, g.name)))
pure def alwaysExistingKeyNeverRegenerated(s: Vault): bool = not(s.generated.includes(slotOf("default", "agent-key")))
pure def sometimesReadFailureKeepsKey(s: Vault): bool = s.result == ReadFailed and hasEntry(s, "default", "agent-key")
pure def sometimesGeneratedAfterEmptyRead(s: Vault): bool = s.generated.length() > 0
```

### A write is acknowledged only after the written value reads back

A mismatched readback restores the previous value; a failed restore is
reported, never hidden.

```quint
pure def canWriteSecret(s: Vault, profile: str, name: str, value: int): bool = s.key == VaultUnlocked and hasEntry(s, profile, name) and s.pending.length() == 0
pure def writeSecret(s: Vault, profile: str, name: str, value: int): Vault =
  { ...s, previous: s.entries, entries: s.entries.listMap(e => if (e.profile == profile and e.name == name) { ...e, value: value } else e), pending: List({ profile: profile, name: name, value: value }), lastProfile: profile }
pure def canReadBack(s: Vault, matches: bool): bool = s.pending.length() > 0
pure def readBack(s: Vault, matches: bool): Vault =
  if (matches) { ...s, acked: s.acked.concat(s.pending), pending: List(), lastProfile: s.pending.nthOr(0, { profile: "", name: "", value: 0 }).profile, result: WriteAcknowledged }
  else { ...s, entries: s.previous, pending: List(), lastProfile: s.pending.nthOr(0, { profile: "", name: "", value: 0 }).profile, result: WriteFailed }
pure def canRollbackFails(s: Vault): bool = s.pending.length() > 0
pure def rollbackFails(s: Vault): Vault = { ...s, pending: List(), lastProfile: s.pending.nthOr(0, { profile: "", name: "", value: 0 }).profile, result: RollbackFailed }
pure def stepAcknowledgedWriteIsDurable(before: Vault, via: str, after: Vault): bool =
  after.acked.select(a => not(before.acked.includes(a))).every(a => via == "readBack" and before.pending.includes(a) and after.entries.includes(a))
pure def alwaysPendingWriteIsOnDisk(s: Vault): bool = s.pending.every(p => s.entries.includes(p)) and s.pending.length() <= 1
pure def sometimesWriteAcknowledged(s: Vault): bool = s.result == WriteAcknowledged
pure def sometimesRollbackFailureVisible(s: Vault): bool = s.result == RollbackFailed
```

### Profiles isolate secrets

A call for one profile never reads, writes or restores another profile's
secrets.

```quint
pure def stepOtherProfilesUntouched(before: Vault, via: str, after: Vault): bool =
  after.entries.select(e => e.profile != after.lastProfile) == before.entries.select(e => e.profile != after.lastProfile)
pure def alwaysOneEntryPerSlot(s: Vault): bool = s.entries.every(e => s.entries.select(o => o.profile == e.profile and o.name == e.name).length() == 1)
pure def sometimesTwoProfiles(s: Vault): bool = s.entries.some(e => e.profile == "work") and hasEntry(s, "default", "agent-key")
```
