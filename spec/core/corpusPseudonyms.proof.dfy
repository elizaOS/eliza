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
