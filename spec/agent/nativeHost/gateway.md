# Native gateway

A device host runs the agent behind a native gateway. The gateway
acquires its resources, listens, admits each conversation turn for the
current owner and reset epoch, streams the reply back through a
start, pull and cancel protocol, and drains before it cleans up. Which
conversation a request may use is [ownership](../conversation/ownership.md);
how the renderer pulls previews is [reply streaming](../client/replyStreaming.md);
the commands sent to a page are the [surface channel](./surfaceChannel.md).

## Story: Start and stop the gateway without leaking a resource

> As a device owner, the gateway serving my agent either serves requests or
> cleans up everything it acquired, and stopping it never cuts off a
> request in progress.

### Resources are acquired in order and released once each, in reverse order

The gateway acquires up to four optional resources in a fixed order, binds
and then listens. A startup failure before listening, or the close of the
HTTP server after a drain, makes the gateway the owner of cleanup. Cleanup
releases each acquired resource once, the most recently acquired first,
even when a release fails, and the gateway closes only when every acquired
resource is released.

```quint
type GatewayPhase = GwAcquiring | GwBinding | GwReady | GwDraining | GwCleanup | GwClosed
type Lifecycle = { phase: GatewayPhase, nextResource: int, acquired: Set[int], released: Set[int], cleanupOwner: bool, listening: bool, readyReported: bool, connectedRequest: bool, managedJoined: bool, closeObserved: bool, errors: int, lastReleased: int }
type AdmissionPhase = AdIdle | AdInference | AdOwner | AdAdmitted | AdSent | AdReturned | AdRejected
type Admission = { phase: AdmissionPhase, checkEpoch: int, requestEpoch: int, memo: int, admittedOwner: int }
type ReplyStream = { pending: bool, captured: int, capturedOwner: int, seq: int, ack: int, done: bool, delivered: bool }
type Gateway = { owner: int, roomOwner: int, epoch: int, life: Lifecycle, admission: Admission, stream: ReplyStream }
pure val startingLife: Lifecycle = { phase: GwAcquiring, nextResource: 0, acquired: Set(), released: Set(), cleanupOwner: false, listening: false, readyReported: false, connectedRequest: false, managedJoined: false, closeObserved: false, errors: 0, lastReleased: 4 }
pure val idleAdmission: Admission = { phase: AdIdle, checkEpoch: -1, requestEpoch: -1, memo: -1, admittedOwner: -1 }
pure val quietStream: ReplyStream = { pending: false, captured: -1, capturedOwner: 0, seq: 0, ack: 0, done: false, delivered: false }
pure val initial: Gateway = { owner: 0, roomOwner: 0, epoch: 0, life: startingLife, admission: idleAdmission, stream: quietStream }
pure def canAcquireResource(g: Gateway): bool = g.life.phase == GwAcquiring and g.life.nextResource < 4
pure def acquireResource(g: Gateway, present: bool): Gateway =
  { ...g, life: { ...g.life, nextResource: g.life.nextResource + 1, acquired: if (present) g.life.acquired.union(Set(g.life.nextResource)) else g.life.acquired } }
pure def canBindGateway(g: Gateway): bool = g.life.phase == GwAcquiring and g.life.nextResource == 4
pure def bindGateway(g: Gateway): Gateway = { ...g, life: { ...g.life, phase: GwBinding } }
pure def canListenGateway(g: Gateway): bool = g.life.phase == GwBinding
pure def listenGateway(g: Gateway): Gateway = { ...g, life: { ...g.life, phase: GwReady, listening: true, readyReported: true } }
pure def canStartupFailure(g: Gateway): bool = g.life.phase == GwAcquiring or g.life.phase == GwBinding
pure def startupFailure(g: Gateway): Gateway = { ...g, life: { ...g.life, phase: GwCleanup, cleanupOwner: true } }
pure def canDisposeResource(g: Gateway, resource: int): bool =
  g.life.phase == GwCleanup and g.life.acquired.contains(resource) and not(g.life.released.contains(resource)) and
  g.life.acquired.forall(other => g.life.released.contains(other) or other <= resource)
pure def disposeResource(g: Gateway, resource: int, failed: bool): Gateway =
  { ...g, life: { ...g.life, released: g.life.released.union(Set(resource)), errors: g.life.errors + (if (failed) 1 else 0), lastReleased: resource } }
pure def canFinishGateway(g: Gateway): bool = g.life.phase == GwCleanup and g.life.acquired.subseteq(g.life.released)
pure def finishGateway(g: Gateway): Gateway = { ...g, life: { ...g.life, phase: GwClosed } }
pure val resourceValues = Set(0, 1, 2, 3)
pure def alwaysReleasedOnceInReverse(g: Gateway): bool =
  g.life.released.subseteq(g.life.acquired) and g.life.acquired.forall(r => r >= 0 and r < g.life.nextResource) and g.life.nextResource <= 4 and
  ((g.life.phase != GwCleanup and g.life.phase != GwClosed) implies (g.life.lastReleased == 4 and g.life.released.size() == 0)) and
  g.life.released.forall(r => r >= g.life.lastReleased) and g.life.acquired.forall(r => g.life.released.contains(r) or r < g.life.lastReleased) and
  (g.life.phase == GwReady implies g.life.listening) and (g.life.phase == GwClosed implies g.life.acquired.subseteq(g.life.released)) and
  (g.life.cleanupOwner == (g.life.phase == GwCleanup or g.life.phase == GwClosed))
pure def sometimesStartupFailureRolledBack(g: Gateway): bool = g.life.phase == GwClosed and not(g.life.closeObserved) and g.life.released.size() > 1 and g.life.errors > 0
```

### Cleanup waits for the HTTP close, which waits for requests in progress

An external close or a managed close stops listening and starts the drain;
a managed close joins a drain already started. The HTTP server reports its
close only when no connected request remains, and cleanup starts only
after that close, so a request in progress is never cut off by cleanup.

```quint
pure def canAdmitConnection(g: Gateway): bool = g.life.phase == GwReady and not(g.life.connectedRequest)
pure def admitConnection(g: Gateway): Gateway = { ...g, life: { ...g.life, connectedRequest: true } }
pure def canFinishConnection(g: Gateway): bool = g.life.connectedRequest
pure def finishConnection(g: Gateway): Gateway = { ...g, life: { ...g.life, connectedRequest: false } }
pure def canStartDrain(g: Gateway): bool = g.life.phase == GwReady
pure def startDrain(g: Gateway, managed: bool): Gateway = { ...g, life: { ...g.life, phase: GwDraining, listening: false, managedJoined: managed } }
pure def canJoinDrain(g: Gateway): bool = g.life.phase == GwDraining and not(g.life.managedJoined)
pure def joinDrain(g: Gateway): Gateway = { ...g, life: { ...g.life, managedJoined: true } }
pure def canReceiveHttpClose(g: Gateway): bool = g.life.phase == GwDraining and not(g.life.connectedRequest)
pure def receiveHttpClose(g: Gateway): Gateway = { ...g, life: { ...g.life, phase: GwCleanup, closeObserved: true, cleanupOwner: true } }
pure def alwaysCleanupFollowsHttpClose(g: Gateway): bool =
  (g.life.connectedRequest implies (g.life.phase == GwReady or g.life.phase == GwDraining)) and
  (g.life.closeObserved implies (g.life.phase == GwCleanup or g.life.phase == GwClosed)) and
  ((g.life.phase == GwAcquiring or g.life.phase == GwBinding) implies not(g.life.readyReported)) and
  (g.life.connectedRequest implies not(g.life.cleanupOwner)) and
  ((g.life.readyReported and g.life.cleanupOwner) implies g.life.closeObserved) and
  (g.life.phase == GwDraining implies (not(g.life.listening) and not(g.life.closeObserved)))
pure def sometimesDrainedAndClosed(g: Gateway): bool = g.life.phase == GwClosed and g.life.closeObserved and g.life.managedJoined
pure def leadsToGatewayCloses(g: Gateway, later: Gateway): bool =
  (g.life.phase == GwDraining or g.life.phase == GwCleanup) implies later.life.phase == GwClosed
pure val fair_finishConnection = "weak"
pure val fair_receiveHttpClose = "weak"
pure val fair_disposeResource = "weak"
pure val fair_finishGateway = "weak"
```

### The local health route answers only an authenticated native GET

The gateway's local health route answers an authenticated native GET with
no origin and no query once ownership is loaded. A CORS preflight carries
no health, a missing or wrong native bearer is unauthenticated, and a
disallowed caller is forbidden. The [device updater's runtime
probe](../../os/update/runtimeHealth.md) reads it.

```quint
type LocalHealthRequest = { expectsNativeToken: bool, bearerMatches: bool, callerAllowed: bool, hasOrigin: bool, methodGet: bool, methodOptions: bool, corsPreflight: bool, hasQuery: bool, ownershipLoaded: bool }
type LocalHealthResponse = LocalNoContent | LocalUnauthenticated | LocalForbidden | LocalOwnershipUnavailable | LocalMethodNotAllowed | LocalBadRequest | LocalHealthy
pure def localHealthRoute(localRequest: LocalHealthRequest): LocalHealthResponse =
  if (localRequest.corsPreflight) (if (localRequest.callerAllowed) LocalNoContent else LocalForbidden)
  else if (localRequest.expectsNativeToken and not(localRequest.bearerMatches)) LocalUnauthenticated
  else if (not(localRequest.callerAllowed)) LocalForbidden
  else if (localRequest.methodOptions) LocalNoContent
  else if (not(localRequest.ownershipLoaded)) LocalOwnershipUnavailable
  else if (not(localRequest.expectsNativeToken) or localRequest.hasOrigin) LocalForbidden
  else if (not(localRequest.methodGet)) LocalMethodNotAllowed
  else if (localRequest.hasQuery) LocalBadRequest
  else LocalHealthy
pure val nativeGet: LocalHealthRequest = { expectsNativeToken: true, bearerMatches: true, callerAllowed: true, hasOrigin: false, methodGet: true, methodOptions: false, corsPreflight: false, hasQuery: false, ownershipLoaded: true }
pure val localRequestValues = Set(nativeGet, { ...nativeGet, bearerMatches: false }, { ...nativeGet, hasOrigin: true }, { ...nativeGet, hasQuery: true }, { ...nativeGet, methodGet: false }, { ...nativeGet, ownershipLoaded: false }, { ...nativeGet, expectsNativeToken: false }, { ...nativeGet, methodGet: false, methodOptions: true, corsPreflight: true })
pure def lawPreflightCarriesNoHealth(localRequest: LocalHealthRequest): bool =
  localRequest.corsPreflight implies localHealthRoute(localRequest) != LocalHealthy
pure def lawHealthSuccessNeedsNativeBearer(localRequest: LocalHealthRequest): bool =
  localHealthRoute(localRequest) == LocalHealthy implies localRequest.expectsNativeToken and localRequest.bearerMatches and localRequest.callerAllowed and not(localRequest.hasOrigin) and localRequest.methodGet and not(localRequest.hasQuery) and localRequest.ownershipLoaded
```

## Story: Answer a turn only for the owner who sent it

> As a device owner, my turn is sent to the agent and its reply returned to
> me only while I am still the signed-in owner, even if the account was
> reset or changed while the agent was thinking.

### A turn is admitted, sent and answered only while its owner and reset epoch are current

Inference may read the owner once and share that read with admission, but a
reset during inference drops it, and admission then reads the owner again.
A turn is admitted only for the room's owner under the epoch it captured.
Dispatch and reply each check again that the admitting owner and epoch are
still current; otherwise the turn is rejected.

```quint
pure def admissionCurrent(g: Gateway): bool = g.admission.requestEpoch == g.epoch and g.admission.admittedOwner == g.owner
pure def canBeginAdmission(g: Gateway): bool =
  g.admission.phase == AdIdle or g.admission.phase == AdReturned or g.admission.phase == AdRejected
pure def beginAdmission(g: Gateway): Gateway = { ...g, admission: { ...idleAdmission, phase: AdInference, checkEpoch: g.epoch } }
pure def canInferenceReadsOwner(g: Gateway): bool = g.admission.phase == AdInference and g.admission.memo == -1
pure def inferenceReadsOwner(g: Gateway): Gateway = { ...g, admission: { ...g.admission, memo: g.owner } }
pure def canInferenceComplete(g: Gateway): bool = g.admission.phase == AdInference
pure def inferenceComplete(g: Gateway): Gateway =
  { ...g, admission: { ...g.admission, phase: AdOwner, requestEpoch: g.epoch, memo: if (g.admission.checkEpoch == g.epoch) g.admission.memo else -1 } }
pure def canOwnerRead(g: Gateway): bool = g.admission.phase == AdOwner and g.admission.memo == -1
pure def ownerRead(g: Gateway): Gateway = { ...g, admission: { ...g.admission, memo: g.owner } }
pure def canAdmitTurn(g: Gateway): bool = g.admission.phase == AdOwner and g.admission.memo >= 0
pure def admitTurn(g: Gateway): Gateway =
  if (g.admission.requestEpoch == g.epoch and g.admission.memo == g.roomOwner) { ...g, admission: { ...g.admission, phase: AdAdmitted, admittedOwner: g.admission.memo } }
  else { ...g, admission: { ...g.admission, phase: AdRejected } }
pure def canSendTurn(g: Gateway): bool = g.admission.phase == AdAdmitted
pure def sendTurn(g: Gateway): Gateway = { ...g, admission: { ...g.admission, phase: if (admissionCurrent(g)) AdSent else AdRejected } }
pure def canReplyTurn(g: Gateway): bool = g.admission.phase == AdSent
pure def replyTurn(g: Gateway): Gateway = { ...g, admission: { ...g.admission, phase: if (admissionCurrent(g)) AdReturned else AdRejected } }
pure def resetGateway(g: Gateway): Gateway = { ...g, epoch: g.epoch + 1, roomOwner: -1, stream: quietStream }
pure def rotateOwner(g: Gateway, nextOwner: int): Gateway = { ...g, owner: nextOwner, stream: { ...g.stream, delivered: false } }
pure def canReopenRoom(g: Gateway): bool = g.roomOwner == -1
pure def reopenRoom(g: Gateway): Gateway = { ...g, roomOwner: g.owner }
pure val nextOwnerValues = Set(0, 1)
pure def stepTurnMovesOnlyUnderCurrentAuthority(before: Gateway, via: str, after: Gateway): bool =
  ((via == "sendTurn" and after.admission.phase == AdSent) or (via == "replyTurn" and after.admission.phase == AdReturned)) implies admissionCurrent(before)
pure def stepResetDropsInferenceOwnerRead(before: Gateway, via: str, after: Gateway): bool =
  (via == "inferenceComplete" and before.admission.checkEpoch != before.epoch) implies after.admission.memo == -1
pure def sometimesTurnReturned(g: Gateway): bool = g.admission.phase == AdReturned
pure def sometimesOwnerChangeRejectsTurn(g: Gateway): bool = g.admission.phase == AdRejected and g.admission.admittedOwner >= 0
```

### Buffered reply text is kept until its cursor is acknowledged, and only its owner receives the reply

A reply stream captures the owner and epoch that opened it. Tokens append to
its buffer; a pull acknowledges a cursor up to the latest token, but only
for the capturing owner under the same epoch. The complete reply is
delivered only to that owner and epoch. A reset destroys the stream and its
buffer, and an owner change withdraws a delivery.

```quint
pure def canOpenReplyStream(g: Gateway): bool = not(g.stream.pending)
pure def openReplyStream(g: Gateway): Gateway = { ...g, stream: { ...quietStream, pending: true, captured: g.epoch, capturedOwner: g.owner } }
pure def canStreamToken(g: Gateway): bool = g.stream.pending and not(g.stream.done)
pure def streamToken(g: Gateway): Gateway = { ...g, stream: { ...g.stream, seq: g.stream.seq + 1 } }
pure def streamCurrent(g: Gateway): bool = g.stream.captured == g.epoch and g.stream.capturedOwner == g.owner
pure def canAcknowledgeCursor(g: Gateway): bool = g.stream.pending and streamCurrent(g) and g.stream.ack < g.stream.seq
pure def acknowledgeCursor(g: Gateway): Gateway = { ...g, stream: { ...g.stream, ack: g.stream.seq } }
pure def canCompleteStream(g: Gateway): bool = g.stream.pending and not(g.stream.done)
pure def completeStream(g: Gateway): Gateway = { ...g, stream: { ...g.stream, done: true } }
pure def canDeliverReply(g: Gateway): bool = g.stream.pending and g.stream.done and streamCurrent(g)
pure def deliverReply(g: Gateway): Gateway = { ...g, stream: { ...g.stream, delivered: true, pending: false } }
pure def alwaysReplyGoesToItsOwner(g: Gateway): bool =
  g.stream.ack >= 0 and g.stream.ack <= g.stream.seq and (g.stream.delivered implies (g.stream.done and streamCurrent(g))) and
  g.epoch >= 0 and g.stream.captured <= g.epoch
pure def sometimesAcknowledgedThenDelivered(g: Gateway): bool = g.stream.delivered and g.stream.ack > 0
pure def sometimesResetDropsStream(g: Gateway): bool = g.epoch > 0 and g.stream.captured == -1 and g.roomOwner == -1
```
