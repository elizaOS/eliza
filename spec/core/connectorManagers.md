# Connector manager registry and account policy

Source `connectors/account-manager.ts` resolves one manager per actual runtime object, with a separate standalone singleton. A registered compatible service takes precedence over the per-runtime cache. Supplying storage updates a native service or a cached or newly constructed manager; a duck-compatible service is returned without applying that override. Each manager retains a stable storage facade and its own provider registry.

## Story: Resolve account providers through the correct manager

As a host, I want account/provider registration scoped to my runtime and an explicit storage override retained by that manager.

### A runtime cache preserves its manager while a compatible registered service takes precedence

Runtime keys represent object identities. The empty key represents the standalone singleton, which does not inspect a runtime service. A native registered manager takes precedence and receives supplied storage. A duck-compatible service also takes precedence, but bypasses storage mutation. Neither service branch populates or replaces the runtime cache; when that service disappears, an existing cached manager remains available.

Runtime bindings and native objects are maps, so each runtime and each object identity has one binding by construction. Separate key sets permit finite iteration in Quint; they are the authoritative modeled domains, and unused backing-map entries outside those domains are inert. Cache bindings and native object state have different owners: bindings associate a runtime with a manager identity, while each native object embeds exactly one [backend cache](./connectorBackends.md). That cache remains the sole owner of explicit storage, facade identity, adapter memoization, fallback and warning state. Selecting an alias updates that same embedded object with `setExplicit`, without reconstructing its facade or other backend state. A first-seen external native service supplies its observed backend snapshot; absence of a known object never asserts that foreign storage is absent. Duck-compatible services need no native backend state.

Manager and provider references are process-local object identities. The allocator is a verification device: observed external service, provider-owner and provider-object references are reserved before fresh construction, so a later model allocation cannot collide with them. It does not assign numeric ids in the source runtime. Backend-cache allocation references and storage references retain their own owner's identity domains. Provider ids are trimmed and lowercased at the boundary. Registering the same provider replaces that manager's normalized provider object at its existing insertion position; new provider ids append. The reference denotes the normalized object retained by the source, not the caller's original input object. Public `listProviders` sorts these values with `provider.localeCompare`, whose locale ordering is a host adapter contract, rather than returning insertion order. Unregistering it leaves other managers untouched. Service classification, object identity, supplied native snapshots and storage truthiness are host observations requiring source conformance. A repeated native observation reuses retained state; it cannot reset an existing object from a new snapshot.

```quint
import connectorBackends as B from "./connectorBackends"
type RegisteredManagerService = NoManagerService | NativeManagerService({ id: int, backend: B::BackendCache }) | CompatibleManagerService({ id: int })
type StorageOverrideInput = NoStorageOverride | SuppliedStorage({ reference: int })
type ProviderRecord = { manager: int, provider: str, reference: int }
type ConnectorManagers = { nextId: int, runtimes: Set[str], managers: str -> int, nativeIdentities: Set[int], nativeObjects: int -> B::BackendCache, providers: List[ProviderRecord], selected: int }
pure val initial: ConnectorManagers = { nextId: 1, runtimes: Set(), managers: Map(), nativeIdentities: Set(), nativeObjects: Map(), providers: List(), selected: 0 }
pure def serviceIdentity(service: RegisteredManagerService): int = match service { | NativeManagerService(native) => native.id | CompatibleManagerService(compatible) => compatible.id | _ => 0 }
pure def compatibleService(service: RegisteredManagerService): bool = match service { | CompatibleManagerService(compatible) => true | _ => false }
pure def serviceBackend(service: RegisteredManagerService): B::BackendCache = match service { | NativeManagerService(native) => native.backend | _ => B::initial }
pure def suppliedStorage(storage: StorageOverrideInput): int = match storage { | SuppliedStorage(supplied) => supplied.reference | _ => 0 }
pure def validService(service: RegisteredManagerService): bool = match service { | NoManagerService => true | NativeManagerService(native) => native.id > 0 and B::alwaysAllocatedIdentitiesAreValid(native.backend) | CompatibleManagerService(compatible) => compatible.id > 0 }
pure def validStorage(storage: StorageOverrideInput): bool = match storage { | NoStorageOverride => true | SuppliedStorage(supplied) => supplied.reference > 0 }
pure def canResolveManager(s: ConnectorManagers, runtime: str, service: RegisteredManagerService, storage: StorageOverrideInput): bool = validService(service) and validStorage(storage)
pure def resolveManager(s: ConnectorManagers, runtime: str, service: RegisteredManagerService, storage: StorageOverrideInput): ConnectorManagers = {
  val hasCached = s.runtimes.contains(runtime)
  val hasService = runtime != "" and serviceIdentity(service) > 0
  val selected = if (hasService) serviceIdentity(service) else if (hasCached) s.managers.getOr(runtime, 0) else s.nextId
  val creates = not(hasService) and not(hasCached)
  val nativeSelected = not(hasService and compatibleService(service))
  val known = s.nativeIdentities.contains(selected)
  val backend = if (known) s.nativeObjects.getOr(selected, B::initial) else if (hasService) serviceBackend(service) else B::initial
  val updated = if (suppliedStorage(storage) != 0) B::setExplicit(backend, suppliedStorage(storage)) else backend
  { ...s, selected: selected, nextId: if (selected >= s.nextId) selected + 1 else s.nextId, runtimes: if (creates) s.runtimes.union(Set(runtime)) else s.runtimes, managers: if (creates) s.managers.put(runtime, selected) else s.managers, nativeIdentities: if (nativeSelected) s.nativeIdentities.union(Set(selected)) else s.nativeIdentities, nativeObjects: if (nativeSelected) s.nativeObjects.put(selected, updated) else s.nativeObjects }
}
pure def hasStorageOverride(s: ConnectorManagers, manager: int, storageReference: int): bool = s.nativeIdentities.contains(manager) and s.nativeObjects.getOr(manager, B::initial).explicit == storageReference
pure def canRegisterProvider(s: ConnectorManagers, manager: int, provider: str, reference: int): bool = manager > 0 and provider != "" and reference > 0
pure def registerProvider(s: ConnectorManagers, manager: int, provider: str, reference: int): ConnectorManagers = { ...s, nextId: if (manager >= s.nextId and manager >= reference) manager + 1 else if (reference >= s.nextId) reference + 1 else s.nextId, providers: if (s.providers.some(entry => entry.manager == manager and entry.provider == provider)) s.providers.listMap(entry => if (entry.manager == manager and entry.provider == provider) { ...entry, reference: reference } else entry) else s.providers.append({ manager: manager, provider: provider, reference: reference }) }
pure def unregisterProvider(s: ConnectorManagers, manager: int, provider: str): ConnectorManagers = { ...s, providers: s.providers.select(entry => entry.manager != manager or entry.provider != provider) }
pure def alwaysOneCachedManagerPerRuntime(s: ConnectorManagers): bool = s.runtimes.forall(runtime => s.managers.keys().contains(runtime) and s.managers.getOr(runtime, 0) > 0)
pure def alwaysOneNativeObjectPerIdentity(s: ConnectorManagers): bool = s.nativeIdentities.forall(identity => s.nativeObjects.keys().contains(identity) and B::alwaysAllocatedIdentitiesAreValid(s.nativeObjects.getOr(identity, B::initial))) and s.runtimes.forall(runtime => s.nativeIdentities.contains(s.managers.getOr(runtime, 0)))
pure def alwaysOneProviderPerManager(s: ConnectorManagers): bool = s.providers.every(entry => s.providers.select(other => other.manager == entry.manager and other.provider == entry.provider).length() == 1)
pure def alwaysFreshReferencesReserved(s: ConnectorManagers): bool = s.nextId > 0 and s.selected >= 0 and s.selected < s.nextId and s.runtimes.forall(runtime => s.managers.getOr(runtime, 0) < s.nextId) and s.nativeIdentities.forall(identity => identity > 0 and identity < s.nextId) and s.providers.every(entry => entry.manager > 0 and entry.manager < s.nextId and entry.reference > 0 and entry.reference < s.nextId)
pure def lawNativeServiceStorage(s: ConnectorManagers, runtime: str, identity: int, backend: B::BackendCache, storageReference: int): bool = runtime != "" and identity > 0 and storageReference > 0 implies hasStorageOverride(resolveManager(s, runtime, NativeManagerService({ id: identity, backend: backend }), SuppliedStorage({ reference: storageReference })), identity, storageReference)
pure def lawServiceDoesNotReplaceCache(s: ConnectorManagers, runtime: str, service: RegisteredManagerService, storage: StorageOverrideInput): bool = runtime != "" and serviceIdentity(service) > 0 implies resolveManager(s, runtime, service, storage).managers == s.managers
pure def lawCompatibleServiceBypassesStorage(s: ConnectorManagers, runtime: str, identity: int, storage: StorageOverrideInput): bool = runtime != "" and identity > 0 implies resolveManager(s, runtime, CompatibleManagerService({ id: identity }), storage).nativeObjects == s.nativeObjects
pure def sameResolution(left: ConnectorManagers, right: ConnectorManagers): bool = left.nextId == right.nextId and left.selected == right.selected and left.managers == right.managers and left.nativeObjects == right.nativeObjects and left.providers == right.providers and left.runtimes.subseteq(right.runtimes) and right.runtimes.subseteq(left.runtimes) and left.nativeIdentities.subseteq(right.nativeIdentities) and right.nativeIdentities.subseteq(left.nativeIdentities)
pure def lawStandaloneIgnoresService(s: ConnectorManagers, service: RegisteredManagerService, storage: StorageOverrideInput): bool = sameResolution(resolveManager(s, "", service, storage), resolveManager(s, "", NoManagerService, storage))
pure def lawOtherManagerStoragePreserved(s: ConnectorManagers, runtime: str, service: RegisteredManagerService, storage: StorageOverrideInput, manager: int, priorReference: int): bool = {
  val resolved = resolveManager(s, runtime, service, storage)
  manager != resolved.selected and hasStorageOverride(s, manager, priorReference) implies hasStorageOverride(resolved, manager, priorReference)
}
pure def lawAbsentStoragePreservesKnownObjects(s: ConnectorManagers, runtime: str, service: RegisteredManagerService): bool = {
  val resolved = resolveManager(s, runtime, service, NoStorageOverride)
  s.nativeIdentities.forall(identity => resolved.nativeIdentities.contains(identity) and resolved.nativeObjects.getOr(identity, B::initial) == s.nativeObjects.getOr(identity, B::initial))
}
pure def retainedBackendFields(prior: B::BackendCache, later: B::BackendCache): bool = later.facade == prior.facade and later.fallback == prior.fallback and later.database == prior.database and later.warnedFallback == prior.warnedFallback
pure def lawNativeBackendStateRetained(s: ConnectorManagers, runtime: str, service: RegisteredManagerService, storage: StorageOverrideInput): bool = {
  val resolved = resolveManager(s, runtime, service, storage)
  s.nativeIdentities.forall(identity => resolved.nativeIdentities.contains(identity) and retainedBackendFields(s.nativeObjects.getOr(identity, B::initial), resolved.nativeObjects.getOr(identity, B::initial)))
}
pure def lawProviderReplacementKeepsPosition(s: ConnectorManagers, manager: int, provider: str, reference: int): bool = {
  val registered = registerProvider(s, manager, provider, reference)
  s.providers.some(entry => entry.manager == manager and entry.provider == provider) implies registered.providers.listMap(entry => entry.manager) == s.providers.listMap(entry => entry.manager) and registered.providers.listMap(entry => entry.provider) == s.providers.listMap(entry => entry.provider)
}
pure def sometimesIndependentManagers(s: ConnectorManagers): bool = s.runtimes.size() > 1
pure def sometimesProviderAvailable(s: ConnectorManagers): bool = s.providers.length() > 0
pure def sometimesUncachedNativeOverride(s: ConnectorManagers): bool = s.nativeIdentities.exists(identity => s.nativeObjects.getOr(identity, B::initial).explicit > 0 and not(s.runtimes.exists(runtime => s.managers.getOr(runtime, 0) == identity)))
pure val serviceValues = Set(NoManagerService, NativeManagerService({ id: 0, backend: B::initial }), NativeManagerService({ id: 2, backend: B::initial }), CompatibleManagerService({ id: 3 }))
pure val storageValues = Set(NoStorageOverride, SuppliedStorage({ reference: 0 }), SuppliedStorage({ reference: 30 }))
pure val backendValues = Set(B::initial)
```
