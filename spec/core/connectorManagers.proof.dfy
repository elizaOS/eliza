// Proofs of the connector manager registry.

// A cache with one manager per runtime is a manager list distinct by runtime.
lemma ManagersUnique(s: ConnectorManagers)
  ensures alwaysOneCachedManagerPerRuntime(s) <==> ProofLib.DistinctBy(s.managers, (m: ManagerRecord) => m.runtime)
{
  var key := (m: ManagerRecord) => m.runtime;
  forall i | 0 <= i < |s.managers|
    ensures |ProofLib.Filter((other: ManagerRecord) => (s.managers[i].runtime == other.runtime), s.managers)| == 1 <==> forall j :: 0 <= j < |s.managers| && j != i ==> key(s.managers[j]) != key(s.managers[i])
  {
    ProofLib.FilterCountOneIffUnique((other: ManagerRecord) => (s.managers[i].runtime == other.runtime), s.managers, key, i);
  }
}

// One provider object per manager and provider id is a provider list distinct by that pair.
lemma ProvidersUnique(s: ConnectorManagers)
  ensures alwaysOneProviderPerManager(s) <==> ProofLib.DistinctBy(s.providers, (e: ProviderRecord) => (e.manager, e.provider))
{
  var key := (e: ProviderRecord) => (e.manager, e.provider);
  forall i | 0 <= i < |s.providers|
    ensures |ProofLib.Filter((other: ProviderRecord) => ((other.manager == s.providers[i].manager) && (other.provider == s.providers[i].provider)), s.providers)| == 1 <==> forall j :: 0 <= j < |s.providers| && j != i ==> key(s.providers[j]) != key(s.providers[i])
  {
    ProofLib.FilterCountOneIffUnique((other: ProviderRecord) => ((other.manager == s.providers[i].manager) && (other.provider == s.providers[i].provider)), s.providers, key, i);
  }
}

// Removing one provider keeps the rest distinct and leaves no entry for it.
lemma ProvidersWithout(s: ConnectorManagers, manager: int, provider: string)
  requires alwaysOneProviderPerManager(s)
  ensures ProofLib.DistinctBy(unregisterProvider(s, manager, provider).providers, (e: ProviderRecord) => (e.manager, e.provider))
  ensures forall e :: e in unregisterProvider(s, manager, provider).providers ==> e.manager != manager || e.provider != provider
{
  var p := (entry: ProviderRecord) => ((entry.manager != manager) || (entry.provider != provider));
  ProvidersUnique(s);
  ProofLib.FilterKeepsDistinctBy(p, s.providers, (e: ProviderRecord) => (e.manager, e.provider));
  forall e | e in unregisterProvider(s, manager, provider).providers
    ensures e.manager != manager || e.provider != provider
  {
    ProofLib.FilterMember(p, s.providers, e);
  }
}

// The cached manager the resolver reads is a cached record of that runtime; with none, no record names the runtime.
lemma CachedLookup(s: ConnectorManagers, runtime: string)
  ensures |ProofLib.Filter((manager: ManagerRecord) => (manager.runtime == runtime), s.managers)| > 0 ==> ProofLib.Filter((manager: ManagerRecord) => (manager.runtime == runtime), s.managers)[0] in s.managers && ProofLib.Filter((manager: ManagerRecord) => (manager.runtime == runtime), s.managers)[0].runtime == runtime
  ensures |ProofLib.Filter((manager: ManagerRecord) => (manager.runtime == runtime), s.managers)| == 0 ==> forall i :: 0 <= i < |s.managers| ==> s.managers[i].runtime != runtime
{
  var p := (manager: ManagerRecord) => (manager.runtime == runtime);
  ProofLib.FilterNone(p, s.managers);
  if |ProofLib.Filter(p, s.managers)| > 0 {
    ProofLib.FilterSubset(p, s.managers);
    ProofLib.FilterMember(p, s.managers, ProofLib.Filter(p, s.managers)[0]);
  }
}

// Adding one identity to a set held as a list adds exactly that identity.
lemma SetAdd(xs: seq<int>, y: int)
  ensures forall x :: x in (xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [y])) <==> (x in xs || x == y)
{
  forall x
    ensures x in (xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [y])) <==> (x in xs || x == y)
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in xs)), [y], x);
  }
}

// What one resolution does: which identity it selects, which identities and objects it adds, and how the cache changes.
lemma ResolveShape(s: ConnectorManagers, runtime: string, service: RegisteredManagerService, storage: string, storageReference: int)
  requires inv(s)
  ensures var after := resolveRegisteredManager(s, runtime, service, storage, storageReference);
    var hasService := (runtime != "") && (serviceIdentity(service) > 0);
    var nativeSelected := !(hasService && compatibleService(service));
    var cached := ProofLib.Filter((manager: ManagerRecord) => (manager.runtime == runtime), s.managers);
    var creates := !hasService && |cached| == 0;
    var prior := if after.selected in s.nativeIdentities then lookup0_core__connectorManagers(s.nativeObjects, after.selected, unusedManager) else if hasService then serviceManager(service) else unusedManager;
    var updated := if storage != "" then prior.(storage := storage, backend := prior.backend.(explicit := storageReference)) else prior;
    && after.providers == s.providers
    && after.selected > 0
    && after.selected < after.nextId
    && after.nextId >= s.nextId
    && (hasService ==> after.selected == serviceIdentity(service))
    && (creates ==> after.selected == s.nextId && after.managers == s.managers + [ManagerRecord(runtime, s.nextId, storage)])
    && (!hasService && !creates ==> after.selected in s.nativeIdentities)
    && (!creates ==> |after.managers| == |s.managers|)
    && (!creates ==> forall i :: 0 <= i < |s.managers| ==> after.managers[i].runtime == s.managers[i].runtime && after.managers[i].id == s.managers[i].id)
    && (!creates ==> forall i :: 0 <= i < |s.managers| ==> after.managers[i].storage == (if storage != "" && nativeSelected && s.managers[i].id == after.selected then storage else s.managers[i].storage))
    && (forall x :: x in after.nativeIdentities <==> (x in s.nativeIdentities || (nativeSelected && x == after.selected)))
    && (forall x :: x in after.compatibleIdentities <==> (x in s.compatibleIdentities || (!nativeSelected && x == after.selected)))
    && (nativeSelected ==> after.nativeObjects == s.nativeObjects[after.selected := updated])
    && (!nativeSelected ==> after.nativeObjects == s.nativeObjects && after.managers == s.managers)
{
  var after := resolveRegisteredManager(s, runtime, service, storage, storageReference);
  CachedLookup(s, runtime);
  SetAdd(s.nativeIdentities, after.selected);
  SetAdd(s.compatibleIdentities, after.selected);
}

lemma registerProvider_ensures(s: ConnectorManagers, manager: int, provider: string, reference: int)
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysOneCachedManagerPerRuntime(registerProvider(s, manager, provider, reference)))
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysOneProviderPerManager(registerProvider(s, manager, provider, reference)))
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysServiceKindsDisjoint(registerProvider(s, manager, provider, reference)))
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysCachedManagersAreNative(registerProvider(s, manager, provider, reference)))
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysNativeStorageInBackend(registerProvider(s, manager, provider, reference)))
{
  if inv(s) {
    var after := registerProvider(s, manager, provider, reference);
    var key := (e: ProviderRecord) => (e.manager, e.provider);
    ProvidersUnique(s);
    ProvidersUnique(after);
    if providerHeld(s, manager, provider) {
      assert forall i :: 0 <= i < |s.providers| ==> key(after.providers[i]) == key(s.providers[i]);
    } else {
      assert after.providers == s.providers + [ProviderRecord(manager, provider, reference)];
      ProofLib.DistinctByConcat(s.providers, [ProviderRecord(manager, provider, reference)], key);
    }
  }
}

lemma unregisterProvider_ensures(s: ConnectorManagers, manager: int, provider: string)
  ensures (inv(s) ==> alwaysOneCachedManagerPerRuntime(unregisterProvider(s, manager, provider)))
  ensures (inv(s) ==> alwaysOneProviderPerManager(unregisterProvider(s, manager, provider)))
  ensures (inv(s) ==> alwaysServiceKindsDisjoint(unregisterProvider(s, manager, provider)))
  ensures (inv(s) ==> alwaysCachedManagersAreNative(unregisterProvider(s, manager, provider)))
  ensures (inv(s) ==> alwaysNativeStorageInBackend(unregisterProvider(s, manager, provider)))
{
  if inv(s) {
    ProvidersWithout(s, manager, provider);
    ProvidersUnique(unregisterProvider(s, manager, provider));
  }
}

lemma resolveRegisteredManager_ensures(s: ConnectorManagers, runtime: string, service: RegisteredManagerService, storage: string, storageReference: int)
  ensures (inv(s) ==> canResolveRegisteredManager(s, runtime, service, storage, storageReference) ==> alwaysOneCachedManagerPerRuntime(resolveRegisteredManager(s, runtime, service, storage, storageReference)))
  ensures (inv(s) ==> canResolveRegisteredManager(s, runtime, service, storage, storageReference) ==> alwaysOneProviderPerManager(resolveRegisteredManager(s, runtime, service, storage, storageReference)))
  ensures (inv(s) ==> canResolveRegisteredManager(s, runtime, service, storage, storageReference) ==> alwaysServiceKindsDisjoint(resolveRegisteredManager(s, runtime, service, storage, storageReference)))
  ensures (inv(s) ==> canResolveRegisteredManager(s, runtime, service, storage, storageReference) ==> alwaysCachedManagersAreNative(resolveRegisteredManager(s, runtime, service, storage, storageReference)))
  ensures (inv(s) ==> canResolveRegisteredManager(s, runtime, service, storage, storageReference) ==> alwaysNativeStorageInBackend(resolveRegisteredManager(s, runtime, service, storage, storageReference)))
{
  if inv(s) && canResolveRegisteredManager(s, runtime, service, storage, storageReference) {
    var after := resolveRegisteredManager(s, runtime, service, storage, storageReference);
    var sel := after.selected;
    var hasService := (runtime != "") && (serviceIdentity(service) > 0);
    var nativeSelected := !(hasService && compatibleService(service));
    var cached := ProofLib.Filter((manager: ManagerRecord) => (manager.runtime == runtime), s.managers);
    var creates := !hasService && |cached| == 0;
    var key := (m: ManagerRecord) => m.runtime;
    ResolveShape(s, runtime, service, storage, storageReference);
    CachedLookup(s, runtime);
    ManagersUnique(s);
    ManagersUnique(after);
    ProvidersUnique(s);
    ProvidersUnique(after);
    // Every cached identity is native, so it is below the next fresh reference and never duck-compatible.
    assert forall m :: m in s.managers ==> m.id in s.nativeIdentities;
    // A native selection is never a known duck-compatible identity, and a duck-compatible one is never native.
    if hasService && !compatibleService(service) {
      assert service.NativeManagerService?;
    }
    assert nativeSelected ==> sel !in s.compatibleIdentities;
    assert !nativeSelected ==> sel !in s.nativeIdentities;
    // One cached manager per runtime.
    if creates {
      ProofLib.DistinctByConcat(s.managers, [ManagerRecord(runtime, s.nextId, storage)], key);
    } else {
      assert forall i :: 0 <= i < |after.managers| ==> key(after.managers[i]) == key(s.managers[i]);
    }
    // Service kinds stay disjoint.
    forall x | x in after.compatibleIdentities
      ensures x > 0 && x < after.nextId && x !in after.nativeIdentities
    {
    }
    // Every cached manager is native and records the storage of its object.
    forall x | x in after.nativeIdentities
      ensures x > 0 && x < after.nextId && x in after.nativeObjects
    {
    }
    // Every known native object holds its explicit storage in its own backend cache.
    var prior := if sel in s.nativeIdentities then lookup0_core__connectorManagers(s.nativeObjects, sel, unusedManager) else if hasService then serviceManager(service) else unusedManager;
    assert (prior.storage != "") == (prior.backend.explicit != 0);
    forall x | x in after.nativeIdentities
      ensures (lookup0_core__connectorManagers(after.nativeObjects, x, unusedManager).storage != "") == (lookup0_core__connectorManagers(after.nativeObjects, x, unusedManager).backend.explicit != 0)
    {
    }
    forall m | m in after.managers
      ensures m.id in after.nativeIdentities && lookup0_core__connectorManagers(after.nativeObjects, m.id, unusedManager).storage == m.storage
    {
      var i :| 0 <= i < |after.managers| && after.managers[i] == m;
      if creates && i == |s.managers| {
        assert m == ManagerRecord(runtime, s.nextId, storage);
        assert sel !in s.nativeIdentities;
      } else {
        assert m.id == s.managers[i].id;
        assert s.managers[i] in s.managers;
        assert s.managers[i].id in s.nativeIdentities;
      }
    }
  }
}

lemma resolveManager_ensures(s: ConnectorManagers, runtime: string, serviceId: int, storage: string)
  ensures (inv(s) ==> alwaysOneCachedManagerPerRuntime(resolveManager(s, runtime, serviceId, storage)))
  ensures (inv(s) ==> alwaysOneProviderPerManager(resolveManager(s, runtime, serviceId, storage)))
  ensures (inv(s) ==> alwaysServiceKindsDisjoint(resolveManager(s, runtime, serviceId, storage)))
  ensures (inv(s) ==> alwaysCachedManagersAreNative(resolveManager(s, runtime, serviceId, storage)))
  ensures (inv(s) ==> alwaysNativeStorageInBackend(resolveManager(s, runtime, serviceId, storage)))
{
  if inv(s) {
    resolveRegisteredManager_ensures(s, runtime, knownService(s, serviceId), storage, if storage != "" then 1 else 0);
  }
}

lemma lawStandaloneIgnoresService_ensures(s: ConnectorManagers, service: RegisteredManagerService, storage: string, storageReference: int)
  ensures (lawStandaloneIgnoresService(s, service, storage, storageReference) == true)
{
  assert resolveRegisteredManager(s, "", service, storage, storageReference) == resolveRegisteredManager(s, "", RegisteredManagerService.NoManagerService, storage, storageReference);
}

lemma lawNativeServiceStorage_ensures(s: ConnectorManagers, runtime: string, identity: int, snapshot: NativeManager, storage: string, storageReference: int)
  ensures (lawNativeServiceStorage(s, runtime, identity, snapshot, storage, storageReference) == true)
{
  SetAdd(s.nativeIdentities, identity);
}

lemma lawCompatibleServiceBypassesStorage_ensures(s: ConnectorManagers, runtime: string, identity: int, storage: string, storageReference: int)
  ensures (lawCompatibleServiceBypassesStorage(s, runtime, identity, storage, storageReference) == true)
{
}

lemma lawServiceDoesNotReplaceCache_ensures(s: ConnectorManagers, runtime: string, service: RegisteredManagerService, storage: string, storageReference: int)
  ensures (lawServiceDoesNotReplaceCache(s, runtime, service, storage, storageReference) == true)
{
  var after := resolveRegisteredManager(s, runtime, service, storage, storageReference);
  if (runtime != "") && (serviceIdentity(service) > 0) {
    assert |after.managers| == |s.managers|;
    assert forall i :: 0 <= i < |s.managers| ==> after.managers[i].runtime == s.managers[i].runtime && after.managers[i].id == s.managers[i].id;
  }
}

lemma lawOtherManagerStoragePreserved_ensures(s: ConnectorManagers, runtime: string, service: RegisteredManagerService, storage: string, storageReference: int, identity: int)
  ensures (lawOtherManagerStoragePreserved(s, runtime, service, storage, storageReference, identity) == true)
{
  var after := resolveRegisteredManager(s, runtime, service, storage, storageReference);
  SetAdd(s.nativeIdentities, after.selected);
}

lemma lawAbsentStoragePreservesKnownObjects_ensures(s: ConnectorManagers, runtime: string, service: RegisteredManagerService)
  ensures (lawAbsentStoragePreservesKnownObjects(s, runtime, service) == true)
{
  var after := resolveRegisteredManager(s, runtime, service, "", 0);
  SetAdd(s.nativeIdentities, after.selected);
}

lemma lawNativeBackendStateRetained_ensures(s: ConnectorManagers, runtime: string, service: RegisteredManagerService, storage: string, storageReference: int)
  ensures (lawNativeBackendStateRetained(s, runtime, service, storage, storageReference) == true)
{
  var after := resolveRegisteredManager(s, runtime, service, storage, storageReference);
  SetAdd(s.nativeIdentities, after.selected);
}

lemma lawNewProviderAppends_ensures(s: ConnectorManagers, manager: int, provider: string, reference: int)
  ensures (lawNewProviderAppends(s, manager, provider, reference) == true)
{
}

lemma lawProviderReplacementKeepsPosition_ensures(s: ConnectorManagers, manager: int, provider: string, reference: int)
  ensures (lawProviderReplacementKeepsPosition(s, manager, provider, reference) == true)
{
  var after := registerProvider(s, manager, provider, reference);
  if providerHeld(s, manager, provider) {
    var e :| e in s.providers && e.manager == manager && e.provider == provider;
    var i :| 0 <= i < |s.providers| && s.providers[i] == e;
    assert |after.providers| == |s.providers|;
    assert after.providers[i] == ProviderRecord(manager, provider, reference);
    assert forall j :: 0 <= j < |s.providers| ==> after.providers[j].manager == s.providers[j].manager && after.providers[j].provider == s.providers[j].provider;
  }
}
