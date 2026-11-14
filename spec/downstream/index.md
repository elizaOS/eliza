# Eliza contracts consumed by downstream applications

Specify the behavior reachable from the pinned Grace and AlphaPhone builds
first. The [core models](../core/) own the runtime state. This tree adds
contracts across the host, client, workflow, Cloud, and native boundaries.

| Consumer | Product source | Eliza pin |
| --- | --- | --- |
| Grace | `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` | `7743504b7c936a764b3938a44cad918808b621df` |
| AlphaPhone | `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` | `c518127a025ab173874af9c7d304f26b25213b0d` |

The [Grace inventory](./grace/baseline.json) and [AlphaPhone inventory](./alphaBaseline.json) record exact source leaves, aliases, and formal artifacts. The [consumer contract map](./contract-coverage.json) connects those paths to current models and retains the behavior still to map. The pins are independently meaningful. A public export at one pin does
not establish that a source alias, build entry, native registration, or
runtime route exists at the other. The consumer's committed build and
startup configuration determines admission. Tests and optional device
features provide distinct evidence from production startup.

- [Recover a reviewed workflow run](./workflowJourney.md)
- [Reviewed workflow submission and activation](./workflow.md)
- [Workflow removal and restoration](./workflowLifecycle.md)
- [Typed workflow authoring](./workflowAuthoring.md)
- [Workflow request custody](./workflowIntents.md)
- [Android workflow source publication](./workflowSource.md)
- [Workflow worker provenance](./workflowWorker.md)
- [Reviewed schedule occurrences](./workflowSchedule.md)
- [Workflow approvals and device scope](./workflowApprovals.md)
- [Workflow worker execution and wakeups](./workflowExecution.md)
- [Hosted digest delivery and retained history](./hostedDigest.md)
- [Resident Cloud inference admission](./residentCloud.md)
- [Resident rebind queue](./residentRebind.md)
- [AlphaPhone remote agent pairing](./remotePairing.md)
- [Native Cloud enrollment](./cloudEnrollment.md)
- [Native sign-in receipt admission](./nativeSignIn.md)
- [Cloud entitlement and billing reads](./cloudEntitlement.md)
- [Native Cloud operations](./cloudHost.md)
- [Consumer plugin profile and host composition](./pluginProfile.md)
- [Product chat authority and runtime configuration](./chatHost.md)
- [Client conversation turns and Stop receipts](./conversation.md)
- [Runtime JSON client and account restart](./runtimeClient.md)
- [Grace browser protection](./browserProtection.md)
- [Browser request grounding](./browserGrounding.md)
- [Required browser execution and qualification](./browserQualification.md)
- [Website command transport](./surfaceTransport.md)
- [Clock handoff and cancellation](./clockReminder.md)
- [Reminder recurrence and occurrence](./reminderOccurrence.md)
- [Reminder creation and action custody](./reminderCustody.md)
- [Native Cloud live speech custody](./nativeCloudSpeech.md)
- [Realtime voice client state](./voiceSessionClient.md)
- [Mobile runtime, device bridges, speech and updates](./mobile.md)
- [Grace product bindings](./grace/)
- [AlphaPhone product bindings](./alpha/)

## Story: Replace an imported Eliza contract from a reviewed consumer trace

A product maintainer can follow each runtime import, type import, projected
source, bundled entry point, and native registration to a pinned producer
and a story. Admission accounts for product flags, native capabilities,
credentials, and deployment identity. Preserve the observed request,
callback, error, and receipt contract at the boundary where the product
uses it.

### A dependency has an observed consumer surface and an owning spec

A recorded dependency is identified by its consumer, pinned producer and
path. Its requirements lead to a named rule or an explicit external
refinement. Shared state is composed by import. A source fixture can
constrain model interpretation. Replacement conformance needs its own
replay evidence in the implementation phase.

```quint
pure def traceableDependency(observedSource: bool, pinned: bool, sourcePath: str, ownerRule: bool, externalRefinement: bool): bool =
  observedSource and pinned and sourcePath != "" and (ownerRule or externalRefinement)
pure def lawAPathAloneDoesNotTrace(sourcePath: str, ownerRule: bool, externalRefinement: bool): bool =
  not(traceableDependency(true, false, sourcePath, ownerRule, externalRefinement))
```

### The same lifecycle preserves typed refusal at the public boundary

A state transition distinguishes an unadmitted operation, a committed
operation, and a result whose delivery is unknown. Consumers may retry an
ambiguous effect only when the underlying identity and scope permit it.
Explicit denial, cancellation, and missing evidence remain visible.
The operation's own spec determines which identity and scopes qualify.

```quint
type CommitEvidence = NoAdmission | ExplicitDenial | CancelledEffect | CommittedEffect | UnknownDelivery
pure def canReplayUnknown(effect: CommitEvidence, exactIdentity: bool, exactScope: bool, retryPermitted: bool): bool =
  effect == UnknownDelivery and exactIdentity and exactScope and retryPermitted
pure def lawAmbiguousRetryKeepsOwnership(effect: CommitEvidence, exactIdentity: bool, exactScope: bool, retryPermitted: bool): bool =
  canReplayUnknown(effect, exactIdentity, exactScope, retryPermitted) implies exactIdentity and exactScope
pure def lawTerminalEvidenceDoesNotReplay(effect: CommitEvidence, retryPermitted: bool): bool =
  effect != UnknownDelivery implies not(canReplayUnknown(effect, true, true, retryPermitted))
```

### Each consumer supplies its own compatibility evidence for the candidate

A spec revision passes the model gate when generation, the declared
Quint scenarios, TypeScript replay, and all safety proofs pass for
the same revision. Temporal claims remain bounded to the checked
fairness assumptions and simulation. Package replacement additionally
requires the same candidate to pass both consumer pins. The expected
source identities include the product commit, Eliza pin, and applicable
consumer build profile. Check type-only and value imports, runtime
and browser-safe entrypoints, native registration, and persisted data
fixtures using the packed artifacts. Include provider and platform
journeys at the I/O boundaries identified by their stories. An inventory
entry or nearby spec link alone supplies none of these compatibility
results. All evidence flags denote observed, revision-bound results.

```quint
type DownstreamEvidence = { generation: bool, scenarios: bool, replay: bool, safetyProofs: bool }
type ConsumerEvidence = { consumerPin: str, productCommit: str, candidate: str, buildProfile: str, importsCompile: bool, exportsResolve: bool, behaviorMatches: bool, nativeJourneys: bool }
pure def reviewableModel(model: DownstreamEvidence): bool =
  model.generation and model.scenarios and model.replay and model.safetyProofs
pure def consumerMatches(expected: ConsumerEvidence, observed: ConsumerEvidence, artifact: str): bool =
  artifact != "" and observed.candidate == artifact and expected.consumerPin != "" and expected.productCommit != "" and expected.buildProfile != "" and
  observed.consumerPin == expected.consumerPin and observed.productCommit == expected.productCommit and observed.buildProfile == expected.buildProfile and
  observed.importsCompile and observed.exportsResolve and observed.behaviorMatches and observed.nativeJourneys
pure val modelValues = Set({ generation: true, scenarios: true, replay: true, safetyProofs: true }, { generation: true, scenarios: true, replay: true, safetyProofs: false })
pure val graceConsumer: ConsumerEvidence = { consumerPin: "7743504b7c936a764b3938a44cad918808b621df", productCommit: "48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154", candidate: "candidate", buildProfile: "grace-android", importsCompile: true, exportsResolve: true, behaviorMatches: true, nativeJourneys: true }
pure val alphaConsumer: ConsumerEvidence = { consumerPin: "c518127a025ab173874af9c7d304f26b25213b0d", productCommit: "8d44dfe52b0a6e2f3462b5da85dd3f8037518f43", candidate: "candidate", buildProfile: "alpha-native", importsCompile: true, exportsResolve: true, behaviorMatches: true, nativeJourneys: true }
pure val expectedValues = Set(graceConsumer, alphaConsumer)
pure val observedValues = expectedValues
pure val graceObservedValues = Set(graceConsumer, alphaConsumer)
pure val alphaObservedValues = graceObservedValues
pure val artifactValues = Set("", "candidate", "other")
pure def replacementReady(model: DownstreamEvidence, artifact: str, graceObserved: ConsumerEvidence, alphaObserved: ConsumerEvidence): bool =
  reviewableModel(model) and consumerMatches(graceConsumer, graceObserved, artifact) and consumerMatches(alphaConsumer, alphaObserved, artifact)
pure def lawReplacementUsesSameCandidate(model: DownstreamEvidence, artifact: str, graceObserved: ConsumerEvidence, alphaObserved: ConsumerEvidence): bool =
  replacementReady(model, artifact, graceObserved, alphaObserved) implies graceObserved.candidate == alphaObserved.candidate
pure def lawReplacementCannotExchangeProductEvidence(model: DownstreamEvidence, artifact: str, graceObserved: ConsumerEvidence, alphaObserved: ConsumerEvidence): bool =
  replacementReady(model, artifact, graceObserved, alphaObserved) implies
  graceObserved.consumerPin == graceConsumer.consumerPin and alphaObserved.consumerPin == alphaConsumer.consumerPin and graceObserved.productCommit != alphaObserved.productCommit
pure def lawModelNeedsSafetyProofs(model: DownstreamEvidence): bool = reviewableModel(model) implies model.safetyProofs
```
