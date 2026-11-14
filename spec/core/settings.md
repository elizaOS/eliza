# Runtime settings

The baseline is `packages/core/src/runtime.ts` methods `getSetting` and
`setSetting`, and `packages/core/src/settings.ts`, at commit
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. Each `SettingLayers` represents
one key of one runtime. The registry composes every runtime and key with
shared-container identity retained across key creation.
Secret encryption and envelope authentication are specified in
[key management](./settingsKeys.md).

## Story: Resolve the same setting in every host

As a host author, I configure each agent independently and retain the
existing precedence of character secrets, direct settings, extra settings,
nested secrets, character environment, and constructor settings.

### Resolution preserves precedence and valid false zero and empty values

Only absence advances to the next layer. Character environment direct
values precede `env.vars`. Ordinary `getSetting` has no process-environment
fallback. The source's explicitly named host policy settings retain their
separate environment resolution contracts.

```quint
type Value = Missing | Text({ text: str }) | BooleanValue({ enabled: bool }) | NumericValue({ number: int })
type SettingLayers = { secret: Value, direct: Value, extra: Value, nested: Value, nestedAliasesSecret: bool, environment: Value, variables: Value, constructorValue: Value }
pure val emptyLayers: SettingLayers = { secret: Missing, direct: Missing, extra: Missing, nested: Missing, nestedAliasesSecret: false, environment: Missing, variables: Missing, constructorValue: Missing }
pure val valueValues = Set(Missing, Text({ text: "" }), Text({ text: "true" }), Text({ text: "credential" }), BooleanValue({ enabled: false }), NumericValue({ number: 0 }))
pure val preferredValues = valueValues
pure val fallbackValues = valueValues
pure val layersValues = Set(emptyLayers, { ...emptyLayers, secret: Text({ text: "credential" }), direct: BooleanValue({ enabled: false }) }, { ...emptyLayers, direct: NumericValue({ number: 0 }), constructorValue: Text({ text: "fallback" }) })
pure def isMissing(value: Value): bool = match value { | Missing => true | _ => false }
pure def sameValue(left: Value, right: Value): bool = left == right
pure def firstValue(preferred: Value, fallback: Value): Value = if (isMissing(preferred)) fallback else preferred
pure def resolved(layers: SettingLayers): Value =
  firstValue(layers.secret, firstValue(layers.direct, firstValue(layers.extra, firstValue(layers.nested, firstValue(layers.environment, firstValue(layers.variables, layers.constructorValue))))))
pure def normalizePlaintext(value: Value): Value = match value {
  | Text(v) => if (v.text == "true") BooleanValue({ enabled: true }) else if (v.text == "false") BooleanValue({ enabled: false }) else Text({ text: v.text })
  | _ => value
}
pure def lawSecretWins(layers: SettingLayers, text: str): bool = sameValue(resolved({ ...layers, secret: Text({ text: text }) }), Text({ text: text }))
pure def lawFalseIsPresent(fallback: Value): bool = sameValue(firstValue(BooleanValue({ enabled: false }), fallback), BooleanValue({ enabled: false }))
pure def lawZeroIsPresent(fallback: Value): bool = sameValue(firstValue(NumericValue({ number: 0 }), fallback), NumericValue({ number: 0 }))
pure def lawEmptyStringIsPresent(fallback: Value): bool = sameValue(firstValue(Text({ text: "" }), fallback), Text({ text: "" }))
pure def lawBooleanStringsNormalize(settingEnabled: bool): bool = sameValue(normalizePlaintext(Text({ text: if (settingEnabled) "true" else "false" })), BooleanValue({ enabled: settingEnabled }))
```

### Setting and clearing align live secret and constructor slots

An existing top-level secret retains secret ownership when updated through
the ordinary setter. Clearing removes that secret, its nested snapshot,
and the constructor value. Lower-priority independently configured layers
keep their values. A secret update removes a distinct nested snapshot.
When initialization has aliased both secret containers, writing the live
container is visible through both references and preserves their identity.

```quint
pure def secretValue(value: Value): Value = match value {
  | BooleanValue(v) => Text({ text: if (v.enabled) "true" else "false" })
  | _ => value
}
pure def writable(value: Value): bool = match value { | NumericValue(v) => false | _ => true }
pure def updated(layers: SettingLayers, value: Value, secret: bool): SettingLayers =
  if (secret or not(isMissing(layers.secret)))
    { ...layers, secret: secretValue(value), nested: if (layers.nestedAliasesSecret) secretValue(value) else Missing, constructorValue: value }
  else { ...layers, direct: value, constructorValue: value }
pure def linkedSecretContainers(layers: SettingLayers): SettingLayers = { ...layers, nested: layers.secret, nestedAliasesSecret: true }
pure def lawSecretClearRemovesRevokedSnapshots(layers: SettingLayers): bool =
  isMissing(updated(layers, Missing, true).secret) and isMissing(updated(layers, Missing, true).nested) and isMissing(updated(layers, Missing, true).constructorValue)
pure def lawOrdinaryUpdateKeepsSecretOwnership(layers: SettingLayers, text: str): bool =
  not(isMissing(layers.secret)) implies sameValue(updated(layers, Text({ text: text }), false).secret, Text({ text: text }))
```

## Story: Isolate settings between agents and keys

As an operator, I update any key of any runtime while retaining every
other runtime and key. A runtime whose secret containers share identity
keeps that identity when a previously absent key is created.

### The registry owns arbitrary runtime and key pairs

A missing key resolves through empty layers. Initial layers are installed
once for each pair; subsequent writes follow the setter contract above.
Secret-container linkage belongs to the whole runtime, so every existing
and future key observes it. No fixed key or runtime count is imposed.

```quint
type SettingSlot = { runtimeId: str, key: str, layers: SettingLayers }
type RuntimeSettings = { slots: List[SettingSlot], linkedRuntimes: Set[str] }
pure val initial: RuntimeSettings = { slots: List(), linkedRuntimes: Set() }
pure def hasSetting(s: RuntimeSettings, runtimeId: str, key: str): bool = s.slots.some(slot => slot.runtimeId == runtimeId and slot.key == key)
pure def settingAt(s: RuntimeSettings, runtimeId: str, key: str): SettingLayers =
  s.slots.select(slot => slot.runtimeId == runtimeId and slot.key == key).nthOr(0, { runtimeId: runtimeId, key: key, layers: if (s.linkedRuntimes.contains(runtimeId)) linkedSecretContainers(emptyLayers) else emptyLayers }).layers
pure def replaceSetting(s: RuntimeSettings, runtimeId: str, key: str, layers: SettingLayers): List[SettingSlot] =
  s.slots.select(slot => slot.runtimeId != runtimeId or slot.key != key).append({ runtimeId: runtimeId, key: key, layers: layers })
pure def canInitializeSetting(s: RuntimeSettings, runtimeId: str, key: str, layers: SettingLayers): bool = not(hasSetting(s, runtimeId, key))
pure def initializeSetting(s: RuntimeSettings, runtimeId: str, key: str, layers: SettingLayers): RuntimeSettings =
  { ...s, slots: replaceSetting(s, runtimeId, key, if (s.linkedRuntimes.contains(runtimeId)) linkedSecretContainers(layers) else { ...layers, nestedAliasesSecret: false }) }
pure def canSetSetting(s: RuntimeSettings, runtimeId: str, key: str, value: Value, secret: bool): bool = writable(value)
pure def setSetting(s: RuntimeSettings, runtimeId: str, key: str, value: Value, secret: bool): RuntimeSettings =
  { ...s, slots: replaceSetting(s, runtimeId, key, updated(settingAt(s, runtimeId, key), value, secret)) }
pure def linkSecrets(s: RuntimeSettings, runtimeId: str): RuntimeSettings =
  { slots: s.slots.listMap(slot => if (slot.runtimeId == runtimeId) { ...slot, layers: linkedSecretContainers(slot.layers) } else slot), linkedRuntimes: s.linkedRuntimes.union(Set(runtimeId)) }
pure val runtimeIdValues = Set("first", "second")
pure val keyValues = Set("TOKEN", "URL")
pure def alwaysUniqueSettingPairs(s: RuntimeSettings): bool = s.slots.every(slot => s.slots.select(other => other.runtimeId == slot.runtimeId and other.key == slot.key).length() == 1)
pure def alwaysLinkedSecretContainersAgree(s: RuntimeSettings): bool = s.slots.every(slot =>
  slot.layers.nestedAliasesSecret == s.linkedRuntimes.contains(slot.runtimeId) and (slot.layers.nestedAliasesSecret implies slot.layers.secret == slot.layers.nested))
pure def stepAtMostOneRuntimeChanges(before: RuntimeSettings, after: RuntimeSettings): bool =
  before.slots.every(left => before.slots.every(right => left.runtimeId != right.runtimeId implies
    settingAt(after, left.runtimeId, left.key) == left.layers or settingAt(after, right.runtimeId, right.key) == right.layers))
pure def stepExistingPairsRetained(before: RuntimeSettings, after: RuntimeSettings): bool = before.slots.every(slot => hasSetting(after, slot.runtimeId, slot.key))
pure def sometimesIndependentCredentials(s: RuntimeSettings): bool = s.slots.some(left => s.slots.some(right => left.runtimeId != right.runtimeId and not(isMissing(left.layers.secret)) and isMissing(right.layers.secret)))
pure def sometimesSecretCleared(s: RuntimeSettings): bool = s.slots.some(left => s.slots.some(right => left.runtimeId != right.runtimeId and isMissing(left.layers.secret) and isMissing(left.layers.constructorValue) and not(isMissing(right.layers.secret))))
pure def sometimesAliasedSecretUpdated(s: RuntimeSettings): bool = s.slots.some(slot => slot.layers.nestedAliasesSecret and not(isMissing(slot.layers.secret)) and slot.layers.nested == slot.layers.secret)
pure def sometimesTwoKeysOnOneRuntime(s: RuntimeSettings): bool = s.slots.some(left => s.slots.some(right => left.runtimeId == right.runtimeId and left.key != right.key))
```
