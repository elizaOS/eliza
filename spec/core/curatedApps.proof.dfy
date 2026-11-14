lemma refreshLookup_ensures(a: CuratedApps, instance: string)
  ensures (inv(a) ==> canRefreshLookup(a, instance) ==> alwaysVersionsNonnegative(refreshLookup(a, instance)))
  ensures (inv(a) ==> canRefreshLookup(a, instance) ==> stepLocalAliasesRetained(a, refreshLookup(a, instance)))
{
  if inv(a) && canRefreshLookup(a, instance) {
    var after := refreshLookup(a, instance);
    var newInstance := (member: string) => !(member in a.instances);
    if instance in a.instances {
      ProofLib.FilterNone(newInstance, [instance]);
    } else {
      ProofLib.FilterOne(newInstance, [instance], 0);
      ProofLib.FilterMember(newInstance, [instance], instance);
    }
    forall member | member in after.instances ensures lookup0_core__curatedApps(after.localVersions, member, 0) <= after.version {
      if member == instance {
        assert "$" + member in after.localVersions;
        assert after.localVersions["$" + member] == a.version;
      } else {
        if member !in a.instances {
          ProofLib.FilterMember(newInstance, [instance], member);
          assert member in [instance];
        }
        AppSlotKeysDistinct(member, instance);
        assert ("$" + member in after.localVersions) == ("$" + member in a.localVersions);
        assert lookup0_core__curatedApps(after.localVersions, member, 0) == lookup0_core__curatedApps(a.localVersions, member, 0);
      }
    }
    forall member | member in a.instances ensures forall key :: key in localAt(a, member).keys ==> key in localAt(after, member).keys {
      assert member in after.instances;
      if member == instance {
        assert "$" + member in after.locals;
        assert localAt(after, member) == Std.Collections.Seq.FoldLeft((table: AliasTable, definition: AppDefinition) => addDefinitionKeys(table, definition), localAt(a, member), a.definitions);
        AppOverlayRetains(localAt(a, member), a.definitions);
      } else {
        AppSlotKeysDistinct(member, instance);
        assert localAt(a, member) == localAt(after, member);
      }
    }
  }
}

lemma AppSlotKeysDistinct(left: string, right: string)
  requires left != right
  ensures "$" + left != "$" + right
{
  if "$" + left == "$" + right {
    assert ("$" + left)[1..] == left;
    assert ("$" + right)[1..] == right;
  }
}

lemma AppOverlayRetains(table: AliasTable, definitions: seq<AppDefinition>)
  ensures forall key :: key in table.keys ==> key in Std.Collections.Seq.FoldLeft((table: AliasTable, definition: AppDefinition) => addDefinitionKeys(table, definition), table, definitions).keys
  decreases |definitions|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |definitions| > 0 {
    AppDefinitionRetains(table, definitions[0]);
    AppOverlayRetains(addDefinitionKeys(table, definitions[0]), definitions[1..]);
  }
}

lemma AppDefinitionRetains(table: AliasTable, definition: AppDefinition)
  ensures forall key :: key in table.keys ==> key in addDefinitionKeys(table, definition).keys
{
  AppKeysRetained(table, definition.keys, definition.slug);
}

lemma AppKeysRetained(table: AliasTable, keys: seq<string>, definitionSlug: string)
  ensures forall previous :: previous in table.keys ==> previous in Std.Collections.Seq.FoldLeft((accumulator: AliasTable, key: string) => addDefinitionKey(accumulator, key, definitionSlug), table, keys).keys
  decreases |keys|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |keys| > 0 {
    var add := (accumulator: AliasTable, key: string) => addDefinitionKey(accumulator, key, definitionSlug);
    var next := addDefinitionKey(table, keys[0], definitionSlug);
    assert Std.Collections.Seq.FoldLeft(add, table, keys) == Std.Collections.Seq.FoldLeft(add, next, keys[1..]);
    AppKeysRetained(next, keys[1..], definitionSlug);
    forall prior | prior in table.keys ensures prior in Std.Collections.Seq.FoldLeft(add, table, keys).keys {
      assert prior in next.keys;
      assert prior in Std.Collections.Seq.FoldLeft(add, next, keys[1..]).keys;
    }
  } else {
    assert keys == [];
  }
}
