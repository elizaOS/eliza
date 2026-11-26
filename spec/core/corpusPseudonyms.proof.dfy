lemma CorpusRemintKeepsEvidence(row: Cluster, proposals: seq<Remint>)
  ensures reminted(row,proposals).id == row.id && reminted(row,proposals).aliases == row.aliases &&
    reminted(row,proposals).identities == row.identities && reminted(row,proposals).evidence == row.evidence
{}

lemma CorpusClusterAt(s: Corpus,row: Cluster)
  requires inv(s) && row in s.clusters
  ensures clusterAt(s,row.id) == row
{
  var selected := ProofLib.Filter((cluster: Cluster) => cluster.id == row.id,s.clusters);
  ProofLib.FilterMember((cluster: Cluster) => cluster.id == row.id,s.clusters,row);
  assert |selected| == 1;
  assert selected[0] == row;
}

lemma assignCluster_ensures(s: Corpus, id: string, aliases: seq<string>, identities: seq<string>, evidence: seq<string>, pseudonym: string, ruleset: string, remints: seq<Remint>)
  ensures (inv(s) ==> canAssignCluster(s, id, aliases, identities, evidence, pseudonym, ruleset, remints) ==> alwaysCorpusIdentityIsUnique(assignCluster(s, id, aliases, identities, evidence, pseudonym, ruleset, remints)))
  ensures (inv(s) ==> canAssignCluster(s, id, aliases, identities, evidence, pseudonym, ruleset, remints) ==> stepClusterEvidenceIsRetained(s, assignCluster(s, id, aliases, identities, evidence, pseudonym, ruleset, remints)))
{
  if inv(s) && canAssignCluster(s,id,aliases,identities,evidence,pseudonym,ruleset,remints) {
    var retained := ProofLib.Filter((cluster: Cluster) => cluster.id != id,s.clusters);
    var previous := clusterAt(s,id);
    var t := assignCluster(s,id,aliases,identities,evidence,pseudonym,ruleset,remints);
    forall row | row in s.clusters
      ensures (exists kept :: kept in t.clusters && kept.id == row.id && (forall x :: x in row.aliases ==> x in kept.aliases) && (forall x :: x in row.identities ==> x in kept.identities) && (forall x :: x in row.evidence ==> x in kept.evidence))
    {
      if row.id == id {
        CorpusClusterAt(s,row);
        assert previous == row;
        var proposed := Cluster(id,row.pseudonym,
          row.aliases + ProofLib.Filter((x: string) => !(x in row.aliases),aliases),
          row.identities + ProofLib.Filter((x: string) => !(x in row.identities),identities),
          row.evidence + ProofLib.Filter((x: string) => !(x in row.evidence),evidence),
          row.superseded,ruleset);
        var kept := t.clusters[|retained|];
        assert kept == reminted(proposed,remints) && kept in t.clusters;
        CorpusRemintKeepsEvidence(proposed,remints);
      } else {
        ProofLib.FilterMember((cluster: Cluster) => cluster.id != id,s.clusters,row);
        var i :| 0 <= i < |retained| && retained[i] == row;
        assert t.clusters[i] == reminted(row,remints) && t.clusters[i] in t.clusters;
        CorpusRemintKeepsEvidence(row,remints);
      }
    }
  }
}

lemma CorpusStagedPseudonymFilter(stored: seq<MapEntry>, person: string)
  ensures stagedPseudonym(stored, person) ==
    (if 0 < |ProofLib.Filter((entry: MapEntry) => (entry.person == person), stored)|
     then ProofLib.Filter((entry: MapEntry) => (entry.person == person), stored)[0].token
     else 0)
{}

lemma CorpusTwoPeopleFilter(stagedPeople: seq<string>)
  ensures lawTwoPeopleNeverShareAPseudonym(stagedPeople) ==
    !((exists entry :: entry in oneAtATime(stagedPeople) && !((|ProofLib.Filter((other: MapEntry) => (other.token == entry.token), oneAtATime(stagedPeople))| == 1))))
{}

lemma lawALaterItemKeepsAnEarlierPseudonym_ensures(stored: seq<MapEntry>, person: string, laterPerson: string, completed: bool)
  ensures (lawALaterItemKeepsAnEarlierPseudonym(stored, person, laterPerson, completed) == true)
{
  if stagedPseudonym(stored, person) != 0 {
    var p := (entry: MapEntry) => (entry.person == person);
    CorpusStagedPseudonymFilter(stored, person);
    assert |ProofLib.Filter(p, stored)| > 0;
    if completed && stagedPseudonym(stored, laterPerson) == 0 {
      var e := MapEntry(laterPerson, |stored| + 1);
      assert stageItem(stored, laterPerson, completed) == stored + [e];
      CorpusStagedPseudonymFilter(stored + [e], person);
      ProofLib.FilterAppend(p, stored, e);
      assert ProofLib.Filter(p, stored + [e])[0] == ProofLib.Filter(p, stored)[0];
    }
  }
}

lemma CorpusStageStep(stored: seq<MapEntry>, person: string)
  requires forall i :: 0 <= i < |stored| ==> stored[i].token == i + 1
  ensures var next := stageItem(stored, person, true);
    (forall i :: 0 <= i < |next| ==> next[i].token == i + 1) &&
    stagedPseudonym(next, person) != 0 &&
    (forall q :: stagedPseudonym(stored, q) != 0 ==> stagedPseudonym(next, q) == stagedPseudonym(stored, q))
{
  var next := stageItem(stored, person, true);
  forall q | stagedPseudonym(stored, q) != 0
    ensures stagedPseudonym(next, q) == stagedPseudonym(stored, q)
  {
    lawALaterItemKeepsAnEarlierPseudonym_ensures(stored, q, person, true);
  }
  if stagedPseudonym(stored, person) == 0 {
    var e := MapEntry(person, |stored| + 1);
    assert next == stored + [e];
    var p := (entry: MapEntry) => (entry.person == person);
    CorpusStagedPseudonymFilter(next, person);
    ProofLib.FilterMember(p, next, e);
    var hits := ProofLib.Filter(p, next);
    assert |hits| > 0;
    ProofLib.FilterMember(p, next, hits[0]);
    var k :| 0 <= k < |next| && next[k] == hits[0];
    assert hits[0].token == k + 1;
  }
}

lemma CorpusStageFold(acc: seq<MapEntry>, xs: seq<string>)
  requires forall i :: 0 <= i < |acc| ==> acc[i].token == i + 1
  ensures var res := Std.Collections.Seq.FoldLeft((stored: seq<MapEntry>, person: string) => stageItem(stored, person, true), acc, xs);
    (forall i :: 0 <= i < |res| ==> res[i].token == i + 1) &&
    (forall q :: stagedPseudonym(acc, q) != 0 ==> stagedPseudonym(res, q) != 0) &&
    (forall q :: q in xs ==> stagedPseudonym(res, q) != 0)
  decreases |xs|
{
  var f := (stored: seq<MapEntry>, person: string) => stageItem(stored, person, true);
  if |xs| > 0 {
    var next := f(acc, xs[0]);
    CorpusStageStep(acc, xs[0]);
    assert Std.Collections.Seq.FoldLeft(f, acc, xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    CorpusStageFold(next, xs[1..]);
    var res := Std.Collections.Seq.FoldLeft(f, acc, xs);
    forall q | q in xs
      ensures stagedPseudonym(res, q) != 0
    {
      if q == xs[0] {
        assert stagedPseudonym(next, q) != 0;
      } else {
        assert q in xs[1..];
      }
    }
  }
}

lemma lawEveryStagedPersonKeepsAPseudonym_ensures(stagedPeople: seq<string>)
  ensures (lawEveryStagedPersonKeepsAPseudonym(stagedPeople) == true)
{
  CorpusStageFold([], stagedPeople);
}

lemma lawTwoPeopleNeverShareAPseudonym_ensures(stagedPeople: seq<string>)
  ensures (lawTwoPeopleNeverShareAPseudonym(stagedPeople) == true)
{
  CorpusStageFold([], stagedPeople);
  CorpusTwoPeopleFilter(stagedPeople);
  var res := oneAtATime(stagedPeople);
  forall entry | entry in res
    ensures |ProofLib.Filter((other: MapEntry) => (other.token == entry.token), res)| == 1
  {
    var i :| 0 <= i < |res| && res[i] == entry;
    ProofLib.FilterOne((other: MapEntry) => (other.token == entry.token), res, i);
  }
}
