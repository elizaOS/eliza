lemma lawConsumerSourceNeverReachesIntoOs_ensures(roots: HostRoots, path: SourcePath, wanted: SourceWanted)
  ensures (lawConsumerSourceNeverReachesIntoOs(roots, path, wanted) == true)
{
  var ref := SourceRef(SourceRoot.ConsumerRoot, path, wanted);
  if sourceAdmitted(roots, ref) && !hasPrefix(roots.consumer, roots.os) {
    var declared := [roots.consumer, roots.os] + (if roots.dependenciesDeclared then [roots.dependencies] else []);
    var place := roots.consumer + belowSegments(path);
    assert rootSegments(roots, ref.root) == roots.consumer;
    assert forall r :: r in declared ==> !hasPrefix(place, r) || hasPrefix(roots.consumer, r);
    assert declared[1] == roots.os;
    assert roots.os in declared;
    assert !hasPrefix(place, roots.os);
    assert pathAdmitted(path, wanted);
  }
}

lemma PrefixScanMatches(segments: seq<string>, prefix: seq<string>)
  requires |prefix| <= |segments|
  ensures Std.Collections.Seq.FoldLeft((scan: PrefixScan, part: string) => PrefixScan((scan.at + 1), (scan.matches && ((if ((0 <= scan.at) && (scan.at < |segments|)) then segments[scan.at] else "") == part))), PrefixScan(0, true), prefix) == PrefixScan(|prefix|, prefix == segments[..|prefix|])
  decreases |prefix|
{
  if |prefix| > 0 {
    var i := |prefix| - 1;
    assert prefix == prefix[..i] + [prefix[i]];
    assert segments[..|prefix|] == segments[..i] + [segments[i]];
    PrefixScanMatches(segments, prefix[..i]);
    ProofLib.FoldLeftAppend((scan: PrefixScan, part: string) => PrefixScan((scan.at + 1), (scan.matches && ((if ((0 <= scan.at) && (scan.at < |segments|)) then segments[scan.at] else "") == part))), PrefixScan(0, true), prefix[..i], prefix[i]);
  }
}

lemma SuffixScanKeepsRest(segments: seq<string>, cut: nat)
  ensures Std.Collections.Seq.FoldLeft((scan: SuffixScan, part: string) => SuffixScan((scan.index + 1), (if (scan.index < cut) then scan.kept else (scan.kept + [part]))), SuffixScan(0, []), segments) == SuffixScan(|segments|, if cut <= |segments| then segments[cut..] else [])
  decreases |segments|
{
  if |segments| > 0 {
    var i := |segments| - 1;
    assert segments == segments[..i] + [segments[i]];
    SuffixScanKeepsRest(segments[..i], cut);
    ProofLib.FoldLeftAppend((scan: SuffixScan, part: string) => SuffixScan((scan.index + 1), (if (scan.index < cut) then scan.kept else (scan.kept + [part]))), SuffixScan(0, []), segments[..i], segments[i]);
    if cut <= i {
      assert segments[cut..] == segments[..i][cut..] + [segments[i]];
    }
  }
}

lemma lawMappedSourceKeepsItsPathBelowTheModule_ensures(table: seq<ModuleRoot>, segments: seq<string>)
  ensures (lawMappedSourceKeepsItsPathBelowTheModule(table, segments) == true)
{
  var matches := (r: ModuleRoot) => hasPrefix(segments, r.prefix);
  var hits := ProofLib.Filter(matches, table);
  if |hits| == 0 {
    forall r | r in table ensures !hasPrefix(segments, r.prefix) {
      ProofLib.FilterMember(matches, table, r);
    }
  } else {
    var hit := hits[0];
    ProofLib.FilterMember(matches, table, hit);
    PrefixScanMatches(segments, hit.prefix);
    SuffixScanKeepsRest(segments, |hit.prefix|);
    assert segments == hit.prefix + segments[|hit.prefix|..];
  }
}
