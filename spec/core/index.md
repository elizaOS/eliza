# Eliza core

The kernel owns agent identity, registration, lifecycle, state composition,
model dispatch, authorization, memory contracts, task scheduling and effect
settlement. Hosts install database adapters, model providers and assistant
behavior explicitly. A runtime serves one agent and never imports an
application host.

The baseline records the [public surface](./baseline/core-public-surface.json),
[consumer imports](./baseline/core-consumers.json) and
[source contract map](./baseline/source-contract-map.json) this version
retains, and the [compatibility decisions](./baseline/compatibility-decisions.json)
on retained failure behavior.

The baseline describes `packages/core` of develop at
`elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`, the develop
commit it was captured from; this version is a rewrite, not a descendant of
that commit. Its source records (file hashes, behavior contracts, import
graph, fixtures and legacy models) stay at that commit, with one exception:
the hashes of the `./catalog/*` assets the packed release ships describe the
catalog this version generates, so they change whenever that catalog is
regenerated (today only `packages/core/src/catalog/generated.json` differs
from develop). A later develop change becomes part of this version only when
a rule of the spec that owns its behavior ports it, and the public surface
and consumer imports change only with the exports that port adds or removes.
The baseline does not record which later develop changes were ported or
declined.

| Cluster | Specifications |
| --- | --- |
| Turn | [End-to-end turn](./journey.md), [state composition](./stateComposition.md), [context](./context.md), [action planning](./actionPlanning.md), [actions](./execution.md), [action receipts](./actionReceipts.md), [receipts](./receipts.md), [receipt binding registry](./receiptBindings.md), [confirmation](./confirmation.md), [response fields](./responseFields.md), [response evaluators](./responseEvaluation.md), [turn controllers](./turnControllers.md), [terminal ownership](./terminal.md), [outbound style rewriting](./outboundStyle.md), [chat pre-handlers](./chatPreHandlers.md) |
| Runtime lifecycle | [Runtime lifecycle](./runtime.md), [shutdown attempts](./runtimeShutdown.md), [runtime run context](./runtimeRunContext.md), [retirement tracker](./retirementTracker.md), [adapter lifecycle](./adapterOwnership.md), [anonymous naming](./anonymousIdentity.md), [internal actors](./internalActors.md) |
| Plugins and registries | [Plugins](./plugins.md), [plugin epochs and services](./pluginServices.md), [runtime registries](./registries.md), [pipeline hooks](./hooks.md), [concurrent hooks](./concurrentHooks.md), [event hooks](./hookService.md) |
| Services | [Services](./services.md), [service instances](./serviceInstances.md), [acquisition results](./serviceAcquisitionResult.md), [service stop observations](./serviceStopObservation.md), [eager startup](./eagerServices.md), [service builder](./serviceBuilder.md) |
| Models and capabilities | [Model dispatch](./models.md), [model diagnostics](./modelDiagnostics.md), [model attempt leases](./modelAttemptLeases.md), [inference priority](./inferenceGate.md), [inference timing](./inferenceTiming.md), [timing registry](./timingRegistry.md), [prepared requests](./preparedRequests.md), [request serializers](./preparedRequestSerialization.md), [processing policy](./processingPolicy.md), [capability routing](./capabilityRouting.md), [capability strategies](./capabilityStrategies.md), [capability coordinator](./capabilityCoordinator.md), [capability dispatch authority](./capabilityAuthority.md), [catalog](./catalog.md), [providers](./providers/index.md) |
| Ambient managers | [Ambient managers](./ambientManagers.md) |
| Authorization and approvals | [Authorization](./authorization.md), [approvals](./approvals.md), [approval service](./approvalService.md), [approval retirement](./approvalRetirement.md), [trusted delivery audiences](./trustedAudience.md), [audience registry](./audienceRegistry.md) |
| Connectors and messaging | [Connector dispatch](./messaging.md), [concurrent connectors](./concurrentConnectors.md), [account lifecycle and storage](./connectorStorage.md), [manager registry](./connectorManagers.md), [OAuth](./oauth/index.md), [operation queues](./connectorQueues.md), [source and profile registries](./connectorRegistries.md), [connector metadata](./connectorSources.md), [connection locks](./connectionLocks.md), [context taxonomy](./contextRegistry.md), [connector values](./accountValues.md), [connector handoff](./connectorHandoff.md), [account bridges](./accountBridges.md), [pairing](./pairing/index.md), [notifications](./notifications/index.md) |
| Tasks and background work | [Scheduling](./scheduling.md), [missed occurrence window](./occurrenceWindow.md), [process scheduler](./processScheduler.md), [query drain ownership](./queryDrain.md), [scheduler and query drain](./sharedScheduler.md), [task service](./taskServiceOwners.md), [task drain](./taskDrain.md), [task event reader](./taskEventReader.md), [serialization](./serialisation.md), [interactive tasks](./interactiveTask.md), [interaction sessions](./sessions.md), [session store](./sessionStore.md), [post-delivery tasks](./postDelivery.md), [awareness cache](./awareness.md), [awareness registry](./awarenessRegistry.md) |
| Concurrency primitives | [Room queue](./concurrency.md), [multi-room leases](./multiRoomLeases.md), [room observers](./roomQueueObservers.md), [semaphores](./semaphore.md), [read memo](./memo.md), [concurrent memo readers](./memoConcurrency.md), [priority queue](./priorityQueue.md), [batch queue](./batchQueue.md), [batch processor](./batchProcessor.md), [async context](./asyncContext.md), [event streams](./events.md) |
| Topics | [Channel topics](./channelTopics.md), [topic service](./topicService.md) |
| Persistence | [Entities and mutations](./entities.md), [fact writes](./factWrites.md), [identity groups](./identityGroups.md), [source storage](./storage.md), [source collection](./sourceSweep.md), [ingress snapshots](./ingressSnapshots.md), [atomic files](./atomicPublication.md), [concurrent file writers](./atomicWriters.md), [temporary names](./temporaryNames.md) |
| Embedding and retrieval | [Embedding service](./embeddingService.md), [embedding identity](./embeddingSpace.md), [embedding writes](./embeddingWrite.md), [retrieval](./retrieval.md) |
| Streaming and values | [Markable streams](./streamMarkable.md), [stream revisions](./streamRevisions.md), [structured fields](./structuredStreamState.md), [response skeleton](./skeletonStreamState.md), [UTF-16 stream units](./streamUnits.md), [stream nesting](./streamDepth.md), [Unicode](./unicode.md), [canonical JSON](./canonicalJson.md), [numbers](./numbers.md), [value guards](./valueGuards.md), [grammar](./grammar.md) |
| Security and privacy | [Content and outbound security](./security.md), [privacy](./privacy.md), [privacy service](./privacyService.md), [confidential transport](./confidentialInference.md), [pseudonym corpus](./corpusPseudonyms.md), [pseudonym session](./pseudonymSession.md), [secret session](./secretSession.md), [secret profile](./secretProfile.md), [sensitive adapters](./sensitiveRequestAdapters.md), [guarded stream](./guardedStream.md) |
| Configuration and diagnostics | [Settings](./settings.md), [key management](./settingsKeys.md), [process environment](./environment.md), [diagnostics](./diagnostics.md), [integration telemetry](./integrationTelemetry.md), [logging](./logging/index.md), [traces](./traces.md), [trajectories](./trajectories.md) |
| Public surface | [Package exports](./packageExports.md), [consumer contracts](./consumerContracts.md), [npm release](./release.md), [protocol values](./protocols.md), [device bridge](./deviceBridge.md), [views](./views.md), [view navigation](./viewNavigation.md), [media](./media.md), [speech](./voice.md), [voice registry](./voiceRegistry.md) |

## Legacy model ownership

The [legacy transition inventory](./baseline/legacy-transition-map.json)
keeps the original target paths. These are the current owners for the three
targets that were consolidated.

### Each consolidated legacy target maps to its own current spec owner

- **`ChannelTopicRetirement` (`topicRooms.md`).** The per-room model checks
  `RoomOrder` with `alwaysOnlyHeadIsActive`. The service model admits only
  current-generation calls before stop (`NoLateOriginalAdmission`).
  `advanceRoom` updates only the selected room (`RoomIsolation`).
  `canFinishStop`, `alwaysRetiredServiceJoined`, and
  `alwaysStoppedCachesCleared` cover `RetirementJoinsOriginal` and
  `RetirementClearsLocal`. The service also owns `roomAt`, `roomIds`,
  `topicsForRoom`, and `topicsForAllRooms`. Queue counts derive from each
  room's queue. `Rooms`, `Calls`, and `OldCalls` are finite fixture sets.
  `leadsToServiceJoined` and `leadsToRoomCallsSettle`
  cover `StopSettles`, `FairStopSettles`, and `FairAcceptedCallsSettle` under
  weak fairness for room rotation and stop completion. The adapter supplies
  room-specific snapshots, normalization, and storage and promise outcomes.
  [Room queue rules](./channelTopics.md#retirement-rejects-new-work-and-joins-admitted-operations-before-clearing-local-state) · [Stop and progress rules](./topicService.md#stop-blocks-every-new-room-admission-and-joins-the-complete-room-snapshot) · [Cache reads](./topicService.md#room-reads-return-the-local-cache-empty-without-a-cache-entry-and-the-all-room-snapshot-follows-cache-insertion-order)
- **`EmbeddingWriteSettlement` (`embeddingBatch.md`).** The phase and receipt
  types and `alwaysAttemptsRespectPolicy` cover `TypeOK` with the configured
  retry limit. The write invariants `alwaysReceiptMatchesExactSource`,
  `alwaysReceiptClosesRetries`, and `alwaysOnlyStoredNotifies` cover
  `ExactSourceReceipt`, `ReceiptClosesRetry`, and `OnlyStoredNotifies`.
  `Items` is the legacy one- or two-item fixture set. `canStartFallback`
  requires the primary batch to settle first, and `canFinishBatchWork`
  requires each ticket to settle. `leadsToAttemptSettles` covers the
  per-write part of `Settled`, `Fairness`, `FairItemsSettle`, and `ItemsSettle`
  under weak fairness for the modeled write transitions. Progress for each
  ticket across the queue, processor, and storage owners remains a refinement
  obligation. The adapter compares the exact source and reports storage
  outcomes. Storage repair and durable deduplication remain adapter obligations.
  [Write receipt and progress rules](./embeddingWrite.md#a-confirmed-storage-receipt-closes-retry-ownership) · [Batch and fallback rules](./batchQueue.md#a-batched-call-settles-successful-items-before-retrying-failures) · [Pending source keys](./embeddingService.md#a-request-waits-for-the-activation-it-captured-and-queues-each-exact-source-once)
- **`TurnCancellation` (`turnEventStack.md`).** The dispatch model inherits
  the root abort only in the same turn (`RootSignalInherited`). Each turn
  can also have its own signal.
  `stepNoRetryAfterCancellation` and the invocation guard cover
  `NoFallbackAfterAbort`. A configured dispatch can cancel before admission
  (`CancelBeforeStart`). `leadsToCancelledDispatch` covers `CancelSettles`
  under weak fairness. `alwaysDispatchDeadlockFree` covers `DeadlockFree`.
  The dispatch phase type and `alwaysRegistrationAttemptedOnce` replace the
  phase and attempt checks in `TypeOK`. Its two-attempt limit belongs to the
  legacy fixture. The turn registry owns the native room scan, captured
  room arrays, and nested listener frames. Async context owns continuation
  restoration. Native callback behavior and recognition of wrapped provider
  errors remain adapter conformance boundaries. Composition across these
  owners remains a refinement obligation.
  [Dispatch cancellation and progress](./models.md#cancellation-follows-turn-identity-and-blocks-fallback) · [Room signal scan](./turnControllers.md#a-room-notice-follows-the-last-native-signal-callback) · [Nested events](./turnControllers.md#each-event-visits-the-live-listeners-in-order-and-finishes-nested-events-before-resuming) · [Continuation scope](./asyncContext.md#scope-restoration-and-peer-isolation-are-exact-for-every-context-value)

```quint
type LegacyTarget = ChannelTopicRetirement | EmbeddingWriteSettlement | TurnCancellation
type ConsolidatedOwner = ChannelTopicsSpec | EmbeddingWriteSpec | TurnDispatchSpec

pure def consolidatedOwner(target: LegacyTarget): ConsolidatedOwner =
  if (target == ChannelTopicRetirement) ChannelTopicsSpec
  else if (target == EmbeddingWriteSettlement) EmbeddingWriteSpec
  else TurnDispatchSpec

pure def lawEachLegacyTargetHasItsOwnConsolidatedOwner(a: LegacyTarget, b: LegacyTarget): bool =
  (consolidatedOwner(a) == consolidatedOwner(b)) iff (a == b)
```

## Story: Compose a kernel through explicit services

> As a host author, I want an agent kernel whose dependencies and failures
> are explicit, so I can compose local, server and embedded hosts around
> the same package.

### Each boundary operation has one owning layer

The host installs lifecycle and HTTP routes. Database and transport writes
cross an adapter boundary. Model inference crosses the installed provider
boundary. Registration, authorization and state decisions belong to core.
This vocabulary specifies dependency direction. Implementation acceptance
checks the actual package import graph and ESM export conditions.

```quint
type Layer = Core | EmbeddingHost | Adapter | Provider
type BoundaryOperation = Register | Authorize | Compose | Schedule | Settle | HttpRoute | PlatformBoot | Store | Send | Infer

pure def owner(operation: BoundaryOperation): Layer =
  if (operation == HttpRoute or operation == PlatformBoot) EmbeddingHost
  else if (operation == Store or operation == Send) Adapter
  else if (operation == Infer) Provider
  else Core

pure def lawCoreOwnsAuthorization(operation: BoundaryOperation): bool = operation == Authorize implies owner(operation) == Core
pure def lawHostOwnsBootAndRoutes(operation: BoundaryOperation): bool = (operation == PlatformBoot or operation == HttpRoute) implies owner(operation) == EmbeddingHost
pure def lawInferenceUsesProvider(operation: BoundaryOperation): bool = operation == Infer implies owner(operation) == Provider
pure def lawPersistenceUsesAdapter(operation: BoundaryOperation): bool = operation == Store implies owner(operation) == Adapter
```

### Compatibility translates asynchronous results without losing failures

Existing consumers retain the `AgentRuntime`, `IAgentRuntime`, `Plugin`,
`Service`, `Action`, `Provider`, `Evaluator`, `Character`, `Memory`, entity,
relationship, model and callback contracts. Public Promise entry points
translate the typed Effect outcome without fabricating success. A canceled
operation retains cancellation, and a failure retains its typed cause.
The complete signatures and leaf exports are recorded in the baseline.

```quint
type Outcome = Succeeded | Failed | Interrupted
type PublicOutcome = Resolved | Rejected | Aborted

pure def publicOutcome(result: Outcome): PublicOutcome =
  if (result == Succeeded) Resolved else if (result == Interrupted) Aborted else Rejected

pure def lawFailureIsRejected(result: Outcome): bool = result == Failed implies publicOutcome(result) == Rejected
pure def lawCancellationIsRetained(result: Outcome): bool = result == Interrupted implies publicOutcome(result) == Aborted
pure def lawSuccessRequiresSuccess(result: Outcome): bool = (publicOutcome(result) == Resolved) == (result == Succeeded)
```
