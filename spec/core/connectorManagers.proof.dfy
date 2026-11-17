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

lemma registerProvider_ensures(s: ConnectorManagers, manager: int, provider: string, reference: int)
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysOneCachedManagerPerRuntime(registerProvider(s, manager, provider, reference)))
  ensures (inv(s) ==> canRegisterProvider(s, manager, provider, reference) ==> alwaysOneProviderPerManager(registerProvider(s, manager, provider, reference)))
{
  if inv(s) {
    var key := (e: ProviderRecord) => (e.manager, e.provider);
    var rest := unregisterProvider(s, manager, provider).providers;
    ProvidersWithout(s, manager, provider);
    ProofLib.DistinctByConcat(rest, [ProviderRecord(manager, provider, reference)], key);
    ProvidersUnique(registerProvider(s, manager, provider, reference));
  }
}

lemma unregisterProvider_ensures(s: ConnectorManagers, manager: int, provider: string)
  ensures (inv(s) ==> alwaysOneCachedManagerPerRuntime(unregisterProvider(s, manager, provider)))
  ensures (inv(s) ==> alwaysOneProviderPerManager(unregisterProvider(s, manager, provider)))
{
  if inv(s) {
    ProvidersWithout(s, manager, provider);
    ProvidersUnique(unregisterProvider(s, manager, provider));
  }
}

lemma resolveManager_ensures(s: ConnectorManagers, runtime: string, serviceId: int, storage: string)
  ensures (inv(s) ==> alwaysOneCachedManagerPerRuntime(resolveManager(s, runtime, serviceId, storage)))
  ensures (inv(s) ==> alwaysOneProviderPerManager(resolveManager(s, runtime, serviceId, storage)))
{
  if inv(s) {
    var after := resolveManager(s, runtime, serviceId, storage);
    var key := (m: ManagerRecord) => m.runtime;
    var p := (manager: ManagerRecord) => (manager.runtime == runtime);
    ManagersUnique(s);
    ManagersUnique(after);
    if !((runtime != "") && (serviceId > 0)) && |ProofLib.Filter(p, s.managers)| == 0 {
      ProofLib.FilterNone(p, s.managers);
      ProofLib.DistinctByConcat(s.managers, [after.managers[|s.managers|]], key);
      assert after.managers == s.managers + [after.managers[|s.managers|]];
    } else {
      assert |after.managers| == |s.managers|;
      assert forall i :: 0 <= i < |s.managers| ==> after.managers[i].runtime == s.managers[i].runtime;
    }
  }
}
