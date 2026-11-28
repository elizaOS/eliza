# Consumer contracts

A consumer is an application or a branded deployment built on Eliza
packages. Each consumer imports Eliza through runtime imports, type imports,
projected sources, bundled entry points and native registrations. The
[core models](./index.md) own the runtime state, the area specs own the
host, client, workflow, cloud and native boundaries, and the
[package exports](./packageExports.md) spec owns which entry an import
reaches. This spec owns how a consumer's recorded imports are traced to an
owning rule, and what evidence lets a candidate package replace the one a
consumer pins.

Eliza names no consumer. The consumers a replacement must satisfy are a
parameter: a list of consumer pins, each a consumer identity, the producer
commit it pins, the consumer commit it was observed at and its build
profile. Each consumer keeps its own inventory of imports and its own
coverage map in its own repository; this spec states only the shape every
such map must have.

## Story: Replace an imported Eliza contract from a reviewed consumer trace

> As a maintainer of a consumer, I want each Eliza import my build makes to
> lead to a pinned producer and a rule that owns its behavior, and a
> replacement package to be admitted only on evidence my own build produced,
> so that a change to Eliza cannot silently break what I rely on.

Admission accounts for the consumer's flags, native capabilities,
credentials and deployment identity. The observed request, callback, error
and receipt contract is preserved at the boundary where the consumer uses
it.

### A dependency has an observed consumer surface and an owning spec

A recorded dependency is identified by its consumer, pinned producer and
path. Its requirements lead to a named rule or an explicit external
refinement. Shared state is composed by import. A source fixture can
constrain model interpretation. Replacement conformance needs its own
replay evidence.

```quint
pure def traceableDependency(observedSource: bool, pinned: bool, sourcePath: str, ownerRule: bool, externalRefinement: bool): bool =
  observedSource and pinned and sourcePath != "" and (ownerRule or externalRefinement)
pure def lawAPathAloneDoesNotTrace(sourcePath: str, ownerRule: bool, externalRefinement: bool): bool =
  not(traceableDependency(true, false, sourcePath, ownerRule, externalRefinement))
```

### Terminal evidence never replays at the public boundary

A state transition distinguishes an unadmitted operation, a committed
operation, and a result whose delivery is unknown. Consumers may retry only
an effect whose delivery is unknown, and only when its exact identity and
scope permit it; the operation's own spec determines which identity and
scopes qualify. Explicit denial, cancellation, commitment and missing
admission remain visible and are never replayed.

```quint
type CommitEvidence = NoAdmission | ExplicitDenial | CancelledEffect | CommittedEffect | UnknownDelivery
pure def canReplayUnknown(effect: CommitEvidence, exactIdentity: bool, exactScope: bool, retryPermitted: bool): bool =
  effect == UnknownDelivery and exactIdentity and exactScope and retryPermitted
pure def lawTerminalEvidenceDoesNotReplay(effect: CommitEvidence, exactIdentity: bool, exactScope: bool, retryPermitted: bool): bool =
  effect != UnknownDelivery implies not(canReplayUnknown(effect, exactIdentity, exactScope, retryPermitted))
```

### Each consumer supplies its own compatibility evidence for the candidate

Package replacement requires at least one declared consumer, and every
declared consumer to pass with the same candidate artifact built from one
spec revision; a result recorded for another revision does not count.
Accepting the spec revision itself is the toolchain's check and review, not
a rule of this spec. The expected identity includes the consumer ID, the
consumer commit, the producer pin and the consumer's build profile. Check
type-only and value imports, runtime and browser-safe entry points, native
registration, and persisted data fixtures using the packed artifacts.
Include provider and platform journeys at the I/O boundaries in their
stories. An inventory entry or nearby spec link alone supplies none of
these results. Development or test-only producers can have their own
conformance evidence without satisfying a consumer's identity.

```quint
type ConsumerPin = { consumerId: str, producerPin: str, consumerCommit: str, buildProfile: str }
type ConsumerEvidence = { identity: ConsumerPin, specRevision: str, candidate: str, importsCompile: bool, exportsResolve: bool, behaviorMatches: bool, nativeJourneys: bool }
pure def consumerMatches(expected: ConsumerPin, observed: ConsumerEvidence, artifact: str, specRevision: str): bool =
  artifact != "" and observed.candidate == artifact and specRevision != "" and observed.specRevision == specRevision and
  expected.consumerId != "" and expected.producerPin != "" and expected.consumerCommit != "" and expected.buildProfile != "" and observed.identity == expected and
  observed.importsCompile and observed.exportsResolve and observed.behaviorMatches and observed.nativeJourneys
pure def consumerSatisfied(expected: ConsumerPin, evidence: List[ConsumerEvidence], artifact: str, specRevision: str): bool =
  evidence.some(e => consumerMatches(expected, e, artifact, specRevision))
pure def replacementReady(specRevision: str, artifact: str, consumers: List[ConsumerPin], evidence: List[ConsumerEvidence]): bool =
  consumers.length() > 0 and
  consumers.every(c => consumerSatisfied(c, evidence, artifact, specRevision))
pure val firstPin: ConsumerPin = { consumerId: "app-one", producerPin: "producer-1", consumerCommit: "consumer-1", buildProfile: "profile-1" }
pure val secondPin: ConsumerPin = { consumerId: "app-two", producerPin: "producer-2", consumerCommit: "consumer-2", buildProfile: "profile-2" }
pure val firstEvidence: ConsumerEvidence = { identity: firstPin, specRevision: "spec-a", candidate: "candidate", importsCompile: true, exportsResolve: true, behaviorMatches: true, nativeJourneys: true }
pure val secondEvidence: ConsumerEvidence = { ...firstEvidence, identity: secondPin }
pure val consumersValues = Set(List(), List(firstPin), List(firstPin, secondPin), List(secondPin, firstPin))
pure val evidenceValues = Set(List(), List(firstEvidence), List(firstEvidence, secondEvidence), List(secondEvidence, firstEvidence),
  List(firstEvidence, { ...secondEvidence, specRevision: "spec-b" }), List(firstEvidence, { ...secondEvidence, nativeJourneys: false }),
  List(firstEvidence, { ...secondEvidence, candidate: "other" }), List(firstEvidence, { ...firstEvidence, candidate: "other" }))
pure val expectedValues = Set(firstPin, secondPin, { ...firstPin, buildProfile: "" })
pure val observedValues = Set(firstEvidence, secondEvidence, { ...firstEvidence, specRevision: "spec-b" },
  { ...firstEvidence, nativeJourneys: false }, { ...secondEvidence, candidate: "other" })
pure val artifactValues = Set("", "candidate", "other")
pure val specRevisionValues = Set("", "spec-a", "spec-b")
pure def lawReplacementUsesSameCandidate(specRevision: str, artifact: str, consumers: List[ConsumerPin], evidence: List[ConsumerEvidence], expected: ConsumerPin): bool =
  (replacementReady(specRevision, artifact, consumers, evidence) and consumers.includes(expected)) implies
    evidence.some(e => e.identity == expected and e.candidate == artifact and e.specRevision == specRevision)
pure def lawEveryDeclaredConsumerIsChecked(specRevision: str, artifact: str, consumers: List[ConsumerPin], evidence: List[ConsumerEvidence], expected: ConsumerPin): bool =
  (consumers.includes(expected) and not(consumerSatisfied(expected, evidence, artifact, specRevision))) implies
    not(replacementReady(specRevision, artifact, consumers, evidence))
pure def lawNoDeclaredConsumerIsNoReplacement(specRevision: str, artifact: str, evidence: List[ConsumerEvidence]): bool =
  not(replacementReady(specRevision, artifact, List(), evidence))
```

### One consumer's evidence cannot stand in for another's

Evidence is bound to the exact consumer pin that produced it, including the
consumer ID, producer pin, consumer commit and build profile. A result observed
for one consumer satisfies no other consumer, even when both use the same
producer pin, commit and build profile. A public export at one pin does not
establish that a source alias,
build entry, native registration or runtime route exists at another.

```quint
pure def lawEvidenceServesOneConsumer(expected: ConsumerPin, otherConsumer: ConsumerPin, observed: ConsumerEvidence, artifact: str, specRevision: str): bool =
  expected != otherConsumer implies
    not(consumerMatches(expected, observed, artifact, specRevision) and consumerMatches(otherConsumer, observed, artifact, specRevision))
pure val otherConsumerValues = Set(firstPin, secondPin, { ...firstPin, consumerId: "app-two" }, { ...firstPin, buildProfile: "profile-2" })
```

### Every recorded import names an owner heading or an explicit drop

A consumer's coverage map lists each import it records: the consumer pin,
the producer path, and either the spec and rule heading that own the
behavior or the reason Eliza no longer provides it. A map is admitted only
when every owned record names a rule that exists in the current tree. A
record with no owner and no drop reason keeps the map unadmitted, so the
gap stays visible instead of being counted as covered.

```quint
type RuleRef = { ownerSpec: str, ownerHeading: str }
type Disposition = OwnedImport | DroppedImport | UnmappedImport
type ImportRecord = { entryPin: str, producerPath: str, disposition: Disposition, owner: RuleRef, dropReason: str }
pure def recordTraced(entry: ImportRecord, knownRules: List[RuleRef]): bool =
  entry.entryPin != "" and entry.producerPath != "" and
    (if (entry.disposition == OwnedImport)
       entry.owner.ownerSpec != "" and entry.owner.ownerHeading != "" and knownRules.includes(entry.owner)
     else if (entry.disposition == DroppedImport) entry.dropReason != ""
     else false)
pure def coverageAdmitted(records: List[ImportRecord], knownRules: List[RuleRef]): bool =
  records.every(r => recordTraced(r, knownRules))
pure val ownedRule: RuleRef = { ownerSpec: "spec/core/packageExports.md", ownerHeading: "An admitted pack serves exactly the declared leaves, each free of host-only code" }
pure val ownedRecord: ImportRecord = { entryPin: "producer-1", producerPath: "packages/core/src/index.ts", disposition: OwnedImport, owner: ownedRule, dropReason: "" }
pure val entryValues = Set(ownedRecord, { ...ownedRecord, disposition: UnmappedImport },
  { ...ownedRecord, disposition: DroppedImport, owner: { ownerSpec: "", ownerHeading: "" }, dropReason: "removed" },
  { ...ownedRecord, disposition: DroppedImport, dropReason: "" }, { ...ownedRecord, owner: { ...ownedRule, ownerHeading: "" } },
  { ...ownedRecord, owner: { ...ownedRule, ownerHeading: "A renamed heading" } })
pure val recordsValues = Set(List(), List(ownedRecord), List(ownedRecord, { ...ownedRecord, disposition: UnmappedImport }),
  List(ownedRecord, { ...ownedRecord, disposition: DroppedImport, dropReason: "removed" }))
pure val knownRulesValues = Set(List(), List(ownedRule), List(ownedRule, { ...ownedRule, ownerHeading: "A renamed heading" }),
  List(ownedRule, { ...ownedRule, ownerSpec: "spec/core/release.md" }))
pure def lawUnmappedImportKeepsTheMapOpen(records: List[ImportRecord], knownRules: List[RuleRef], entry: ImportRecord): bool =
  (records.includes(entry) and entry.disposition == UnmappedImport) implies not(coverageAdmitted(records, knownRules))
pure def lawOwnedImportNamesAnExistingRule(records: List[ImportRecord], knownRules: List[RuleRef], entry: ImportRecord): bool =
  (coverageAdmitted(records, knownRules) and records.includes(entry) and entry.disposition == OwnedImport) implies
    (knownRules.includes(entry.owner) and entry.owner.ownerHeading != "")
pure def lawDropNeedsAReason(knownRules: List[RuleRef], entry: ImportRecord): bool =
  (entry.disposition == DroppedImport and entry.dropReason == "") implies not(recordTraced(entry, knownRules))
```

### A recorded owner heading resolves to the one current spec that holds it or to a named successor

A source contract map records each owning rule by the spec and heading it
had at the producer pin. A rule still found there owns the record. A rule
moved to another spec owns it when exactly one current spec holds the same
heading. A heading that was rewritten resolves only through a successor
named here. A heading that no current spec holds, or that more than one
holds, with no successor, leaves the record unmapped.

Eliza's own workspace packages are consumers too. Their inventory is the
[consumer import baseline](./baseline/core-consumers.json), and each name it
records reaches its declaring source through the
[public surface](./baseline/core-public-surface.json) and its owning rules
through the [source contract map](./baseline/source-contract-map.json). Its
recorded rules either stand where it says or moved to exactly one current
spec, with these exceptions:

- the trace heading "Expired trace progress follows the observed wall
  clock" in [traces](./traces.md) has the successor "Native expiry
  observations retire the exact captured key";
- `TrajectoryChatMessage` is dropped with trajectory export, which v4 no
  longer provides;
- the deep path `runtime/prepared-model-request` is dropped as an import
  path, because no declared leaf serves it, and its guard is reached through
  the root entry, owned by "A request guard captures its exact admitted
  serialization" in [prepared requests](./preparedRequests.md).

```quint
type Successor = { replaced: RuleRef, successor: RuleRef }
pure def headingSites(recorded: RuleRef, knownRules: List[RuleRef]): List[RuleRef] =
  knownRules.select(r => r.ownerHeading == recorded.ownerHeading)
pure def namedSuccessor(recorded: RuleRef, knownRules: List[RuleRef], successors: List[Successor]): bool =
  successors.some(s => s.replaced == recorded and knownRules.includes(s.successor))
pure def ownerResolves(recorded: RuleRef, knownRules: List[RuleRef], successors: List[Successor]): bool =
  recorded.ownerSpec != "" and recorded.ownerHeading != "" and
    (knownRules.includes(recorded) or headingSites(recorded, knownRules).length() == 1 or namedSuccessor(recorded, knownRules, successors))
pure val movedRule: RuleRef = { ...ownedRule, ownerSpec: "spec/core/pairing/admission.md" }
pure val rewrittenRule: RuleRef = { ...ownedRule, ownerHeading: "A rewritten heading" }
pure val recordedValues = Set(ownedRule, movedRule, rewrittenRule, { ownerSpec: "", ownerHeading: "" })
pure val successorsValues = Set(List(), List({ replaced: rewrittenRule, successor: ownedRule }),
  List({ replaced: rewrittenRule, successor: { ...ownedRule, ownerHeading: "A renamed heading" } }))
pure def lawAStandingRuleResolves(recorded: RuleRef, knownRules: List[RuleRef], successors: List[Successor]): bool =
  (knownRules.includes(recorded) and recorded.ownerSpec != "" and recorded.ownerHeading != "") implies ownerResolves(recorded, knownRules, successors)
pure def lawAMissingHeadingNeedsASuccessor(recorded: RuleRef, knownRules: List[RuleRef], successors: List[Successor]): bool =
  (headingSites(recorded, knownRules).length() == 0 and not(namedSuccessor(recorded, knownRules, successors))) implies
    not(ownerResolves(recorded, knownRules, successors))
pure def lawAnAmbiguousMoveNeedsASuccessor(recorded: RuleRef, knownRules: List[RuleRef], successors: List[Successor]): bool =
  (not(knownRules.includes(recorded)) and headingSites(recorded, knownRules).length() > 1 and not(namedSuccessor(recorded, knownRules, successors))) implies
    not(ownerResolves(recorded, knownRules, successors))
```
