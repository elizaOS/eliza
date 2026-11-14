# Shared request authority and completion registry

The source is `packages/core/src/actions/task-extraction-context.ts:40-146,360-375,810-1015,1028-1087,1184-1371`. The process-wide WeakMaps are composed here: runtime/message pairs own issuer objects; State.data objects own extraction views; each opaque attempt and result object has one issuer owner. [Issuer restriction](./requestIssuer.md) and [completion evidence](./requestCompletions.md) are components of that owner, not independent authorities. IDs denote actual host object references. `HostBoundary` is supplied separately from parsed caller payloads. Hashes, source projections and current action-registration observations remain exact external algorithm inputs.

## Story: Keep concurrent requests and their copied views isolated

### Object identity and current request fields determine the active issuer

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
pure val sourceMessageIdValues = messageIdValues
pure val sourceRoomIdValues = roomIdValues
pure val stateHashValues = Set("state1", "state2")
pure val sourceHashValues = Set("source1", "source2")
pure val observedSourceHashValues = sourceHashValues
pure val projectionHashValues = Set("projection1", "projection2")
pure val expectedProjectionHashValues = projectionHashValues
pure val currentSourceHashValues = sourceHashValues
pure val currentOriginalHashValues = sourceHashValues
pure val classificationValues = Set(I::ReadOnlyRequest, I::MutationRequest, I::UnresolvedRequest)
pure val interpretationValues = I::interpretationValues
pure def runtimeAt(s: RequestRegistry, runtimeId: int): RuntimeObject = s.runtimes.select(runtime => runtime.id == runtimeId).nthOr(0, emptyRuntime)
pure def messageAt(s: RequestRegistry, messageObject: int): RequestMessage = s.messages.select(message => message.objectId == messageObject).nthOr(0, emptyMessage)
pure def stateAt(s: RequestRegistry, stateObject: int): RequestState = s.states.select(frame => frame.objectId == stateObject).nthOr(0, emptyState)
pure def ownerAt(s: RequestRegistry, issuerId: int): IssuerOwner = s.owners.select(owner => owner.id == issuerId).nthOr(0, emptyOwner)
pure def pairOwner(s: RequestRegistry, runtimeId: int, messageObject: int): IssuerOwner = s.owners.select(owner => owner.runtimeId == runtimeId and owner.messageObject == messageObject).nthOr(0, emptyOwner)
pure def ownerCurrent(owner: IssuerOwner, s: RequestRegistry): bool = owner.id != 0 and runtimeAt(s, owner.runtimeId).live and runtimeAt(s, owner.runtimeId).agentId == owner.agentId and messageAt(s, owner.messageObject).agentId == owner.agentId and messageAt(s, owner.messageObject).messageId == owner.messageId and messageAt(s, owner.messageObject).roomId == owner.roomId and messageAt(s, owner.messageObject).entityId == owner.entityId and messageAt(s, owner.messageObject).requestHash == owner.issuer.requestHash and I::validIssuer(owner.issuer) and (not(owner.issuer.committed) or owner.originalSourceHash == owner.issuer.sourceHash)
pure def completionClass(classification: I::RequestClassification): C::RequestClass = if (classification == I::MutationRequest) C::MutationClass else if (classification == I::ReadOnlyRequest) C::ReadOnlyClass else C::UnresolvedClass
pure def refreshedOwner(owner: IssuerOwner, s: RequestRegistry): IssuerOwner = { ...owner, completions: C::observeAuthority(owner.completions, owner.issuer.revision, ownerCurrent(owner, s) and owner.issuer.committed, completionClass(I::restriction(owner.issuer))) }
pure def replaceOwner(owner: IssuerOwner, s: RequestRegistry): RequestRegistry = { ...s, owners: s.owners.listMap(existing => if (existing.id == owner.id) owner else existing) }
pure def canRegisterRuntime(s: RequestRegistry, by: RegistryCaller, runtimeId: int, agentId: str, live: bool): bool = by == HostBoundary and runtimeId > 0 and agentId != "" and not(s.runtimes.some(runtime => runtime.id == runtimeId))
pure def registerRuntime(s: RequestRegistry, by: RegistryCaller, runtimeId: int, agentId: str, live: bool): RequestRegistry = { ...s, runtimes: s.runtimes.append({ id: runtimeId, agentId: agentId, live: live }) }
pure def canCreateMessage(s: RequestRegistry, by: RegistryCaller, messageObject: int, agentId: str, messageId: str, roomId: str, entityId: str, requestHash: str): bool = by == HostBoundary and messageObject > 0 and not(s.messages.some(message => message.objectId == messageObject))
pure def createMessage(s: RequestRegistry, by: RegistryCaller, messageObject: int, agentId: str, messageId: str, roomId: str, entityId: str, requestHash: str): RequestRegistry = { ...s, messages: s.messages.append({ objectId: messageObject, agentId: agentId, messageId: messageId, roomId: roomId, entityId: entityId, requestHash: requestHash }) }
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
pure def canCommitRestriction(s: RequestRegistry, by: RegistryCaller, issuerId: int, sourceHash: str, observedSourceHash: str): bool = by == HostBoundary and ownerCurrent(ownerAt(s, issuerId), s) and I::canCommitRestriction(ownerAt(s, issuerId).issuer, sourceHash, observedSourceHash)
pure def commitRestriction(s: RequestRegistry, by: RegistryCaller, issuerId: int, classification: I::RequestClassification, interpretation: I::Interpretation, sourceHash: str, observedSourceHash: str): RequestRegistry = {
  val owner = ownerAt(s, issuerId)
  replaceOwner({ ...owner, originalSourceHash: if (owner.issuer.committed) owner.originalSourceHash else sourceHash, issuer: I::commitRestriction(owner.issuer, classification, interpretation, sourceHash, observedSourceHash) }, s)
}
pure def canObserveSources(s: RequestRegistry, by: RegistryCaller, issuerId: int, currentSourceHash: str, currentOriginalHash: str): bool = by == HostBoundary and ownerAt(s, issuerId).id != 0
pure def observeSources(s: RequestRegistry, by: RegistryCaller, issuerId: int, currentSourceHash: str, currentOriginalHash: str): RequestRegistry = {
  val owner = ownerAt(s, issuerId)
  replaceOwner({ ...owner, originalSourceHash: currentOriginalHash, issuer: I::observeCurrent(owner.issuer, owner.issuer.live, owner.issuer.currentRequestHash, currentSourceHash) }, s)
}
```

### State.data aliases share one exact view while serialized copies carry no view

```quint
pure def viewAt(s: RequestRegistry, stateObject: int): ExtractionView = s.views.select(view => view.dataId == stateAt(s, stateObject).dataId).nthOr(0, emptyView)
pure def boundViewCurrent(s: RequestRegistry, stateObject: int, messageObject: int): bool = viewAt(s, stateObject).dataId != 0 and viewAt(s, stateObject).requestHash == messageAt(s, messageObject).requestHash and viewAt(s, stateObject).stateHash == stateAt(s, stateObject).stateHash and viewAt(s, stateObject).sourceHash == viewAt(s, stateObject).observedSourceHash and viewAt(s, stateObject).projectionHash == viewAt(s, stateObject).observedProjectionHash
pure def extractionViewAllowed(s: RequestRegistry, stateObject: int, messageObject: int): bool = boundViewCurrent(s, stateObject, messageObject) and viewAt(s, stateObject).extractionAllowed
pure def canBindView(s: RequestRegistry, by: RegistryCaller, stateObject: int, messageObject: int, issuerId: int, runtimeId: int, sourceMessageId: str, sourceRoomId: str, sourceHash: str, projectionHash: str, expectedProjectionHash: str, extractionAllowed: bool): bool = by == HostBoundary and stateAt(s, stateObject).objectId != 0 and messageAt(s, messageObject).objectId != 0
pure def bindView(s: RequestRegistry, by: RegistryCaller, stateObject: int, messageObject: int, issuerId: int, runtimeId: int, sourceMessageId: str, sourceRoomId: str, sourceHash: str, projectionHash: str, expectedProjectionHash: str, extractionAllowed: bool): RequestRegistry = {
  val frame = stateAt(s, stateObject)
  val exact = projectionHash == expectedProjectionHash
  val projected = if (exact) projectionHash else sourceHash
  val owner = ownerAt(s, issuerId)
  val boundOwner = if (owner.runtimeId == runtimeId and owner.messageObject == messageObject and ownerCurrent(owner, s)) issuerId else 0
  val sourceValid = messageAt(s, messageObject).messageId != "" and messageAt(s, messageObject).roomId != "" and messageAt(s, messageObject).entityId != "" and sourceMessageId == messageAt(s, messageObject).messageId and sourceRoomId == messageAt(s, messageObject).roomId
  { ...s, views: if (not(sourceValid)) s.views.select(view => view.dataId != frame.dataId) else s.views.select(view => view.dataId != frame.dataId).append({ dataId: frame.dataId, messageObject: messageObject, requestHash: messageAt(s, messageObject).requestHash, stateHash: frame.stateHash, sourceHash: sourceHash, projectionHash: projected, observedSourceHash: sourceHash, observedProjectionHash: projected, issuerId: boundOwner, extractionAllowed: exact and extractionAllowed }) }
}
pure def canMutateState(s: RequestRegistry, stateObject: int, stateHash: str): bool = stateAt(s, stateObject).objectId != 0
pure def mutateState(s: RequestRegistry, stateObject: int, stateHash: str): RequestRegistry = { ...s, states: s.states.listMap(frame => if (frame.objectId == stateObject) { ...frame, stateHash: stateHash } else frame) }
pure def canMutateView(s: RequestRegistry, stateObject: int, sourceHash: str, projectionHash: str): bool = viewAt(s, stateObject).dataId != 0
pure def mutateView(s: RequestRegistry, stateObject: int, sourceHash: str, projectionHash: str): RequestRegistry = { ...s, views: s.views.listMap(view => if (view.dataId == stateAt(s, stateObject).dataId) { ...view, observedSourceHash: sourceHash, observedProjectionHash: projectionHash } else view) }
```

### Attempts and result objects belong to one issuer across every map

Discovered by the proof: each owner retains the identity uniqueness of its own completion records as well as the cross-owner fence. A reordered or copied view cannot supply a duplicate identity to a component. An issued view names an actual issuer, so a view with a fabricated issuer ID cannot pick up authority when that ID is allocated later.

```quint
pure val attemptIdValues = Set("attempt1", "attempt2")
pure val resultIdValues = Set("result1", "result2")
pure val sourceIdValues = Set("result1")
pure val targetIdValues = Set("result2")
pure val operationValues = Set(C::GetOperation, C::ListOperation, C::CreateOperation, C::UpdateOperation, C::PatchOperation, C::DeleteOperation)
pure val registeredValues = operationValues
pure val denialIdValues = Set("denial1", "denial2")
pure val fingerprintValues = Set("fingerprint1", "fingerprint2")
pure val sourceFingerprintValues = fingerprintValues
pure val targetFingerprintValues = fingerprintValues
pure def attemptOwner(s: RequestRegistry, attemptId: str): IssuerOwner = s.owners.select(owner => owner.completions.attempts.some(attempt => attempt.id == attemptId)).nthOr(0, emptyOwner)
pure def resultOwner(s: RequestRegistry, resultId: str): IssuerOwner = s.owners.select(owner => owner.completions.results.some(result => result.id == resultId)).nthOr(0, emptyOwner)
pure def canBeginAttempt(s: RequestRegistry, by: RegistryCaller, issuerId: int, stateObject: int, messageObject: int, attemptId: str): bool = by == HostBoundary and boundViewCurrent(s, stateObject, messageObject) and viewAt(s, stateObject).issuerId == issuerId and ownerAt(s, issuerId).messageObject == messageObject and attemptOwner(s, attemptId).id == 0 and C::canBeginAttempt(refreshedOwner(ownerAt(s, issuerId), s).completions, attemptId)
pure def beginAttempt(s: RequestRegistry, by: RegistryCaller, issuerId: int, stateObject: int, messageObject: int, attemptId: str): RequestRegistry = {
  val owner = refreshedOwner(ownerAt(s, issuerId), s)
  replaceOwner({ ...owner, completions: C::beginAttempt(owner.completions, attemptId) }, s)
}
pure def denialOwner(s: RequestRegistry, denialId: str): IssuerOwner = s.owners.select(owner => owner.completions.denials.some(denial => denial.id == denialId)).nthOr(0, emptyOwner)
pure def canCheckOperation(s: RequestRegistry, stateObject: int, messageObject: int, attemptId: str, operation: C::Operation, registered: C::Operation, denialId: str): bool = operation != C::NoOperation and (denialId == "" or denialOwner(s, denialId).id == 0)
pure def checkOperation(s: RequestRegistry, stateObject: int, messageObject: int, attemptId: str, operation: C::Operation, registered: C::Operation, denialId: str): RequestRegistry = {
  val owner = refreshedOwner(attemptOwner(s, attemptId), s)
  val same = owner.id != 0 and owner.messageObject == messageObject and boundViewCurrent(s, stateObject, messageObject) and viewAt(s, stateObject).issuerId == owner.id
  val checked = C::checkOperation(owner.completions, attemptId, operation, registered, denialId)
  if (same) { ...replaceOwner({ ...owner, completions: checked }, s), lastAllowed: checked.lastAllowed }
  else { ...s, lastAllowed: not(C::mutation(operation)) }
}
pure def canBindResult(s: RequestRegistry, by: RegistryCaller, resultId: str, attemptId: str): bool = by == HostBoundary and C::canBindResult(refreshedOwner(attemptOwner(s, attemptId), s).completions, resultId, attemptId)
pure def bindResult(s: RequestRegistry, by: RegistryCaller, resultId: str, attemptId: str, fingerprint: str, projectionHash: str, currentRegistration: bool, canonicalDispatch: bool): RequestRegistry = {
  val owner = refreshedOwner(attemptOwner(s, attemptId), s)
  val existingOwner = resultOwner(s, resultId)
  val existing = C::resultAt(existingOwner.completions, resultId)
  val same = existingOwner.id == 0 or (existingOwner.id == owner.id and existing.attempt == attemptId)
  if (same) { ...replaceOwner({ ...owner, completions: C::bindResult(owner.completions, resultId, attemptId, fingerprint, projectionHash, currentRegistration, canonicalDispatch) }, s), lastBound: existingOwner.id == 0 or (not(existing.changed) and existing.fingerprint == fingerprint) }
  else { ...replaceOwner({ ...existingOwner, completions: { ...existingOwner.completions, results: existingOwner.completions.results.listMap(result => if (result.id == resultId) { ...result, changed: result.changed or result.fingerprint != fingerprint } else result) } }, s), lastBound: false }
}
pure def canProjectResult(s: RequestRegistry, by: RegistryCaller, issuerId: int, sourceId: str, targetId: str): bool = by == HostBoundary and resultOwner(s, sourceId).id == issuerId and issuerId != 0 and resultOwner(s, targetId).id == 0 and C::canProjectResult(resultOwner(s, sourceId).completions, sourceId, targetId, true)
pure def projectResult(s: RequestRegistry, by: RegistryCaller, issuerId: int, sourceId: str, targetId: str, fingerprint: str, projectionHash: str, sourceFingerprint: str): RequestRegistry = {
  val owner = resultOwner(s, sourceId)
  replaceOwner({ ...owner, completions: C::projectResult(owner.completions, sourceId, targetId, fingerprint, projectionHash, true, sourceFingerprint) }, s)
}
pure def canCopyCompletion(s: RequestRegistry, sourceId: str, targetId: str, sourceFingerprint: str, targetFingerprint: str): bool = resultOwner(s, sourceId).id != 0 and resultOwner(s, sourceId).id == resultOwner(s, targetId).id and C::canCopyCompletion(resultOwner(s, sourceId).completions, sourceId, targetId, sourceFingerprint, targetFingerprint)
pure def copyCompletion(s: RequestRegistry, sourceId: str, targetId: str, sourceFingerprint: str, targetFingerprint: str): RequestRegistry = {
  val owner = resultOwner(s, sourceId)
  replaceOwner({ ...owner, completions: C::copyCompletion(owner.completions, sourceId, targetId, sourceFingerprint, targetFingerprint) }, s)
}
pure def canInspectCompletion(s: RequestRegistry, issuerId: int, resultId: str): bool = issuerId != 0 and resultOwner(s, resultId).id == issuerId and C::canInspectCompletion(resultOwner(s, resultId).completions, resultId, true)
pure def inspectCompletion(s: RequestRegistry, issuerId: int, resultId: str, fingerprint: str, registrationCurrent: bool): RequestRegistry = {
  val owner = refreshedOwner(resultOwner(s, resultId), s)
  replaceOwner({ ...owner, completions: C::inspectCompletion(owner.completions, resultId, true, fingerprint, registrationCurrent) }, s)
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
pure def canTransferDenial(s: RequestRegistry, sourceDenial: str, targetResult: str, expectedAttempt: str, targetNotStarted: bool, sourceNotStarted: bool): bool = denialOwner(s, sourceDenial).id != 0 and denialOwner(s, sourceDenial).id == resultOwner(s, targetResult).id and denialOwner(s, sourceDenial).id == attemptOwner(s, expectedAttempt).id and (denialOwner(s, targetResult).id == 0 or denialOwner(s, targetResult).id == denialOwner(s, sourceDenial).id) and C::canTransferDenial(refreshedOwner(denialOwner(s, sourceDenial), s).completions, sourceDenial, targetResult, expectedAttempt, targetNotStarted, sourceNotStarted)
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
pure def sometimesIndependentRequestIssuers(s: RequestRegistry): bool = s.owners.length() > 1
pure def sometimesStateCopiesShareData(s: RequestRegistry): bool = s.states.some(frame => s.states.some(other => other.objectId != frame.objectId and other.dataId == frame.dataId))
```
