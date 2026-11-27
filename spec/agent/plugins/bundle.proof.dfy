lemma ManifestPackagesBridge(m: BundleManifest, bundleBytesSha256: string)
  ensures manifestReadable(m, bundleBytesSha256) == ((((((((((((m.schema == 1) && (m.node == "26")) && (m.sourceCommit != "")) && (m.schemaVersion > 0)) && (m.bundleSha256 != "")) && (m.bundleSha256 == bundleBytesSha256)) && (|m.packages| > 0)) && !((exists r :: r in m.packages && !((|ProofLib.Filter((o: PackageRow) => (o == r), m.packages)| == 1))))) && pluginsWellFormed(m.plugins, m.productPlugin)) && (m.localInference == (localInferencePlugin in m.plugins))) && (workerPinned(m.workflowWorker) == (workflowPlugin in m.plugins))) && actionsWellFormed(m.actions))
{
}

lemma DerivedLoadListBridge(groups: ProfileGroups, carried: seq<string>, deviceVariant: DeviceVariant, chosen: seq<string>)
  ensures lawDerivedLoadListNamesOnlyCarriedPluginsOnce(groups, carried, deviceVariant, chosen) == (var local_6 := variantLoadList(groups, deviceVariant, chosen); (!(profilesWellFormed(groups, carried)) || !((exists n :: n in local_6 && !(((n in carried) && (|ProofLib.Filter((m: string) => (m == n), local_6)| == 1)))))))
{
}

lemma RowsComeFromContributingInputs(f: (seq<PackageRow>, BundleInput) -> seq<PackageRow>, acc: seq<PackageRow>, xs: seq<BundleInput>, r: PackageRow)
  requires forall rows, i :: f(rows, i) == (if (inputDisposition(i).Contributes? && !((rowOf(i) in rows))) then (rows + [rowOf(i)]) else rows)
  ensures r in Std.Collections.Seq.FoldLeft(f, acc, xs) ==> r in acc || (exists i :: i in xs && inputDisposition(i).Contributes? && rowOf(i) == r)
  decreases |xs|
{
  if |xs| > 0 {
    RowsComeFromContributingInputs(f, f(acc, xs[0]), xs[1..], r);
    if r in Std.Collections.Seq.FoldLeft(f, f(acc, xs[0]), xs[1..]) && !(r in acc) && r in f(acc, xs[0]) {
      assert r == rowOf(xs[0]);
      assert xs[0] in xs;
    }
    if (exists i :: i in xs[1..] && inputDisposition(i).Contributes? && rowOf(i) == r) {
      var i :| i in xs[1..] && inputDisposition(i).Contributes? && rowOf(i) == r;
      assert i in xs;
    }
  }
}

lemma RowsAreDistinct(f: (seq<PackageRow>, BundleInput) -> seq<PackageRow>, acc: seq<PackageRow>, xs: seq<BundleInput>)
  requires forall rows, i :: f(rows, i) == (if (inputDisposition(i).Contributes? && !((rowOf(i) in rows))) then (rows + [rowOf(i)]) else rows)
  requires ProofLib.Distinct(acc)
  ensures ProofLib.Distinct(Std.Collections.Seq.FoldLeft(f, acc, xs))
  decreases |xs|
{
  if |xs| > 0 {
    RowsAreDistinct(f, f(acc, xs[0]), xs[1..]);
  }
}

lemma FilterKeepsDistinct(p: string -> bool, xs: seq<string>)
  requires ProofLib.Distinct(xs)
  ensures ProofLib.Distinct(ProofLib.Filter(p, xs))
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    var tail := xs[1..];
    FilterKeepsDistinct(p, tail);
    var ft := ProofLib.Filter(p, tail);
    if p(xs[0]) {
      forall j | 0 <= j < |ft| ensures ft[j] != xs[0] {
        ProofLib.FilterMember(p, tail, ft[j]);
        assert ft[j] in tail;
      }
    }
  }
}

lemma ConcatDistinctSplit<T>(a: seq<T>, b: seq<T>)
  requires ProofLib.Distinct(a + b)
  ensures ProofLib.Distinct(a) && ProofLib.Distinct(b)
  ensures forall x :: x in a ==> !(x in b)
{
  var ab := a + b;
  forall i, j | 0 <= i < j < |a| ensures a[i] != a[j] {
    assert ab[i] == a[i] && ab[j] == a[j];
  }
  forall i, j | 0 <= i < j < |b| ensures b[i] != b[j] {
    assert ab[|a| + i] == b[i] && ab[|a| + j] == b[j];
  }
  forall x | x in a ensures !(x in b) {
    if x in b {
      var i :| 0 <= i < |a| && a[i] == x;
      var j :| 0 <= j < |b| && b[j] == x;
      assert ab[i] == ab[|a| + j];
      assert false;
    }
  }
}

lemma ConcatDistinctJoin<T>(a: seq<T>, b: seq<T>)
  requires ProofLib.Distinct(a) && ProofLib.Distinct(b)
  requires forall x :: x in a ==> !(x in b)
  ensures ProofLib.Distinct(a + b)
{
  var ab := a + b;
  forall i, j | 0 <= i < j < |ab| ensures ab[i] != ab[j] {
    if i < |a| && j >= |a| {
      assert ab[i] in a && ab[j] in b;
    }
  }
}

lemma ProfilesDistinct(groups: ProfileGroups, carried: seq<string>)
  requires profilesWellFormed(groups, carried)
  ensures ProofLib.Distinct(groupedPlugins(groups))
  ensures ProofLib.Distinct(groups.core + groups.views)
  ensures ProofLib.Distinct(groups.aospOnly)
  ensures ProofLib.Distinct(groups.optional)
  ensures forall x :: x in (groups.core + groups.views) ==> !(x in groups.aospOnly) && !(x in groups.optional)
  ensures forall x :: x in groups.aospOnly ==> !(x in groups.optional)
{
  var all := groupedPlugins(groups);
  forall i, j | 0 <= i < |all| && 0 <= j < |all| && i != j ensures all[i] != all[j] {
    var n := all[i];
    assert n in all;
    ProofLib.FilterCountOneIffUnique((m: string) => (m == n), all, (m: string) => m, i);
  }
  var cva := (groups.core + groups.views) + groups.aospOnly;
  ConcatDistinctSplit(cva, groups.optional);
  ConcatDistinctSplit(groups.core + groups.views, groups.aospOnly);
}

lemma lawExcludedPackageNeverShips_ensures(b: Build, name: string)
  ensures (lawExcludedPackageNeverShips(b, name) == true)
{
  var f := (rows: seq<PackageRow>, i: BundleInput) => (if (inputDisposition(i).Contributes? && !((rowOf(i) in rows))) then (rows + [rowOf(i)]) else rows);
  if buildVerdict(b).Built? && name in excludedPackages && (exists r :: r in packageRows(b) && r.name == name) {
    var r :| r in packageRows(b) && r.name == name;
    assert packageRows(b) == Std.Collections.Seq.FoldLeft(f, [], b.inputs);
    RowsComeFromContributingInputs(f, [], b.inputs, r);
    var i :| i in b.inputs && inputDisposition(i).Contributes? && rowOf(i) == r;
    assert contributesExcluded(b);
  }
}

lemma lawCloudOnlyBundleCarriesNoLocalInference_ensures(b: Build)
  ensures (lawCloudOnlyBundleCarriesNoLocalInference(b) == true)
{
  if buildVerdict(b).Built? && !carriesLocalInference(b) {
    var req := requiredFiles(false);
    var p := (set_x: string) => !((set_x in req));
    ProofLib.FilterCons(p, [manifestFile]);
    assert [manifestFile][0] == manifestFile && [manifestFile][1..] == [];
    ProofLib.FilterNil(p, []);
    assert req + ProofLib.Filter(p, [manifestFile]) == baseFiles + [manifestFile];
    forall f | f in b.files
      ensures f.extension != sharedLibraryExtension && !(f.name in localInferencePrograms) && !(exists d :: d in f.directories && d in localInferenceDirectories)
    {
      assert fileAdmitted(false, f);
      assert f.directories == [];
      assert f.name in (baseFiles + [manifestFile]);
    }
  }
}

lemma lawBuiltBundleManifestIsReadable_ensures(b: Build, bundleSha256: string, sourceCommit: string)
  ensures (lawBuiltBundleManifestIsReadable(b, bundleSha256, sourceCommit) == true)
{
  if buildVerdict(b).Built? && bundleSha256 != "" && sourceCommit != "" {
    var f := (rows: seq<PackageRow>, i: BundleInput) => (if (inputDisposition(i).Contributes? && !((rowOf(i) in rows))) then (rows + [rowOf(i)]) else rows);
    var rows := packageRows(b);
    assert rows == Std.Collections.Seq.FoldLeft(f, [], b.inputs);
    RowsAreDistinct(f, [], b.inputs);
    var m := manifestOf(b, bundleSha256, sourceCommit);
    ManifestPackagesBridge(m, bundleSha256);
    forall r | r in rows ensures |ProofLib.Filter((o: PackageRow) => (o == r), rows)| == 1 {
      ProofLib.FilterDistinctCountOne((o: PackageRow) => (o == r), rows, r);
    }
  }
}

lemma lawDerivedLoadListNamesOnlyCarriedPluginsOnce_ensures(groups: ProfileGroups, carried: seq<string>, deviceVariant: DeviceVariant, chosen: seq<string>)
  ensures (lawDerivedLoadListNamesOnlyCarriedPluginsOnce(groups, carried, deviceVariant, chosen) == true)
{
  DerivedLoadListBridge(groups, carried, deviceVariant, chosen);
  if profilesWellFormed(groups, carried) {
    ProfilesDistinct(groups, carried);
    var p := (n: string) => (n in chosen);
    var opt := ProofLib.Filter(p, groups.optional);
    FilterKeepsDistinct(p, groups.optional);
    var prefix := (groups.core + groups.views) + (if deviceVariant.AospImage? then groups.aospOnly else []);
    ConcatDistinctJoin(groups.core + groups.views, if deviceVariant.AospImage? then groups.aospOnly else []);
    forall x | x in opt ensures x in groups.optional {
      ProofLib.FilterMember(p, groups.optional, x);
    }
    ConcatDistinctJoin(prefix, opt);
    var listed := variantLoadList(groups, deviceVariant, chosen);
    assert listed == prefix + opt;
    forall n | n in listed ensures n in carried && |ProofLib.Filter((m: string) => (m == n), listed)| == 1 {
      assert n in groupedPlugins(groups);
      ProofLib.FilterDistinctCountOne((m: string) => (m == n), listed, n);
    }
  }
}

lemma lawStockAndroidNeverLoadsAnAospOnlyPlugin_ensures(groups: ProfileGroups, carried: seq<string>, chosen: seq<string>)
  ensures (lawStockAndroidNeverLoadsAnAospOnlyPlugin(groups, carried, chosen) == true)
{
  if profilesWellFormed(groups, carried) {
    ProfilesDistinct(groups, carried);
    var p := (n: string) => (n in chosen);
    var opt := ProofLib.Filter(p, groups.optional);
    forall x | x in opt ensures x in groups.optional {
      ProofLib.FilterMember(p, groups.optional, x);
    }
  }
}

lemma lawOptionalPluginLoadsOnlyWhenChosen_ensures(groups: ProfileGroups, carried: seq<string>, deviceVariant: DeviceVariant, chosen: seq<string>)
  ensures (lawOptionalPluginLoadsOnlyWhenChosen(groups, carried, deviceVariant, chosen) == true)
{
  if profilesWellFormed(groups, carried) {
    ProfilesDistinct(groups, carried);
    var p := (n: string) => (n in chosen);
    forall n | n in groups.optional ensures (n in variantLoadList(groups, deviceVariant, chosen)) == (n in chosen) {
      ProofLib.FilterMember(p, groups.optional, n);
    }
  }
}

lemma lawAHostModuleNeverReplacesAnAgentModule_ensures(names: seq<string>, bundled: seq<string>, builtins: seq<string>)
  ensures (lawAHostModuleNeverReplacesAnAgentModule(names, bundled, builtins) == true)
{
  if hostModulesAdmitted(names, bundled, builtins) {
    var p := (set_x: string) => (set_x in builtins);
    forall i | 0 <= i < |names| ensures !p(names[i]) {
      assert names[i] in names;
    }
    ProofLib.FilterNone(p, names);
  }
}
