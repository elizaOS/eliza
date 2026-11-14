# Eliza core

The kernel owns agent identity, registration, lifecycle, state composition,
model dispatch, authorization, memory contracts, task scheduling and effect
settlement. Hosts install database adapters, model providers and assistant
behavior explicitly. A runtime serves one agent and never imports an
application host.

The compatibility baseline is the source and published export map at
`elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Public declarations
and downstream imports are retained in `baseline/`. Existing core Quint
modules, case bounds, temporal assumptions and source coverage are retained
verbatim in `baseline/legacy-models.json` for comparison with these models.
The [legacy transition map](./baseline/legacy-transition-map.json) traces
the original actions and properties to their replacement owners and lists
remaining refinement and model gaps. The linked literate models own the
replacement's state.

| Area | Specifications |
| --- | --- |
| Kernel composition | [End-to-end turn](./journey.md), [runtime lifecycle](./runtime.md), [shutdown attempts](./runtimeShutdown.md), [services](./services.md), [service registry](./serviceRegistry.md), [plugins](./plugins.md), [plugin epochs](./pluginRegistry.md), [plugin service ownership](./pluginServices.md), [component registries](./registries.md), [pipeline hooks](./hooks.md), [internal actors](./internalActors.md), [anonymous naming](./anonymousIdentity.md) |
| Turn execution | [Model dispatch](./models.md), [providers](./providers.md), [evaluators](./evaluators.md), [actions](./execution.md), [messaging](./messaging.md), [terminal ownership](./terminal.md) |
| Concurrency | [Room queue](./concurrency.md), [multi-room leases](./multiRoomLeases.md), [semaphores](./semaphore.md), [serialization](./serialisation.md), [read memo](./memo.md), [concurrent memo readers](./memoConcurrency.md), [priority queue](./priorityQueue.md), [batch queue](./batchQueue.md), [batch processor](./batchProcessor.md), [inference priority](./inferenceGate.md) |
| Identity and persistence | [Authorization](./authorization.md), [capability dispatch authority](./capabilityAuthority.md), [trusted delivery audiences](./trustedAudience.md), [entities and mutations](./entities.md), [identity groups](./identityGroups.md), [source storage](./storage.md), [ingress snapshots](./ingressSnapshots.md), [atomic files](./atomicPublication.md), [concurrent file writers](./atomicWriters.md), [pairing](./pairing.md), [connector metadata](./connectorSources.md), [source collection](./sourceSweep.md), [fact writes](./factWrites.md) |
| Evidence and privacy | [Context](./context.md), [receipts](./receipts.md), [confirmation](./confirmation.md), [response field fences](./responseFences.md), [response field registry](./responseFields.md), [traces](./traces.md), [privacy](./privacy.md) |
| Background work | [Scheduling](./scheduling.md), [query drain ownership](./queryDrain.md), [interactive tasks](./interactiveTask.md), [interaction sessions](./sessions.md), [post-delivery tasks](./postDelivery.md), [approvals](./approvals.md), [notifications](./notifications.md), [notification startup](./notificationHydration.md), [notification payload ownership](./notificationPayload.md), [notification recovery](./notificationRecovery.md), [event streams](./events.md), [async context](./asyncContext.md), [awareness cache](./awareness.md), [awareness registry](./awarenessRegistry.md) |
| Public consumers | [Package contracts](./contracts.md), [npm release](./release.md), [protocols](./protocols.md), [catalog](./catalog.md), [curated aliases](./curatedApps.md), [views](./views.md), [channel topics](./channelTopics.md), [topic rooms](./topicRooms.md), [media](./media.md), [speech](./voice.md), [voice registry](./voiceRegistry.md), [voice rewriting](./voiceRewrite.md) |
| Embedding and retrieval | [Embedding identity](./embeddingSpace.md), [embedding writes](./embeddingWrite.md), [batch embedding](./embeddingBatch.md), [retrieval corpus](./retrievalIndex.md), [optimization metrics](./scoreCard.md) |
| Streaming | [Markable streams](./streamMarkable.md), [structured fields](./streamStructured.md), [response skeleton](./streamSkeleton.md), [stream revisions](./streamRevisions.md) |
| Pure value semantics | [Canonical JSON](./canonicalJson.md), [numbers](./numbers.md), [Unicode](./unicode.md), [value guards](./valueGuards.md), [grammar](./grammar.md) |
| Configuration and diagnostics | [Settings](./settings.md), [key management](./settingsKeys.md), [process environment](./environment.md), [account bridges](./accountBridges.md), [diagnostics](./diagnostics.md), [integration telemetry](./integrationTelemetry.md), [log listeners](./logListeners.md), [log files](./logFiles.md), [inference timing](./inferenceTiming.md), [timing registry](./timingRegistry.md) |
| Runtime authority | [Routing extensions](./routingRegistries.md), [processing policy](./processingPolicy.md), [model attempt leases](./modelAttemptLeases.md), [prepared requests](./preparedRequests.md), [ambient managers](./ambientManagers.md), [request issuer](./requestIssuer.md), [request completion](./requestCompletions.md), [reminder presentation](./reminderPresentation.md) |
| Confidential processing | [Confidential transport](./confidentialInference.md), [outbound envelope](./outboundEnvelope.md), [pseudonym corpus](./corpusPseudonyms.md), [pseudonym session](./pseudonymSession.md), [secret session](./secretSession.md), [guarded stream](./guardedStream.md) |
| Connector accounts | [Account storage](./connectorStorage.md), [manager policy](./connectorManagers.md), [storage migration](./connectorMigration.md), [OAuth completion](./oauthLifecycle.md), [PKCE secrets](./oauthSecrets.md) |
| Concurrent delivery | [Turn controllers](./turnControllers.md), [notification pagination](./notificationCursor.md), [notification recovery ownership](./notificationRecoveryOwners.md), [pairing admission](./pairingAdmission.md), [pairing grants](./pairingGrants.md), [pairing replies](./pairingReplies.md), [view navigation](./viewNavigation.md) |
| Shared service ownership | [Service instances](./serviceInstances.md), [eager startup](./eagerServices.md), [service builder](./serviceBuilder.md), [runtime extensions](./runtimeExtensions.md), [capability strategies](./capabilityStrategies.md), [chat pre-handlers](./chatPreHandlers.md), [response evaluator registry](./responseEvaluators.md), [response evaluation](./responseEvaluation.md) |
| Dispatch composition | [Provider executions](./providerExecutions.md), [concurrent hooks](./concurrentHooks.md), [concurrent connectors](./concurrentConnectors.md), [hook service](./hookService.md), [turn event stack](./turnEventStack.md), [stream nesting](./streamDepth.md), [action receipts](./actionReceipts.md) |
| Shared authorization | [Capability coordinator](./capabilityCoordinator.md), [audience registry](./audienceRegistry.md), [receipt binding registry](./receiptBindings.md), [approval workers](./approvalWorkers.md), [approval service](./approvalService.md), [approval retirement](./approvalRetirement.md), [session store](./sessionStore.md), [secret profile](./secretProfile.md), [sensitive adapters](./sensitiveRequestAdapters.md), [trajectory source registry](./trajectorySources.md) |
| Connector composition | [Backend identity](./connectorBackends.md), [operation queues](./connectorQueues.md), [source and profile registries](./connectorRegistries.md), [connection locks](./connectionLocks.md), [OAuth start](./oauthStart.md), [context taxonomy](./contextRegistry.md) |
| Shared task ownership | [Process scheduler](./processScheduler.md), [scheduler and query drain](./sharedScheduler.md), [task service](./taskServiceOwners.md), [task drain](./taskDrain.md), [task event reader](./taskEventReader.md), [temporary names](./temporaryNames.md) |
| Detailed ownership | [Adapter lifecycle](./adapterOwnership.md), [runtime run context](./runtimeRunContext.md), [model diagnostics](./modelDiagnostics.md), [retirement tracker](./retirementTracker.md), [room observers](./roomQueueObservers.md), [request authority](./requestAuthorityRegistry.md), [embedding service](./embeddingService.md), [privacy service](./privacyService.md) |
| Canonical data and streaming | [Connector values](./accountValues.md), [OAuth bridge](./oauthBridge.md), [connector handoff](./connectorHandoff.md), [topic service](./topicService.md), [UTF-16 stream units](./streamUnits.md), [structured stream state](./structuredStreamState.md), [skeleton stream state](./skeletonStreamState.md) |

The [public surface](./baseline/core-public-surface.json),
[consumer imports](./baseline/core-consumers.json), and
[source contract map](./baseline/source-contract-map.json) make the
compatibility research auditable at the pinned revision.
Proposed corrections to legacy failure behavior are recorded in the
[compatibility decisions](./baseline/compatibility-decisions.json).

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
type Layer = Core | Host | Adapter | Provider
type BoundaryOperation = Register | Authorize | Compose | Schedule | Settle | HttpRoute | PlatformBoot | Store | Send | Infer

pure def owner(operation: BoundaryOperation): Layer =
  if (operation == HttpRoute or operation == PlatformBoot) Host
  else if (operation == Store or operation == Send) Adapter
  else if (operation == Infer) Provider
  else Core

pure def lawCoreOwnsAuthorization(operation: BoundaryOperation): bool = operation == Authorize implies owner(operation) == Core
pure def lawHostOwnsBootAndRoutes(operation: BoundaryOperation): bool = (operation == PlatformBoot or operation == HttpRoute) implies owner(operation) == Host
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
