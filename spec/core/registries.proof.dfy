lemma RegistryComponentFacts(s: ExtensionRegistry)
  ensures alwaysComponentNamesUnique(s) ==
    (forall row :: row in s.components ==> |ProofLib.Filter((other: ComponentRegistration) => other.kind == row.kind && other.name == row.name, s.components)| == 1)
  ensures alwaysComponentOwnershipValid(s) ==
    (forall row :: row in s.components ==> row.reference > 0 && row.owner >= 0)
{}

lemma RegistryModelFacts(s: ExtensionRegistry)
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

lemma RegistryRetainComponents(s: ExtensionRegistry, after: ExtensionRegistry, keep: ComponentRegistration -> bool)
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

lemma RegistryAppendModel(s: ExtensionRegistry, after: ExtensionRegistry, row: ModelRegistration)
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

lemma RegistryRetainModels(s: ExtensionRegistry, after: ExtensionRegistry, keep: ModelRegistration -> bool)
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

lemma RegistryModelSelection(s: ExtensionRegistry)
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

lemma registerComponent_ensures(s: ExtensionRegistry, kind: ComponentKind, name: string, reference: int, owner: int, allowsOverride: bool)
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysComponentNamesUnique(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysComponentOwnershipValid(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysModelRegistrationOrderUnique(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysModelSelectionPriority(registerComponent(s, kind, name, reference, owner, allowsOverride)))
  ensures (inv(s) ==> canRegisterComponent(s, kind, name, reference, owner, allowsOverride) ==> alwaysRegistryCountersNonnegative(registerComponent(s, kind, name, reference, owner, allowsOverride)))
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

lemma unregisterComponent_ensures(s: ExtensionRegistry, kind: ComponentKind, name: string)
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysComponentNamesUnique(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysComponentOwnershipValid(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysModelRegistrationOrderUnique(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysModelSelectionPriority(unregisterComponent(s, kind, name)))
  ensures (inv(s) ==> canUnregisterComponent(s, kind, name) ==> alwaysRegistryCountersNonnegative(unregisterComponent(s, kind, name)))
{
  if inv(s) && canUnregisterComponent(s, kind, name) {
    var after := unregisterComponent(s, kind, name);
    RegistryRetainComponents(s, after, (row: ComponentRegistration) => row.kind != kind || row.name != name);
  }
}

lemma registerModel_ensures(s: ExtensionRegistry, modelType: string, provider: string, reference: int, priority: int, owner: int, capabilityEnabled: bool)
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysComponentNamesUnique(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysComponentOwnershipValid(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysModelRegistrationOrderUnique(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysModelSelectionPriority(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
  ensures (inv(s) ==> canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) ==> alwaysRegistryCountersNonnegative(registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled)))
{
  if inv(s) && canRegisterModel(s, modelType, provider, reference, priority, owner, capabilityEnabled) && capabilityEnabled {
    var after := registerModel(s, modelType, provider, reference, priority, owner, capabilityEnabled);
    RegistryAppendModel(s, after, ModelRegistration(modelType, provider, reference, priority, s.nextOrder, owner));
    RegistryModelSelection(after);
  }
}

lemma unloadOwner_ensures(s: ExtensionRegistry, owner: int)
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysComponentNamesUnique(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysComponentOwnershipValid(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysModelRegistrationOrderUnique(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysModelSelectionPriority(unloadOwner(s, owner)))
  ensures (inv(s) ==> canUnloadOwner(s, owner) ==> alwaysRegistryCountersNonnegative(unloadOwner(s, owner)))
{
  if inv(s) && canUnloadOwner(s, owner) {
    var after := unloadOwner(s, owner);
    RegistryRetainComponents(s, after, (row: ComponentRegistration) => row.owner != owner);
    RegistryRetainModels(s, after, (row: ModelRegistration) => row.owner != owner);
    RegistryModelSelection(after);
  }
}
