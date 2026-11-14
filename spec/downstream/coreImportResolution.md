# Core entry point resolution for pinned consumers

Grace and AlphaPhone route several `@elizaos/core` imports through their
own source projections. The [core package contract](../core/contracts.md)
owns the published names and signatures. The
[downstream source inventory](./index.md) identifies each pin and call
site. Source, TypeScript declaration and packed ESM resolution are
separate observations.

## Story: Preserve the imported core surface in the consumer build and the npm package

### The selected build profile determines which bytes may satisfy an import

The three recorded manifests, Grace's `2.0.12-beta.0`, AlphaPhone's
`2.0.5`, and the core baseline `2.0.6`, expose the same ordered
conditions. For a code entry, `eliza-source` precedes `types`,
`import`, and `default`. The last two target the same ESM file. JSON
entries expose `eliza-source` and `default`. The packed package lists
`dist` as its shipped files, so a validation intended for ordinary
package consumers must exercise declaration and ESM resolution without
the source condition.

Grace's task-widget import resolves to
`.generated/task-events/messaging/task-widgets.ts`. The selected UI
compiles `TaskChoiceWidget`, `validateTaskChoiceWidget` and
`admitTaskChoiceResponse` from that projection. The configured Grace
protocol alias points to a file absent from the pinned tracked tree.
No production value import was found that resolves through that alias.

Alpha's browser source projection supplies `SingleFlightMemo` as a
runtime export and `ViewActionHandoff` for a development type import.
The [agenda source observation](./alpha/calendarAgendaSource.md) owns
the product's use of that memo.
The configured voice protocol alias is an Alpha-generated re-export
map. Its runtime exports are `ElizaError`, `redactTrailingArgs`,
`parseViewInteractionClientId`, `AGENT_SURFACE_CAPABILITY_IDS` and
`findViewActionHandoff`. `ViewActionHandoff` and `PermissionState`
are type exports. The manifest's `./protocol` is a separate package
entry. Projection names and exact source path alternatives use the
consumer's resolver configuration. File existence, successful evaluation,
and declaration compatibility must be observed for the chosen target.
The model receives the known alias classification after exact resolution.

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
source projection must identify the exact product and producer pins
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
