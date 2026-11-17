lemma ManagerUnionMembership<T>(xs: seq<T>, item: T)
  ensures item in xs + ProofLib.Filter((set_x: T) => !((set_x in xs)), [item])
  ensures forall value :: value in xs + ProofLib.Filter((set_x: T) => !((set_x in xs)), [item]) ==> value in xs || value == item
{
  ProofLib.FilterMember((set_x: T) => !((set_x in xs)), [item], item);
  forall value | value in xs + ProofLib.Filter((set_x: T) => !((set_x in xs)), [item])
    ensures value in xs || value == item
  {
    ProofLib.FilterMember((set_x: T) => !((set_x in xs)), [item], value);
  }
}

lemma ManagerAlwaysOneProviderPerManagerView(s: ConnectorManagers)
  ensures alwaysOneProviderPerManager(s) == (!((exists entry :: entry in s.providers && !((|ProofLib.Filter((other: ProviderRecord) => ((other.manager == entry.manager) && (other.provider == entry.provider)), s.providers)| == 1)))))
{
}

lemma ManagerUnregisterProviderView(s: ConnectorManagers, manager: int, provider: string)
  ensures unregisterProvider(s, manager, provider) == (s.(providers := ProofLib.Filter((entry: ProviderRecord) => ((entry.manager != manager) || (entry.provider != provider)), s.providers)))
{
}

lemma ManagerResolveManagerView(s: ConnectorManagers, runtime: string, service: RegisteredManagerService, storage: StorageOverrideInput)
  ensures resolveManager(s, runtime, service, storage) == (var local_1 := (runtime in s.runtimes);
  var local_2 := ((runtime != "") && (serviceIdentity(service) > 0));
  var local_3 := (if local_2 then serviceIdentity(service) else (if local_1 then lookup1_core__connectorManagers(s.managers, runtime, 0) else s.nextId));
  var local_4 := (!(local_2) && !(local_1));
  var local_5 := !((local_2 && compatibleService(service)));
  var local_6 := (local_3 in s.nativeIdentities);
  var local_7 := (if local_6 then lookup0_core__connectorManagers(s.nativeObjects, local_3, core__connectorBackends_initial) else (if local_2 then serviceBackend(service) else core__connectorBackends_initial));
  var local_8 := (if (suppliedStorage(storage) != 0) then core__connectorBackends_setExplicit(local_7, suppliedStorage(storage)) else local_7);
  s.(selected := local_3, nextId := (if (local_3 >= s.nextId) then (local_3 + 1) else s.nextId), runtimes := (if local_4 then (s.runtimes + ProofLib.Filter((set_x: string) => !((set_x in s.runtimes)), [runtime])) else s.runtimes), managers := (if local_4 then s.managers[("$" + runtime) := local_3] else s.managers), nativeIdentities := (if local_5 then (s.nativeIdentities + ProofLib.Filter((set_x: int) => !((set_x in s.nativeIdentities)), [local_3])) else s.nativeIdentities), nativeObjects := (if local_5 then s.nativeObjects[local_3 := local_8] else s.nativeObjects)))
{
}

lemma registerProvider_ensures(s: ConnectorManagers, manager: int, provider: string, reference: int)
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysOneCachedManagerPerRuntime(registerProvider(s, manager, provider, reference)))
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysOneNativeObjectPerIdentity(registerProvider(s, manager, provider, reference)))
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysOneProviderPerManager(registerProvider(s, manager, provider, reference)))
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysFreshReferencesReserved(registerProvider(s, manager, provider, reference)))
{
  if inv(s) && canRegisterProvider(s, manager, provider, reference) {
    var after := registerProvider(s, manager, provider, reference);
    ManagerAlwaysOneProviderPerManagerView(s);
    ManagerAlwaysOneProviderPerManagerView(after);
    if exists priorEntry :: priorEntry in s.providers && priorEntry.manager == manager && priorEntry.provider == provider {
      assert |after.providers| == |s.providers|;
      forall entry | entry in after.providers
        ensures |ProofLib.Filter((other: ProviderRecord) => ((other.manager == entry.manager) && (other.provider == entry.provider)), after.providers)| == 1
      {
        var i :| 0 <= i < |after.providers| && after.providers[i] == entry;
        var prior := s.providers[i];
        assert prior.manager == entry.manager && prior.provider == entry.provider;
        assert |ProofLib.Filter((other: ProviderRecord) => ((other.manager == prior.manager) && (other.provider == prior.provider)), s.providers)| == 1;
        ProofLib.FilterLengthPointwise((other: ProviderRecord) => ((other.manager == entry.manager) && (other.provider == entry.provider)), (other: ProviderRecord) => ((other.manager == prior.manager) && (other.provider == prior.provider)), after.providers, s.providers);
      }
    } else {
      var added := ProviderRecord(manager, provider, reference);
      forall entry | entry in after.providers
        ensures |ProofLib.Filter((other: ProviderRecord) => ((other.manager == entry.manager) && (other.provider == entry.provider)), after.providers)| == 1
      {
        ProofLib.FilterAppend((other: ProviderRecord) => ((other.manager == entry.manager) && (other.provider == entry.provider)), s.providers, added);
        if entry == added {
          ProofLib.FilterNone((other: ProviderRecord) => ((other.manager == entry.manager) && (other.provider == entry.provider)), s.providers);
        } else {
          assert entry in s.providers;
          assert entry.manager != manager || entry.provider != provider;
        }
      }
    }
  }
}

lemma unregisterProvider_ensures(s: ConnectorManagers, manager: int, provider: string)
  ensures (inv(s) ==> alwaysOneCachedManagerPerRuntime(unregisterProvider(s, manager, provider)))
  ensures (inv(s) ==> alwaysOneNativeObjectPerIdentity(unregisterProvider(s, manager, provider)))
  ensures (inv(s) ==> alwaysOneProviderPerManager(unregisterProvider(s, manager, provider)))
  ensures (inv(s) ==> alwaysFreshReferencesReserved(unregisterProvider(s, manager, provider)))
{
  if inv(s) {
    ManagerUnregisterProviderView(s, manager, provider);
    ManagerAlwaysOneProviderPerManagerView(s);
    var after := unregisterProvider(s, manager, provider);
    ManagerAlwaysOneProviderPerManagerView(after);
    forall entry | entry in after.providers
      ensures entry in s.providers && |ProofLib.Filter((other: ProviderRecord) => ((other.manager == entry.manager) && (other.provider == entry.provider)), after.providers)| == 1
    {
      ProofLib.FilterMember((entry: ProviderRecord) => ((entry.manager != manager) || (entry.provider != provider)), s.providers, entry);
      ProofLib.FilterOfFilterLength((entry: ProviderRecord) => ((entry.manager != manager) || (entry.provider != provider)), (other: ProviderRecord) => ((other.manager == entry.manager) && (other.provider == entry.provider)), (other: ProviderRecord) => ((other.manager == entry.manager) && (other.provider == entry.provider)), s.providers);
      ProofLib.FilterMember((other: ProviderRecord) => ((other.manager == entry.manager) && (other.provider == entry.provider)), after.providers, entry);
    }
  }
}

lemma resolveManager_ensures(s: ConnectorManagers, runtime: string, service: RegisteredManagerService, storage: StorageOverrideInput)
  ensures (inv(s) ==> canResolveManager(s, runtime, service, storage) ==> alwaysOneCachedManagerPerRuntime(resolveManager(s, runtime, service, storage)))
  ensures (inv(s) ==> canResolveManager(s, runtime, service, storage) ==> alwaysOneNativeObjectPerIdentity(resolveManager(s, runtime, service, storage)))
  ensures (inv(s) ==> canResolveManager(s, runtime, service, storage) ==> alwaysOneProviderPerManager(resolveManager(s, runtime, service, storage)))
  ensures (inv(s) ==> canResolveManager(s, runtime, service, storage) ==> alwaysFreshReferencesReserved(resolveManager(s, runtime, service, storage)))
{
  if inv(s) && canResolveManager(s, runtime, service, storage) {
    ManagerResolveManagerView(s, runtime, service, storage);
    var after := resolveManager(s, runtime, service, storage);
    var hasService := runtime != "" && serviceIdentity(service) > 0;
    var creates := !hasService && runtime !in s.runtimes;
    var nativeSelected := !(hasService && compatibleService(service));
    var selected := after.selected;
    ManagerUnionMembership(s.runtimes, runtime);
    ManagerUnionMembership(s.nativeIdentities, selected);
    assert selected > 0;
    assert after.nextId >= s.nextId && selected < after.nextId;
    if nativeSelected {
      var backend := if selected in s.nativeIdentities then lookup0_core__connectorManagers(s.nativeObjects, selected, core__connectorBackends_initial) else if hasService then serviceBackend(service) else core__connectorBackends_initial;
      assert core__connectorBackends_alwaysAllocatedIdentitiesAreValid(backend);
      assert core__connectorBackends_alwaysAllocatedIdentitiesAreValid(if suppliedStorage(storage) != 0 then core__connectorBackends_setExplicit(backend, suppliedStorage(storage)) else backend);
      assert selected in after.nativeIdentities;
    }
    forall key | key in after.runtimes
      ensures ("$" + key) in after.managers && lookup1_core__connectorManagers(after.managers, key, 0) > 0 && lookup1_core__connectorManagers(after.managers, key, 0) < after.nextId && lookup1_core__connectorManagers(after.managers, key, 0) in after.nativeIdentities
    {
      if creates && key == runtime {
        assert nativeSelected;
      } else {
        assert key in s.runtimes;
      }
    }
    forall identity | identity in after.nativeIdentities
      ensures identity in after.nativeObjects && core__connectorBackends_alwaysAllocatedIdentitiesAreValid(lookup0_core__connectorManagers(after.nativeObjects, identity, core__connectorBackends_initial)) && identity > 0 && identity < after.nextId
    {
      if !nativeSelected || identity != selected {
        assert identity in s.nativeIdentities;
      }
    }
  }
}

lemma lawNativeServiceStorage_ensures(s: ConnectorManagers, runtime: string, identity: int, backend: core__connectorBackends_BackendCache, storageReference: int)
  ensures (lawNativeServiceStorage(s, runtime, identity, backend, storageReference) == true)
{
  if runtime != "" && identity > 0 && storageReference > 0 {
    ManagerResolveManagerView(s, runtime, NativeManagerService(identity, backend), SuppliedStorage(storageReference));
    ManagerUnionMembership(s.nativeIdentities, identity);
  }
}
