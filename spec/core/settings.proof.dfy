lemma SettingsFilters(s: RuntimeSettings)
  ensures alwaysUniqueSettingPairs(s) == (forall slot :: slot in s.slots ==> |ProofLib.Filter((other: SettingSlot) => ((other.runtimeId == slot.runtimeId) && (other.key == slot.key)), s.slots)| == 1)
  ensures alwaysLinkedSecretContainersAgree(s) == (forall slot :: slot in s.slots ==> slot.layers.nestedAliasesSecret == (slot.runtimeId in s.linkedRuntimes) && (slot.layers.nestedAliasesSecret ==> slot.layers.secret == slot.layers.nested))
{}

lemma SettingsDistinct(slots: seq<SettingSlot>)
  ensures (forall slot :: slot in slots ==> |ProofLib.Filter((other: SettingSlot) => ((other.runtimeId == slot.runtimeId) && (other.key == slot.key)), slots)| == 1) <==> ProofLib.DistinctBy(slots, (slot: SettingSlot) => (slot.runtimeId, slot.key))
{
  if forall slot :: slot in slots ==> |ProofLib.Filter((other: SettingSlot) => ((other.runtimeId == slot.runtimeId) && (other.key == slot.key)), slots)| == 1 {
    forall i, j | 0 <= i < |slots| && 0 <= j < |slots| && i != j
      ensures (slots[i].runtimeId, slots[i].key) != (slots[j].runtimeId, slots[j].key)
    {
      ProofLib.FilterCountOneIffUnique((other: SettingSlot) => ((other.runtimeId == slots[i].runtimeId) && (other.key == slots[i].key)), slots, (slot: SettingSlot) => (slot.runtimeId, slot.key), i);
    }
  } else if ProofLib.DistinctBy(slots, (slot: SettingSlot) => (slot.runtimeId, slot.key)) {
    forall slot | slot in slots
      ensures |ProofLib.Filter((other: SettingSlot) => ((other.runtimeId == slot.runtimeId) && (other.key == slot.key)), slots)| == 1
    {
      var i :| 0 <= i < |slots| && slots[i] == slot;
      ProofLib.FilterOne((other: SettingSlot) => ((other.runtimeId == slot.runtimeId) && (other.key == slot.key)), slots, i);
    }
  }
}

lemma SettingsReplaceParts(s: RuntimeSettings, runtimeId: string, key: string, layers: SettingLayers)
  ensures replaceSetting(s, runtimeId, key, layers) == ProofLib.Filter((slot: SettingSlot) => ((slot.runtimeId != runtimeId) || (slot.key != key)), s.slots) + [SettingSlot(runtimeId, key, layers)]
{}

lemma SettingsReplaceDistinct(s: RuntimeSettings, runtimeId: string, key: string, layers: SettingLayers)
  requires ProofLib.DistinctBy(s.slots, (slot: SettingSlot) => (slot.runtimeId, slot.key))
  ensures ProofLib.DistinctBy(replaceSetting(s, runtimeId, key, layers), (slot: SettingSlot) => (slot.runtimeId, slot.key))
{
  SettingsReplaceParts(s, runtimeId, key, layers);
  var kept := ProofLib.Filter((slot: SettingSlot) => ((slot.runtimeId != runtimeId) || (slot.key != key)), s.slots);
  ProofLib.FilterKeepsDistinctBy((slot: SettingSlot) => ((slot.runtimeId != runtimeId) || (slot.key != key)), s.slots, (slot: SettingSlot) => (slot.runtimeId, slot.key));
  forall slot | slot in kept ensures (slot.runtimeId, slot.key) != (runtimeId, key) {
    ProofLib.FilterMember((slot: SettingSlot) => ((slot.runtimeId != runtimeId) || (slot.key != key)), s.slots, slot);
  }
  ProofLib.DistinctByConcat(kept, [SettingSlot(runtimeId, key, layers)], (slot: SettingSlot) => (slot.runtimeId, slot.key));
}

lemma SettingsLookup(s: RuntimeSettings, slot: SettingSlot)
  requires alwaysUniqueSettingPairs(s)
  requires slot in s.slots
  ensures settingAt(s, slot.runtimeId, slot.key) == slot.layers
{
  SettingsFilters(s);
  var matches := ProofLib.Filter((other: SettingSlot) => ((other.runtimeId == slot.runtimeId) && (other.key == slot.key)), s.slots);
  ProofLib.FilterMember((other: SettingSlot) => ((other.runtimeId == slot.runtimeId) && (other.key == slot.key)), s.slots, slot);
  assert |matches| == 1;
  assert matches[0] == slot;
}

lemma SettingsLookupAlias(s: RuntimeSettings, runtimeId: string, key: string)
  requires inv(s)
  ensures settingAt(s, runtimeId, key).nestedAliasesSecret == (runtimeId in s.linkedRuntimes)
  ensures settingAt(s, runtimeId, key).nestedAliasesSecret ==> settingAt(s, runtimeId, key).secret == settingAt(s, runtimeId, key).nested
{
  SettingsFilters(s);
  if hasSetting(s, runtimeId, key) {
    var slot :| slot in s.slots && slot.runtimeId == runtimeId && slot.key == key;
    SettingsLookup(s, slot);
  } else {
    ProofLib.FilterNone((slot: SettingSlot) => ((slot.runtimeId == runtimeId) && (slot.key == key)), s.slots);
  }
}

lemma SettingsAfterReplace(s: RuntimeSettings, runtimeId: string, key: string, layers: SettingLayers)
  requires inv(s)
  requires layers.nestedAliasesSecret == (runtimeId in s.linkedRuntimes)
  requires layers.nestedAliasesSecret ==> layers.secret == layers.nested
  ensures alwaysUniqueSettingPairs(RuntimeSettings(replaceSetting(s, runtimeId, key, layers), s.linkedRuntimes))
  ensures alwaysLinkedSecretContainersAgree(RuntimeSettings(replaceSetting(s, runtimeId, key, layers), s.linkedRuntimes))
  ensures stepAtMostOneRuntimeChanges(s, RuntimeSettings(replaceSetting(s, runtimeId, key, layers), s.linkedRuntimes))
  ensures stepExistingPairsRetained(s, RuntimeSettings(replaceSetting(s, runtimeId, key, layers), s.linkedRuntimes))
{
  SettingsFilters(s);
  SettingsDistinct(s.slots);
  SettingsReplaceDistinct(s, runtimeId, key, layers);
  SettingsReplaceParts(s, runtimeId, key, layers);
  var after := RuntimeSettings(replaceSetting(s, runtimeId, key, layers), s.linkedRuntimes);
  var kept := ProofLib.Filter((slot: SettingSlot) => ((slot.runtimeId != runtimeId) || (slot.key != key)), s.slots);
  SettingsFilters(after);
  SettingsDistinct(after.slots);
  assert alwaysUniqueSettingPairs(after);
  forall slot | slot in after.slots
    ensures slot.layers.nestedAliasesSecret == (slot.runtimeId in after.linkedRuntimes) && (slot.layers.nestedAliasesSecret ==> slot.layers.secret == slot.layers.nested)
  {
    if slot in kept {
      ProofLib.FilterMember((slot: SettingSlot) => ((slot.runtimeId != runtimeId) || (slot.key != key)), s.slots, slot);
    } else {
      assert slot == SettingSlot(runtimeId, key, layers);
    }
  }
  forall slot | slot in s.slots
    ensures hasSetting(after, slot.runtimeId, slot.key)
  {
    if slot.runtimeId == runtimeId && slot.key == key {
      assert SettingSlot(runtimeId, key, layers) in after.slots;
    } else {
      ProofLib.FilterMember((slot: SettingSlot) => ((slot.runtimeId != runtimeId) || (slot.key != key)), s.slots, slot);
      assert slot in after.slots;
    }
  }
  forall slot | slot in s.slots && slot.runtimeId != runtimeId
    ensures settingAt(after, slot.runtimeId, slot.key) == slot.layers
  {
    ProofLib.FilterMember((slot: SettingSlot) => ((slot.runtimeId != runtimeId) || (slot.key != key)), s.slots, slot);
    SettingsLookup(after, slot);
  }
  forall left | left in s.slots
    ensures forall right :: right in s.slots && left.runtimeId != right.runtimeId ==> settingAt(after, left.runtimeId, left.key) == left.layers || settingAt(after, right.runtimeId, right.key) == right.layers
  {
    forall right | right in s.slots && left.runtimeId != right.runtimeId
      ensures settingAt(after, left.runtimeId, left.key) == left.layers || settingAt(after, right.runtimeId, right.key) == right.layers
    {
      if left.runtimeId != runtimeId {
        assert settingAt(after, left.runtimeId, left.key) == left.layers;
      } else {
        assert right.runtimeId != runtimeId;
        assert settingAt(after, right.runtimeId, right.key) == right.layers;
      }
    }
  }
}

lemma SettingsLinkParts(s: RuntimeSettings, runtimeId: string)
  ensures |linkSecrets(s, runtimeId).slots| == |s.slots|
  ensures forall i :: 0 <= i < |s.slots| ==> linkSecrets(s, runtimeId).slots[i].runtimeId == s.slots[i].runtimeId && linkSecrets(s, runtimeId).slots[i].key == s.slots[i].key
  ensures forall i :: 0 <= i < |s.slots| ==> linkSecrets(s, runtimeId).slots[i] == (if s.slots[i].runtimeId == runtimeId then s.slots[i].(layers := linkedSecretContainers(s.slots[i].layers)) else s.slots[i])
  ensures forall id :: (id in linkSecrets(s, runtimeId).linkedRuntimes) <==> (id in s.linkedRuntimes || id == runtimeId)
{
  forall id: string
    ensures (id in linkSecrets(s, runtimeId).linkedRuntimes) <==> (id in s.linkedRuntimes || id == runtimeId)
  {
    ProofLib.FilterMember((set_x: string) => !((set_x in s.linkedRuntimes)), [runtimeId], id);
  }
}

lemma linkSecrets_ensures(s: RuntimeSettings, runtimeId: string)
  ensures (inv(s) ==> alwaysUniqueSettingPairs(linkSecrets(s, runtimeId)))
  ensures (inv(s) ==> alwaysLinkedSecretContainersAgree(linkSecrets(s, runtimeId)))
  ensures (inv(s) ==> stepAtMostOneRuntimeChanges(s, linkSecrets(s, runtimeId)))
  ensures (inv(s) ==> stepExistingPairsRetained(s, linkSecrets(s, runtimeId)))
{
  if inv(s) {
    var after := linkSecrets(s, runtimeId);
    SettingsFilters(s);
    SettingsFilters(after);
    SettingsDistinct(s.slots);
    SettingsLinkParts(s, runtimeId);
    forall i, j | 0 <= i < |after.slots| && 0 <= j < |after.slots| && i != j
      ensures (after.slots[i].runtimeId, after.slots[i].key) != (after.slots[j].runtimeId, after.slots[j].key)
    {}
    assert ProofLib.DistinctBy(after.slots, (slot: SettingSlot) => (slot.runtimeId, slot.key));
    SettingsDistinct(after.slots);
    assert alwaysUniqueSettingPairs(after);
    forall slot | slot in after.slots
      ensures slot.layers.nestedAliasesSecret == (slot.runtimeId in after.linkedRuntimes) && (slot.layers.nestedAliasesSecret ==> slot.layers.secret == slot.layers.nested)
    {
      var i :| 0 <= i < |after.slots| && after.slots[i] == slot;
      if slot.runtimeId == runtimeId {
        assert slot.layers == linkedSecretContainers(s.slots[i].layers);
      } else {
        assert slot == s.slots[i];
      }
    }
    forall slot | slot in s.slots
      ensures hasSetting(after, slot.runtimeId, slot.key)
    {
      var i :| 0 <= i < |s.slots| && s.slots[i] == slot;
      assert after.slots[i] in after.slots;
    }
    forall slot | slot in s.slots && slot.runtimeId != runtimeId
      ensures settingAt(after, slot.runtimeId, slot.key) == slot.layers
    {
      var i :| 0 <= i < |s.slots| && s.slots[i] == slot;
      assert after.slots[i] == slot;
      SettingsLookup(after, slot);
    }
    forall left | left in s.slots
      ensures forall right :: right in s.slots && left.runtimeId != right.runtimeId ==> settingAt(after, left.runtimeId, left.key) == left.layers || settingAt(after, right.runtimeId, right.key) == right.layers
    {
      forall right | right in s.slots && left.runtimeId != right.runtimeId
        ensures settingAt(after, left.runtimeId, left.key) == left.layers || settingAt(after, right.runtimeId, right.key) == right.layers
      {
        if left.runtimeId != runtimeId {
          assert settingAt(after, left.runtimeId, left.key) == left.layers;
        } else {
          assert right.runtimeId != runtimeId;
          assert settingAt(after, right.runtimeId, right.key) == right.layers;
        }
      }
    }
  }
}

lemma initializeSetting_ensures(s: RuntimeSettings, runtimeId: string, key: string, layers: SettingLayers)
  ensures (inv(s) ==> canInitializeSetting(s, runtimeId, key, layers) ==> alwaysUniqueSettingPairs(initializeSetting(s, runtimeId, key, layers)))
  ensures (inv(s) ==> canInitializeSetting(s, runtimeId, key, layers) ==> alwaysLinkedSecretContainersAgree(initializeSetting(s, runtimeId, key, layers)))
  ensures (inv(s) ==> canInitializeSetting(s, runtimeId, key, layers) ==> stepAtMostOneRuntimeChanges(s, initializeSetting(s, runtimeId, key, layers)))
  ensures (inv(s) ==> canInitializeSetting(s, runtimeId, key, layers) ==> stepExistingPairsRetained(s, initializeSetting(s, runtimeId, key, layers)))
{
  if inv(s) && canInitializeSetting(s, runtimeId, key, layers) {
    var normalized := if runtimeId in s.linkedRuntimes then linkedSecretContainers(layers) else layers.(nestedAliasesSecret := false);
    SettingsAfterReplace(s, runtimeId, key, normalized);
  }
}

lemma setSetting_ensures(s: RuntimeSettings, runtimeId: string, key: string, value: Value, secret: bool)
  ensures (inv(s) ==> canSetSetting(s, runtimeId, key, value, secret) ==> alwaysUniqueSettingPairs(setSetting(s, runtimeId, key, value, secret)))
  ensures (inv(s) ==> canSetSetting(s, runtimeId, key, value, secret) ==> alwaysLinkedSecretContainersAgree(setSetting(s, runtimeId, key, value, secret)))
  ensures (inv(s) ==> canSetSetting(s, runtimeId, key, value, secret) ==> stepAtMostOneRuntimeChanges(s, setSetting(s, runtimeId, key, value, secret)))
  ensures (inv(s) ==> canSetSetting(s, runtimeId, key, value, secret) ==> stepExistingPairsRetained(s, setSetting(s, runtimeId, key, value, secret)))
{
  if inv(s) && canSetSetting(s, runtimeId, key, value, secret) {
    SettingsLookupAlias(s, runtimeId, key);
    SettingsAfterReplace(s, runtimeId, key, updated(settingAt(s, runtimeId, key), value, secret));
  }
}
