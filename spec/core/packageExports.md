# Core package exports for consumer builds

A consumer imports `@elizaos/core` through the published export map, or
through a source projection of its own. The [core package contract](./contracts.md)
owns the published names and signatures, and the [npm release](./release.md)
owns the freshness of release evidence. This spec owns which entry a
consumer's import reaches, which evidence may certify it, and which
browser-safe leaves the package declares and packs. Source, TypeScript
declaration and packed ESM resolution are separate observations.

## Story: Preserve the imported core surface in the consumer build and the npm package

> As a consumer of the core package, I want each import I make to resolve to
> the entry my build profile selects, and to be certified only by evidence
> about the packed package, so that a build that works from source also works
> from npm.

### The selected build profile determines which bytes may satisfy an import

Every recorded manifest of the package exposes the same ordered conditions.
For a code entry, `eliza-source` precedes `types`, `import`, and `default`.
The last two target the same ESM file. JSON entries expose `eliza-source`
and `default`. The packed package lists `dist` as its shipped files, so a
validation intended for ordinary package consumers must exercise declaration
and ESM resolution without the source condition.

A consumer may route an import through its own source projection: a copied
leaf, which compiles a copy of one core leaf, or a synthetic map, which
re-exports chosen names from several leaves. A projection the consumer
configures but whose target is absent resolves nothing. Projection names
and exact source path alternatives use the consumer's resolver
configuration. File existence, successful evaluation and declaration
compatibility must be observed for the chosen target. The model receives
the known alias classification after exact resolution.

```quint
type ImportKind = ImportsCode | ImportsJson
type ImportProfile = { sourceCondition: bool, typeCondition: bool, esmCondition: bool }
type ObservedAlias = NoAlias | CopiedLeaf | SyntheticMap | UnavailableAlias
type ImportTarget = SourceTarget | DeclarationTarget | BuiltModule | BuiltJson | ProjectedLeaf | ProjectedMap | ResolutionRefused
pure def publishedTarget(kind: ImportKind, profile: ImportProfile, entryExists: bool): ImportTarget =
  if (not(entryExists)) ResolutionRefused
  else if (profile.sourceCondition) SourceTarget
  else if (kind == ImportsJson) BuiltJson
  else if (profile.typeCondition) DeclarationTarget
  else BuiltModule
pure def consumerTarget(kind: ImportKind, profile: ImportProfile, entryExists: bool, alias: ObservedAlias): ImportTarget =
  if (alias == CopiedLeaf) ProjectedLeaf
  else if (alias == SyntheticMap) ProjectedMap
  else if (alias == UnavailableAlias) ResolutionRefused
  else publishedTarget(kind, profile, entryExists)
pure val defaultProfile: ImportProfile = { sourceCondition: false, typeCondition: false, esmCondition: false }
pure val profileValues = Set(defaultProfile, { ...defaultProfile, typeCondition: true, esmCondition: true },
  { ...defaultProfile, sourceCondition: true, typeCondition: true, esmCondition: true })
pure def lawSourceConditionPrecedesType(kind: ImportKind, profile: ImportProfile): bool =
  profile.sourceCondition implies publishedTarget(kind, profile, true) == SourceTarget
pure def lawMissingEntryDoesNotReachThePackage(kind: ImportKind, profile: ImportProfile): bool =
  publishedTarget(kind, profile, false) == ResolutionRefused
pure def lawConsumerSyntheticMapDoesNotUsePackageProtocol(kind: ImportKind, profile: ImportProfile, entryExists: bool): bool =
  consumerTarget(kind, profile, entryExists, SyntheticMap) == ProjectedMap
pure def lawUnavailableAliasDoesNotQualify(kind: ImportKind, profile: ImportProfile, entryExists: bool): bool =
  consumerTarget(kind, profile, entryExists, UnavailableAlias) == ResolutionRefused
```

### Evidence for a projected source cannot satisfy the packed client

Consumer evidence checks each normal import in its actual profile. A
source projection must identify the exact consumer and producer pins
and prove the selected export path. A packed check must observe the same
candidate digest through its normal npm entry, using built declarations
for type imports and a built ESM module or JSON asset for value imports.
The browser value path also checks that its resolved transitive graph
avoids host-only modules. Results carry the actual resolved target,
identity, and whether evaluation and type checking succeeded as
applicable to that observation.

```quint
type ImportUse = TypeOnly | ValueImport
type ImportEvidence = { target: ImportTarget, identity: str, symbols: bool, valid: bool, browserSafe: bool }
pure def valueTarget(target: ImportTarget): bool = target == BuiltModule or target == BuiltJson
pure def admitsPacked(use: ImportUse, candidate: str, browser: bool, evidence: ImportEvidence): bool =
  candidate != "" and evidence.identity == candidate and evidence.symbols and evidence.valid and
    (if (use == TypeOnly) evidence.target == DeclarationTarget else valueTarget(evidence.target) and (not(browser) or evidence.browserSafe))
pure val candidateValues = Set("", "a", "b")
pure val evidenceValues = Set(
  { target: BuiltModule, identity: "a", symbols: true, valid: true, browserSafe: true },
  { target: BuiltModule, identity: "a", symbols: true, valid: true, browserSafe: false },
  { target: DeclarationTarget, identity: "a", symbols: true, valid: true, browserSafe: false },
  { target: ProjectedLeaf, identity: "a", symbols: true, valid: true, browserSafe: true })
pure def lawASourceProjectionCannotCertifyPackedImport(use: ImportUse, candidate: str, browser: bool, evidence: ImportEvidence): bool =
  (evidence.target == ProjectedLeaf or evidence.target == ProjectedMap or evidence.target == SourceTarget) implies
    not(admitsPacked(use, candidate, browser, evidence))
pure def lawPackedBrowserValueCannotLoadHostCode(candidate: str, evidence: ImportEvidence): bool =
  admitsPacked(ValueImport, candidate, true, evidence) implies evidence.browserSafe and valueTarget(evidence.target)
```

## Story: Declare and pack every browser-safe leaf a consumer imports

> As a consumer that runs in a browser or a device web view, I want each
> core leaf I import to be declared by the package, owned by a rule, packed
> exactly as declared and free of host-only code, so that my bundle never
> pulls the Node runtime in.

### Each browser-safe leaf that consumers import has an owning spec

The leaves are logging, the read memo, view interaction, speech, schema
types, the protocol, events, errors, spoken text, the language catalog of
i18n, log redaction, the single-flight memo, the `types/*` and `views/*`
leaves, the embedding vector space, task widgets and the restart exit code
asset. Each names the core spec whose rules own its behavior.

```quint
type CoreLeaf = LoggingLeaf | ReadMemoLeaf | ViewInteractionLeaf | SpeechLeaf | SchemaTypesLeaf | ProtocolLeaf | EventsLeaf
  | ErrorsLeaf | SpokenTextLeaf | LanguageLeaf | LogRedactionLeaf | SingleFlightMemoLeaf | TypesLeaves | ViewsLeaves
  | EmbeddingVectorSpaceLeaf | TaskWidgetsLeaf | RestartExitCodeLeaf
pure def leafOwner(leaf: CoreLeaf): str =
  if (leaf == LoggingLeaf) "spec/core/logListeners.md"
  else if (leaf == ReadMemoLeaf) "spec/core/memo.md"
  else if (leaf == ViewInteractionLeaf) "spec/core/views.md"
  else if (leaf == SpeechLeaf or leaf == SpokenTextLeaf) "spec/core/voice.md"
  else if (leaf == ProtocolLeaf) "spec/core/protocols.md"
  else if (leaf == EventsLeaf) "spec/core/events.md"
  else if (leaf == LogRedactionLeaf) "spec/core/privacy.md"
  else if (leaf == SingleFlightMemoLeaf) "spec/core/memoConcurrency.md"
  else if (leaf == ViewsLeaves) "spec/core/viewNavigation.md"
  else if (leaf == EmbeddingVectorSpaceLeaf) "spec/core/embeddingSpace.md"
  else "spec/core/contracts.md"
pure val leafOwnerSpecs: Set[str] = Set("spec/core/logListeners.md", "spec/core/memo.md", "spec/core/views.md",
  "spec/core/voice.md", "spec/core/protocols.md", "spec/core/events.md", "spec/core/privacy.md",
  "spec/core/memoConcurrency.md", "spec/core/viewNavigation.md", "spec/core/embeddingSpace.md", "spec/core/contracts.md")
pure def lawEveryLeafHasAnOwner(leaf: CoreLeaf): bool = leafOwnerSpecs.contains(leafOwner(leaf))
```

### A browser-safe leaf never reaches host-only code

A leaf's resolved static import closure is classified once: browser-safe
leaves load only other browser-safe modules. A leaf whose closure reaches a
host-only module cannot be declared browser-safe.

```quint
type ClosureModule = BrowserModule | HostOnlyModule
pure def browserSafeClosure(closure: Set[ClosureModule]): bool = not(closure.contains(HostOnlyModule))
pure def lawHostOnlyClosureIsNotBrowserSafe(closure: Set[ClosureModule]): bool =
  closure.contains(HostOnlyModule) implies not(browserSafeClosure(closure))
```

### The packed export set equals the declared set

A pack is admitted only when every declared leaf is in the packed export map
and the packed map exports nothing undeclared: a missing leaf breaks its
consumers, and an undeclared one is an unowned public surface.

```quint
pure def packAdmitted(declared: Set[CoreLeaf], packed: Set[CoreLeaf]): bool = declared.subseteq(packed) and packed.subseteq(declared)
pure def lawUndeclaredPackedLeafRefusesThePack(declared: Set[CoreLeaf], packed: Set[CoreLeaf], leaf: CoreLeaf): bool =
  (packed.contains(leaf) and not(declared.contains(leaf))) implies not(packAdmitted(declared, packed))
pure def lawMissingDeclaredLeafRefusesThePack(declared: Set[CoreLeaf], packed: Set[CoreLeaf], leaf: CoreLeaf): bool =
  (declared.contains(leaf) and not(packed.contains(leaf))) implies not(packAdmitted(declared, packed))
```
