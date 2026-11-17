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

| Cluster | Specifications |
| --- | --- |
| Turn | [End-to-end turn](./journey.md), [state composition](./stateComposition.md), [context](./context.md), [action planning](./actionPlanning.md), [actions](./execution.md), [action receipts](./actionReceipts.md), [receipts](./receipts.md), [receipt binding registry](./receiptBindings.md), [confirmation](./confirmation.md), [response fields](./responseFields.md), [response evaluators](./responseEvaluation.md), [turn controllers](./turnControllers.md), [terminal ownership](./terminal.md), [outbound style rewriting](./outboundStyle.md), [chat pre-handlers](./chatPreHandlers.md) |
| Runtime lifecycle | [Runtime lifecycle](./runtime.md), [shutdown attempts](./runtimeShutdown.md), [runtime run context](./runtimeRunContext.md), [retirement tracker](./retirementTracker.md), [adapter lifecycle](./adapterOwnership.md), [anonymous naming](./anonymousIdentity.md), [internal actors](./internalActors.md) |
| Plugins and registries | [Plugins](./plugins.md), [plugin epochs and services](./pluginServices.md), [runtime registries](./registries.md), [pipeline hooks](./hooks.md), [concurrent hooks](./concurrentHooks.md) |
| Services | [Services](./services.md), [service instances](./serviceInstances.md), [acquisition results](./serviceAcquisitionResult.md), [service stop observations](./serviceStopObservation.md), [eager startup](./eagerServices.md), [service builder](./serviceBuilder.md) |
| Models and capabilities | [Model dispatch](./models.md), [model diagnostics](./modelDiagnostics.md), [model attempt leases](./modelAttemptLeases.md), [inference priority](./inferenceGate.md), [inference timing](./inferenceTiming.md), [timing registry](./timingRegistry.md), [prepared requests](./preparedRequests.md), [request serializers](./preparedRequestSerialization.md), [processing policy](./processingPolicy.md), [capability routing](./capabilityRouting.md), [capability strategies](./capabilityStrategies.md), [capability coordinator](./capabilityCoordinator.md), [capability dispatch authority](./capabilityAuthority.md), [catalog](./catalog.md), [providers](./providers/index.md) |
| Request authority | [Request issuer](./requestIssuer.md), [request completion](./requestCompletions.md), [request authority](./requestAuthorityRegistry.md), [ambient managers](./ambientManagers.md) |
| Authorization and approvals | [Authorization](./authorization.md), [approvals](./approvals.md), [approval service](./approvalService.md), [approval retirement](./approvalRetirement.md), [trusted delivery audiences](./trustedAudience.md), [audience registry](./audienceRegistry.md) |
| Connectors and messaging | [Connector dispatch](./messaging.md), [concurrent connectors](./concurrentConnectors.md), [account lifecycle and storage](./connectorStorage.md), [manager registry](./connectorManagers.md), [storage backends](./connectorBackends.md), [OAuth](./oauth/index.md), [operation queues](./connectorQueues.md), [source and profile registries](./connectorRegistries.md), [connector metadata](./connectorSources.md), [connection locks](./connectionLocks.md), [context taxonomy](./contextRegistry.md), [connector values](./accountValues.md), [connector handoff](./connectorHandoff.md), [account bridges](./accountBridges.md), [pairing](./pairing/index.md), [notifications](./notifications/index.md) |
| Tasks and background work | [Scheduling](./scheduling.md), [process scheduler](./processScheduler.md), [query drain ownership](./queryDrain.md), [scheduler and query drain](./sharedScheduler.md), [task service](./taskServiceOwners.md), [task drain](./taskDrain.md), [task event reader](./taskEventReader.md), [serialization](./serialisation.md), [interactive tasks](./interactiveTask.md), [interaction sessions](./sessions.md), [session store](./sessionStore.md), [post-delivery tasks](./postDelivery.md), [awareness cache](./awareness.md), [awareness registry](./awarenessRegistry.md) |
| Concurrency primitives | [Room queue](./concurrency.md), [multi-room leases](./multiRoomLeases.md), [room observers](./roomQueueObservers.md), [semaphores](./semaphore.md), [read memo](./memo.md), [concurrent memo readers](./memoConcurrency.md), [priority queue](./priorityQueue.md), [batch queue](./batchQueue.md), [batch processor](./batchProcessor.md), [async context](./asyncContext.md), [event streams](./events.md) |
| Topics | [Channel topics](./channelTopics.md), [topic service](./topicService.md) |
| Persistence | [Entities and mutations](./entities.md), [fact writes](./factWrites.md), [identity groups](./identityGroups.md), [source storage](./storage.md), [source collection](./sourceSweep.md), [ingress snapshots](./ingressSnapshots.md), [atomic files](./atomicPublication.md), [concurrent file writers](./atomicWriters.md), [temporary names](./temporaryNames.md) |
| Embedding and retrieval | [Embedding service](./embeddingService.md), [embedding identity](./embeddingSpace.md), [embedding writes](./embeddingWrite.md), [retrieval](./retrieval.md) |
| Streaming and values | [Markable streams](./streamMarkable.md), [stream revisions](./streamRevisions.md), [structured fields](./structuredStreamState.md), [response skeleton](./skeletonStreamState.md), [UTF-16 stream units](./streamUnits.md), [stream nesting](./streamDepth.md), [Unicode](./unicode.md), [canonical JSON](./canonicalJson.md), [numbers](./numbers.md), [value guards](./valueGuards.md), [grammar](./grammar.md) |
| Security and privacy | [Content and outbound security](./security.md), [privacy](./privacy.md), [privacy service](./privacyService.md), [confidential transport](./confidentialInference.md), [pseudonym corpus](./corpusPseudonyms.md), [pseudonym session](./pseudonymSession.md), [secret session](./secretSession.md), [secret profile](./secretProfile.md), [sensitive adapters](./sensitiveRequestAdapters.md), [guarded stream](./guardedStream.md) |
| Configuration and diagnostics | [Settings](./settings.md), [key management](./settingsKeys.md), [process environment](./environment.md), [diagnostics](./diagnostics.md), [integration telemetry](./integrationTelemetry.md), [logging](./logging/index.md), [traces](./traces.md), [trajectories](./trajectories.md) |
| Public surface | [Package exports](./packageExports.md), [consumer contracts](./consumerContracts.md), [npm release](./release.md), [protocol values](./protocols.md), [device bridge](./deviceBridge.md), [views](./views.md), [view navigation](./viewNavigation.md), [media](./media.md), [speech](./voice.md), [voice registry](./voiceRegistry.md) |

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
