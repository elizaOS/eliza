# Channel-topic service retirement

This model migrates lifecycle and durable/local separation from `quint/ChannelTopicRetirement.qnt` and `services/channel-topics.ts`. Each room owns the exact call identities, read/write inputs and results, and local/durable LRU lists. Hydration occupies that queue, so a cold read orders with writes in its room while another room can progress independently.

## Story: Replace a topic service after its admitted work settles

As a host, I want retiring services to join their accepted operations and replacements to hydrate persisted topic state.

### Retirement rejects new work and joins admitted operations before clearing local state

An accepted operation can finish after stop begins. Failed persistence releases the queue and retains the source's current local topic state, which may be included by a later successful write. A retired instance clears its hydrated local cache. The replacement increments its service generation and obtains persisted state when it hydrates. Stale handles fail generation-aware admission. Room identity belongs to the service operation. A write refreshes every nonblank trimmed topic to the tail and retains at most twenty distinct topics. A missing room during persistence succeeds without changing durable data. A cold read returns the complete defensive-copy list.

The room adapter can return the current durable list represented in this model, a new snapshot read from storage, or a read failure. A new snapshot includes pre-existing metadata on the first access after process start. The boundary applies JavaScript trim, ignores non-string and blank entries, retains the first occurrence of each normalized string, then retains at most twenty entries from the tail. A missing room or non-array metadata yields an empty snapshot. The guard checks the structural result of normalization; JavaScript coercion and storage read linearization are adapter conformance obligations. Empty hydration marks the room hydrated without adding an entry to the local map; a write adds an entry even if its resulting list is empty.

```quint
type TopicOwner = Live | Stopping | Retired | Replacement
type TopicCallPhase = TopicQueued | HydratingTopics | TopicReady | PersistingTopics | TopicRead | TopicSaved | TopicMissingRoom | TopicFailed
type TopicCall = { id: str, readOnly: bool, incoming: List[str], phase: TopicCallPhase, result: List[str] }
type TopicService = { owner: TopicOwner, generation: int, queue: List[str], calls: List[TopicCall], hydrated: bool, cachePresent: bool, localTopics: List[str], durableTopics: List[str] }
type TopicHydration = ReadTrackedTopics | ReadTopicSnapshot({ topics: List[str] }) | TopicReadFailure
pure val initial: TopicService = { owner: Live, generation: 0, queue: List(), calls: List(), hydrated: false, cachePresent: false, localTopics: List(), durableTopics: List() }
pure val noCall: TopicCall = { id: "", readOnly: true, incoming: List(), phase: TopicFailed, result: List() }
pure def headCall(t: TopicService): TopicCall = t.calls.select(call => call.id == t.queue.nthOr(0, "")).nthOr(0, noCall)
pure def callFinished(call: TopicCall): bool = call.phase == TopicRead or call.phase == TopicSaved or call.phase == TopicMissingRoom or call.phase == TopicFailed
pure def hasCall(t: TopicService, callId: str): bool = t.calls.some(call => call.id == callId)
pure def activeOwner(t: TopicService): bool = t.owner == Live or t.owner == Replacement
pure def generationAdmissible(t: TopicService, generation: int): bool = activeOwner(t) and t.generation == generation
pure def canAdmit(t: TopicService, capturedGeneration: int, callId: str, readOnly: bool, incoming: List[str]): bool = generationAdmissible(t, capturedGeneration) and callId != "" and not(hasCall(t, callId)) and (readOnly or incoming.length() > 0)
pure def admit(t: TopicService, capturedGeneration: int, callId: str, readOnly: bool, incoming: List[str]): TopicService = { ...t, queue: t.queue.append(callId), calls: t.calls.append({ id: callId, readOnly: readOnly, incoming: incoming, phase: TopicQueued, result: List() }) }
pure def withHeadPhase(call: TopicCall, callId: str, phase: TopicCallPhase, result: List[str]): TopicCall = if (call.id == callId) { ...call, phase: phase, result: result } else call
pure def canClaimHead(t: TopicService): bool = headCall(t).phase == TopicQueued
pure def claimHead(t: TopicService): TopicService = { ...t, calls: t.calls.listMap(call => withHeadPhase(call, headCall(t).id, if (t.hydrated) TopicReady else HydratingTopics, List())) }
pure def dropHead(queue: List[str]): List[str] = if (queue.length() > 0) queue.tail() else List()
pure def validTopics(topics: List[str]): bool = topics.length() <= 20 and topics.every(topic => topic != "" and topics.select(other => topic == other).length() == 1)
pure def hydrationAccepted(hydration: TopicHydration): bool = match hydration { | ReadTrackedTopics => true | ReadTopicSnapshot(snapshot) => validTopics(snapshot.topics) | TopicReadFailure => true }
pure def hydrationSucceeded(hydration: TopicHydration): bool = match hydration { | ReadTrackedTopics => true | ReadTopicSnapshot(_) => true | TopicReadFailure => false }
pure def hydratedSnapshot(t: TopicService, hydration: TopicHydration): List[str] = match hydration { | ReadTrackedTopics => t.durableTopics | ReadTopicSnapshot(snapshot) => snapshot.topics | TopicReadFailure => t.durableTopics }
pure def isHydrating(t: TopicService): bool = headCall(t).phase == HydratingTopics
pure def canHydrate(t: TopicService, hydration: TopicHydration): bool = isHydrating(t) and hydrationAccepted(hydration)
pure def hydrate(t: TopicService, hydration: TopicHydration): TopicService = {
  val succeeded = hydrationSucceeded(hydration)
  val snapshot = hydratedSnapshot(t, hydration)
  { ...t, hydrated: succeeded, cachePresent: if (succeeded) snapshot.length() > 0 else t.cachePresent, durableTopics: snapshot, localTopics: if (succeeded) snapshot else t.localTopics, queue: if (succeeded) t.queue else dropHead(t.queue), calls: t.calls.listMap(call => withHeadPhase(call, headCall(t).id, if (succeeded) TopicReady else TopicFailed, List())) }
}
pure def refreshTopic(currentTopics: List[str], topic: str): List[str] = {
  val updated = currentTopics.select(previous => previous != topic).append(topic)
  if (topic == "") currentTopics else if (updated.length() > 20) dropHead(updated) else updated
}
pure def canStart(t: TopicService): bool = headCall(t).phase == TopicReady
pure def start(t: TopicService): TopicService = {
  val own = headCall(t)
  val updated = own.incoming.foldl(t.localTopics, (topics, topic) => refreshTopic(topics, topic))
  if (own.readOnly) { ...t, queue: dropHead(t.queue), calls: t.calls.listMap(call => withHeadPhase(call, own.id, TopicRead, t.localTopics)) }
  else { ...t, cachePresent: true, localTopics: updated, calls: t.calls.listMap(call => withHeadPhase(call, own.id, PersistingTopics, updated)) }
}
type TopicPersistence = TopicCommitted | TopicRoomMissing | TopicWriteFailed
pure def canPersist(t: TopicService): bool = headCall(t).phase == PersistingTopics
pure def persist(t: TopicService, persistence: TopicPersistence): TopicService = {
  val own = headCall(t)
  val phase = if (persistence == TopicCommitted) TopicSaved else if (persistence == TopicRoomMissing) TopicMissingRoom else TopicFailed
  { ...t, queue: dropHead(t.queue), durableTopics: if (persistence == TopicCommitted) own.result else t.durableTopics, calls: t.calls.listMap(call => withHeadPhase(call, own.id, phase, own.result)) }
}
pure def roomEligible(t: TopicService): bool = canClaimHead(t) or isHydrating(t) or canStart(t) or canPersist(t)
pure def canAdvanceRoom(t: TopicService, hydration: TopicHydration): bool = roomEligible(t) and (not(isHydrating(t)) or hydrationAccepted(hydration))
pure def advanceRoom(t: TopicService, hydration: TopicHydration, persistence: TopicPersistence): TopicService = if (canClaimHead(t)) claimHead(t) else if (isHydrating(t)) hydrate(t, hydration) else if (canStart(t)) start(t) else persist(t, persistence)
pure def alwaysCallIdsUnique(t: TopicService): bool = t.calls.every(call => call.id != "" and t.calls.select(other => other.id == call.id).length() == 1)
pure def alwaysQueueOwnsCalls(t: TopicService): bool = t.queue.every(callId => t.calls.some(call => call.id == callId and not(callFinished(call))) and t.queue.select(other => other == callId).length() == 1) and t.calls.every(call => callFinished(call) or t.queue.includes(call.id))
pure def alwaysOnlyHeadIsActive(t: TopicService): bool = t.calls.every(call => call.phase == TopicQueued or callFinished(call) or call.id == t.queue.nthOr(0, ""))
pure def alwaysTopicCapacity(t: TopicService): bool = t.localTopics.length() <= 20 and t.durableTopics.length() <= 20 and t.calls.every(call => call.result.length() <= 20)
pure def alwaysTopicCacheOwnership(t: TopicService): bool = (t.cachePresent implies t.hydrated) and (not(t.cachePresent) implies t.localTopics.length() == 0)
pure def alwaysUnhydratedHasNoCache(t: TopicService): bool = not(t.hydrated) implies not(t.cachePresent)
pure def sometimesFailedWriteRetained(t: TopicService): bool = t.localTopics != t.durableTopics and t.calls.some(call => call.phase == TopicFailed and call.result.length() > 0)
```

### A stopping owner eventually joins its admitted room operations

Progress assumes fair hydration, application and persistence settlement, including failed I/O. Stop prevents additional admission to this generation. Completing stop clears local state before a replacement can hydrate durable topics.

The proof needs the queue phase to agree with cache ownership: a hydrating call owns an unhydrated room; a ready or persisting call owns a hydrated one.

```quint
pure def canBeginStop(t: TopicService): bool = activeOwner(t)
pure def beginStop(t: TopicService): TopicService = { ...t, owner: Stopping }
pure def canFinishStop(t: TopicService): bool = t.owner == Stopping and t.queue.length() == 0
pure def finishStop(t: TopicService): TopicService = { ...t, owner: Retired, hydrated: false, cachePresent: false, localTopics: List() }
pure def canReplace(t: TopicService): bool = t.owner == Retired
pure def replace(t: TopicService): TopicService = { ...t, owner: Replacement, generation: t.generation + 1 }
pure def alwaysRetiredServiceJoined(t: TopicService): bool = t.owner == Retired implies t.queue.length() == 0 and not(t.hydrated) and t.localTopics.length() == 0
pure def alwaysActiveCallMatchesHydration(t: TopicService): bool = t.calls.every(call => (call.phase == HydratingTopics implies not(t.hydrated)) and ((call.phase == TopicReady or call.phase == PersistingTopics) implies t.hydrated))
pure def sometimesRetired(t: TopicService): bool = t.owner == Retired
pure def sometimesReplacementHydrated(t: TopicService): bool = t.owner == Replacement and t.hydrated
pure def sometimesColdReadReturnsStoredTopics(t: TopicService): bool = t.calls.some(call => call.phase == TopicRead and call.result.includes("stored"))
pure val capturedGenerationValues = Set(0, 1, 2)
pure val hydrationValues: Set[TopicHydration] = Set(ReadTrackedTopics, ReadTopicSnapshot({ topics: List() }), ReadTopicSnapshot({ topics: List("stored") }), ReadTopicSnapshot({ topics: List("stored", "stored") }), TopicReadFailure)
pure val callIdValues = Set("call1", "call2", "call3")
pure val incomingValues = Set(List(), List("old"), List("new"), List("new", "old"))
pure val fair_advanceRoom = "weak"
pure val fair_finishStop = "weak"
pure def leadsToRetiredOwner(t: TopicService, later: TopicService): bool = t.owner == Stopping implies later.owner == Retired or later.generation > t.generation
pure def leadsToAcceptedCallsSettle(t: TopicService, later: TopicService): bool = t.calls.every(call => later.calls.some(done => done.id == call.id and callFinished(done)))
```
