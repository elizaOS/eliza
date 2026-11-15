# Process-wide trajectory source metadata

The source is `packages/core/src/trajectory-utils.ts:1763-1793` at the pinned baseline. The Symbol.for ambient singleton owns a process-wide source-name map, shared across runtime instances and module copies. Registration stores a copied metadata record and replaces an earlier record of the same trimmed name. The only metadata field is the export exclusion: trajectories recorded for an excluded source are never exported from the runtime. Unicode trimming and nonstring rejection are input normalization boundaries; names in this model are their normalized string values.

## Story: Apply the current registered export-exclusion policy

> As a runtime host, I want the latest exclusion registered for a trajectory
> source to decide whether its trajectories may leave the runtime, so that a
> source marked excluded is never exported.

Empty or absent source names are not excluded. Unknown source names default to false. A valid registration can either enable or disable exclusion and applies to later reads from any runtime. Restarting one runtime does not reset this process-wide map. There is no unregister API. Discovered by the proof: a source is known by membership in the policy map; no separate name registry decides the exclusion policy.

### The latest copied metadata record determines exclusion

```quint
type TrajectorySources = { policies: str -> bool }
pure val initial: TrajectorySources = { policies: Map() }
pure val nameValues = Set("", "live-chat", "synthetic")
pure def register(s: TrajectorySources, name: str, excludeExport: bool): TrajectorySources = if (name == "") s else { policies: s.policies.put(name, excludeExport) }
pure def excluded(s: TrajectorySources, name: str): bool = name != "" and s.policies.getOr(name, false)
pure def alwaysEmptyNameHasNoMetadata(s: TrajectorySources): bool = not(s.policies.keys().contains(""))
pure def lawLatestRegistrationWins(s: TrajectorySources, name: str, excludeExport: bool): bool = name == "" or excluded(register(s, name, excludeExport), name) == excludeExport
pure def lawUnknownSourceIsIncluded(s: TrajectorySources, name: str): bool = not(s.policies.keys().contains(name)) implies not(excluded(s, name))
pure def lawEmptySourceIsIncluded(s: TrajectorySources): bool = not(excluded(s, ""))
pure def sometimesSyntheticIsExcluded(s: TrajectorySources): bool = excluded(s, "synthetic")
```
