# Sensitive-request delivery adapter registry

The source is `packages/core/src/sensitive-request-dispatch.ts:103-190` at the pinned baseline. A runtime service owns a map from delivery target to an insertion-ordered adapter array. Adapter object identities are distinct from equal serialized fields. `register` is idempotent only for the same object in the same target. This internal connector registration API grants no delivery success or user authority.

## Story: Resolve the correct connector while retaining registration order

The default getter returns the latest adapter for a target. Channel resolution checks that target's adapters from oldest to newest and takes the first optional support callback which does not return false. If every callback returns false, it deliberately falls back to the latest adapter. A callback exception escapes resolution. Unregister removes the entire target; registering it again appends it after surviving target groups.

### Per-target identity and callback order determine resolution

```quint
type DeliveryTarget = Dm | OwnerAppInline | OwnerAppOauth | CloudAuthenticatedLink | TunnelAuthenticatedLink | PublicLink | InstructDmOnly
type Adapter = { objectId: int, hasSupports: bool }
type AdapterGroup = { target: DeliveryTarget, adapters: List[Adapter] }
type AdapterRegistry = { groups: List[AdapterGroup] }
type AdapterResolution = { chosen: int, failed: bool }
pure val initial: AdapterRegistry = { groups: List() }
pure val targetValues = Set(Dm, OwnerAppInline, OwnerAppOauth, CloudAuthenticatedLink, TunnelAuthenticatedLink, PublicLink, InstructDmOnly)
pure val adapterValues = Set({ objectId: 1, hasSupports: false }, { objectId: 2, hasSupports: true }, { objectId: 3, hasSupports: true })
pure val supportsValues = Set(Set(), Set(1), Set(2), Set(3))
pure val throwsValues = Set(Set(), Set(2), Set(3))
pure def adaptersFor(r: AdapterRegistry, target: DeliveryTarget): List[Adapter] = r.groups.select(group => group.target == target).nthOr(0, { target: target, adapters: List() }).adapters
pure def canRegister(r: AdapterRegistry, target: DeliveryTarget, adapter: Adapter): bool = adapter.objectId > 0
pure def register(r: AdapterRegistry, target: DeliveryTarget, adapter: Adapter): AdapterRegistry = {
  val entries = adaptersFor(r, target)
  if (entries.some(existing => existing.objectId == adapter.objectId)) r
  else if (r.groups.some(group => group.target == target)) { groups: r.groups.listMap(group => if (group.target == target) { ...group, adapters: group.adapters.append(adapter) } else group) }
  else { groups: r.groups.append({ target: target, adapters: List(adapter) }) }
}
pure def unregister(r: AdapterRegistry, target: DeliveryTarget): AdapterRegistry = { groups: r.groups.select(group => group.target != target) }
pure def stop(r: AdapterRegistry): AdapterRegistry = initial
pure def newest(r: AdapterRegistry, target: DeliveryTarget): int = {
  val entries = adaptersFor(r, target)
  entries.nthOr(entries.length() - 1, { objectId: 0, hasSupports: false }).objectId
}
pure val noResolution: AdapterResolution = { chosen: 0, failed: false }
pure def chooseAdapter(supports: Set[int], throws: Set[int], resolved: AdapterResolution, adapter: Adapter): AdapterResolution = if (resolved.chosen != 0 or resolved.failed) resolved else if (adapter.hasSupports and throws.contains(adapter.objectId)) { chosen: 0, failed: true } else if (not(adapter.hasSupports) or supports.contains(adapter.objectId)) { chosen: adapter.objectId, failed: false } else resolved
pure def resolveAdapter(r: AdapterRegistry, target: DeliveryTarget, supports: Set[int], throws: Set[int]): AdapterResolution = {
  val result = adaptersFor(r, target).foldl(noResolution, (resolved, adapter) => chooseAdapter(supports, throws, resolved, adapter))
  if (result.chosen == 0 and not(result.failed)) { chosen: newest(r, target), failed: false } else result
}
pure def listed(r: AdapterRegistry): List[Adapter] = r.groups.foldl(List(), (entries, group) => entries.concat(group.adapters))
pure def alwaysTargetOrderIsUnique(r: AdapterRegistry): bool = r.groups.every(group => group.adapters.length() > 0 and r.groups.select(other => other.target == group.target).length() == 1)
pure def alwaysObjectRegistrationIsIdempotent(r: AdapterRegistry): bool = r.groups.every(group => group.adapters.every(adapter => adapter.objectId > 0 and group.adapters.select(other => other.objectId == adapter.objectId).length() == 1))
pure def lawResolvedAdapterIsRegistered(r: AdapterRegistry, target: DeliveryTarget, supports: Set[int], throws: Set[int]): bool = resolveAdapter(r, target, supports, throws).chosen == 0 or adaptersFor(r, target).some(adapter => adapter.objectId == resolveAdapter(r, target, supports, throws).chosen)
pure def lawAllRejectFallBackToLatest(r: AdapterRegistry, target: DeliveryTarget): bool = adaptersFor(r, target).every(adapter => adapter.hasSupports) implies resolveAdapter(r, target, Set(), Set()).chosen == newest(r, target)
pure def sometimesSeveralAdaptersShareTarget(r: AdapterRegistry): bool = r.groups.some(group => group.adapters.length() > 1)
```
