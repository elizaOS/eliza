# Connector manager registry

Source `connectors/account-manager.ts` resolves one manager per actual runtime object, with a separate standalone singleton. A registered native or duck-compatible service takes precedence over the per-runtime cache. Supplying storage updates a native service or a cached or newly constructed manager; a duck-compatible service is returned without that override. Each manager retains a stable storage facade and its own provider registry. Account status and policy decisions are [account values](./accountValues.md).

## Story: Resolve account providers through the correct manager

> As a host, I want account providers resolved through my runtime's own
> manager, so that another runtime's registration or storage never answers
> for mine.

### A runtime cache preserves its manager while a compatible registered service takes precedence

Runtime keys represent object identities. The empty key represents the standalone singleton, which does not inspect a runtime service. A native registered manager (an object that is `instanceof ConnectorAccountManager`) takes precedence and receives supplied storage. A duck-compatible service (one with `registerProvider` and `evaluatePolicy`) also takes precedence, but it is returned without the storage override. Neither service branch adds or replaces a cache binding of a runtime to a manager identity, so an existing cached manager stays available after the service disappears. `resolveRegisteredManager` takes the kind of the registered service, for a native service the state that object holds, and the reference of the supplied storage object; a reference is positive exactly when storage is supplied. That storage is written into the object's own [backend cache](./connectorHandoff.md) as its explicit storage, like `setStorage`, which the backend resolution reads first, and its name is kept beside it. `resolveManager` names the service by identity only and takes the kind and state the registry already knows for that identity, or a native object with no storage and an unused backend; it gives supplied storage the reference 1. Manager identities are fresh process-local references, and provider ids are trimmed and lowercased at the boundary. Registering the same provider replaces that manager's provider object. Unregistering it leaves other managers untouched.

```quint
import connectorHandoff as H from "./connectorHandoff"
type ManagerRecord = { runtime: str, id: int, storage: str }
type ProviderRecord = { manager: int, provider: str, reference: int }
type NativeManager = { storage: str, backend: H::BackendCache }
type RegisteredManagerService = NoManagerService | NativeManagerService({ id: int, manager: NativeManager }) | CompatibleManagerService({ id: int })
type ConnectorManagers = { nextId: int, managers: List[ManagerRecord], providers: List[ProviderRecord], selected: int, nativeIdentities: Set[int], nativeObjects: int -> NativeManager, compatibleIdentities: Set[int] }
pure val initial: ConnectorManagers = { nextId: 1, managers: List(), providers: List(), selected: 0, nativeIdentities: Set(), nativeObjects: Map(), compatibleIdentities: Set() }
pure val unusedManager: NativeManager = { storage: "", backend: H::initialBackends }
pure def serviceIdentity(service: RegisteredManagerService): int = match service { | NativeManagerService(native) => native.id | CompatibleManagerService(compatible) => compatible.id | _ => 0 }
pure def compatibleService(service: RegisteredManagerService): bool = match service { | CompatibleManagerService(compatible) => true | _ => false }
pure def nativeService(service: RegisteredManagerService): bool = match service { | NativeManagerService(native) => true | _ => false }
pure def serviceManager(service: RegisteredManagerService): NativeManager = match service { | NativeManagerService(native) => native.manager | _ => unusedManager }
pure def canResolveRegisteredManager(s: ConnectorManagers, runtime: str, service: RegisteredManagerService, storage: str, storageReference: int): bool = (storage != "") == (storageReference > 0) and (serviceManager(service).storage != "") == (serviceManager(service).backend.explicit != 0) and not(runtime != "" and compatibleService(service) and s.nativeIdentities.contains(serviceIdentity(service))) and not(runtime != "" and nativeService(service) and s.compatibleIdentities.contains(serviceIdentity(service)))
pure def resolveRegisteredManager(s: ConnectorManagers, runtime: str, service: RegisteredManagerService, storage: str, storageReference: int): ConnectorManagers = {
  val cached = s.managers.select(manager => manager.runtime == runtime)
  val hasService = runtime != "" and serviceIdentity(service) > 0
  val selected = if (hasService) serviceIdentity(service) else if (cached.length() > 0) cached.nthOr(0, { runtime: runtime, id: 0, storage: "" }).id else s.nextId
  val creates = not(hasService) and cached.length() == 0
  val nativeSelected = not(hasService and compatibleService(service))
  val prior = if (s.nativeIdentities.contains(selected)) s.nativeObjects.getOr(selected, unusedManager) else if (hasService) serviceManager(service) else unusedManager
  val updated = if (storage != "") { ...prior, storage: storage, backend: { ...prior.backend, explicit: storageReference } } else prior
  { ...s, selected: selected, nextId: if (selected >= s.nextId) selected + 1 else s.nextId, managers: if (creates) s.managers.append({ runtime: runtime, id: selected, storage: storage }) else if (storage != "" and nativeSelected) s.managers.listMap(manager => if (manager.id == selected) { ...manager, storage: storage } else manager) else s.managers, nativeIdentities: if (nativeSelected) s.nativeIdentities.union(Set(selected)) else s.nativeIdentities, nativeObjects: if (nativeSelected) s.nativeObjects.put(selected, updated) else s.nativeObjects, compatibleIdentities: if (nativeSelected) s.compatibleIdentities else s.compatibleIdentities.union(Set(selected)) }
}
pure def knownService(s: ConnectorManagers, serviceId: int): RegisteredManagerService = if (serviceId <= 0) NoManagerService else if (s.compatibleIdentities.contains(serviceId)) CompatibleManagerService({ id: serviceId }) else NativeManagerService({ id: serviceId, manager: if (s.nativeIdentities.contains(serviceId)) s.nativeObjects.getOr(serviceId, unusedManager) else unusedManager })
pure def resolveManager(s: ConnectorManagers, runtime: str, serviceId: int, storage: str): ConnectorManagers = resolveRegisteredManager(s, runtime, knownService(s, serviceId), storage, if (storage != "") 1 else 0)
pure def canRegisterProvider(s: ConnectorManagers, manager: int, provider: str, reference: int): bool = manager > 0 and provider != "" and reference > 0
pure def registerProvider(s: ConnectorManagers, manager: int, provider: str, reference: int): ConnectorManagers = { ...s, providers: if (s.providers.some(entry => entry.manager == manager and entry.provider == provider)) s.providers.listMap(entry => if (entry.manager == manager and entry.provider == provider) { ...entry, reference: reference } else entry) else s.providers.append({ manager: manager, provider: provider, reference: reference }) }
pure def unregisterProvider(s: ConnectorManagers, manager: int, provider: str): ConnectorManagers = { ...s, providers: s.providers.select(entry => entry.manager != manager or entry.provider != provider) }
pure def alwaysOneCachedManagerPerRuntime(s: ConnectorManagers): bool = s.managers.every(manager => s.managers.select(other => manager.runtime == other.runtime).length() == 1)
pure def alwaysOneProviderPerManager(s: ConnectorManagers): bool = s.providers.every(entry => s.providers.select(other => other.manager == entry.manager and other.provider == entry.provider).length() == 1)
pure def lawNativeServiceStorage(s: ConnectorManagers, runtime: str, identity: int, snapshot: NativeManager, storage: str, storageReference: int): bool = {
  val resolved = resolveRegisteredManager(s, runtime, NativeManagerService({ id: identity, manager: snapshot }), storage, storageReference)
  val object = resolved.nativeObjects.getOr(identity, unusedManager)
  runtime != "" and identity > 0 and storage != "" and storageReference > 0 implies resolved.selected == identity and resolved.nativeIdentities.contains(identity) and object.storage == storage and object.backend.explicit == storageReference and H::selectedKind(object.backend, 0, 0) == H::ServiceBackend
}
pure def lawCompatibleServiceBypassesStorage(s: ConnectorManagers, runtime: str, identity: int, storage: str, storageReference: int): bool = {
  val resolved = resolveRegisteredManager(s, runtime, CompatibleManagerService({ id: identity }), storage, storageReference)
  runtime != "" and identity > 0 implies resolved.selected == identity and resolved.nativeObjects == s.nativeObjects and resolved.managers == s.managers
}
pure def lawServiceDoesNotReplaceCache(s: ConnectorManagers, runtime: str, service: RegisteredManagerService, storage: str, storageReference: int): bool = {
  val resolved = resolveRegisteredManager(s, runtime, service, storage, storageReference)
  runtime != "" and serviceIdentity(service) > 0 implies resolved.managers.listMap(manager => manager.runtime) == s.managers.listMap(manager => manager.runtime) and resolved.managers.listMap(manager => manager.id) == s.managers.listMap(manager => manager.id)
}
pure def sameResolution(left: ConnectorManagers, right: ConnectorManagers): bool = left.nextId == right.nextId and left.selected == right.selected and left.managers == right.managers and left.providers == right.providers and left.nativeObjects == right.nativeObjects and left.nativeIdentities.subseteq(right.nativeIdentities) and right.nativeIdentities.subseteq(left.nativeIdentities) and left.compatibleIdentities.subseteq(right.compatibleIdentities) and right.compatibleIdentities.subseteq(left.compatibleIdentities)
pure def lawStandaloneIgnoresService(s: ConnectorManagers, service: RegisteredManagerService, storage: str, storageReference: int): bool = sameResolution(resolveRegisteredManager(s, "", service, storage, storageReference), resolveRegisteredManager(s, "", NoManagerService, storage, storageReference))
pure def sometimesIndependentManagers(s: ConnectorManagers): bool = s.managers.length() > 1
pure def sometimesProviderAvailable(s: ConnectorManagers): bool = s.providers.length() > 0
pure def sometimesCompatibleServiceBesideCachedManager(s: ConnectorManagers): bool = s.compatibleIdentities.contains(s.selected) and s.managers.length() > 0
pure val heldBackend: H::BackendCache = { ...H::initialBackends, serial: 3, facade: 1, fallback: 2, warnedFallback: true }
pure val serviceValues = Set(NoManagerService, NativeManagerService({ id: 0, manager: unusedManager }), NativeManagerService({ id: 2, manager: unusedManager }), NativeManagerService({ id: 3, manager: { storage: "", backend: heldBackend } }), CompatibleManagerService({ id: 3 }), CompatibleManagerService({ id: 4 }))
pure val snapshotValues = Set(unusedManager, { storage: "", backend: heldBackend })
pure val managerValues = Set(0, 1, 2)
pure val referenceValues = Set(0, 1, 2)
pure val storageReferenceValues = Set(0, 1, 2)
```

### A registered service object is never both a native manager and a duck-compatible service

The source decides the kind of a registered service with `instanceof ConnectorAccountManager` before the duck-type test, and it never changes the prototype of an object, so one object identity always takes the same branch. Managers that the source constructs are native. Each identity observed as duck-compatible is therefore positive, below the next fresh reference, and never a known native identity.

```quint
pure def alwaysServiceKindsDisjoint(s: ConnectorManagers): bool = s.compatibleIdentities.forall(identity => identity > 0 and identity < s.nextId and not(s.nativeIdentities.contains(identity)))
```

### Supplying storage changes only the selected manager and keeps its backend state

Every cached manager is a native object, and its cache record names the same explicit storage as that object. Each native manager owns one [backend cache](./connectorHandoff.md), and that cache holds an explicit storage reference exactly when the manager has explicit storage. Selecting a manager with storage applies `setStorage` to that same object: only the explicit storage of its backend cache changes, its facade, fallback, database wrapper and fallback warning stay as they were, and no other manager's object changes. Without storage, no known object changes.

```quint
pure def alwaysCachedManagersAreNative(s: ConnectorManagers): bool = s.nextId > 0 and s.nativeIdentities.forall(identity => identity > 0 and identity < s.nextId and s.nativeObjects.keys().contains(identity)) and s.managers.every(manager => s.nativeIdentities.contains(manager.id) and s.nativeObjects.getOr(manager.id, unusedManager).storage == manager.storage)
pure def alwaysNativeStorageInBackend(s: ConnectorManagers): bool = s.nativeIdentities.forall(identity => (s.nativeObjects.getOr(identity, unusedManager).storage != "") == (s.nativeObjects.getOr(identity, unusedManager).backend.explicit != 0))
pure def lawOtherManagerStoragePreserved(s: ConnectorManagers, runtime: str, service: RegisteredManagerService, storage: str, storageReference: int, identity: int): bool = {
  val resolved = resolveRegisteredManager(s, runtime, service, storage, storageReference)
  identity != resolved.selected and s.nativeIdentities.contains(identity) implies resolved.nativeIdentities.contains(identity) and resolved.nativeObjects.getOr(identity, unusedManager) == s.nativeObjects.getOr(identity, unusedManager)
}
pure def lawAbsentStoragePreservesKnownObjects(s: ConnectorManagers, runtime: str, service: RegisteredManagerService): bool = {
  val resolved = resolveRegisteredManager(s, runtime, service, "", 0)
  s.nativeIdentities.forall(identity => resolved.nativeIdentities.contains(identity) and resolved.nativeObjects.getOr(identity, unusedManager) == s.nativeObjects.getOr(identity, unusedManager))
}
pure def retainedBackendFields(prior: H::BackendCache, later: H::BackendCache): bool = later.facade == prior.facade and later.fallback == prior.fallback and later.database == prior.database and later.warnedFallback == prior.warnedFallback
pure def lawNativeBackendStateRetained(s: ConnectorManagers, runtime: str, service: RegisteredManagerService, storage: str, storageReference: int): bool = {
  val resolved = resolveRegisteredManager(s, runtime, service, storage, storageReference)
  s.nativeIdentities.forall(identity => resolved.nativeIdentities.contains(identity) and retainedBackendFields(s.nativeObjects.getOr(identity, unusedManager).backend, resolved.nativeObjects.getOr(identity, unusedManager).backend))
}
pure def sometimesUncachedNativeOverride(s: ConnectorManagers): bool = s.nativeIdentities.exists(identity => s.nativeObjects.getOr(identity, unusedManager).storage != "" and not(s.managers.some(manager => manager.id == identity)))
```

### Registering a known provider id keeps its position and a new provider id appends

The registry is a `Map` keyed by the normalized provider id, and `Map.set` on a key it holds replaces the value in place. So registering a provider id the manager already holds replaces its object at its existing position, and a new id goes to the end. `listProviders` does not return this order: it sorts the providers by id with the host's `localeCompare`, which this model leaves out.

```quint
pure def providerHeld(s: ConnectorManagers, manager: int, provider: str): bool = s.providers.some(entry => entry.manager == manager and entry.provider == provider)
pure def lawProviderReplacementKeepsPosition(s: ConnectorManagers, manager: int, provider: str, reference: int): bool = {
  val registered = registerProvider(s, manager, provider, reference)
  providerHeld(s, manager, provider) implies registered.providers.listMap(entry => entry.manager) == s.providers.listMap(entry => entry.manager) and registered.providers.listMap(entry => entry.provider) == s.providers.listMap(entry => entry.provider) and registered.providers.includes({ manager: manager, provider: provider, reference: reference })
}
pure def lawNewProviderAppends(s: ConnectorManagers, manager: int, provider: str, reference: int): bool = not(providerHeld(s, manager, provider)) implies registerProvider(s, manager, provider, reference).providers == s.providers.append({ manager: manager, provider: provider, reference: reference })
```
