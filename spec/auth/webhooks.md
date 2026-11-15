# Login webhooks

The identity service tells a deployment about sign-in events by webhook. The
service owns a registration of its delivery work on a shared interval, and a
task adapter may also keep that interval alive. A delivery is claimed from a
durable queue, sent, and settled with a durable receipt. A request may also
fan out immediate deliveries, which are tracked until every one of them
settles. On shutdown the service closes its listener first, then stops the
worker from claiming more, and releases the database only after every
claimed or immediate delivery has settled.

Ported from develop `packages/auth/quint/LoginWebhookTimer.qnt` (both its
modules: the timer registration and the immediate fan-out); the refusal of
private-network endpoints is new, from develop `src/server/webhooks/`.

## Story: Deliver login events and drain them at shutdown

> As a deployment, I want every sign-in event delivered to my webhook and
> recorded once, also across a restart, and I want the service to refuse
> endpoints that point into its private network.

### Webhook endpoints on private networks are refused

```quint
type Endpoint = { url: str, privateNetwork: bool }
type ServicePhase = ServiceOff | Serving | ClosingListener | Draining | ServiceClosed
type CallbackPhase = CallbackIdle | CallbackQueued | Scanning | Claiming | Sending | WritingReceipt
type DeliveryStatus = DeliveryPending | DeliveryProcessing | DeliveryDelivered | DeliveryFailed
type Delivery = { id: int, status: DeliveryStatus }
type Webhooks = {
  service: ServicePhase, generation: int, storageOpen: bool, listenerOpen: bool, workerRunning: bool,
  adapterAttached: bool, registered: bool, timerArmed: bool, callback: CallbackPhase, claimed: int, sendOk: bool,
  deliveries: List[Delivery], claims: int, claimsAtAbort: int, immediateInFlight: int, endpoints: List[Endpoint]
}
pure val initial: Webhooks = {
  service: ServiceOff, generation: 0, storageOpen: false, listenerOpen: false, workerRunning: false,
  adapterAttached: false, registered: false, timerArmed: false, callback: CallbackIdle, claimed: 0, sendOk: false,
  deliveries: List({ id: 1, status: DeliveryPending }, { id: 2, status: DeliveryPending }), claims: 0, claimsAtAbort: 0, immediateInFlight: 0, endpoints: List()
}
pure def canRegisterEndpoint(s: Webhooks, endpoint: Endpoint): bool = endpoint.url != "" and not(endpoint.privateNetwork)
pure def registerEndpoint(s: Webhooks, endpoint: Endpoint): Webhooks = { ...s, endpoints: s.endpoints.append(endpoint) }
pure val endpointValues = Set({ url: "https://hooks.example.org/login", privateNetwork: false }, { url: "http://10.0.0.5/hook", privateNetwork: true })
pure def alwaysNoPrivateEndpoint(s: Webhooks): bool = s.endpoints.every(e => not(e.privateNetwork))
pure def sometimesEndpointRegistered(s: Webhooks): bool = s.endpoints.length() > 0
```

### The delivery timer runs exactly while the service registration or a task adapter owns it

```quint
pure def canAttachAdapter(s: Webhooks): bool = not(s.adapterAttached)
pure def attachAdapter(s: Webhooks): Webhooks = { ...s, adapterAttached: true, timerArmed: true }
pure def canDetachAdapter(s: Webhooks): bool = s.adapterAttached
pure def detachAdapter(s: Webhooks): Webhooks = { ...s, adapterAttached: false, timerArmed: s.registered }
pure def canStartService(s: Webhooks): bool = s.service == ServiceOff or s.service == ServiceClosed
pure def startService(s: Webhooks): Webhooks =
  { ...s, service: Serving, generation: s.generation + 1, storageOpen: true, listenerOpen: true, workerRunning: true, registered: true, timerArmed: true }
pure def alwaysTimerFollowsOwners(s: Webhooks): bool = s.timerArmed == (s.adapterAttached or s.registered)
pure def alwaysServiceOwnsRegistration(s: Webhooks): bool = s.registered == (s.service == Serving or s.service == ClosingListener)
pure def sometimesAdapterKeepsTimerAfterClose(s: Webhooks): bool = s.service == ServiceClosed and s.timerArmed
```

### A claimed delivery keeps the database open until its transport and durable receipt settle

```quint
pure def due(s: Webhooks): List[Delivery] = s.deliveries.select(d => d.status == DeliveryPending)
pure def canQueueCallback(s: Webhooks): bool = s.timerArmed and s.registered and s.callback == CallbackIdle and due(s).length() > 0
pure def queueCallback(s: Webhooks): Webhooks = { ...s, callback: CallbackQueued }
pure def canStartCallback(s: Webhooks): bool = s.callback == CallbackQueued and s.registered
pure def startCallback(s: Webhooks): Webhooks = { ...s, callback: Scanning }
pure def canFinishCallback(s: Webhooks): bool =
  (s.callback == CallbackQueued and not(s.registered)) or (s.callback == Scanning and (not(s.registered) or due(s).length() == 0))
pure def finishCallback(s: Webhooks): Webhooks = { ...s, callback: CallbackIdle }
pure def canBeginClaim(s: Webhooks, delivery: int): bool = s.callback == Scanning and s.registered and due(s).some(d => d.id == delivery)
pure def beginClaim(s: Webhooks, delivery: int): Webhooks = { ...s, callback: Claiming, claimed: delivery, claims: s.claims + 1 }
pure val deliveryValues = Set(1, 2)
pure def canClaimCommitted(s: Webhooks): bool = s.callback == Claiming
pure def claimCommitted(s: Webhooks): Webhooks =
  { ...s, callback: Sending, deliveries: s.deliveries.listMap(d => if (d.id == s.claimed) { ...d, status: DeliveryProcessing } else d) }
pure def canSettleDelivery(s: Webhooks, ok: bool): bool = s.callback == Sending
pure def settleDelivery(s: Webhooks, ok: bool): Webhooks = { ...s, callback: WritingReceipt, sendOk: ok }
pure def canCommitReceipt(s: Webhooks): bool = s.callback == WritingReceipt and s.storageOpen
pure def commitReceipt(s: Webhooks): Webhooks =
  { ...s, callback: Scanning, claimed: 0, deliveries: s.deliveries.listMap(d => if (d.id == s.claimed) { ...d, status: if (s.sendOk) DeliveryDelivered else DeliveryFailed } else d) }
pure def alwaysStorageOutlivesDeliveryWork(s: Webhooks): bool = (s.callback != CallbackIdle or s.immediateInFlight > 0) implies s.storageOpen
pure def alwaysProcessingDeliveryIsClaimed(s: Webhooks): bool =
  s.deliveries.every(d => d.status == DeliveryProcessing implies (s.claimed == d.id and (s.callback == Sending or s.callback == WritingReceipt)))
pure def sometimesDeliveredAcrossRestart(s: Webhooks): bool = s.generation == 2 and s.deliveries.some(d => d.status == DeliveryDelivered)
pure def sometimesFailedReceiptRecorded(s: Webhooks): bool = s.deliveries.some(d => d.status == DeliveryFailed)
```

### A request's immediate deliveries are tracked until every one settles, even when one fails first

```quint
pure def canEmitImmediate(s: Webhooks, count: int): bool = s.service == Serving and count > 0
pure def emitImmediate(s: Webhooks, count: int): Webhooks = { ...s, immediateInFlight: s.immediateInFlight + count }
pure val countValues = Set(1, 2)
pure def canSettleImmediate(s: Webhooks): bool = s.immediateInFlight > 0 and s.storageOpen
pure def settleImmediate(s: Webhooks): Webhooks = { ...s, immediateInFlight: s.immediateInFlight - 1 }
pure def alwaysImmediateCountValid(s: Webhooks): bool = s.immediateInFlight >= 0
pure def sometimesDrainingWithImmediateDeliveries(s: Webhooks): bool = s.service == Draining and s.immediateInFlight > 0
```

### The listener closes before the worker stops claiming, and the service closes only when all work has settled

```quint
pure def canStopService(s: Webhooks): bool = s.service == Serving
pure def stopService(s: Webhooks): Webhooks = { ...s, service: ClosingListener, listenerOpen: false }
pure def canRetireWorker(s: Webhooks): bool = s.service == ClosingListener
pure def retireWorker(s: Webhooks): Webhooks = { ...s, service: Draining, workerRunning: false, registered: false, timerArmed: s.adapterAttached, claimsAtAbort: s.claims }
pure def canCloseService(s: Webhooks): bool = s.service == Draining and s.callback == CallbackIdle and s.immediateInFlight == 0
pure def closeService(s: Webhooks): Webhooks = { ...s, service: ServiceClosed, storageOpen: false }
pure def alwaysListenerClosesFirst(s: Webhooks): bool =
  (s.listenerOpen implies s.workerRunning) and (s.listenerOpen iff s.service == Serving) and (s.workerRunning iff (s.service == Serving or s.service == ClosingListener))
pure def alwaysDrainingClaimsNothing(s: Webhooks): bool = (s.service == Draining or s.service == ServiceClosed or s.service == ServiceOff) implies s.claims == s.claimsAtAbort
pure def alwaysClosedStorageHasNoWork(s: Webhooks): bool = not(s.storageOpen) iff (s.service == ServiceOff or s.service == ServiceClosed)
pure val fair_retireWorker = "weak"
pure val fair_startCallback = "weak"
pure val fair_finishCallback = "weak"
pure val fair_claimCommitted = "weak"
pure val fair_settleDelivery = "weak"
pure val fair_commitReceipt = "weak"
pure val fair_settleImmediate = "weak"
pure val fair_closeService = "weak"
pure def leadsToShutdownCompletes(s: Webhooks, later: Webhooks): bool =
  (s.service == ClosingListener or s.service == Draining) implies later.service == ServiceClosed
pure def sometimesQueuedCallbackAbandonedAtClose(s: Webhooks): bool = s.service == ServiceClosed and s.claims == 0 and s.generation == 1
```
