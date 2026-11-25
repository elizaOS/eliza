lemma RegistryComponentFacts(s: RuntimeRegistries)
  ensures alwaysComponentNamesUnique(s) ==
    (forall row :: row in s.components ==> |ProofLib.Filter((other: ComponentRegistration) => other.kind == row.kind && other.name == row.name, s.components)| == 1)
  ensures alwaysComponentOwnershipValid(s) ==
    (forall row :: row in s.components ==> row.reference > 0 && row.owner >= 0)
{}

lemma RegistryModelFacts(s: RuntimeRegistries)
  ensures alwaysModelRegistrationOrderUnique(s) ==
    (forall row :: row in s.models ==> (row.reference > 0 && row.owner >= 0 && 0 < row.order < s.nextOrder &&
      |ProofLib.Filter((other: ModelRegistration) => other.order == row.order, s.models)| == 1))
{}

lemma RegistryFreshComponent(rows: seq<ComponentRegistration>, row: ComponentRegistration)
  requires forall prior :: prior in rows ==> |ProofLib.Filter((other: ComponentRegistration) => other.kind == prior.kind && other.name == prior.name, rows)| == 1
  requires |ProofLib.Filter((other: ComponentRegistration) => other.kind == row.kind && other.name == row.name, rows)| == 0
  ensures forall prior :: prior in rows + [row] ==> |ProofLib.Filter((other: ComponentRegistration) => other.kind == prior.kind && other.name == prior.name, rows + [row])| == 1
{
  forall current | current in rows + [row]
    ensures |ProofLib.Filter((other: ComponentRegistration) => other.kind == current.kind && other.name == current.name, rows + [row])| == 1
  {
    var key := (other: ComponentRegistration) => other.kind == current.kind && other.name == current.name;
    ProofLib.FilterAppend(key, rows, row);
    if current != row {
      assert current in rows;
      ProofLib.FilterMember((other: ComponentRegistration) => other.kind == row.kind && other.name == row.name, rows, current);
    }
  }
}

lemma RegistryReplaceComponent(rows: seq<ComponentRegistration>, updated: seq<ComponentRegistration>, replacement: ComponentRegistration)
  requires forall row :: row in rows ==> |ProofLib.Filter((other: ComponentRegistration) => other.kind == row.kind && other.name == row.name, rows)| == 1
  requires |updated| == |rows|
  requires forall i :: 0 <= i < |rows| ==> (updated[i] ==
    (if rows[i].kind == replacement.kind && rows[i].name == replacement.name then replacement else rows[i]))
  ensures forall row :: row in updated ==> |ProofLib.Filter((other: ComponentRegistration) => other.kind == row.kind && other.name == row.name, updated)| == 1
{
  forall i | 0 <= i < |rows|
    ensures rows[i].kind == updated[i].kind && rows[i].name == updated[i].name
  {}
  forall row | row in updated
    ensures |ProofLib.Filter((other: ComponentRegistration) => other.kind == row.kind && other.name == row.name, updated)| == 1
  {
    var i :| 0 <= i < |updated| && updated[i] == row;
    assert rows[i] in rows;
    var key := (other: ComponentRegistration) => other.kind == row.kind && other.name == row.name;
    ProofLib.FilterLengthPointwise(key, key, rows, updated);
  }
}

lemma RegistryRetainComponents(s: RuntimeRegistries, after: RuntimeRegistries, keep: ComponentRegistration -> bool)
  requires alwaysComponentNamesUnique(s) && alwaysComponentOwnershipValid(s)
  requires after.components == ProofLib.Filter(keep, s.components)
  ensures alwaysComponentNamesUnique(after) && alwaysComponentOwnershipValid(after)
{
  RegistryComponentFacts(s);
  RegistryComponentFacts(after);
  forall row | row in after.components
    ensures |ProofLib.Filter((other: ComponentRegistration) => other.kind == row.kind && other.name == row.name, after.components)| == 1
    ensures row.reference > 0 && row.owner >= 0
  {
    var key := (other: ComponentRegistration) => other.kind == row.kind && other.name == row.name;
    ProofLib.FilterMember(keep, s.components, row);
    ProofLib.FilterOfFilterShorter(keep, key, s.components);
    ProofLib.FilterMember(key, after.components, row);
  }
}

lemma RegistryAppendModel(s: RuntimeRegistries, after: RuntimeRegistries, row: ModelRegistration)
  requires alwaysModelRegistrationOrderUnique(s) && s.nextOrder > 0
  requires row.reference > 0 && row.owner >= 0 && row.order == s.nextOrder
  requires after.models == s.models + [row] && after.nextOrder == s.nextOrder + 1
  ensures alwaysModelRegistrationOrderUnique(after)
{
  RegistryModelFacts(s);
  RegistryModelFacts(after);
  forall current | current in after.models
    ensures current.reference > 0 && current.owner >= 0 && 0 < current.order < after.nextOrder &&
      |ProofLib.Filter((other: ModelRegistration) => other.order == current.order, after.models)| == 1
  {
    var key := (other: ModelRegistration) => other.order == current.order;
    ProofLib.FilterAppend(key, s.models, row);
    if current == row {
      ProofLib.FilterNone(key, s.models);
    } else {
      assert current in s.models;
      assert current.order < s.nextOrder;
    }
  }
}

lemma RegistryRetainModels(s: RuntimeRegistries, after: RuntimeRegistries, keep: ModelRegistration -> bool)
  requires alwaysModelRegistrationOrderUnique(s)
  requires after.models == ProofLib.Filter(keep, s.models) && after.nextOrder == s.nextOrder
  ensures alwaysModelRegistrationOrderUnique(after)
{
  RegistryModelFacts(s);
  RegistryModelFacts(after);
  forall row | row in after.models
    ensures row.reference > 0 && row.owner >= 0 && 0 < row.order < after.nextOrder &&
      |ProofLib.Filter((other: ModelRegistration) => other.order == row.order, after.models)| == 1
  {
    var key := (other: ModelRegistration) => other.order == row.order;
    ProofLib.FilterMember(keep, s.models, row);
    ProofLib.FilterOfFilterShorter(keep, key, s.models);
    ProofLib.FilterMember(key, after.models, row);
  }
}

lemma RegistryBestModel(rows: seq<ModelRegistration>, chosen: ModelRegistration)
  requires chosen.reference >= 0
  requires forall row :: row in rows ==> row.reference > 0
  ensures var best := Std.Collections.Seq.FoldLeft((a: ModelRegistration, b: ModelRegistration) => preferredModel(a, b), chosen, rows);
    (|rows| > 0 || chosen.reference > 0 ==> best.reference > 0) &&
    (chosen.reference > 0 ==> best.priority > chosen.priority || (best.priority == chosen.priority && best.order <= chosen.order)) &&
    (forall row :: row in rows ==> best.priority > row.priority || (best.priority == row.priority && best.order <= row.order))
  decreases |rows|
{
  var best := Std.Collections.Seq.FoldLeft((a: ModelRegistration, b: ModelRegistration) => preferredModel(a, b), chosen, rows);
  if |rows| > 0 {
    var first := rows[0];
    var next := preferredModel(chosen, first);
    assert next.reference > 0;
    assert next.priority > first.priority || (next.priority == first.priority && next.order <= first.order);
    RegistryBestModel(rows[1..], next);
    assert best == Std.Collections.Seq.FoldLeft((a: ModelRegistration, b: ModelRegistration) => preferredModel(a, b), next, rows[1..]);
    forall row | row in rows
      ensures best.priority > row.priority || (best.priority == row.priority && best.order <= row.order)
    {
      if row != first {
        assert rows == [first] + rows[1..];
        assert row in rows[1..];
      }
    }
  }
}

lemma RegistryModelSelection(s: RuntimeRegistries)
  requires alwaysModelRegistrationOrderUnique(s)
  ensures alwaysModelSelectionPriority(s)
{
  RegistryModelFacts(s);
  forall row | row in s.models
    ensures selectedModel(s, row.modelType).priority > row.priority ||
      (selectedModel(s, row.modelType).priority == row.priority && selectedModel(s, row.modelType).order <= row.order)
  {
    var keep := (other: ModelRegistration) => other.modelType == row.modelType;
    var rows := ProofLib.Filter(keep, s.models);
    forall other | other in rows ensures other.reference > 0 {
      ProofLib.FilterMember(keep, s.models, other);
    }
    ProofLib.FilterMember(keep, s.models, row);
    RegistryBestModel(rows, noModel);
    assert selectedModel(s, row.modelType) ==
      Std.Collections.Seq.FoldLeft((a: ModelRegistration, b: ModelRegistration) => preferredModel(a, b), noModel, rows);
  }
}

lemma registerComponent_ensures(s: RuntimeRegistries, kind: ComponentKind, name: string, reference: int, owner: int, allowsOverride: bool)
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysComponentNamesUnique(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysComponentOwnershipValid(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysModelRegistrationOrderUnique(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysModelSelectionPriority(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysRegistryCountersNonnegative(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysLocalizedSlotUnique(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysUniqueKeys(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> stepRegisterWorkerWakesScheduler(s, "registerComponent", registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> stepCategoryIsolation(s, "registerComponent", registerComponent(s, kind, name, reference, owner, allowsOverride)))
{
  if inv(s) && canRegisterComponent(s, kind, name, reference, owner, allowsOverride) {
    var after := registerComponent(s, kind, name, reference, owner, allowsOverride);
    var key := (row: ComponentRegistration) => row.kind == kind && row.name == name;
    var incumbent := ProofLib.Filter(key, s.components);
    var replacement := ComponentRegistration(kind, name, reference, owner);
    RegistryComponentFacts(s);
    RegistryComponentFacts(after);
    if !(exists row :: row in incumbent && row.reference == reference) {
      if |incumbent| == 0 {
        assert after.components == s.components + [replacement];
        RegistryFreshComponent(s.components, replacement);
      } else if allowsOverride && owner == 0 {
        assert |after.components| == |s.components|;
        forall i | 0 <= i < |s.components|
          ensures after.components[i] == (if key(s.components[i]) then replacement else s.components[i])
        {}
        RegistryReplaceComponent(s.components, after.components, replacement);
      }
    }
  }
}

lemma unregisterComponent_ensures(s: RuntimeRegistries, kind: ComponentKind, name: string)
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysComponentNamesUnique(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysComponentOwnershipValid(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysModelRegistrationOrderUnique(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysModelSelectionPriority(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysRegistryCountersNonnegative(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysLocalizedSlotUnique(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysUniqueKeys(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> stepRegisterWorkerWakesScheduler(s, "unregisterComponent", unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> stepCategoryIsolation(s, "unregisterComponent", unregisterComponent(s, kind, name)))
{
  if inv(s) && canUnregisterComponent(s, kind, name) {
    var after := unregisterComponent(s, kind, name);
    RegistryRetainComponents(s, after, (row: ComponentRegistration) => row.kind != kind || row.name != name);
  }
}

lemma registerModel_ensures(s: RuntimeRegistries, modelType: string, provider: string, reference: int, priority: int, owner: int, capabilityEnabled: bool)
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysComponentNamesUnique(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysComponentOwnershipValid(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysModelRegistrationOrderUnique(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysModelSelectionPriority(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysRegistryCountersNonnegative(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysLocalizedSlotUnique(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysUniqueKeys(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> stepRegisterWorkerWakesScheduler(s, "registerModel", registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> stepCategoryIsolation(s, "registerModel", registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
{
  if inv(s) && canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) && capabilityEnabled {
    var after := registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled);
    RegistryAppendModel(s, after, ModelRegistration(modelType, provider, reference, priority, s.nextOrder, owner));
    RegistryModelSelection(after);
  }
}

lemma unloadOwner_ensures(s: RuntimeRegistries, owner: int)
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysComponentNamesUnique(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysComponentOwnershipValid(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysModelRegistrationOrderUnique(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysModelSelectionPriority(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysRegistryCountersNonnegative(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysLocalizedSlotUnique(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysUniqueKeys(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> stepRegisterWorkerWakesScheduler(s, "unloadOwner", unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> stepCategoryIsolation(s, "unloadOwner", unloadOwner(s, owner)))
{
  if inv(s) && canUnloadOwner(s, owner) {
    var after := unloadOwner(s, owner);
    RegistryRetainComponents(s, after, (row: ComponentRegistration) => row.owner != owner);
    RegistryRetainModels(s, after, (row: ModelRegistration) => row.owner != owner);
    RegistryModelSelection(after);
  }
}

lemma LocalizedProviderRoutingCounts(s: RuntimeRegistries)
  ensures alwaysLocalizedSlotUnique(s) ==
    (forall entry :: entry in s.localized ==> |ProofLib.Filter((other: LocalizedProvider) => other.runtime == entry.runtime, s.localized)| == 1)
{}

lemma registerLocalized_ensures(s: RuntimeRegistries, runtimeId: int, reference: int)
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> alwaysComponentNamesUnique(registerLocalized(s, runtimeId, reference)))
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> alwaysComponentOwnershipValid(registerLocalized(s, runtimeId, reference)))
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> alwaysModelRegistrationOrderUnique(registerLocalized(s, runtimeId, reference)))
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> alwaysModelSelectionPriority(registerLocalized(s, runtimeId, reference)))
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> alwaysRegistryCountersNonnegative(registerLocalized(s, runtimeId, reference)))
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> alwaysLocalizedSlotUnique(registerLocalized(s, runtimeId, reference)))
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> alwaysUniqueKeys(registerLocalized(s, runtimeId, reference)))
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> stepRegisterWorkerWakesScheduler(s, "registerLocalized", registerLocalized(s, runtimeId, reference)))
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> stepCategoryIsolation(s, "registerLocalized", registerLocalized(s, runtimeId, reference)))
{
  if inv(s) && canRegisterLocalized(s, runtimeId, reference) {
    var added := LocalizedProvider(runtimeId, reference);
    var after := registerLocalized(s, runtimeId, reference);
    var matching := (row: LocalizedProvider) => row.runtime == added.runtime;
    LocalizedProviderRoutingCounts(s);
    LocalizedProviderRoutingCounts(after);
    if exists row :: row in s.localized && matching(row) {
      assert |after.localized| == |s.localized|;
      forall index | 0 <= index < |s.localized|
        ensures after.localized[index].runtime == s.localized[index].runtime

      {
        assert after.localized[index] == (if s.localized[index].runtime == added.runtime then added else s.localized[index]);
      }
      forall entry | entry in after.localized
        ensures |ProofLib.Filter((other: LocalizedProvider) => other.runtime == entry.runtime, after.localized)| == 1
      {
        var index :| 0 <= index < |after.localized| && after.localized[index] == entry;
        assert s.localized[index] in s.localized;
        var key := (other: LocalizedProvider) => other.runtime == entry.runtime;
        assert |ProofLib.Filter((other: LocalizedProvider) => other.runtime == s.localized[index].runtime, s.localized)| == 1;
        ProofLib.FilterLengthPointwise(key, key, s.localized, after.localized);
      }
    } else {
      assert after.localized == s.localized + [added];
      forall entry | entry in after.localized
        ensures |ProofLib.Filter((other: LocalizedProvider) => other.runtime == entry.runtime, after.localized)| == 1
      {
        var key := (other: LocalizedProvider) => other.runtime == entry.runtime;
        ProofLib.FilterAppend(key, s.localized, added);
        if entry == added {
          ProofLib.FilterNone(matching, s.localized);
        } else {
          assert entry in s.localized;
          assert !matching(entry);
        }
      }
    }
  }
}

lemma KeyCountsDistinct<T, K>(xs: seq<T>, key: T -> K, p: T -> (T -> bool))
  requires forall a, b :: p(a)(b) == (key(b) == key(a))
  ensures (forall x :: x in xs ==> |ProofLib.Filter(p(x), xs)| == 1) <==> ProofLib.DistinctBy(xs, key)
{
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter(p(xs[i]), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> key(xs[j]) != key(xs[i])
  {
    ProofLib.FilterCountOneIffUnique(p(xs[i]), xs, key, i);
  }
  if ProofLib.DistinctBy(xs, key) {
    forall x | x in xs
      ensures |ProofLib.Filter(p(x), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == x;
    }
  } else {
    var i, j :| 0 <= i < |xs| && 0 <= j < |xs| && i != j && key(xs[i]) == key(xs[j]);
    assert xs[i] in xs;
  }
}

lemma UniqueKeysFacts(s: RuntimeRegistries)
  ensures alwaysUniqueKeys(s) == (ProofLib.DistinctBy(s.workers, (w: Worker) => w.name) && ProofLib.DistinctBy(s.categories, (c: SearchCategory) => c.key) && ProofLib.DistinctBy(s.providers, (p: ResolvedProvider) => p.modelType))
{
  KeyCountsDistinct(s.workers, (w: Worker) => w.name, (w: Worker) => (other: Worker) => (other.name == w.name));
  KeyCountsDistinct(s.categories, (c: SearchCategory) => c.key, (c: SearchCategory) => (other: SearchCategory) => (other.key == c.key));
  KeyCountsDistinct(s.providers, (p: ResolvedProvider) => p.modelType, (p: ResolvedProvider) => (other: ResolvedProvider) => (other.modelType == p.modelType));
}

lemma UpsertKeepsDistinct<T, K>(xs: seq<T>, ys: seq<T>, key: T -> K, k: K, item: T)
  requires ProofLib.DistinctBy(xs, key) && key(item) == k
  requires (exists x :: x in xs && key(x) == k) ==> |ys| == |xs| && forall i :: 0 <= i < |xs| ==> key(ys[i]) == key(xs[i])
  requires !(exists x :: x in xs && key(x) == k) ==> ys == xs + [item]
  ensures ProofLib.DistinctBy(ys, key)
{
  if !(exists x :: x in xs && key(x) == k) {
    forall i | 0 <= i < |xs|
      ensures key(xs[i]) != k
    {
      assert xs[i] in xs;
    }
  }
}

lemma ReplaceKeepsDistinct<T, K>(xs: seq<T>, keep: T -> bool, key: T -> K, item: T)
  requires ProofLib.DistinctBy(xs, key)
  requires forall x :: keep(x) == (key(x) != key(item))
  ensures ProofLib.DistinctBy(ProofLib.Filter(keep, xs) + [item], key)
{
  ProofLib.FilterKeepsDistinctBy(keep, xs, key);
  forall x | x in ProofLib.Filter(keep, xs)
    ensures key(x) != key(item)
  {
    ProofLib.FilterMember(keep, xs, x);
  }
  ProofLib.DistinctByConcat(ProofLib.Filter(keep, xs), [item], key);
}

lemma registerWorker_ensures(s: RuntimeRegistries, workerName: string, reference: int)
  ensures (inv(s) ==> canRegisterWorker(s, workerName, reference) ==> alwaysComponentNamesUnique(registerWorker(s, workerName, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, workerName, reference) ==> alwaysComponentOwnershipValid(registerWorker(s, workerName, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, workerName, reference) ==> alwaysModelRegistrationOrderUnique(registerWorker(s, workerName, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, workerName, reference) ==> alwaysModelSelectionPriority(registerWorker(s, workerName, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, workerName, reference) ==> alwaysRegistryCountersNonnegative(registerWorker(s, workerName, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, workerName, reference) ==> alwaysLocalizedSlotUnique(registerWorker(s, workerName, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, workerName, reference) ==> alwaysUniqueKeys(registerWorker(s, workerName, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, workerName, reference) ==> stepRegisterWorkerWakesScheduler(s, "registerWorker", registerWorker(s, workerName, reference)))
  ensures (inv(s) ==> canRegisterWorker(s, workerName, reference) ==> stepCategoryIsolation(s, "registerWorker", registerWorker(s, workerName, reference)))
{
  if inv(s) && canRegisterWorker(s, workerName, reference) {
    var after := registerWorker(s, workerName, reference);
    UniqueKeysFacts(s);
    UniqueKeysFacts(after);
    UpsertKeepsDistinct(s.workers, after.workers, (w: Worker) => w.name, workerName, Worker(workerName, reference));
  }
}

lemma unregisterWorker_ensures(s: RuntimeRegistries, workerName: string)
  ensures (inv(s) ==> alwaysComponentNamesUnique(unregisterWorker(s, workerName)))
  ensures (inv(s) ==> alwaysComponentOwnershipValid(unregisterWorker(s, workerName)))
  ensures (inv(s) ==> alwaysModelRegistrationOrderUnique(unregisterWorker(s, workerName)))
  ensures (inv(s) ==> alwaysModelSelectionPriority(unregisterWorker(s, workerName)))
  ensures (inv(s) ==> alwaysRegistryCountersNonnegative(unregisterWorker(s, workerName)))
  ensures (inv(s) ==> alwaysLocalizedSlotUnique(unregisterWorker(s, workerName)))
  ensures (inv(s) ==> alwaysUniqueKeys(unregisterWorker(s, workerName)))
  ensures (inv(s) ==> stepRegisterWorkerWakesScheduler(s, "unregisterWorker", unregisterWorker(s, workerName)))
  ensures (inv(s) ==> stepCategoryIsolation(s, "unregisterWorker", unregisterWorker(s, workerName)))
{
  if inv(s) {
    var after := unregisterWorker(s, workerName);
    UniqueKeysFacts(s);
    UniqueKeysFacts(after);
    ProofLib.FilterKeepsDistinctBy((w: Worker) => (w.name != workerName), s.workers, (w: Worker) => w.name);
  }
}

lemma registerCategory_ensures(s: RuntimeRegistries, category: SearchCategory)
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> alwaysComponentNamesUnique(registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> alwaysComponentOwnershipValid(registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> alwaysModelRegistrationOrderUnique(registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> alwaysModelSelectionPriority(registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> alwaysRegistryCountersNonnegative(registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> alwaysLocalizedSlotUnique(registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> alwaysUniqueKeys(registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> stepRegisterWorkerWakesScheduler(s, "registerCategory", registerCategory(s, category)))
  ensures (inv(s) ==> canRegisterCategory(s, category) ==> stepCategoryIsolation(s, "registerCategory", registerCategory(s, category)))
{
  if inv(s) && canRegisterCategory(s, category) {
    var after := registerCategory(s, category);
    UniqueKeysFacts(s);
    UniqueKeysFacts(after);
    UpsertKeepsDistinct(s.categories, after.categories, (c: SearchCategory) => c.key, category.key, category);
  }
}

lemma noteResolvedProvider_ensures(s: RuntimeRegistries, modelType: string, providerName: string, nonblank: bool)
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, providerName, nonblank) ==> alwaysComponentNamesUnique(noteResolvedProvider(s, modelType, providerName, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, providerName, nonblank) ==> alwaysComponentOwnershipValid(noteResolvedProvider(s, modelType, providerName, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, providerName, nonblank) ==> alwaysModelRegistrationOrderUnique(noteResolvedProvider(s, modelType, providerName, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, providerName, nonblank) ==> alwaysModelSelectionPriority(noteResolvedProvider(s, modelType, providerName, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, providerName, nonblank) ==> alwaysRegistryCountersNonnegative(noteResolvedProvider(s, modelType, providerName, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, providerName, nonblank) ==> alwaysLocalizedSlotUnique(noteResolvedProvider(s, modelType, providerName, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, providerName, nonblank) ==> alwaysUniqueKeys(noteResolvedProvider(s, modelType, providerName, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, providerName, nonblank) ==> stepRegisterWorkerWakesScheduler(s, "noteResolvedProvider", noteResolvedProvider(s, modelType, providerName, nonblank)))
  ensures (inv(s) ==> canNoteResolvedProvider(s, modelType, providerName, nonblank) ==> stepCategoryIsolation(s, "noteResolvedProvider", noteResolvedProvider(s, modelType, providerName, nonblank)))
{
  if inv(s) && canNoteResolvedProvider(s, modelType, providerName, nonblank) && nonblank {
    var after := noteResolvedProvider(s, modelType, providerName, nonblank);
    UniqueKeysFacts(s);
    UniqueKeysFacts(after);
    ReplaceKeepsDistinct(s.providers, (p: ResolvedProvider) => (p.modelType != modelType), (p: ResolvedProvider) => p.modelType, ResolvedProvider(modelType, providerName));
  }
}
