# Process-wide trajectory source metadata

The source is `packages/core/src/trajectory-utils.ts:1763-1793` at the pinned baseline. The Symbol.for ambient singleton owns a process-wide source-name map, shared across runtime instances and module copies. Registration stores a copied metadata record and replaces an earlier record of the same trimmed name. The only current metadata field is `excludeFromTraining`. Unicode trimming and nonstring rejection are input normalization boundaries; names in this model are their normalized string values.

## Story: Apply the current registered training-exclusion policy

Empty or absent source names are not excluded. Unknown source names default to false. A valid registration can either enable or disable exclusion and applies to later reads from any runtime. Restarting one runtime does not reset this process-wide map. There is no unregister API. Discovered by the proof: a source is known by membership in the policy map; no separate name registry decides training policy.

### The latest copied metadata record determines exclusion

```quint
type TrajectorySources = { policies: str -> bool }
pure val initial: TrajectorySources = { policies: Map() }
pure val nameValues = Set("", "live-chat", "benchmark")
pure def register(s: TrajectorySources, name: str, excludeTraining: bool): TrajectorySources = if (name == "") s else { policies: s.policies.put(name, excludeTraining) }
pure def excluded(s: TrajectorySources, name: str): bool = name != "" and s.policies.getOr(name, false)
pure def alwaysEmptyNameHasNoMetadata(s: TrajectorySources): bool = not(s.policies.keys().contains(""))
pure def lawLatestRegistrationWins(s: TrajectorySources, name: str, excludeTraining: bool): bool = name == "" or excluded(register(s, name, excludeTraining), name) == excludeTraining
pure def lawUnknownSourceIsIncluded(s: TrajectorySources, name: str): bool = not(s.policies.keys().contains(name)) implies not(excluded(s, name))
pure def lawEmptySourceIsIncluded(s: TrajectorySources): bool = not(excluded(s, ""))
pure def sometimesBenchmarkIsExcluded(s: TrajectorySources): bool = excluded(s, "benchmark")
```
