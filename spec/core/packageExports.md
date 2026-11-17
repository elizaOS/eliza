# Core package exports for consumer builds

A consumer imports `@elizaos/core` through the published export map, or
through a source projection of its own. The
[public surface baseline](./baseline/core-public-surface.json) records the
published names and signatures, and the [npm release](./release.md)
owns the freshness of release evidence. This spec owns which entry a
consumer's import reaches, which evidence may certify it, and which
browser-safe leaves the package declares and packs. Source, TypeScript
declaration and packed ESM resolution are separate observations.
A compatibility projection keeps every required field and its exact
discriminant; Effect environment requirements stay internal, and a public
Promise entry point keeps the typed outcome (see the
[core introduction](./index.md)).

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

Each browser-safe leaf names the core spec whose rules own its behavior:

| Leaf | Owner |
| --- | --- |
| logging | [log listeners](./logging/index.md); the logger contract and trailing-argument redaction are [diagnostics](./diagnostics.md), "A renderer's log line redacts its trailing arguments as the host sink does" |
| read memo | [read memo](./memo.md) |
| single-flight memo | [concurrent memo readers](./memoConcurrency.md) |
| view interaction | [views](./views.md) |
| `views/*` | [view navigation](./viewNavigation.md) |
| speech, spoken text | the speech leaf's text below; turn cancellation is [speech](./voice.md) |
| protocol, schema types, task widgets | [protocol values](./protocols.md) |
| events | [event streams](./events.md) |
| log redaction | [content and outbound security](./security.md) |
| embedding vector space | [embedding identity](./embeddingSpace.md) |
| errors, the i18n language catalog, `types/*`, the restart exit code asset | [public surface baseline](./baseline/core-public-surface.json) |

### An admitted pack serves exactly the declared leaves, each free of host-only code

A leaf's resolved static import closure is observed once, at pack time:
browser-safe leaves load only other browser-safe modules. A pack is admitted
only when every declared leaf is in the packed export map, the packed map
exports nothing undeclared, and no packed leaf's closure reaches a host-only
module. A missing leaf breaks its consumers, an undeclared one is an unowned
public surface, and a host-only closure pulls the Node runtime into a
browser bundle.

```quint
type CoreLeaf = LoggingLeaf | ReadMemoLeaf | ViewInteractionLeaf | SpeechLeaf | SchemaTypesLeaf | ProtocolLeaf | EventsLeaf
  | ErrorsLeaf | SpokenTextLeaf | LanguageLeaf | LogRedactionLeaf | SingleFlightMemoLeaf | TypesLeaves | ViewsLeaves
  | EmbeddingVectorSpaceLeaf | TaskWidgetsLeaf | RestartExitCodeLeaf
type ClosureModule = BrowserModule | HostOnlyModule
type PackedLeaf = { leaf: CoreLeaf, closure: List[ClosureModule] }
pure def browserSafeClosure(closure: List[ClosureModule]): bool = not(closure.includes(HostOnlyModule))
pure def packAdmitted(declared: Set[CoreLeaf], packed: List[PackedLeaf]): bool =
  declared.forall(leaf => packed.some(p => p.leaf == leaf)) and packed.every(p => declared.contains(p.leaf) and browserSafeClosure(p.closure))
pure val packedValues = Set(List(), List({ leaf: LoggingLeaf, closure: List(BrowserModule) }),
  List({ leaf: LoggingLeaf, closure: List(BrowserModule, HostOnlyModule) }),
  List({ leaf: LoggingLeaf, closure: List(BrowserModule) }, { leaf: EventsLeaf, closure: List() }))
pure def lawAdmittedPackServesExactlyTheDeclaredSafeLeaves(declared: Set[CoreLeaf], packed: List[PackedLeaf], leaf: CoreLeaf): bool =
  packAdmitted(declared, packed) implies (declared.contains(leaf) iff packed.some(p => p.leaf == leaf and browserSafeClosure(p.closure)))
```

## Story: Speak only the prose of a reply

> As a person listening to the agent, I hear what it says, never its
> reasoning, code, links or stage directions, and the client that speaks it
> uses the same rules as the host.

The speech leaf exports the error type, the reduction of a reply to
speakable text and the trimming of trailing characters, and nothing that
starts the host; the error type and the trimming are in the
[public surface baseline](./baseline/core-public-surface.json). A reply is modeled as the segments the reduction tells
apart.

### Spoken text keeps the prose of a reply and drops reasoning, tool calls, code, addresses, markup and stage directions

Reasoning and tool-call blocks, including one left open at the end of a
reply, code fences, including an unterminated one, web addresses, markup
and stage directions are not spoken. Prose is spoken in order, and inline
code, the text of a link and emphasized words are spoken as their words.

```quint
type ReplySegment = ProseSegment | ReasoningSegment | ToolCallSegment | CodeFenceSegment | InlineCodeSegment | LinkTextSegment | AddressSegment | MarkupSegment | StageDirectionSegment | EmphasisSegment
pure def spoken(segment: ReplySegment): bool =
  segment == ProseSegment or segment == InlineCodeSegment or segment == LinkTextSegment or segment == EmphasisSegment
pure def speakable(reply: List[ReplySegment]): List[ReplySegment] = reply.select(segment => spoken(segment))
pure val replyValues = Set(List(), List(ProseSegment, ReasoningSegment, ProseSegment), List(CodeFenceSegment, LinkTextSegment, AddressSegment),
  List(StageDirectionSegment, EmphasisSegment, ToolCallSegment, MarkupSegment, InlineCodeSegment))
pure def lawSpokenTextHasNoReasoningCodeOrAddresses(reply: List[ReplySegment]): bool =
  speakable(reply).every(segment => segment != ReasoningSegment and segment != ToolCallSegment and segment != CodeFenceSegment and
    segment != AddressSegment and segment != MarkupSegment and segment != StageDirectionSegment)
pure def lawEveryProseSegmentIsSpoken(reply: List[ReplySegment]): bool =
  speakable(reply).select(segment => segment == ProseSegment).length() == reply.select(segment => segment == ProseSegment).length()
```
