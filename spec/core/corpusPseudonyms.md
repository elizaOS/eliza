# Corpus pseudonym identity

The source is `packages/core/src/security/pii-pseudonym-map.ts` at the pinned baseline. A protected map owns clusters, case-folded alias owners, unique platform identity owners, pseudonym names and superseded names. Case-folding and alias filtering occur before the normalized inputs below. Assigning a platform identity to another cluster is rejected before mutation. Cluster merging is owned by the identity merge engine.

## Story: Preserve one pseudonym per verified cluster across corpus writes

> As a user whose data is pseudonymized, I want each verified person to keep
> one stable pseudonym across writes, so that the model never sees my real
> identifiers or confuses two people.

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
  val merged = { id: id, pseudonym: if (prior.id == "") pseudonym else prior.pseudonym, aliases: prior.aliases.union(aliases), identities: prior.identities.union(identities), evidence: prior.evidence.union(evidence), superseded: prior.superseded, ruleset: ruleset }
  s.clusters.select(cluster => cluster.id != id).append(merged).listMap(cluster => reminted(cluster, remints))
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

### Scrub items that assemble the pseudonym map do so one at a time, so every pseudonym they mint stays in the stored map

The PII scrub service drains two items at once. An item that brings no
context pack and no pseudonym assignments of its own assembles them from
the stored corpus map: it loads the map, mints a pseudonym for each person
the map does not hold yet, hands those pseudonyms to the scrub model, and
saves its whole copy of the map, which replaces the stored one. Only one
such item holds that stage at a time, from loading the map to saving it,
so two items naming two people in one drain both keep their pseudonyms,
and the pseudonym an item's scrubbed text carries is the one the stored
map keeps for that person. An item whose scrub fails saves nothing and
releases the stage, and its retry waits behind any item already waiting
for the stage. An item that brings its own context pack or assignments
never waits for the stage.

```quint
type MapEntry = { person: str, token: int }
pure val mapStagePermits = 1
pure def stagedPseudonym(stored: List[MapEntry], person: str): int =
  stored.select(entry => entry.person == person).nthOr(0, { person: "", token: 0 }).token
pure def stageItem(stored: List[MapEntry], person: str, completed: bool): List[MapEntry] =
  if (not(completed) or stagedPseudonym(stored, person) != 0) stored
  else stored.append({ person: person, token: stored.length() + 1 })
pure def oneAtATime(stagedPeople: List[str]): List[MapEntry] = stagedPeople.foldl(List(), (stored, person) => stageItem(stored, person, true))
pure val stagedPeopleValues = Set(List(), List("ada"), List("ada", "grace"), List("grace", "ada"), List("ada", "ada"), List("ada", "grace", "ada"))
pure val storedValues: Set[List[MapEntry]] = Set(List(), List({ person: "ada", token: 1 }), List({ person: "ada", token: 1 }, { person: "grace", token: 2 }))
pure def lawEveryStagedPersonKeepsAPseudonym(stagedPeople: List[str]): bool =
  stagedPeople.every(person => stagedPseudonym(oneAtATime(stagedPeople), person) != 0)
pure def lawTwoPeopleNeverShareAPseudonym(stagedPeople: List[str]): bool =
  oneAtATime(stagedPeople).every(entry => oneAtATime(stagedPeople).select(other => other.token == entry.token).length() == 1)
pure val personValues = Set("ada", "grace", "lin")
pure val laterPersonValues = Set("ada", "grace", "lin")
pure def lawALaterItemKeepsAnEarlierPseudonym(stored: List[MapEntry], person: str, laterPerson: str, completed: bool): bool =
  stagedPseudonym(stageItem(stored, laterPerson, completed), person) == stagedPseudonym(stored, person) or stagedPseudonym(stored, person) == 0
pure def lawAFailedItemSavesNothing(stored: List[MapEntry], person: str): bool = stageItem(stored, person, false) == stored
```
