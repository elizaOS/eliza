# Per-turn pseudonym namespace

The source is `packages/core/src/security/pii-pseudonymizer.ts` at the pinned baseline. PseudonymSession owns exact real-value and surrogate maps, normalized collision sets, retired surrogate identities, the complete learned corpus and lazily rebuilt replacers. Inputs below use canonical case-folded strings supplied by the existing string normalization boundary. Corpus substrings denote the complete substring closure of the accumulated lowercased source, not whitespace-separated tokens. A span decomposition splits out every current or retired surrogate occurrence and classifies the entire remaining text as Unicode punctuation/whitespace or real text; this exact lexical decomposition is an external boundary. Candidate generation is an external pure algorithm whose output must satisfy the collision guard.

## Story: Keep substitutions reversible across repeated model calls

As an agent, I reuse the same surrogate for a known value. New real values may collide with old surrogates, so those entries are reminted and the retired surrogate is retained as a known fictional token. Replacement tables are invalidated by every mapping change and rebuilt before use. The private defensive remint helper is retained as a pure operation, rather than an externally selectable event: current learning rejects surrogate-only incoming values and candidate generation excludes the full incoming namespace, so ordinary admission cannot manufacture that collision.

### Learning real values precedes publishing collision-free mappings

```quint
type LearningAtom = { text: str, punctuation: bool }
type LearningSpan = { value: str, atoms: List[LearningAtom] }
type PseudonymEntry = { value: str, surrogate: str, kind: str, valueAtoms: List[LearningAtom], ordinal: int }
type Pseudonyms = { entries: List[PseudonymEntry], knownSpans: List[LearningSpan], knownValues: Set[str], corpusSubstrings: Set[str], retired: Set[str], dirty: bool, mappingVersion: int, replacerVersion: int }
pure val initial: Pseudonyms = { entries: List(), knownSpans: List(), knownValues: Set(), corpusSubstrings: Set(), retired: Set(), dirty: true, mappingVersion: 0, replacerVersion: -1 }
pure val valueValues = Set("personA", "personB", "aliasA", "aliasA apartment")
pure val surrogateValues = Set("aliasA", "aliasB", "aliasC", "aliasD")
pure val atomsValues = Set(List({ text: "aliasA", punctuation: false }), List({ text: "personA", punctuation: false }))
pure val kindValues = Set("person", "email")
pure val spansValues = Set(List({ value: "personA", atoms: List({ text: "personA", punctuation: false }) }), List({ value: "aliasA", atoms: List({ text: "aliasA", punctuation: false }) }), List({ value: "aliasA apartment", atoms: List({ text: "aliasA", punctuation: false }, { text: " apartment", punctuation: false }) }), List({ value: "(aliasA)", atoms: List({ text: "(", punctuation: true }, { text: "aliasA", punctuation: false }, { text: ")", punctuation: true }) }))
pure val tokensValues = Set(Set(), Set("personA"), Set("aliasA"))
pure def knownSurrogate(s: Pseudonyms, token: str): bool = s.retired.contains(token) or s.entries.some(entry => entry.surrogate == token)
pure def onlySurrogates(s: Pseudonyms, span: LearningSpan): bool = span.atoms.some(atom => knownSurrogate(s, atom.text)) and span.atoms.every(atom => atom.punctuation or knownSurrogate(s, atom.text))
pure def canLearn(s: Pseudonyms, spans: List[LearningSpan], tokens: Set[str]): bool = spans.every(span => span.value != "" and span.atoms.length() > 0)
pure def learn(s: Pseudonyms, spans: List[LearningSpan], tokens: Set[str]): Pseudonyms = {
  val accepted = spans.select(span => not(onlySurrogates(s, span)))
  { ...s, knownSpans: accepted.foldl(s.knownSpans, (known, span) => if (known.some(existing => existing.value == span.value)) known else known.append(span)), knownValues: accepted.foldl(s.knownValues, (values, span) => values.union(Set(span.value))), corpusSubstrings: s.corpusSubstrings.union(tokens), dirty: true }
}
pure def lawSurrogateOnlySpansAreSkipped(s: Pseudonyms, spans: List[LearningSpan], tokens: Set[str]): bool = spans.every(span => onlySurrogates(s, span)) implies (learn(s, spans, tokens).knownValues.subseteq(s.knownValues) and s.knownValues.subseteq(learn(s, spans, tokens).knownValues))
pure def candidateAvailable(s: Pseudonyms, surrogate: str): bool = surrogate != "" and not(s.knownValues.contains(surrogate)) and not(s.corpusSubstrings.contains(surrogate)) and not(s.entries.some(entry => entry.surrogate == surrogate)) and not(s.knownSpans.some(span => span.atoms.some(atom => atom.text == surrogate)))
pure def canAssignPseudonym(s: Pseudonyms, value: str, surrogate: str, kind: str): bool = s.knownValues.contains(value) and s.knownSpans.some(span => span.value == value) and not(s.entries.some(entry => entry.value == value)) and candidateAvailable(s, surrogate) and kind != ""
pure def assignPseudonym(s: Pseudonyms, value: str, surrogate: str, kind: str): Pseudonyms = { ...s, entries: s.entries.append({ value: value, surrogate: surrogate, kind: kind, valueAtoms: s.knownSpans.select(span => span.value == value).nthOr(0, { value: "", atoms: List() }).atoms, ordinal: s.entries.length() }), mappingVersion: s.mappingVersion + 1, dirty: true }
pure def remintEligible(s: Pseudonyms, value: str, surrogate: str): bool = s.entries.some(entry => entry.value == value and s.knownValues.contains(entry.surrogate)) and candidateAvailable(s, surrogate)
pure def remintValue(value: str, surrogate: str, s: Pseudonyms): Pseudonyms = { ...s, entries: s.entries.listMap(entry => if (entry.value == value) { ...entry, surrogate: surrogate } else entry), retired: s.entries.select(entry => entry.value == value).foldl(s.retired, (retired, entry) => retired.union(Set(entry.surrogate))), mappingVersion: s.mappingVersion + 1, dirty: true }
pure def lawRemintPreservesBijection(s: Pseudonyms, value: str, surrogate: str): bool = alwaysMapsAreBijective(s) and remintEligible(s, value, surrogate) implies alwaysMapsAreBijective(remintValue(value, surrogate, s))
pure def lawRemintRetainsOldToken(s: Pseudonyms, value: str, surrogate: str): bool = remintEligible(s, value, surrogate) implies s.entries.every(entry => entry.value != value or remintValue(value, surrogate, s).retired.contains(entry.surrogate))
pure def collisionFree(s: Pseudonyms): bool = s.entries.every(entry => not(s.knownValues.contains(entry.surrogate)))
pure def canRebuild(s: Pseudonyms): bool = s.dirty and collisionFree(s)
pure def rebuild(s: Pseudonyms): Pseudonyms = { ...s, dirty: false, replacerVersion: s.mappingVersion }
```

### Replacement and restoration share the exact current mapping

This rule specifies token-level substitution after boundary-aware longest-match detection. The direct `restoreToken` helper reads one mapping; actual `restoreAtoms` repeatedly expands nested current-surrogate references for at most the number of entries, matching the source fixed-point bound. Complete atomization retains every literal fragment. Candidate exclusion from all learned atoms keeps the dependency order acyclic. Regex compilation and span extraction preserve these mappings and consume no independent authoritative state. A retired surrogate is excluded from relearning as a person.

```quint
pure val noEntry: PseudonymEntry = { value: "", surrogate: "", kind: "", valueAtoms: List(), ordinal: -1 }
pure def substituteToken(s: Pseudonyms, value: str): str = s.entries.select(entry => entry.value == value).nthOr(0, { ...noEntry, surrogate: value }).surrogate
pure def restoreToken(s: Pseudonyms, surrogate: str): str = s.entries.select(entry => entry.surrogate == surrogate).nthOr(0, { ...noEntry, value: surrogate }).value
pure def restoreAtoms(s: Pseudonyms, atoms: List[LearningAtom]): List[LearningAtom] = s.entries.foldl(atoms, (resolvedAtoms, passEntry) => resolvedAtoms.foldl(List(), (result, atom) => if (s.entries.some(entry => entry.surrogate == atom.text)) result.concat(s.entries.select(entry => entry.surrogate == atom.text).nthOr(0, noEntry).valueAtoms) else result.append(atom)))
pure def alwaysRestorationDependenciesAreAcyclic(s: Pseudonyms): bool = s.entries.every(entry => entry.ordinal >= 0 and entry.valueAtoms.every(atom => s.entries.every(dependency => dependency.surrogate != atom.text or dependency.ordinal < entry.ordinal)))
pure def lawRestorationReachesRealText(s: Pseudonyms, atoms: List[LearningAtom]): bool = alwaysRestorationDependenciesAreAcyclic(s) implies restoreAtoms(s, atoms).every(atom => not(s.entries.some(entry => entry.surrogate == atom.text)))
pure def replacersUsable(s: Pseudonyms): bool = not(s.dirty) and s.replacerVersion == s.mappingVersion and collisionFree(s)
pure def alwaysMappingVersionsAreValid(s: Pseudonyms): bool = s.mappingVersion >= 0 and s.replacerVersion >= -1 and s.replacerVersion <= s.mappingVersion
pure def alwaysMapsAreBijective(s: Pseudonyms): bool = s.entries.every(entry => s.entries.select(other => other.value == entry.value).length() == 1 and s.entries.select(other => other.surrogate == entry.surrogate).length() == 1)
pure def alwaysCleanReplacersAreCurrent(s: Pseudonyms): bool = s.dirty or s.replacerVersion == s.mappingVersion
pure def lawEntryRoundTrips(s: Pseudonyms, value: str): bool = not(alwaysMapsAreBijective(s)) or not(s.entries.some(entry => entry.value == value)) or restoreToken(s, substituteToken(s, value)) == value
pure def sometimesMappingsAreReady(s: Pseudonyms): bool = s.entries.length() > 0 and collisionFree(s) and not(s.dirty)
```
