# Shared request authority and completion registry

Shared request authority of `actions/task-extraction-context.ts`. Runtime/message pairs own issuers, `State.data` objects own extraction views, and each opaque attempt and result object has one issuer owner, under which its [issuer restriction](./requestIssuer.md) and [completion evidence](./requestCompletions.md) live. IDs denote host object references. The authenticated sender supplies `HostBoundary` separately from parsed payloads, and the host derives hashes and resolves the registered action, family and canonical child from its live registry.

## Story: Keep concurrent requests and their copied views isolated

> As the execution boundary, I want concurrent requests and their copied
> views kept isolated, so that one request's authority or completion
> evidence never reaches another.

### Object identity and current request fields determine the active issuer

Each issuer owns its original liveness callback. A trusted observation can close one request without changing another issuer or the runtime. Source observations retain the exact frozen classification input and its live counterpart.

Discovered by simulation: a classification and its interpretation come from one classifier result over one frozen source, and the host repeats a commit for the same request with that same result. Sampled as independent values, almost every later commit contradicted the first and tainted the issuer, so no attempt survived long enough to complete. A commit is sampled as one record: most records state a first commit (consistent mutation and read-only results, unresolved, an inconsistent interpretation, a contradictory one, another source, a mismatched observed source) that a later commit repeats exactly, two records are contradictory later commits (a changed classification and a changed source) that taint the issuer, and one is a later commit whose live source no longer matches its frozen source, which is refused. Consistent mutation results with several operation sets make up about half of the first commits, since only a mutation can complete an attempt; the read-only and unresolved ones still reach a denial.

Discovered by simulation: the host receives a message for the agent of one of its runtimes, and an issuer exists only when the two agents match. Sampled independently, half the messages belonged to no runtime's agent. A message's agent is sampled as either the agent of a runtime the host holds or an explicit agent, so messages for another agent are still created.

Discovered by simulation: the host registers the runtimes it is running, so a runtime is usually live when it is registered. Sampled as an independent flag, half the runtimes were dead from the start, and a trace whose two runtimes were both dead could begin no issuer. A registration is sampled as one record: a live runtime for either agent, or one registered dead. Observing a runtime still makes it dead or live later.

```quint
import requestIssuer as I from "./requestIssuer"
import requestCompletions as C from "./requestCompletions"
type RegistryCaller = HostBoundary | ExternalPayload
type RuntimeObject = { id: int, agentId: str, live: bool }
type RequestMessage = { objectId: int, agentId: str, messageId: str, roomId: str, entityId: str, requestHash: str }
type RequestState = { objectId: int, dataId: int, stateHash: str }
type ExtractionView = { dataId: int, messageObject: int, requestHash: str, stateHash: str, sourceHash: str, projectionHash: str, observedSourceHash: str, observedProjectionHash: str, issuerId: int, extractionAllowed: bool }
type IssuerOwner = { id: int, runtimeId: int, messageObject: int, agentId: str, messageId: str, roomId: str, entityId: str, originalSourceHash: str, issuer: I::RequestIssuer, completions: C::RequestCompletions }
type RequestRegistry = { runtimes: List[RuntimeObject], messages: List[RequestMessage], states: List[RequestState], views: List[ExtractionView], owners: List[IssuerOwner], nextIssuer: int, lastIssuer: int, lastAllowed: bool, lastBound: bool }
pure val emptyRuntime: RuntimeObject = { id: 0, agentId: "", live: false }
pure val emptyMessage: RequestMessage = { objectId: 0, agentId: "", messageId: "", roomId: "", entityId: "", requestHash: "" }
pure val emptyState: RequestState = { objectId: 0, dataId: 0, stateHash: "" }
pure val emptyView: ExtractionView = { dataId: 0, messageObject: 0, requestHash: "", stateHash: "", sourceHash: "", projectionHash: "", observedSourceHash: "", observedProjectionHash: "", issuerId: 0, extractionAllowed: false }
pure val emptyOwner: IssuerOwner = { id: 0, runtimeId: 0, messageObject: 0, agentId: "", messageId: "", roomId: "", entityId: "", originalSourceHash: "", issuer: I::initial, completions: C::initial }
pure val initial: RequestRegistry = { runtimes: List(), messages: List(), states: List(), views: List(), owners: List(), nextIssuer: 1, lastIssuer: 0, lastAllowed: false, lastBound: false }
pure val byValues = Set(HostBoundary, ExternalPayload)
pure val runtimeIdValues = Set(1, 2)
pure val messageObjectValues = Set(1, 2, 3)
pure val stateObjectValues = Set(1, 2, 3)
pure val copyIdValues = Set(1, 2, 3)
pure val dataIdValues = Set(1, 2, 3)
pure val issuerIdValues = Set(1, 2, 3)
pure val agentIdValues = Set("agent1", "agent2")
pure val messageIdValues = Set("message1", "message2")
pure val roomIdValues = Set("room1", "room2")
pure val entityIdValues = Set("actor1", "actor2")
pure val requestHashValues = Set("request1", "request2")
pure val stateHashValues = Set("state1", "state2")
pure val sourceHashValues = Set("source1", "source2")
pure val projectionHashValues = Set("projection1", "projection2")
pure val currentSourceHashValues = sourceHashValues
pure val currentOriginalHashValues = sourceHashValues
pure def runtimeAt(s: RequestRegistry, runtimeId: int): RuntimeObject = s.runtimes.select(runtime => runtime.id == runtimeId).nthOr(0, emptyRuntime)
pure def messageAt(s: RequestRegistry, messageObject: int): RequestMessage = s.messages.select(message => message.objectId == messageObject).nthOr(0, emptyMessage)
pure def stateAt(s: RequestRegistry, stateObject: int): RequestState = s.states.select(frame => frame.objectId == stateObject).nthOr(0, emptyState)
pure def ownerAt(s: RequestRegistry, issuerId: int): IssuerOwner = s.owners.select(owner => owner.id == issuerId).nthOr(0, emptyOwner)
pure def pairOwner(s: RequestRegistry, runtimeId: int, messageObject: int): IssuerOwner = s.owners.select(owner => owner.runtimeId == runtimeId and owner.messageObject == messageObject).nthOr(0, emptyOwner)
pure def ownerCurrent(owner: IssuerOwner, s: RequestRegistry): bool = owner.id != 0 and runtimeAt(s, owner.runtimeId).live and runtimeAt(s, owner.runtimeId).agentId == owner.agentId and messageAt(s, owner.messageObject).agentId == owner.agentId and messageAt(s, owner.messageObject).messageId == owner.messageId and messageAt(s, owner.messageObject).roomId == owner.roomId and messageAt(s, owner.messageObject).entityId == owner.entityId and messageAt(s, owner.messageObject).requestHash == owner.issuer.requestHash and I::validIssuer(owner.issuer) and (not(owner.issuer.committed) or owner.originalSourceHash == owner.issuer.sourceHash)
pure def refreshedOwner(owner: IssuerOwner, s: RequestRegistry): IssuerOwner = { ...owner, completions: C::observeAuthority(owner.completions, owner.issuer.revision, ownerCurrent(owner, s) and owner.issuer.committed, I::restriction(owner.issuer)) }
pure def replaceOwner(owner: IssuerOwner, s: RequestRegistry): RequestRegistry = { ...s, owners: s.owners.listMap(existing => if (existing.id == owner.id) owner else existing) }
type RuntimeRegistration = { agentId: str, live: bool }
pure val runtimeRegistrationValues = Set({ agentId: "agent1", live: true }, { agentId: "agent2", live: true }, { agentId: "agent1", live: false })
pure def canRegisterRuntime(s: RequestRegistry, by: RegistryCaller, runtimeId: int, runtimeRegistration: RuntimeRegistration): bool = by == HostBoundary and runtimeId > 0 and runtimeRegistration.agentId != "" and not(s.runtimes.some(runtime => runtime.id == runtimeId))
pure def registerRuntime(s: RequestRegistry, by: RegistryCaller, runtimeId: int, runtimeRegistration: RuntimeRegistration): RequestRegistry = { ...s, runtimes: s.runtimes.append({ id: runtimeId, agentId: runtimeRegistration.agentId, live: runtimeRegistration.live }) }
type MessageAgent = { runtimeAgent: bool, runtimeId: int, agentId: str }
pure val messageAgentValues = Set({ runtimeAgent: true, runtimeId: 1, agentId: "" }, { runtimeAgent: true, runtimeId: 2, agentId: "" }, { runtimeAgent: false, runtimeId: 0, agentId: "agent1" }, { runtimeAgent: false, runtimeId: 0, agentId: "agent2" })
pure def messageAgentId(s: RequestRegistry, messageAgent: MessageAgent): str = if (messageAgent.runtimeAgent) runtimeAt(s, messageAgent.runtimeId).agentId else messageAgent.agentId
pure def canCreateMessage(s: RequestRegistry, by: RegistryCaller, messageObject: int, messageAgent: MessageAgent, messageId: str, roomId: str, entityId: str, requestHash: str): bool = by == HostBoundary and messageObject > 0 and not(s.messages.some(message => message.objectId == messageObject))
pure def createMessage(s: RequestRegistry, by: RegistryCaller, messageObject: int, messageAgent: MessageAgent, messageId: str, roomId: str, entityId: str, requestHash: str): RequestRegistry = { ...s, messages: s.messages.append({ objectId: messageObject, agentId: messageAgentId(s, messageAgent), messageId: messageId, roomId: roomId, entityId: entityId, requestHash: requestHash }) }
pure def canCopyMessage(s: RequestRegistry, messageObject: int, copyId: int): bool = messageAt(s, messageObject).objectId != 0 and copyId > 0 and not(s.messages.some(message => message.objectId == copyId))
pure def copyMessage(s: RequestRegistry, messageObject: int, copyId: int): RequestRegistry = { ...s, messages: s.messages.append({ ...messageAt(s, messageObject), objectId: copyId }) }
pure def canCreateState(s: RequestRegistry, stateObject: int, dataId: int, stateHash: str): bool = stateObject > 0 and dataId > 0 and not(s.states.some(frame => frame.objectId == stateObject)) and not(s.states.some(frame => frame.dataId == dataId))
pure def createState(s: RequestRegistry, stateObject: int, dataId: int, stateHash: str): RequestRegistry = { ...s, states: s.states.append({ objectId: stateObject, dataId: dataId, stateHash: stateHash }) }
pure def canCopyState(s: RequestRegistry, stateObject: int, copyId: int): bool = stateAt(s, stateObject).objectId != 0 and copyId > 0 and not(s.states.some(frame => frame.objectId == copyId))
pure def copyState(s: RequestRegistry, stateObject: int, copyId: int): RequestRegistry = { ...s, states: s.states.append({ ...stateAt(s, stateObject), objectId: copyId }) }
pure def getIssuer(s: RequestRegistry, runtimeId: int, messageObject: int): int = if (ownerCurrent(pairOwner(s, runtimeId, messageObject), s)) pairOwner(s, runtimeId, messageObject).id else 0
pure def canBeginIssuer(s: RequestRegistry, by: RegistryCaller, runtimeId: int, messageObject: int): bool = by == HostBoundary and runtimeAt(s, runtimeId).live and messageAt(s, messageObject).messageId != "" and messageAt(s, messageObject).roomId != "" and messageAt(s, messageObject).entityId != "" and runtimeAt(s, runtimeId).agentId == messageAt(s, messageObject).agentId
pure def beginIssuer(s: RequestRegistry, by: RegistryCaller, runtimeId: int, messageObject: int): RequestRegistry = {
  val previous = pairOwner(s, runtimeId, messageObject)
  val message = messageAt(s, messageObject)
  val owner = { id: s.nextIssuer, runtimeId: runtimeId, messageObject: messageObject, agentId: runtimeAt(s, runtimeId).agentId, messageId: message.messageId, roomId: message.roomId, entityId: message.entityId, originalSourceHash: "", issuer: I::beginIssuer(I::initial, true, true, message.requestHash), completions: C::initial }
  if (previous.id != 0) { ...s, lastIssuer: if (ownerCurrent(previous, s)) previous.id else 0 }
  else { ...s, owners: s.owners.append(owner), nextIssuer: s.nextIssuer + 1, lastIssuer: s.nextIssuer }
}
pure def canObserveRequest(s: RequestRegistry, by: RegistryCaller, messageObject: int, requestHash: str): bool = by == HostBoundary and messageAt(s, messageObject).objectId != 0
pure def observeRequest(s: RequestRegistry, by: RegistryCaller, messageObject: int, requestHash: str): RequestRegistry = { ...s, messages: s.messages.listMap(message => if (message.objectId == messageObject) { ...message, requestHash: requestHash } else message) }
pure def canObserveRuntime(s: RequestRegistry, by: RegistryCaller, runtimeId: int, agentId: str, live: bool): bool = by == HostBoundary and runtimeAt(s, runtimeId).id != 0
pure def observeRuntime(s: RequestRegistry, by: RegistryCaller, runtimeId: int, agentId: str, live: bool): RequestRegistry = { ...s, runtimes: s.runtimes.listMap(runtime => if (runtime.id == runtimeId) { ...runtime, agentId: agentId, live: live } else runtime) }
type RestrictionCommit = { repeatCommitted: bool, classification: C::RequestClass, interpretation: I::Interpretation, sourceHash: str, observedSourceHash: str }
pure val restrictionCommitValues = Set(
  { repeatCommitted: true, classification: C::MutationClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::UpdateOperation) }, sourceHash: "source1", observedSourceHash: "source1" },
  { repeatCommitted: true, classification: C::MutationClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::CreateOperation, C::DeleteOperation) }, sourceHash: "source1", observedSourceHash: "source1" },
  { repeatCommitted: true, classification: C::MutationClass, interpretation: { status: I::UnavailableInterpretation, operations: Set() }, sourceHash: "source2", observedSourceHash: "source2" },
  { repeatCommitted: true, classification: C::MutationClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::CreateOperation) }, sourceHash: "source2", observedSourceHash: "source2" },
  { repeatCommitted: true, classification: C::MutationClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::UpdateOperation, C::PatchOperation) }, sourceHash: "source2", observedSourceHash: "source2" },
  { repeatCommitted: true, classification: C::MutationClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::DeleteOperation) }, sourceHash: "source1", observedSourceHash: "source1" },
  { repeatCommitted: true, classification: C::MutationClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::CreateOperation, C::UpdateOperation) }, sourceHash: "source2", observedSourceHash: "source2" },
  { repeatCommitted: true, classification: C::ReadOnlyClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::GetOperation, C::ListOperation) }, sourceHash: "source1", observedSourceHash: "source1" },
  { repeatCommitted: true, classification: C::ReadOnlyClass, interpretation: { status: I::UnavailableInterpretation, operations: Set() }, sourceHash: "source2", observedSourceHash: "source2" },
  { repeatCommitted: true, classification: C::UnresolvedClass, interpretation: { status: I::UnavailableInterpretation, operations: Set() }, sourceHash: "source1", observedSourceHash: "source1" },
  { repeatCommitted: true, classification: C::MutationClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::GetOperation, C::ListOperation) }, sourceHash: "source1", observedSourceHash: "source1" },
  { repeatCommitted: true, classification: C::ReadOnlyClass, interpretation: { status: I::ContradictoryInterpretation, operations: Set() }, sourceHash: "source1", observedSourceHash: "source1" },
  { repeatCommitted: true, classification: C::MutationClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::UpdateOperation) }, sourceHash: "source1", observedSourceHash: "source2" },
  { repeatCommitted: false, classification: C::ReadOnlyClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::GetOperation, C::ListOperation) }, sourceHash: "source1", observedSourceHash: "source1" },
  { repeatCommitted: false, classification: C::MutationClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::UpdateOperation) }, sourceHash: "source2", observedSourceHash: "source2" },
  { repeatCommitted: false, classification: C::MutationClass, interpretation: { status: I::ExplicitInterpretation, operations: Set(C::UpdateOperation) }, sourceHash: "source1", observedSourceHash: "source2" })
pure def committedRestriction(s: RequestRegistry, issuerId: int, restrictionCommit: RestrictionCommit): RestrictionCommit = if (restrictionCommit.repeatCommitted and ownerAt(s, issuerId).issuer.committed) { repeatCommitted: true, classification: ownerAt(s, issuerId).issuer.classification, interpretation: ownerAt(s, issuerId).issuer.interpretation, sourceHash: ownerAt(s, issuerId).issuer.sourceHash, observedSourceHash: ownerAt(s, issuerId).issuer.sourceHash } else restrictionCommit
pure def canCommitRestriction(s: RequestRegistry, by: RegistryCaller, issuerId: int, restrictionCommit: RestrictionCommit): bool = {
  val commit = committedRestriction(s, issuerId, restrictionCommit)
  by == HostBoundary and ownerCurrent(ownerAt(s, issuerId), s) and I::canCommitRestriction(ownerAt(s, issuerId).issuer, commit.sourceHash, commit.observedSourceHash)
}
pure def commitRestriction(s: RequestRegistry, by: RegistryCaller, issuerId: int, restrictionCommit: RestrictionCommit): RequestRegistry = {
  val owner = ownerAt(s, issuerId)
  val commit = committedRestriction(s, issuerId, restrictionCommit)
  replaceOwner({ ...owner, originalSourceHash: if (owner.issuer.committed) owner.originalSourceHash else commit.sourceHash, issuer: I::commitRestriction(owner.issuer, commit.classification, commit.interpretation, commit.sourceHash, commit.observedSourceHash) }, s)
}
pure def canObserveSources(s: RequestRegistry, by: RegistryCaller, issuerId: int, issuerLive: bool, currentSourceHash: str, currentOriginalHash: str): bool = by == HostBoundary and ownerAt(s, issuerId).id != 0
pure def observeSources(s: RequestRegistry, by: RegistryCaller, issuerId: int, issuerLive: bool, currentSourceHash: str, currentOriginalHash: str): RequestRegistry = {
  val owner = ownerAt(s, issuerId)
  replaceOwner({ ...owner, originalSourceHash: currentOriginalHash, issuer: I::observeCurrent(owner.issuer, issuerLive, owner.issuer.currentRequestHash, currentSourceHash) }, s)
}
```

### State.data aliases share one exact view while serialized copies carry no view

Discovered by simulation: the source and projection values of a binding
come from one host observation. Sample them together so the simulation
exercises an exact view, a mismatched projection and a stale source tuple.
Each field is still checked with its own identity or hash.

Discovered by simulation: the planner boundary passes the issuer it reads
for its own runtime and message, and builds the original context from that
message. Sampled independently, the issuer, runtime, message ID and room
almost never describe one request, and each wrong binding replaces a good
view. An observation therefore says where its issuer and source metadata
come from: the caller's own issuer or an explicit one, and the bound
message's own metadata or explicit IDs. Its runtime is either the one that
serves the message's agent, as on the planner path, or an explicit one.
The planner binds the state for the request it is serving, the one whose
issuer the host began last, so most planner observations bind that request's
message, and so wait until the host has begun one; the others name the
message explicitly, as before. Foreign issuers, a foreign
runtime, an explicit issuer on the serving runtime, stale message IDs or
rooms, a mismatched projection and a denied extraction remain in the sample,
and the resolved values are checked exactly as before.

```quint
pure def viewAt(s: RequestRegistry, stateObject: int): ExtractionView = s.views.select(view => view.dataId == stateAt(s, stateObject).dataId).nthOr(0, emptyView)
pure def boundViewCurrent(s: RequestRegistry, stateObject: int, messageObject: int): bool = viewAt(s, stateObject).dataId != 0 and viewAt(s, stateObject).requestHash == messageAt(s, messageObject).requestHash and viewAt(s, stateObject).stateHash == stateAt(s, stateObject).stateHash and viewAt(s, stateObject).sourceHash == viewAt(s, stateObject).observedSourceHash and viewAt(s, stateObject).projectionHash == viewAt(s, stateObject).observedProjectionHash
pure def extractionViewAllowed(s: RequestRegistry, stateObject: int, messageObject: int): bool = boundViewCurrent(s, stateObject, messageObject) and viewAt(s, stateObject).extractionAllowed
type ViewBindingObservation = {servedMessage: bool, callerIssuer: bool, issuerId: int, callerRuntime: bool, runtimeId: int, currentMetadata: bool, sourceMessageId: str, sourceRoomId: str, sourceHash: str, projectionHash: str, expectedProjectionHash: str, extractionAllowed: bool}
pure val bindingValues = Set(
  {servedMessage: true, callerIssuer: true, issuerId: 0, callerRuntime: true, runtimeId: 0, currentMetadata: true, sourceMessageId: "", sourceRoomId: "", sourceHash: "source1", projectionHash: "projection1", expectedProjectionHash: "projection1", extractionAllowed: true},
  {servedMessage: true, callerIssuer: true, issuerId: 0, callerRuntime: true, runtimeId: 0, currentMetadata: true, sourceMessageId: "", sourceRoomId: "", sourceHash: "source2", projectionHash: "projection2", expectedProjectionHash: "projection2", extractionAllowed: true},
  {servedMessage: true, callerIssuer: true, issuerId: 0, callerRuntime: true, runtimeId: 0, currentMetadata: true, sourceMessageId: "", sourceRoomId: "", sourceHash: "source1", projectionHash: "projection1", expectedProjectionHash: "projection1", extractionAllowed: false},
  {servedMessage: true, callerIssuer: true, issuerId: 0, callerRuntime: true, runtimeId: 0, currentMetadata: true, sourceMessageId: "", sourceRoomId: "", sourceHash: "source1", projectionHash: "projection1", expectedProjectionHash: "projection2", extractionAllowed: true},
  {servedMessage: true, callerIssuer: true, issuerId: 0, callerRuntime: true, runtimeId: 0, currentMetadata: false, sourceMessageId: "message1", sourceRoomId: "room2", sourceHash: "source1", projectionHash: "projection1", expectedProjectionHash: "projection1", extractionAllowed: true},
  {servedMessage: true, callerIssuer: true, issuerId: 0, callerRuntime: true, runtimeId: 0, currentMetadata: false, sourceMessageId: "message2", sourceRoomId: "room1", sourceHash: "source2", projectionHash: "projection2", expectedProjectionHash: "projection2", extractionAllowed: true},
  {servedMessage: false, callerIssuer: true, issuerId: 0, callerRuntime: false, runtimeId: 2, currentMetadata: true, sourceMessageId: "", sourceRoomId: "", sourceHash: "source2", projectionHash: "projection2", expectedProjectionHash: "projection2", extractionAllowed: true},
  {servedMessage: false, callerIssuer: false, issuerId: 1, callerRuntime: false, runtimeId: 2, currentMetadata: true, sourceMessageId: "", sourceRoomId: "", sourceHash: "source2", projectionHash: "projection2", expectedProjectionHash: "projection2", extractionAllowed: true},
  {servedMessage: false, callerIssuer: false, issuerId: 2, callerRuntime: false, runtimeId: 1, currentMetadata: true, sourceMessageId: "", sourceRoomId: "", sourceHash: "source1", projectionHash: "projection1", expectedProjectionHash: "projection1", extractionAllowed: false},
  {servedMessage: false, callerIssuer: false, issuerId: 1, callerRuntime: true, runtimeId: 0, currentMetadata: true, sourceMessageId: "", sourceRoomId: "", sourceHash: "source1", projectionHash: "projection1", expectedProjectionHash: "projection1", extractionAllowed: true},
  {servedMessage: false, callerIssuer: true, issuerId: 0, callerRuntime: true, runtimeId: 0, currentMetadata: true, sourceMessageId: "", sourceRoomId: "", sourceHash: "source1", projectionHash: "projection1", expectedProjectionHash: "projection1", extractionAllowed: true},
  {servedMessage: false, callerIssuer: true, issuerId: 0, callerRuntime: true, runtimeId: 0, currentMetadata: true, sourceMessageId: "", sourceRoomId: "", sourceHash: "source1", projectionHash: "projection1", expectedProjectionHash: "projection2", extractionAllowed: true})
pure def servingRuntime(s: RequestRegistry, messageObject: int): int = s.runtimes.select(runtime => runtime.agentId == messageAt(s, messageObject).agentId).nthOr(0, emptyRuntime).id
pure def bindingRuntime(s: RequestRegistry, messageObject: int, binding: ViewBindingObservation): int = if (binding.callerRuntime) servingRuntime(s, messageObject) else binding.runtimeId
pure def bindingIssuer(s: RequestRegistry, messageObject: int, binding: ViewBindingObservation): int = if (binding.callerIssuer) getIssuer(s, bindingRuntime(s, messageObject, binding), messageObject) else binding.issuerId
pure def boundMessage(s: RequestRegistry, messageObject: int, binding: ViewBindingObservation): int = if (binding.servedMessage) ownerAt(s, s.lastIssuer).messageObject else messageObject
pure def canBindView(s: RequestRegistry, by: RegistryCaller, stateObject: int, messageObject: int, binding: ViewBindingObservation): bool = by == HostBoundary and stateAt(s, stateObject).objectId != 0 and messageAt(s, boundMessage(s, messageObject, binding)).objectId != 0
pure def bindView(s: RequestRegistry, by: RegistryCaller, stateObject: int, messageObject: int, binding: ViewBindingObservation): RequestRegistry = {
  val boundObject = boundMessage(s, messageObject, binding)
  val frame = stateAt(s, stateObject)
  val message = messageAt(s, boundObject)
  val exact = binding.projectionHash == binding.expectedProjectionHash
  val projected = if (exact) binding.projectionHash else binding.sourceHash
  val issuerId = bindingIssuer(s, boundObject, binding)
  val owner = ownerAt(s, issuerId)
  val boundOwner = if (owner.runtimeId == bindingRuntime(s, boundObject, binding) and owner.messageObject == boundObject and ownerCurrent(owner, s)) issuerId else 0
  val sourceMessageId = if (binding.currentMetadata) message.messageId else binding.sourceMessageId
  val sourceRoomId = if (binding.currentMetadata) message.roomId else binding.sourceRoomId
  val sourceValid = message.messageId != "" and message.roomId != "" and message.entityId != "" and sourceMessageId == message.messageId and sourceRoomId == message.roomId
  { ...s, views: if (not(sourceValid)) s.views.select(view => view.dataId != frame.dataId) else s.views.select(view => view.dataId != frame.dataId).append({ dataId: frame.dataId, messageObject: boundObject, requestHash: messageAt(s, boundObject).requestHash, stateHash: frame.stateHash, sourceHash: binding.sourceHash, projectionHash: projected, observedSourceHash: binding.sourceHash, observedProjectionHash: projected, issuerId: boundOwner, extractionAllowed: exact and binding.extractionAllowed }) }
}
pure def canMutateState(s: RequestRegistry, stateObject: int, stateHash: str): bool = stateAt(s, stateObject).objectId != 0
pure def mutateState(s: RequestRegistry, stateObject: int, stateHash: str): RequestRegistry = { ...s, states: s.states.listMap(frame => if (frame.objectId == stateObject) { ...frame, stateHash: stateHash } else frame) }
pure def canMutateView(s: RequestRegistry, stateObject: int, sourceHash: str, projectionHash: str): bool = viewAt(s, stateObject).dataId != 0
pure def mutateView(s: RequestRegistry, stateObject: int, sourceHash: str, projectionHash: str): RequestRegistry = { ...s, views: s.views.listMap(view => if (view.dataId == stateAt(s, stateObject).dataId) { ...view, observedSourceHash: sourceHash, observedProjectionHash: projectionHash } else view) }
```

### Attempts and result objects belong to one issuer across every map

Discovered by the proof: each owner retains the identity uniqueness of its own completion records as well as the cross-owner fence. A reordered or copied view cannot supply a duplicate identity to a component. An issued view names an actual issuer, so a view with a fabricated issuer ID cannot pick up authority when that ID is allocated later.

Discovered by simulation: completing an attempt requires a live issuer, a committed restriction and a current bound view before the operation and result can be observed. Give those events and the matching operation and child observations more chances in the harness. Include both a mutation that can complete and a restricted request whose denial can transfer. A copied completion needs about eleven events, and the first simulated traces have twenty: the events that set up a request (registering a runtime, creating its message, beginning its issuer and committing its restriction) are tried often enough to finish early, but a new message or issuer begins another request that the planner then binds instead, so those two are tried less often. An operation check is possible from the start, even with no attempt, so it is tried only somewhat more often than the events that disturb a request; each other later step toward a completion, which is enabled only when the step before it has happened, is tried more often than the events that repeat or disturb an earlier step.

Discovered by simulation: the host derives most of what these events need from the request it is serving, and independent samples almost never agree with it. An attempt takes its issuer from the bound view, as the source does, and the handler begins it with the state it holds and the message that state's view was bound for; explicit state and message pairs, including mismatched ones, are still sampled. The host's action is usually registered, so most sampled registrations are known ones, for the create or the update action, and a missing registration is still sampled. An operation check can run with no attempt, as when the routing context is absent or the issuer was never committed: reads are then allowed and a mutation is denied as unresolved, and explicit states and messages sample that path. Otherwise the check usually comes from the handler that holds the attempt, which passes that attempt's message and a state whose current view binds the attempt's issuer, and which repeats the operation it already resolved; a different later operation, which conflicts, explicit states and messages with mutations, a read and a mismatched registered operation, an unknown attempt and a missing operation are still sampled.

Each observation of a result, projection, copy or inspection says whether a value is the one the host already holds (the captured registration, the canonical child for the registered operation, the source's projection, the source's or target's own fingerprint, the inspected result's fingerprint and stored evidence) or gives an explicit value. Every value an independent observation could take is still a value of the record type, so the proof, which quantifies over the record types, still covers every host observation. Only the simulated sample is narrower: it lists the unchanged values and chosen explicit ones, not every combination of explicit values. The simulation tries the unchanged values, as the host usually observes them, together with explicit changed registrations, a child for each operation, an unequal or equal explicit projection, explicit source and target fingerprints of both kinds (both changed at once included), a result whose fingerprint and projection were bound separately, a rebinding with another shape and binding the target object directly. Projection, copy and inspection are enabled only once a completion fact or an owned projection exists, so they are tried more often than the events that can invalidate those results first. Inspected with independent values, half the inspections changed the fingerprint and invalidated the fact, and the traces the checker keeps showed no completed result being inspected; an inspection now usually observes the result's own fingerprint and stored evidence, and explicit fingerprints and evidence are still sampled.

```quint
pure val attemptIdValues = Set("attempt1", "attempt2")
pure val resultIdValues = Set("result1", "result2")
pure val sourceIdValues = Set("result1")
pure val targetIdValues = Set("result2")
pure val operationValues = Set(C::NoOperation, C::GetOperation, C::CreateOperation, C::UpdateOperation)
pure val denialIdValues = Set("denial1", "denial2")
pure val updateAction: C::DefinitionIdentity = { ...C::sampleAction, objectId: 3, definitionId: "action-update" }
pure val updateChild: C::ChildSnapshot = { definition: updateAction, operation: C::UpdateOperation }
pure val changedRegistration: C::RegistrationSnapshot = { ...C::sampleRegistration, registeredAction: { ...C::sampleAction, fingerprint: "changed-definition" } }
pure val registrationValues = C::registrationValues.union(Set({ ...C::sampleRegistration, registeredAction: updateAction }))
type OperationCheck = { attemptContext: bool, stateObject: int, messageObject: int, attemptId: str, repeatResolved: bool, operation: C::Operation, registered: C::Operation, denialId: str }
pure val operationCheckValues =
  attemptIdValues.map(attemptId => Set({ repeatResolved: true, operation: C::CreateOperation, registered: C::CreateOperation }, { repeatResolved: true, operation: C::UpdateOperation, registered: C::UpdateOperation }, { repeatResolved: false, operation: C::UpdateOperation, registered: C::CreateOperation }, { repeatResolved: false, operation: C::GetOperation, registered: C::UpdateOperation }, { repeatResolved: false, operation: C::NoOperation, registered: C::CreateOperation }).map(check => denialIdValues.map(denialId => { attemptContext: true, stateObject: 0, messageObject: 0, attemptId: attemptId, repeatResolved: check.repeatResolved, operation: check.operation, registered: check.registered, denialId: denialId })).flatten()).flatten()
    .union(Set({ stateObject: 1, messageObject: 1, attemptId: "", operation: C::CreateOperation, registered: C::CreateOperation, denialId: "denial1" }, { stateObject: 2, messageObject: 1, attemptId: "", operation: C::GetOperation, registered: C::UpdateOperation, denialId: "denial1" }, { stateObject: 1, messageObject: 2, attemptId: "attempt1", operation: C::UpdateOperation, registered: C::CreateOperation, denialId: "denial2" }, { stateObject: 3, messageObject: 3, attemptId: "attempt2", operation: C::CreateOperation, registered: C::UpdateOperation, denialId: "denial2" }).map(context => { attemptContext: false, stateObject: context.stateObject, messageObject: context.messageObject, attemptId: context.attemptId, repeatResolved: false, operation: context.operation, registered: context.registered, denialId: context.denialId }))
type ResultObservation = { resultId: str, fingerprint: str, projectionHash: str, registrationUnchanged: bool, observation: C::RegistrationSnapshot, childUnchanged: bool, child: C::ChildSnapshot }
pure val resultObservationValues = Set(
  { resultId: "result1", fingerprint: "fingerprint1", projectionHash: "projection1", registrationUnchanged: true, observation: C::noRegistration, childUnchanged: true, child: C::noChild },
  { resultId: "result1", fingerprint: "fingerprint2", projectionHash: "projection2", registrationUnchanged: true, observation: C::noRegistration, childUnchanged: true, child: C::noChild },
  { resultId: "result1", fingerprint: "fingerprint1", projectionHash: "projection2", registrationUnchanged: true, observation: C::noRegistration, childUnchanged: true, child: C::noChild },
  { resultId: "result1", fingerprint: "fingerprint2", projectionHash: "projection1", registrationUnchanged: true, observation: C::noRegistration, childUnchanged: true, child: C::noChild },
  { resultId: "result1", fingerprint: "fingerprint1", projectionHash: "projection1", registrationUnchanged: false, observation: changedRegistration, childUnchanged: true, child: C::noChild },
  { resultId: "result1", fingerprint: "fingerprint1", projectionHash: "projection1", registrationUnchanged: false, observation: C::sampleRegistration, childUnchanged: true, child: C::noChild },
  { resultId: "result1", fingerprint: "fingerprint1", projectionHash: "projection1", registrationUnchanged: true, observation: C::noRegistration, childUnchanged: false, child: C::sampleChild },
  { resultId: "result1", fingerprint: "fingerprint1", projectionHash: "projection1", registrationUnchanged: true, observation: C::noRegistration, childUnchanged: false, child: updateChild },
  { resultId: "result2", fingerprint: "fingerprint2", projectionHash: "projection2", registrationUnchanged: true, observation: C::noRegistration, childUnchanged: true, child: C::noChild })
type ProjectionObservation = { fingerprint: str, sameProjection: bool, projectionHash: str, sourceUnchanged: bool, sourceFingerprint: str }
pure val projectionObservationValues = Set(
  { fingerprint: "fingerprint1", sameProjection: true, projectionHash: "", sourceUnchanged: true, sourceFingerprint: "" },
  { fingerprint: "fingerprint2", sameProjection: true, projectionHash: "", sourceUnchanged: true, sourceFingerprint: "" },
  { fingerprint: "fingerprint2", sameProjection: false, projectionHash: "projection1", sourceUnchanged: true, sourceFingerprint: "" },
  { fingerprint: "fingerprint2", sameProjection: false, projectionHash: "projection2", sourceUnchanged: true, sourceFingerprint: "" },
  { fingerprint: "fingerprint2", sameProjection: true, projectionHash: "", sourceUnchanged: false, sourceFingerprint: "fingerprint1" },
  { fingerprint: "fingerprint2", sameProjection: true, projectionHash: "", sourceUnchanged: false, sourceFingerprint: "fingerprint2" })
type CopyObservation = { sourceUnchanged: bool, sourceFingerprint: str, targetUnchanged: bool, targetFingerprint: str }
pure val copyObservationValues = Set(
  { sourceUnchanged: true, sourceFingerprint: "", targetUnchanged: true, targetFingerprint: "" },
  { sourceUnchanged: false, sourceFingerprint: "fingerprint1", targetUnchanged: true, targetFingerprint: "" },
  { sourceUnchanged: false, sourceFingerprint: "fingerprint2", targetUnchanged: true, targetFingerprint: "" },
  { sourceUnchanged: true, sourceFingerprint: "", targetUnchanged: false, targetFingerprint: "fingerprint1" },
  { sourceUnchanged: true, sourceFingerprint: "", targetUnchanged: false, targetFingerprint: "fingerprint2" },
  { sourceUnchanged: false, sourceFingerprint: "fingerprint1", targetUnchanged: false, targetFingerprint: "fingerprint2" })
pure def canonicalChild(operation: C::Operation): C::ChildSnapshot = if (operation == C::UpdateOperation) updateChild else if (operation == C::CreateOperation) C::sampleChild else C::noChild
pure def attemptOwner(s: RequestRegistry, attemptId: str): IssuerOwner = s.owners.select(owner => owner.completions.attempts.some(attempt => attempt.id == attemptId)).nthOr(0, emptyOwner)
pure def resultOwner(s: RequestRegistry, resultId: str): IssuerOwner = s.owners.select(owner => owner.completions.results.some(result => result.id == resultId)).nthOr(0, emptyOwner)
type ExecutionContext = { viewMessage: bool, stateObject: int, messageObject: int }
pure val executionContextValues = stateObjectValues.map(stateObject => { viewMessage: true, stateObject: stateObject, messageObject: 0 })
  .union(Set({ stateObject: 1, messageObject: 1 }, { stateObject: 1, messageObject: 2 }, { stateObject: 2, messageObject: 1 }, { stateObject: 3, messageObject: 3 }).map(context => { viewMessage: false, stateObject: context.stateObject, messageObject: context.messageObject }))
pure def executionMessageObject(s: RequestRegistry, executionContext: ExecutionContext): int = if (executionContext.viewMessage) viewAt(s, executionContext.stateObject).messageObject else executionContext.messageObject
pure def canBeginAttempt(s: RequestRegistry, by: RegistryCaller, executionContext: ExecutionContext, attemptId: str): bool = {
  val stateObject = executionContext.stateObject
  val messageObject = executionMessageObject(s, executionContext)
  by == HostBoundary and boundViewCurrent(s, stateObject, messageObject) and viewAt(s, stateObject).issuerId != 0 and ownerAt(s, viewAt(s, stateObject).issuerId).messageObject == messageObject and attemptOwner(s, attemptId).id == 0 and C::canBeginAttempt(refreshedOwner(ownerAt(s, viewAt(s, stateObject).issuerId), s).completions, attemptId)
}
pure def beginAttempt(s: RequestRegistry, by: RegistryCaller, executionContext: ExecutionContext, attemptId: str, registration: C::RegistrationSnapshot): RequestRegistry = {
  val owner = refreshedOwner(ownerAt(s, viewAt(s, executionContext.stateObject).issuerId), s)
  replaceOwner({ ...owner, completions: C::beginAttempt(owner.completions, attemptId, registration) }, s)
}
pure def denialOwner(s: RequestRegistry, denialId: str): IssuerOwner = s.owners.select(owner => owner.completions.denials.some(denial => denial.id == denialId)).nthOr(0, emptyOwner)
pure def attemptStateObject(s: RequestRegistry, attemptId: str): int = {
  val owner = attemptOwner(s, attemptId)
  s.states.select(frame => owner.id != 0 and boundViewCurrent(s, frame.objectId, owner.messageObject) and viewAt(s, frame.objectId).issuerId == owner.id).nthOr(0, emptyState).objectId
}
pure def checkedStateObject(s: RequestRegistry, operationCheck: OperationCheck): int = if (operationCheck.attemptContext) attemptStateObject(s, operationCheck.attemptId) else operationCheck.stateObject
pure def checkedMessageObject(s: RequestRegistry, operationCheck: OperationCheck): int = if (operationCheck.attemptContext) attemptOwner(s, operationCheck.attemptId).messageObject else operationCheck.messageObject
pure def resolvedAttempt(s: RequestRegistry, attemptId: str): C::Attempt = C::attemptAt(attemptOwner(s, attemptId).completions, attemptId)
pure def checkedOperation(s: RequestRegistry, operationCheck: OperationCheck): C::Operation = if (operationCheck.attemptContext and operationCheck.repeatResolved and resolvedAttempt(s, operationCheck.attemptId).resolved != C::NoOperation) resolvedAttempt(s, operationCheck.attemptId).resolved else operationCheck.operation
pure def checkedRegistered(s: RequestRegistry, operationCheck: OperationCheck): C::Operation = if (operationCheck.attemptContext and operationCheck.repeatResolved and resolvedAttempt(s, operationCheck.attemptId).registered != C::NoOperation) resolvedAttempt(s, operationCheck.attemptId).registered else operationCheck.registered
pure def canCheckOperation(s: RequestRegistry, operationCheck: OperationCheck): bool = operationCheck.operation != C::NoOperation and (operationCheck.denialId == "" or denialOwner(s, operationCheck.denialId).id == 0) and (not(operationCheck.attemptContext) or attemptOwner(s, operationCheck.attemptId).id != 0)
pure def checkOperation(s: RequestRegistry, operationCheck: OperationCheck): RequestRegistry = {
  val stateObject = checkedStateObject(s, operationCheck)
  val messageObject = checkedMessageObject(s, operationCheck)
  val operation = checkedOperation(s, operationCheck)
  val owner = refreshedOwner(attemptOwner(s, operationCheck.attemptId), s)
  val same = owner.id != 0 and owner.messageObject == messageObject and boundViewCurrent(s, stateObject, messageObject) and viewAt(s, stateObject).issuerId == owner.id
  val checked = C::checkOperation(owner.completions, operationCheck.attemptId, operation, checkedRegistered(s, operationCheck), operationCheck.denialId)
  if (same) { ...replaceOwner({ ...owner, completions: checked }, s), lastAllowed: checked.lastAllowed }
  else { ...s, lastAllowed: not(C::mutation(operation)) }
}
pure def canBindResult(s: RequestRegistry, by: RegistryCaller, attemptId: str, resultObservation: ResultObservation): bool = by == HostBoundary and C::canBindResult(refreshedOwner(attemptOwner(s, attemptId), s).completions, resultObservation.resultId, attemptId)
pure def flagChangedResult(completions: C::RequestCompletions, resultId: str, fingerprint: str): C::RequestCompletions = { ...completions, results: completions.results.listMap(result => if (result.id == resultId) { ...result, changed: result.changed or result.fingerprint != fingerprint } else result) }
pure def bindResult(s: RequestRegistry, by: RegistryCaller, attemptId: str, resultObservation: ResultObservation): RequestRegistry = {
  val resultId = resultObservation.resultId
  val fingerprint = resultObservation.fingerprint
  val projectionHash = resultObservation.projectionHash
  val owner = refreshedOwner(attemptOwner(s, attemptId), s)
  val attempt = C::attemptAt(owner.completions, attemptId)
  val observation = if (resultObservation.registrationUnchanged) attempt.registration else resultObservation.observation
  val child = if (resultObservation.childUnchanged) canonicalChild(attempt.registered) else resultObservation.child
  val existingOwner = resultOwner(s, resultId)
  val existing = C::resultAt(existingOwner.completions, resultId)
  val same = existingOwner.id == 0 or (existingOwner.id == owner.id and existing.attempt == attemptId)
  if (same) { ...replaceOwner({ ...owner, completions: C::bindResult(owner.completions, resultId, attemptId, fingerprint, projectionHash, observation, child) }, s), lastBound: existingOwner.id == 0 or (not(existing.changed) and existing.fingerprint == fingerprint) }
  else { ...replaceOwner({ ...existingOwner, completions: flagChangedResult(existingOwner.completions, resultId, fingerprint) }, s), lastBound: false }
}
pure def canProjectResult(s: RequestRegistry, by: RegistryCaller, issuerId: int, sourceId: str, targetId: str): bool = by == HostBoundary and resultOwner(s, sourceId).id == issuerId and issuerId != 0 and resultOwner(s, targetId).id == 0 and C::canProjectResult(resultOwner(s, sourceId).completions, sourceId, targetId, true)
pure def projectedHash(s: RequestRegistry, sourceId: str, projectionObservation: ProjectionObservation): str = if (projectionObservation.sameProjection) C::resultAt(resultOwner(s, sourceId).completions, sourceId).projectionHash else projectionObservation.projectionHash
pure def observedFingerprint(s: RequestRegistry, resultId: str, unchanged: bool, fingerprint: str): str = if (unchanged) C::resultAt(resultOwner(s, resultId).completions, resultId).fingerprint else fingerprint
pure def projectResult(s: RequestRegistry, by: RegistryCaller, issuerId: int, sourceId: str, targetId: str, projectionObservation: ProjectionObservation): RequestRegistry = {
  val owner = resultOwner(s, sourceId)
  val projectionHash = projectedHash(s, sourceId, projectionObservation)
  val sourceFingerprint = observedFingerprint(s, sourceId, projectionObservation.sourceUnchanged, projectionObservation.sourceFingerprint)
  replaceOwner({ ...owner, completions: C::projectResult(owner.completions, sourceId, targetId, projectionObservation.fingerprint, projectionHash, true, sourceFingerprint) }, s)
}
pure def canCopyCompletion(s: RequestRegistry, sourceId: str, targetId: str, copyObservation: CopyObservation): bool = resultOwner(s, sourceId).id != 0 and resultOwner(s, sourceId).id == resultOwner(s, targetId).id and C::canCopyCompletion(resultOwner(s, sourceId).completions, sourceId, targetId, observedFingerprint(s, sourceId, copyObservation.sourceUnchanged, copyObservation.sourceFingerprint), observedFingerprint(s, targetId, copyObservation.targetUnchanged, copyObservation.targetFingerprint))
pure def copyCompletion(s: RequestRegistry, sourceId: str, targetId: str, copyObservation: CopyObservation): RequestRegistry = {
  val owner = resultOwner(s, sourceId)
  val sourceFingerprint = observedFingerprint(s, sourceId, copyObservation.sourceUnchanged, copyObservation.sourceFingerprint)
  val targetFingerprint = observedFingerprint(s, targetId, copyObservation.targetUnchanged, copyObservation.targetFingerprint)
  replaceOwner({ ...owner, completions: C::copyCompletion(owner.completions, sourceId, targetId, sourceFingerprint, targetFingerprint) }, s)
}
pure def canInspectCompletion(s: RequestRegistry, issuerId: int, resultId: str): bool = issuerId != 0 and resultOwner(s, resultId).id == issuerId and C::canInspectCompletion(resultOwner(s, resultId).completions, resultId, true)
type InspectionObservation = { fingerprintUnchanged: bool, fingerprint: str, evidenceUnchanged: bool, observation: C::RegistrationSnapshot, child: C::ChildSnapshot }
pure val inspectionValues = Set({ fingerprintUnchanged: true, fingerprint: "", evidenceUnchanged: true, observation: C::noRegistration, child: C::noChild })
  .union(C::fingerprintValues.map(fingerprint => { fingerprintUnchanged: false, fingerprint: fingerprint, evidenceUnchanged: true, observation: C::noRegistration, child: C::noChild }))
  .union(C::observationValues.map(observation => C::childValues.map(child => { fingerprintUnchanged: true, fingerprint: "", evidenceUnchanged: false, observation: observation, child: child })).flatten())
pure def inspectCompletion(s: RequestRegistry, issuerId: int, resultId: str, inspection: InspectionObservation): RequestRegistry = {
  val owner = refreshedOwner(resultOwner(s, resultId), s)
  val stored = C::resultAt(owner.completions, resultId)
  val fingerprint = if (inspection.fingerprintUnchanged) stored.fingerprint else inspection.fingerprint
  val observation = if (inspection.evidenceUnchanged) stored.registration else inspection.observation
  val child = if (inspection.evidenceUnchanged) stored.child else inspection.child
  replaceOwner({ ...owner, completions: C::inspectCompletion(owner.completions, resultId, true, fingerprint, observation, child) }, s)
}
pure val sourceDenialValues = denialIdValues
pure val errorIdValues = Set("error1", "error2")
pure val targetResultValues = resultIdValues
pure val expectedAttemptValues = attemptIdValues
pure def canWrapDenialError(s: RequestRegistry, sourceDenial: str, errorId: str): bool = denialOwner(s, sourceDenial).id != 0 and denialOwner(s, errorId).id == 0 and resultOwner(s, errorId).id == 0 and C::canWrapDenialError(refreshedOwner(denialOwner(s, sourceDenial), s).completions, sourceDenial, errorId)
pure def wrapDenialError(s: RequestRegistry, sourceDenial: str, errorId: str): RequestRegistry = {
  val owner = refreshedOwner(denialOwner(s, sourceDenial), s)
  replaceOwner({ ...owner, completions: C::wrapDenialError(owner.completions, sourceDenial, errorId) }, s)
}
pure def canTransferDenial(s: RequestRegistry, sourceDenial: str, targetResult: str, expectedAttempt: str, targetNotStarted: bool, sourceNotStarted: bool): bool = targetResult != "" and denialOwner(s, sourceDenial).id != 0 and denialOwner(s, sourceDenial).id == resultOwner(s, targetResult).id and denialOwner(s, sourceDenial).id == attemptOwner(s, expectedAttempt).id and (denialOwner(s, targetResult).id == 0 or denialOwner(s, targetResult).id == denialOwner(s, sourceDenial).id) and C::canTransferDenial(refreshedOwner(denialOwner(s, sourceDenial), s).completions, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)
pure def transferDenial(s: RequestRegistry, sourceDenial: str, targetResult: str, expectedAttempt: str, targetNotStarted: bool, sourceNotStarted: bool): RequestRegistry = {
  val owner = refreshedOwner(denialOwner(s, sourceDenial), s)
  replaceOwner({ ...owner, completions: C::transferDenial(owner.completions, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted) }, s)
}
pure def alwaysDenialOwnershipIsUnique(s: RequestRegistry): bool = s.owners.every(owner => owner.completions.denials.every(denial => s.owners.every(other => other.id == owner.id or not(other.completions.denials.some(candidate => candidate.id == denial.id)))))
pure def alwaysSourceObjectIdentitiesAreUnique(s: RequestRegistry): bool = s.runtimes.every(runtime => runtime.id > 0 and s.runtimes.select(other => other.id == runtime.id).length() == 1) and s.messages.every(message => message.objectId > 0 and s.messages.select(other => other.objectId == message.objectId).length() == 1) and s.states.every(frame => frame.objectId > 0 and frame.dataId > 0 and s.states.select(other => other.objectId == frame.objectId).length() == 1)
pure def alwaysViewsHaveOneDataOwner(s: RequestRegistry): bool = s.views.every(view => s.states.some(frame => frame.dataId == view.dataId) and s.views.select(other => other.dataId == view.dataId).length() == 1 and (view.issuerId == 0 or (ownerAt(s, view.issuerId).id == view.issuerId and ownerAt(s, view.issuerId).messageObject == view.messageObject)))
pure def stepActivePairIdentityNeverChanges(before: RequestRegistry, via: str, after: RequestRegistry): bool = before.owners.every(owner => after.owners.some(retained => retained.id == owner.id and retained.runtimeId == owner.runtimeId and retained.messageObject == owner.messageObject))
pure def alwaysActivePairsAreUnique(s: RequestRegistry): bool = s.nextIssuer > 0 and s.owners.every(owner => owner.id > 0 and owner.id < s.nextIssuer and s.owners.select(other => other.id == owner.id).length() == 1 and s.owners.select(other => other.runtimeId == owner.runtimeId and other.messageObject == owner.messageObject).length() == 1)
pure def alwaysAttemptOwnershipIsUnique(s: RequestRegistry): bool = s.owners.every(owner => owner.completions.attempts.every(attempt => s.owners.every(other => other.id == owner.id or not(other.completions.attempts.some(candidate => candidate.id == attempt.id)))))
pure def alwaysResultOwnershipIsUnique(s: RequestRegistry): bool = s.owners.every(owner => owner.completions.results.every(result => s.owners.every(other => other.id == owner.id or not(other.completions.results.some(candidate => candidate.id == result.id)))))
pure def alwaysOwnersRetainProtocolSafety(s: RequestRegistry): bool = s.owners.every(owner => I::alwaysIssuerRevision(owner.issuer) and I::alwaysTaintedIssuerUnresolved(owner.issuer) and C::alwaysCompletionOwnsAttempt(owner.completions) and C::alwaysAttemptAndResultIdentityUnique(owner.completions))
pure def lawExternalCannotMint(s: RequestRegistry, runtimeId: int, messageObject: int): bool = not(canBeginIssuer(s, ExternalPayload, runtimeId, messageObject))
pure def lawCrossIssuerProjectionRejected(s: RequestRegistry, by: RegistryCaller, issuerId: int, sourceId: str, targetId: str): bool = resultOwner(s, sourceId).id != issuerId implies not(canProjectResult(s, by, issuerId, sourceId, targetId))
pure val weight_registerRuntime = 60
pure val weight_createMessage = 5
pure val weight_createState = 10
pure val weight_beginIssuer = 10
pure val weight_commitRestriction = 30
pure val weight_bindView = 20
pure val weight_beginAttempt = 100
pure val weight_checkOperation = 10
pure val weight_bindResult = 60
pure val weight_projectResult = 100
pure val weight_copyCompletion = 100
pure val weight_inspectCompletion = 100
pure val weight_wrapDenialError = 8
pure val weight_transferDenial = 20
pure def sometimesIndependentRequestIssuers(s: RequestRegistry): bool = s.owners.length() > 1
pure def sometimesStateCopiesShareData(s: RequestRegistry): bool = s.states.some(frame => s.states.some(other => other.objectId != frame.objectId and other.dataId == frame.dataId))
pure def sometimesRegistryTransfersDenial(s: RequestRegistry): bool =
  s.owners.some(owner => owner.completions.denials.some(denial => denial.projectedResult))
pure def sometimesRegistryCopiesCompletion(s: RequestRegistry): bool =
  s.owners.some(owner => owner.completions.results.some(result => result.projected and result.hasFact and not(result.changed)))
```
