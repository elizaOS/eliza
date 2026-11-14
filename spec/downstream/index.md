# Eliza contracts consumed by downstream applications

Specify the behavior reachable from the pinned Grace and AlphaPhone builds
first. The [core models](../core/) own the runtime state. This tree adds
contracts across the host, client, workflow, Cloud, and native boundaries.

| Consumer | Product source | Eliza pin |
| --- | --- | --- |
| Grace | `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` | `7743504b7c936a764b3938a44cad918808b621df` |
| AlphaPhone | `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` | `c518127a025ab173874af9c7d304f26b25213b0d` |

The [Grace inventory](./grace/baseline.json) and [AlphaPhone inventory](./alphaBaseline.json) record exact source leaves, aliases, and formal artifacts. The [consumer contract map](./contract-coverage.json) connects those paths to current models, includes the exact Android composition paths for traced native producers, and retains the behavior still to map. The pins are independently meaningful. A public export at one pin does
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
- [Core source and package import resolution](./coreImportResolution.md)
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

A spec revision passes the model gate when generation and typechecking,
the declared Quint scenarios, TypeScript replay, and all safety proofs
pass for that revision. Record the revision separately for each result
so reports from different revisions cannot combine into one pass. Temporal
claims remain bounded to the checked fairness assumptions and simulation.
Vibestack review records the user's acceptance against the same revision.
Package replacement additionally requires both consumer pins to pass with
the same candidate artifact built from that revision. The expected source
identities include the product commit, Eliza pin, and consumer build profile.
Check type-only and value imports, runtime and browser-safe entrypoints,
native registration, and persisted data fixtures using the packed artifacts.
Include provider and platform journeys at the I/O boundaries in their stories.
An inventory entry or nearby spec link alone supplies none of these results.

```quint
type CheckReceipt = { specRevision: str, passed: bool }
type DownstreamEvidence = { generation: CheckReceipt, scenarios: CheckReceipt, replay: CheckReceipt, safetyProofs: CheckReceipt, review: CheckReceipt }
type ConsumerPin = { consumerPin: str, productCommit: str, buildProfile: str }
type ConsumerEvidence = { identity: ConsumerPin, specRevision: str, candidate: str, importsCompile: bool, exportsResolve: bool, behaviorMatches: bool, nativeJourneys: bool }
pure def receiptMatches(receipt: CheckReceipt, specRevision: str): bool =
  specRevision != "" and receipt.passed and receipt.specRevision == specRevision
pure def reviewableModel(model: DownstreamEvidence, specRevision: str): bool =
  receiptMatches(model.generation,specRevision) and receiptMatches(model.scenarios,specRevision) and
  receiptMatches(model.replay,specRevision) and receiptMatches(model.safetyProofs,specRevision)
pure def modelAccepted(model: DownstreamEvidence, specRevision: str): bool =
  reviewableModel(model,specRevision) and receiptMatches(model.review,specRevision)
pure def consumerMatches(expected: ConsumerPin, observed: ConsumerEvidence, artifact: str, specRevision: str): bool =
  artifact != "" and observed.candidate == artifact and specRevision != "" and observed.specRevision == specRevision and
  expected.consumerPin != "" and expected.productCommit != "" and expected.buildProfile != "" and observed.identity == expected and
  observed.importsCompile and observed.exportsResolve and observed.behaviorMatches and observed.nativeJourneys
pure val goodReceipt: CheckReceipt = { specRevision: "spec-a", passed: true }
pure val goodModel: DownstreamEvidence = { generation: goodReceipt, scenarios: goodReceipt, replay: goodReceipt, safetyProofs: goodReceipt, review: goodReceipt }
pure val receiptValues = Set(goodReceipt, { ...goodReceipt, specRevision: "spec-b" }, { ...goodReceipt, passed: false })
pure val modelValues = Set(goodModel, { ...goodModel, safetyProofs: { ...goodReceipt, specRevision: "spec-b" } },
  { ...goodModel, review: { ...goodReceipt, passed: false } }, { ...goodModel, review: { ...goodReceipt, specRevision: "spec-b" } })
pure val graceConsumer: ConsumerPin = { consumerPin: "7743504b7c936a764b3938a44cad918808b621df", productCommit: "48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154", buildProfile: "grace-android" }
pure val alphaConsumer: ConsumerPin = { consumerPin: "c518127a025ab173874af9c7d304f26b25213b0d", productCommit: "8d44dfe52b0a6e2f3462b5da85dd3f8037518f43", buildProfile: "alpha-native" }
pure val graceEvidence: ConsumerEvidence = { identity: graceConsumer, specRevision: "spec-a", candidate: "candidate", importsCompile: true, exportsResolve: true, behaviorMatches: true, nativeJourneys: true }
pure val alphaEvidence: ConsumerEvidence = { ...graceEvidence, identity: alphaConsumer }
pure val expectedValues = Set(graceConsumer, alphaConsumer)
pure val graceObservedValues = Set(graceEvidence, alphaEvidence, { ...graceEvidence, specRevision: "spec-b" },
  { ...graceEvidence, nativeJourneys: false }, { ...alphaEvidence, candidate: "other" })
pure val observedValues = graceObservedValues
pure val alphaObservedValues = graceObservedValues
pure val artifactValues = Set("", "candidate", "other")
pure val specRevisionValues = Set("", "spec-a", "spec-b")
pure def replacementReady(model: DownstreamEvidence, specRevision: str, artifact: str, graceObserved: ConsumerEvidence, alphaObserved: ConsumerEvidence): bool =
  modelAccepted(model,specRevision) and consumerMatches(graceConsumer,graceObserved,artifact,specRevision) and
  consumerMatches(alphaConsumer,alphaObserved,artifact,specRevision)
pure def lawReplacementUsesSameCandidate(model: DownstreamEvidence, specRevision: str, artifact: str, graceObserved: ConsumerEvidence, alphaObserved: ConsumerEvidence): bool =
  replacementReady(model,specRevision,artifact,graceObserved,alphaObserved) implies
  graceObserved.candidate == alphaObserved.candidate and graceObserved.specRevision == alphaObserved.specRevision
pure def lawReplacementCannotExchangeProductEvidence(model: DownstreamEvidence, specRevision: str, artifact: str, graceObserved: ConsumerEvidence, alphaObserved: ConsumerEvidence): bool =
  replacementReady(model,specRevision,artifact,graceObserved,alphaObserved) implies
  graceObserved.identity == graceConsumer and alphaObserved.identity == alphaConsumer and graceObserved.identity.productCommit != alphaObserved.identity.productCommit
pure def lawModelNeedsSafetyProofs(model: DownstreamEvidence, specRevision: str): bool =
  reviewableModel(model,specRevision) implies model.safetyProofs.passed and model.safetyProofs.specRevision == specRevision
pure def lawReviewMustMatchCurrentSpec(model: DownstreamEvidence, specRevision: str): bool =
  model.review.specRevision != specRevision implies not(modelAccepted(model,specRevision))
```

The two consumer identities above name the currently pinned release
profiles. Development or test-only producers can have their own
conformance evidence without satisfying those identities.
