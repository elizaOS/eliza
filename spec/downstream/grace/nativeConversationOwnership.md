# Grace native conversation ownership

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` sets its installed resident agent's database to `pglite` with `dataDir: "memory://"`. Its native gateway substitutes a process-local ownership store for the `conversation-ownership.json` credential port. The development gateway can use a file. Eliza `7743504b7c936a764b3938a44cad918808b621df` passes that port from `packages/host/native-host/gateway-bootstrap.mjs` into `packages/agent/native-host/gateway.mjs`. This model owns access to a conversation ID through its exact room and owner, and the fate of that admission across reset and process replacement. The client turn controller, core room and message contracts, and separately durable task data own their respective state.

## Story: Reuse only the conversation this process admitted for the current owner

### Installed conversation ownership starts empty with the new process

Grace creates the native ownership port with an initially null string. `read` returns the current value, `write` stores its string form, and `clear` resets it to null. Only the exact native conversation-ownership path uses this substitution. The Cloud credential path follows the credential store and the encrypted task database has a separate port. The shared gateway hydrates its room map before handling routes. A missing or empty ownership value means no entries. A truthy value must parse as an array of rows with string `id`, `roomId` and `owner`. Hydration does not check UUID syntax. The last duplicate ID wins in input order. Failed hydration grants no room authority. A route already waiting on hydration receives the gateway failure. The pinned gateway starts the hydration promise before listening and does not attach a separate startup rejection handler, so an immediate invalid store may instead fail startup before a route observes it. Successful hydration also gates the installed local-readiness response.

The shared writer snapshots the entire map at enqueue, then serializes writes in order. One rejected write does not poison the following write. Native memory and native ownership both end with their respective process instances. A new installed launch starts with empty ownership even for the same verified account. Process replacement retires the previous launch. The machine records a late completion at the replacement boundary as fenced, without prescribing an HTTP response from a dead process. A client holding the old conversation or room ID receives `409 CONVERSATION_NOT_OWNED` when it tries to send or abort under the new gateway. A development restart with an injected surviving store may restore the mapping. The model receives decoded values and uses a single queried conversation ID with ordered matching rows. Grace `apps/app/native/java/technology/graceful/grace/LocalRuntimeService.java:264–275,800–804`, `apps/app/host/local-agent-gateway.ts:51–55,488–505`. Eliza `gateway-bootstrap.mjs:84–95`, `gateway.mjs:208–244,673–687`.

```quint
type LoadedOwnership = { found: bool, strings: bool, id: str, room: str, ownerId: str }
type OwnershipInput = { nativeHost: bool, exactOwnershipPort: bool, hasValue: bool, decodedArray: bool, records: List[LoadedOwnership] }
pure val absentOwner: LoadedOwnership = { found: false, strings: true, id: "", room: "", ownerId: "" }
pure def memoryOwnershipPort(nativeHost: bool, exactOwnershipPort: bool): bool = nativeHost and exactOwnershipPort
pure def hydrationValid(loaded: OwnershipInput): bool =
  not(loaded.hasValue) or (loaded.decodedArray and loaded.records.every(row => row.strings))
pure def lookupLoaded(loaded: OwnershipInput, requestedId: str): LoadedOwnership =
  if (not(loaded.hasValue) or not(hydrationValid(loaded))) absentOwner
  else loaded.records.foldl(absentOwner, (latest, row) => if (row.id == requestedId) { ...row, found: true } else latest)
pure def lawInvalidOwnershipCannotAuthorize(loaded: OwnershipInput, requestedId: str): bool =
  not(hydrationValid(loaded)) implies not(lookupLoaded(loaded, requestedId).found)
pure val savedOwner: LoadedOwnership = { found: true, strings: true, id: "id", room: "room", ownerId: "account-a" }
pure val fileOwnership: OwnershipInput = { nativeHost: false, exactOwnershipPort: true, hasValue: true, decodedArray: true, records: List(savedOwner) }
pure val loadedValues = Set(fileOwnership, { ...fileOwnership, hasValue: false }, { ...fileOwnership, decodedArray: false }, { ...fileOwnership, records: List({ ...savedOwner, strings: false }) }, { ...fileOwnership, records: List(savedOwner, { ...savedOwner, ownerId: "account-b" }) })
pure val requestedIdValues = Set("id", "other")
```

### A send uses the conversation ID, a Stop uses its room, and both need the captured owner

Conversation creation and buffered and streamed starts precede the upstream call with the host's admission checks. The gateway admits a send using the exact conversation ID under the captured account. It sends the upstream request only after rechecking owner, reset epoch and cancellation. Stop resolves its path by room ID among that owner's records, then rechecks the same authority before it forwards. A well-formed identifier for an unknown room or a different owner is `409 CONVERSATION_NOT_OWNED`. The gateway uses its authenticated credential gate rather than an owner supplied by the request. The existing credential gate and outer route policy stay authoritative.

The buffered reply reads upstream JSON and rechecks owner and epoch before returning it. The final task-presentation step rechecks the epoch, cancellation and the exact presentation if one was requested. The code does not perform another owner read after that last presentation await. A streaming pull checks the owner and epoch immediately before publishing, and drops the stream on that check's failure. Stream cancel intentionally discards its exact matched handle without an account check. Its acknowledgement does not authorize disclosure. The predicates below model ownership and authority only. Eliza `gateway.mjs:237–244,269–351,466–524,530–608,792–821,837–885`.

```quint
type TurnAuthority = { capturedOwner: str, observedOwner: str, capturedEpoch: int, liveEpoch: int, aborted: bool }
pure def ownerStillCurrent(scope: TurnAuthority): bool =
  scope.capturedOwner != "" and scope.capturedOwner == scope.observedOwner and scope.capturedEpoch == scope.liveEpoch and not(scope.aborted)
pure def mapAdmits(roomRecord: LoadedOwnership, ownerId: str, requestedId: str, abortRoom: bool): bool =
  roomRecord.found and roomRecord.ownerId == ownerId and
  (if (abortRoom) roomRecord.room == requestedId else roomRecord.id == requestedId)
pure def acceptsTurn(roomRecord: LoadedOwnership, scope: TurnAuthority, requestedId: str, abortRoom: bool): bool =
  ownerStillCurrent(scope) and mapAdmits(roomRecord, scope.capturedOwner, requestedId, abortRoom)
pure def lawForeignOwnerCannotUseRoom(roomRecord: LoadedOwnership, scope: TurnAuthority, requestedId: str, abortRoom: bool): bool =
  roomRecord.ownerId != scope.capturedOwner implies not(acceptsTurn(roomRecord, scope, requestedId, abortRoom))
pure def lawLateTurnCannotUseNewResetEpoch(roomRecord: LoadedOwnership, scope: TurnAuthority, requestedId: str, abortRoom: bool): bool =
  scope.capturedEpoch != scope.liveEpoch implies not(acceptsTurn(roomRecord, scope, requestedId, abortRoom))
pure val roomRecordValues = Set(absentOwner, savedOwner, { ...savedOwner, ownerId: "account-b" })
pure val liveAuthority: TurnAuthority = { capturedOwner: "account-a", observedOwner: "account-a", capturedEpoch: 1, liveEpoch: 1, aborted: false }
pure val scopeValues = Set(liveAuthority, { ...liveAuthority, observedOwner: "account-b" }, { ...liveAuthority, liveEpoch: 2 }, { ...liveAuthority, aborted: true })
```

## Story: Fence an old conversation while creation, reset or restart is in progress

### Creation records only a validated upstream identity under the checked owner

A create captures the owner and reset epoch and checks both before and after the upstream call. An OK response needs UUID-form conversation and room IDs. The gateway writes the returned id and room under that captured owner into the map before awaiting the ownership-store write. Its post-write fence checks only the reset epoch. A same-process credential change observed during that write does not itself prevent the create receipt. The mapped room stays with the original owner, so requests from a different owner cannot use it. A failed write rejects the create call but does not roll the map back. A reset while awaiting that write clears the map and prevents a late success response after the write returns. A valid upstream create may have already happened before a late refusal. Nothing here replays the upstream create or promises that the agent removed its room.

The state below tracks one create and one conversation record, retaining symbolic identities supplied by the validated upstream response. The process change and the reset epoch together distinguish a retired caller even when a fresh process starts its reset count at zero. `acceptCreated` starts after the before-send check and represents the open I/O completing. The main request handler separately owns upstream error bodies, client cancellation and transport failure. Eliza `gateway.mjs:237–244,827–919`.

```quint
type ConversationOwnerState = { processId: int, resetEpoch: int, currentOwner: str, ownership: LoadedOwnership, createPhase: str, capturedProcess: int, capturedReset: int, capturedOwner: str }
pure val initial: ConversationOwnerState = { processId: 1, resetEpoch: 0, currentOwner: "account-a", ownership: absentOwner, createPhase: "idle", capturedProcess: 0, capturedReset: 0, capturedOwner: "" }
pure def createInProgress(gateway: ConversationOwnerState): bool = gateway.createPhase == "upstream" or gateway.createPhase == "persisting"
pure def canBeginCreate(gateway: ConversationOwnerState): bool = not(createInProgress(gateway)) and gateway.currentOwner != ""
pure def beginCreate(gateway: ConversationOwnerState): ConversationOwnerState =
  { ...gateway, createPhase: "upstream", capturedProcess: gateway.processId, capturedReset: gateway.resetEpoch, capturedOwner: gateway.currentOwner }
pure def sameGatewayEpoch(gateway: ConversationOwnerState): bool =
  gateway.capturedProcess == gateway.processId and gateway.capturedReset == gateway.resetEpoch
pure def canAcceptCreated(gateway: ConversationOwnerState): bool = gateway.createPhase == "upstream"
type CreateEvidence = { upstreamOk: bool, idValid: bool, roomValid: bool, id: str, room: str }
pure def acceptCreated(gateway: ConversationOwnerState, reply: CreateEvidence): ConversationOwnerState =
  if (not(sameGatewayEpoch(gateway)) or gateway.capturedOwner != gateway.currentOwner) { ...gateway, createPhase: "not-owned" }
  else if (not(reply.upstreamOk and reply.idValid and reply.roomValid)) { ...gateway, createPhase: "upstream-refused" }
  else { ...gateway, createPhase: "persisting", ownership: { found: true, strings: true, id: reply.id, room: reply.room, ownerId: gateway.capturedOwner } }
pure def canFinishCreate(gateway: ConversationOwnerState): bool = gateway.createPhase == "persisting"
pure def finishCreate(gateway: ConversationOwnerState, written: bool): ConversationOwnerState =
  { ...gateway, createPhase: if (not(written)) "write-failed" else if (not(sameGatewayEpoch(gateway))) "not-owned" else "published" }
pure def changeGatewayOwner(gateway: ConversationOwnerState, nextOwner: str): ConversationOwnerState =
  { ...gateway, currentOwner: nextOwner }
pure def resetGateway(gateway: ConversationOwnerState): ConversationOwnerState =
  { ...gateway, resetEpoch: gateway.resetEpoch + 1, ownership: absentOwner }
pure def replaceNativeGateway(gateway: ConversationOwnerState): ConversationOwnerState =
  { ...gateway, processId: gateway.processId + 1, resetEpoch: 0, ownership: absentOwner }
pure def alwaysCapturedProcessNotFuture(gateway: ConversationOwnerState): bool =
  gateway.processId >= 1 and gateway.resetEpoch >= 0 and gateway.capturedProcess >= 0 and gateway.capturedProcess <= gateway.processId
pure def alwaysCurrentCreateHasOwner(gateway: ConversationOwnerState): bool =
  createInProgress(gateway) implies gateway.capturedProcess > 0 and gateway.capturedOwner != ""
pure def stepOnlyCurrentCreatePublishes(before: ConversationOwnerState, via: str, after: ConversationOwnerState): bool =
  via == "finishCreate" and after.createPhase == "published" implies sameGatewayEpoch(before)
pure def stepResetAndReplacementDropRoute(before: ConversationOwnerState, via: str, after: ConversationOwnerState): bool =
  via == "resetGateway" or via == "replaceNativeGateway" implies not(after.ownership.found)
pure def sometimesCreatedAndPublished(gateway: ConversationOwnerState): bool =
  gateway.createPhase == "published" and gateway.ownership.found
pure def sometimesCreationLostAcrossReplacement(gateway: ConversationOwnerState): bool =
  gateway.createPhase == "not-owned" and gateway.capturedProcess > 0 and gateway.capturedProcess < gateway.processId and not(gateway.ownership.found)
pure def sometimesFailedWriteStillHasMap(gateway: ConversationOwnerState): bool =
  gateway.createPhase == "write-failed" and gateway.ownership.found
pure val validCreate: CreateEvidence = { upstreamOk: true, idValid: true, roomValid: true, id: "id", room: "room" }
pure val replyValues = Set(validCreate, { ...validCreate, idValid: false }, { ...validCreate, roomValid: false }, { ...validCreate, upstreamOk: false })
pure val nextOwnerValues = Set("account-a", "account-b")
pure val weight_beginCreate = 4
pure val weight_acceptCreated = 6
pure val weight_finishCreate = 6
```

### A reset withdraws access even if cleanup or sign-out fails

Grace resets on POST `/cloud/native/start`, `/cloud/native/cancel` or `/cloud/logout`. The shared gateway revokes the surface channel scope, advances the local epoch and clears ownership and its turn counts before calling the later Cloud route. It cancels pending request controllers. It gathers a set of tracked rooms with dispatched turns, including a turn whose renderer pipe closed before the agent replied, and any additional rooms on pending requests. Unused rooms are absent. It asks the agent to abort each member once with reason `cloud-logout`. That call has a five-second timeout and is best effort. It awaits task revoke and then persists the current ownership snapshot. A new request can change the map while cleanup awaits, so the write captures the map at enqueue. If task revoke fails, the write and later Cloud route are skipped. If the store write fails, the later route is skipped. Neither failure restores the gateway map before the reset. Other requests completing after the captured reset are fenced with their own error, including an aborted upstream transport error. Device execution, cancellation completion and Cloud sign-out outcomes belong to their own ports. Grace `apps/app/host/gateway-policy.ts:215–225`. Eliza `gateway.mjs:194–205,270–323,705–733`.

```quint
pure def abortRooms(trackedRooms: Set[str], pendingRooms: Set[str]): Set[str] = trackedRooms.union(pendingRooms)
pure def resetOutcome(taskRevoked: bool, ownershipWritten: bool): str =
  if (not(taskRevoked)) "cleanup-refused"
  else if (not(ownershipWritten)) "write-failed"
  else "continue-to-cloud-route"
pure def lawOnlyTrackedOrPendingRoomsAbort(trackedRooms: Set[str], pendingRooms: Set[str], room: str): bool =
  abortRooms(trackedRooms, pendingRooms).contains(room) == (trackedRooms.contains(room) or pendingRooms.contains(room))
pure def lawCloudRouteRequiresEarlierCleanup(taskRevoked: bool, ownershipWritten: bool): bool =
  resetOutcome(taskRevoked, ownershipWritten) == "continue-to-cloud-route" implies taskRevoked and ownershipWritten
pure val trackedRoomsValues = Set(Set(), Set("a"), Set("a", "b"))
pure val pendingRoomsValues = Set(Set(), Set("a"), Set("b", "c"))
pure val roomValues = Set("a", "b", "c", "unused")
```
