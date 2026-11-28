# Sensitive-request delivery adapter registry

The source is `sensitive-request-dispatch.ts`. A runtime service maps each delivery target to an insertion-ordered list of adapters. Targets are opaque names that hosts choose, such as a direct message or an authenticated link; core attaches no meaning to them. Adapter object identities are distinct from equal serialized fields. This internal connector registration API grants no delivery success or user authority.

## Story: Resolve the correct connector while retaining registration order

> As a connector host, I want target resolution to select the oldest adapter
> that supports the channel, or the latest registration when none does, so
> that selection stays predictable across registrations.

The default getter returns the latest adapter for a target. A callback exception escapes resolution.

### Each target holds one nonempty adapter list in registration order

Unregistering a target removes its whole list, and stopping removes every
list. Registering a target again appends it after the targets that remain.

```quint
type Adapter = { objectId: int, hasSupports: bool }
type AdapterGroup = { target: str, adapters: List[Adapter] }
type AdapterRegistry = { groups: List[AdapterGroup] }
type AdapterResolution = { chosen: int, failed: bool }
pure val initial: AdapterRegistry = { groups: List() }
pure val targetValues = Set("dm", "link")
pure val adapterValues = Set({ objectId: 1, hasSupports: false }, { objectId: 2, hasSupports: true }, { objectId: 3, hasSupports: true })
pure val supportsValues = Set(Set(), Set(1), Set(2), Set(3))
pure val throwsValues = Set(Set(), Set(2), Set(3))
pure def adaptersFor(r: AdapterRegistry, target: str): List[Adapter] = r.groups.select(group => group.target == target).nthOr(0, { target: target, adapters: List() }).adapters
pure def canRegister(r: AdapterRegistry, target: str, adapter: Adapter): bool = adapter.objectId > 0
pure def register(r: AdapterRegistry, target: str, adapter: Adapter): AdapterRegistry = {
  val entries = adaptersFor(r, target)
  if (entries.some(existing => existing.objectId == adapter.objectId)) r
  else if (r.groups.some(group => group.target == target)) { groups: r.groups.listMap(group => if (group.target == target) { ...group, adapters: group.adapters.append(adapter) } else group) }
  else { groups: r.groups.append({ target: target, adapters: List(adapter) }) }
}
pure def unregister(r: AdapterRegistry, target: str): AdapterRegistry = { groups: r.groups.select(group => group.target != target) }
pure def stop(r: AdapterRegistry): AdapterRegistry = initial
pure def listed(r: AdapterRegistry): List[Adapter] = r.groups.foldl(List(), (entries, group) => entries.concat(group.adapters))
pure def alwaysTargetOrderIsUnique(r: AdapterRegistry): bool = r.groups.every(group => group.adapters.length() > 0 and r.groups.select(other => other.target == group.target).length() == 1)
pure def sometimesSeveralAdaptersShareTarget(r: AdapterRegistry): bool = r.groups.some(group => group.adapters.length() > 1)
```

### Registering the same adapter twice for a target is a no-op

Registration is idempotent only for the same adapter object in the same
target; the same object may serve several targets.

```quint
pure def alwaysObjectRegistrationIsIdempotent(r: AdapterRegistry): bool = r.groups.every(group => group.adapters.every(adapter => adapter.objectId > 0 and group.adapters.select(other => other.objectId == adapter.objectId).length() == 1))
```

### Resolution takes the oldest supporting adapter and falls back to the newest

Resolution checks a target's adapters from oldest to newest and takes the
first whose optional support callback does not return false; an adapter
without a callback supports every channel. If every callback returns false,
it falls back to the newest adapter. A throwing callback fails resolution.

```quint
pure def newest(r: AdapterRegistry, target: str): int = {
  val entries = adaptersFor(r, target)
  entries.nthOr(entries.length() - 1, { objectId: 0, hasSupports: false }).objectId
}
pure val noResolution: AdapterResolution = { chosen: 0, failed: false }
pure def chooseAdapter(supports: Set[int], throws: Set[int], resolved: AdapterResolution, adapter: Adapter): AdapterResolution = if (resolved.chosen != 0 or resolved.failed) resolved else if (adapter.hasSupports and throws.contains(adapter.objectId)) { chosen: 0, failed: true } else if (not(adapter.hasSupports) or supports.contains(adapter.objectId)) { chosen: adapter.objectId, failed: false } else resolved
pure def resolveAdapter(r: AdapterRegistry, target: str, supports: Set[int], throws: Set[int]): AdapterResolution = {
  val result = adaptersFor(r, target).foldl(noResolution, (resolved, adapter) => chooseAdapter(supports, throws, resolved, adapter))
  if (result.chosen == 0 and not(result.failed)) { chosen: newest(r, target), failed: false } else result
}
pure def lawResolvedAdapterIsRegistered(r: AdapterRegistry, target: str, supports: Set[int], throws: Set[int]): bool = resolveAdapter(r, target, supports, throws).chosen == 0 or adaptersFor(r, target).some(adapter => adapter.objectId == resolveAdapter(r, target, supports, throws).chosen)
pure def lawAllRejectFallBackToLatest(r: AdapterRegistry, target: str): bool = adaptersFor(r, target).every(adapter => adapter.hasSupports) implies resolveAdapter(r, target, Set(), Set()).chosen == newest(r, target)
```
