# Process environment cache

The source is `packages/core/src/utils/environment.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. This is an explicitly
process-scoped host utility. Ordinary per-agent `getSetting` remains
independent of it. The singleton and separately created `Environment`
instances use the same cache semantics with their own cache contents.

## Story: Cache environment reads with explicit invalidation

As a host, I can cache a present or absent raw environment value. A direct
process-environment change leaves a cached value intact until invalidation.
The provided setter invalidates that key before writing. Clearing the cache
rereads the current process environment on the next access.

### An absent cached value uses each call's own default

The default is never stored as the raw cached value. Raw empty strings are
present values for `Environment.get`; the separate `readEnv` utility applies
trim-and-empty normalization afterward.

```quint
type EnvValue = AbsentValue | PresentValue({ text: str })
pure val absentEnvironment: EnvValue = AbsentValue
type EnvEntry = { key: str, value: EnvValue }
type Environment = { processValues: List[EnvEntry], cachedValues: List[EnvEntry] }
type EnvObservation = ReadValue({ key: str, value: EnvValue })
type EnvRead = { state: Environment, out: List[EnvObservation] }
pure val initial: Environment = { processValues: List(), cachedValues: List() }
pure def containsKey(entries: List[EnvEntry], key: str): bool = entries.some(entry => entry.key == key)
pure def valueAt(entries: List[EnvEntry], key: str): EnvValue = entries.select(entry => entry.key == key).nthOr(0, { key: key, value: absentEnvironment }).value
pure def absentValue(value: EnvValue): bool = match value { | AbsentValue => true | _ => false }
pure def fallback(value: EnvValue, defaultValue: EnvValue): EnvValue = if (absentValue(value)) defaultValue else value
pure def readEnvironment(s: Environment, key: str, defaultValue: EnvValue): EnvRead = {
  val value = if (containsKey(s.cachedValues, key)) valueAt(s.cachedValues, key) else valueAt(s.processValues, key)
  { state: if (containsKey(s.cachedValues, key)) s else { ...s, cachedValues: s.cachedValues.append({ key: key, value: value }) }, out: List(ReadValue({ key: key, value: fallback(value, defaultValue) })) }
}
pure def setEnvironment(s: Environment, key: str, text: str): Environment = { processValues: s.processValues.select(entry => entry.key != key).append({ key: key, value: PresentValue({ text: text }) }), cachedValues: s.cachedValues.select(entry => entry.key != key) }
pure def externalEnvironmentChange(s: Environment, key: str, value: EnvValue): Environment = { ...s, processValues: s.processValues.select(entry => entry.key != key).append({ key: key, value: value }) }
pure def clearEnvironmentCache(s: Environment): Environment = { ...s, cachedValues: List() }
pure val valueValues = Set(AbsentValue, PresentValue({ text: "" }), PresentValue({ text: "first" }), PresentValue({ text: "second" }))
pure val defaultValueValues = valueValues
pure val entriesValues = Set(List(), List({ key: "key", value: absentEnvironment }), List({ key: "key", value: PresentValue({ text: "first" }) }))
pure def alwaysKeysAreUnique(s: Environment): bool = s.processValues.every(entry => s.processValues.select(other => other.key == entry.key).length() == 1) and s.cachedValues.every(entry => s.cachedValues.select(other => other.key == entry.key).length() == 1)
pure def stepExternalWriteLeavesCacheIntact(before: Environment, via: str, after: Environment, out: List[EnvObservation]): bool = via == "externalEnvironmentChange" implies after.cachedValues == before.cachedValues
pure def sometimesAbsenceIsCached(s: Environment): bool = s.cachedValues.some(entry => absentValue(entry.value))
pure def sometimesCachedValueIsStale(s: Environment): bool = s.cachedValues.some(entry => entry.value != valueAt(s.processValues, entry.key))
```
