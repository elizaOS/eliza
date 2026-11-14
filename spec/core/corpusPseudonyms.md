# Corpus pseudonym identity

The source is `packages/core/src/security/pii-pseudonym-map.ts` at the pinned baseline. A protected map owns clusters, case-folded alias owners, unique platform identity owners, pseudonym names and superseded names. Case-folding and alias filtering occur before the normalized inputs below. Assigning a platform identity to another cluster is rejected before mutation. Cluster merging is owned by the identity merge engine.

## Story: Preserve one pseudonym per verified cluster across corpus writes

### Assignment keeps platform identity ownership unique and aliases explicitly ambiguous

Each atomic assignment unions aliases and identity keys into the existing cluster. A new pseudonym must avoid all current aliases and other pseudonyms. Remint proposals cover existing pseudonyms that collide with newly learned real aliases, with prior pseudonyms retained for artifact repair.

```quint
type Cluster = { id: str, pseudonym: str, aliases: Set[str], identities: Set[str], evidence: Set[str], superseded: Set[str], ruleset: str }
type Remint = { id: str, pseudonym: str }
type Corpus = { clusters: List[Cluster] }
pure val initial: Corpus = { clusters: List() }
pure val idValues = Set("cluster1", "cluster2")
pure val aliasesValues = Set(Set("personA"), Set("personB"), Set("aliasA"))
pure val identitiesValues = Set(Set(), Set("platform:user1"), Set("platform:user2"))
pure val evidenceValues = Set(Set(), Set("evidence1"), Set("evidence2"))
pure val pseudonymValues = Set("aliasA", "aliasB", "aliasC")
pure val rulesetValues = Set("v1", "v2")
pure val remintsValues: Set[List[Remint]] = Set(List(), List({ id: "cluster1", pseudonym: "aliasC" }))
pure val absentCluster: Cluster = { id: "", pseudonym: "", aliases: Set(), identities: Set(), evidence: Set(), superseded: Set(), ruleset: "" }
pure def clusterAt(s: Corpus, id: str): Cluster = s.clusters.select(cluster => cluster.id == id).nthOr(0, absentCluster)
pure def reminted(cluster: Cluster, remints: List[Remint]): Cluster = {
  val replacement = remints.select(entry => entry.id == cluster.id).nthOr(0, { id: "", pseudonym: "" })
  if (replacement.id == "") cluster else { ...cluster, pseudonym: replacement.pseudonym, superseded: cluster.superseded.union(Set(cluster.pseudonym)) }
}
pure val clusterValues: Set[Cluster] = Set({ id: "cluster1", pseudonym: "aliasA", aliases: Set("personA"), identities: Set("platform:user1"), evidence: Set(), superseded: Set(), ruleset: "v1" })
pure def assignedClusters(s: Corpus, id: str, aliases: Set[str], identities: Set[str], evidence: Set[str], pseudonym: str, ruleset: str, remints: List[Remint]): List[Cluster] = {
  val prior = clusterAt(s, id)
  val assigned = { id: id, pseudonym: if (prior.id == "") pseudonym else prior.pseudonym, aliases: prior.aliases.union(aliases), identities: prior.identities.union(identities), evidence: prior.evidence.union(evidence), superseded: prior.superseded, ruleset: ruleset }
  s.clusters.select(cluster => cluster.id != id).append(assigned).listMap(cluster => reminted(cluster, remints))
}
pure def uniqueAndDisjoint(clusters: List[Cluster]): bool = clusters.every(cluster => cluster.id != "" and cluster.pseudonym != "" and clusters.select(other => other.id == cluster.id).length() == 1 and clusters.select(other => other.pseudonym == cluster.pseudonym).length() == 1 and clusters.every(other => not(other.aliases.contains(cluster.pseudonym)) and (cluster.id == other.id or cluster.identities.intersect(other.identities).size() == 0)))
pure val clustersValues: Set[List[Cluster]] = Set(List(), List({ id: "cluster1", pseudonym: "aliasA", aliases: Set("personA"), identities: Set("platform:user1"), evidence: Set(), superseded: Set(), ruleset: "v1" }))
pure def canAssignCluster(s: Corpus, id: str, aliases: Set[str], identities: Set[str], evidence: Set[str], pseudonym: str, ruleset: str, remints: List[Remint]): bool = id != "" and ruleset != "" and s.clusters.every(cluster => cluster.id == id or cluster.identities.intersect(identities).size() == 0) and remints.every(entry => s.clusters.some(cluster => cluster.id == entry.id and aliases.contains(cluster.pseudonym))) and uniqueAndDisjoint(assignedClusters(s, id, aliases, identities, evidence, pseudonym, ruleset, remints))
pure def assignCluster(s: Corpus, id: str, aliases: Set[str], identities: Set[str], evidence: Set[str], pseudonym: str, ruleset: str, remints: List[Remint]): Corpus = { clusters: assignedClusters(s, id, aliases, identities, evidence, pseudonym, ruleset, remints) }
pure def alwaysCorpusIdentityIsUnique(s: Corpus): bool = uniqueAndDisjoint(s.clusters)
pure def stepClusterEvidenceIsRetained(before: Corpus, after: Corpus): bool = before.clusters.every(cluster => after.clusters.some(other => other.id == cluster.id and cluster.aliases.subseteq(other.aliases) and cluster.identities.subseteq(other.identities) and cluster.evidence.subseteq(other.evidence)))
pure def aliasOwners(s: Corpus, alias: str): Set[str] = s.clusters.select(cluster => cluster.aliases.contains(alias)).foldl(Set(), (owners, cluster) => owners.union(Set(cluster.id)))
pure def aliasIsAmbiguous(s: Corpus, alias: str): bool = aliasOwners(s, alias).size() > 1
pure def sometimesAmbiguousAlias(s: Corpus): bool = s.clusters.some(cluster => cluster.aliases.exists(alias => aliasIsAmbiguous(s, alias)))
pure def sometimesCollisionReminted(s: Corpus): bool = s.clusters.some(cluster => cluster.superseded.size() > 0)
```
