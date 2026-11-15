# Android native sign-in

Sign-in on the device runs on native Android screens with an email or SMS
code, Google, or a second factor. Three parties take part: the Android
sign-in plugin's single worker, which verifies codes up to the mobile grant
(`CloudSignInPlugin`); the renderer's request broker, which owns one open
request and its native return; and the renderer's sign-in controller, which
gives each dispatched operation a request id and cancels exactly that
request, including after a code resend. Codes, verifiers, keys and sessions
stay native; the renderer sees only request, attempt and credential ids,
admitted by [receipt](../receipt.md). The model holds the four parts
independently.

## Story: Verify a sign-in code on the device

> As a person signing in with a code, I want each try answered once, a
> retry after a wrong code or a dropped request to work, and a cancelled
> attempt never to answer for a newer one.

### A retry reply after a wrong code or no answer belongs to the worker that detached the waiter

Starting a code attempt advances its generation. A verification is taken
only for the current attempt, its channel and step, while no other
verification waits. The single worker checks it. A wrong code, or a
request that got no answer, detaches the bridge waiter so the person can
retry at once, and the worker still owes that call its reply; the reply,
when it is delivered, never touches the new waiter or attempt. Every call
gets exactly one reply.

```quint
type Channel = NoChannel | EmailChannel | PhoneChannel
type Factor = NoFactor | TotpFactor | SmsFactor | PasskeyFactor
type VerifyTarget = VerifyEmail | VerifyPhone | VerifyFactor
type WorkStage = WorkIdle | Checking | InvalidReply | Granting
type Work = { owner: int, rpc: int, stage: WorkStage }
type CodeVerification = { generation: int, channel: Channel, factor: Factor, sending: bool, expired: bool, failed: int,
  issued: int, waiter: int, work: Work, replied: List[int] }
type BrokerOutcome = RequestPending | RequestResolved | RequestRejected
type CallbackState = CallbackIdle | CallbackRunning | CallbackAborted
type BrokerRequest = { id: int, key: str, outcome: BrokerOutcome, callback: CallbackState }
type RouteKind = NoRoute | JoinRoute | BusyRoute | ColdRoute | ViewRoute | RetainRoute
type Route = { kind: RouteKind, source: str, ownerKey: str }
type Broker = { issued: int, owner: int, ownerKey: str, requests: List[BrokerRequest], subscribed: bool, retained: bool, route: Route, staleSettled: bool }
type CtlPhase = ShowingMethods | QueuedMethod | NativeMethod
type CleanupState = NoCleanup | CleanupWaiting | CleanupFailed
type CleanupIntent = NoIntent | ChooseIntent | LeaveIntent | AbortIntent | DispatchIntent
type Cleanup = { request: int, cleanupState: CleanupState, intent: CleanupIntent }
type CancelReceipt = { request: int, before: int, after: int }
type Controller = { mounted: bool, issued: int, request: int, phase: CtlPhase, native: int, cleanup: Cleanup, detached: Set[int], receipt: CancelReceipt }
type ResendStage = CodeStage | SendingStage | VerifyingStage | AuthenticatedStage | CancellingStage | RetiredStage
type Delivery = NotSent | SentResend | AdmittedResend | RefusedResend | DroppedResend
type ResendReceipt = { scope: int, before: int, after: int }
type VerifiedOutcome = { verifiedStep: int, verified: int, echo: int }
type Resend = { live: int, displayed: int, verifying: int, stage: ResendStage, delivery: Delivery, known: Set[int], pending: Set[int],
  fenced: bool, receipt: ResendReceipt, outcome: VerifiedOutcome, lateAdmission: bool }
type SignIn = { code: CodeVerification, broker: Broker, controller: Controller, resend: Resend }
pure val noWork: Work = { owner: 0, rpc: 0, stage: WorkIdle }
pure val noRoute: Route = { kind: NoRoute, source: "", ownerKey: "" }
pure val noCleanup: Cleanup = { request: 0, cleanupState: NoCleanup, intent: NoIntent }
pure val noCancelReceipt: CancelReceipt = { request: 0, before: 0, after: 0 }
pure val originalRequest = 1
pure val resendRequest = 2
pure val foreignRequest = 3
pure val noResendReceipt: ResendReceipt = { scope: 0, before: 0, after: 0 }
pure val noOutcome: VerifiedOutcome = { verifiedStep: 0, verified: 0, echo: 0 }
pure val initial: SignIn = {
  code: { generation: 0, channel: NoChannel, factor: NoFactor, sending: false, expired: false, failed: 0, issued: 0, waiter: 0, work: noWork, replied: List() },
  broker: { issued: 0, owner: 0, ownerKey: "", requests: List(), subscribed: false, retained: false, route: noRoute, staleSettled: false },
  controller: { mounted: true, issued: 0, request: 0, phase: ShowingMethods, native: 0, cleanup: noCleanup, detached: Set(), receipt: noCancelReceipt },
  resend: { live: originalRequest, displayed: originalRequest, verifying: 0, stage: CodeStage, delivery: NotSent, known: Set(originalRequest),
    pending: Set(), fenced: false, receipt: noResendReceipt, outcome: noOutcome, lateAdmission: false } }
pure def withReply(rpc: int, c: CodeVerification): CodeVerification = { ...c, replied: c.replied.append(rpc) }
pure def retired(c: CodeVerification): CodeVerification =
  { ...c, channel: NoChannel, factor: NoFactor, sending: false, expired: false, failed: 0, waiter: 0 }
pure def ownsWork(c: CodeVerification): bool = c.work.rpc != 0 and c.work.rpc == c.waiter and c.work.owner == c.generation
pure def canStartCode(s: SignIn, channel: Channel): bool = s.code.waiter == 0 and not(s.code.sending) and channel != NoChannel
pure def startCode(s: SignIn, channel: Channel): SignIn =
  { ...s, code: { ...s.code, generation: s.code.generation + 1, channel: channel, factor: NoFactor, sending: true, expired: false, failed: 0 } }
pure def canCodeSent(s: SignIn): bool = s.code.sending and s.code.work == noWork
pure def codeSent(s: SignIn): SignIn = { ...s, code: { ...s.code, sending: false } }
pure def canExpireCode(s: SignIn): bool = s.code.channel != NoChannel and not(s.code.sending) and not(s.code.expired)
pure def expireCode(s: SignIn): SignIn = { ...s, code: { ...s.code, expired: true } }
pure def verifyCode(c: CodeVerification, attempt: int, target: VerifyTarget): CodeVerification = {
  val ownsAttempt = c.channel != NoChannel and attempt == c.generation and c.waiter == 0 and not(c.sending)
  val rightChannel = target == VerifyFactor or (target == VerifyEmail and c.channel == EmailChannel) or (target == VerifyPhone and c.channel == PhoneChannel)
  val rightStep = if (target == VerifyFactor) c.factor == TotpFactor or c.factor == SmsFactor else c.factor == NoFactor
  if (not(ownsAttempt and rightChannel)) c
  else if (c.expired) retired(c)
  else if (rightStep) { ...c, issued: c.issued + 1, waiter: c.issued + 1 }
  else c
}
pure def verify(s: SignIn, attempt: int, target: VerifyTarget): SignIn = { ...s, code: verifyCode(s.code, attempt, target) }
pure def cancelCode(c: CodeVerification, attempt: int): CodeVerification =
  if (c.channel == NoChannel or (attempt != 0 and attempt != c.generation)) c
  else if (c.waiter == 0) retired(c) else retired(withReply(c.waiter, c))
pure def cancelAttempt(s: SignIn, attempt: int): SignIn = { ...s, code: cancelCode(s.code, attempt) }
pure def canStartWork(s: SignIn): bool = s.code.work == noWork and s.code.waiter != 0
pure def startWork(s: SignIn): SignIn = { ...s, code: { ...s.code, work: { owner: s.code.generation, rpc: s.code.waiter, stage: Checking } } }
pure def canWrongCode(s: SignIn): bool = s.code.work.stage == Checking and ownsWork(s.code)
pure def wrongCode(s: SignIn): SignIn = { ...s, code:
  if (s.code.failed == 4) retired(withReply(s.code.waiter, { ...s.code, work: noWork }))
  else { ...s.code, failed: s.code.failed + 1, waiter: 0, work: { ...s.code.work, stage: InvalidReply } } }
pure def canNoAnswer(s: SignIn): bool = s.code.work.stage == Checking and ownsWork(s.code)
pure def noAnswer(s: SignIn): SignIn = { ...s, code: { ...s.code, waiter: 0, work: { ...s.code.work, stage: InvalidReply } } }
pure def canDeliverRetryReply(s: SignIn): bool = s.code.work.stage == InvalidReply
pure def deliverRetryReply(s: SignIn): SignIn = { ...s, code: withReply(s.code.work.rpc, { ...s.code, work: noWork }) }
pure def canFinishTerminal(s: SignIn): bool = s.code.work.stage == Checking or s.code.work.stage == Granting
pure def finishTerminal(s: SignIn): SignIn = { ...s, code:
  if (ownsWork(s.code)) retired(withReply(s.code.waiter, { ...s.code, work: noWork })) else { ...s.code, work: noWork } }
pure val attemptValues = Set(0, 1, 2)
pure def repliesTo(c: CodeVerification, rpc: int): int = c.replied.select(r => r == rpc).length()
pure def detachedRpc(c: CodeVerification): int = if (c.work.stage == InvalidReply) c.work.rpc else 0
pure def alwaysAtMostOneReply(s: SignIn): bool = s.code.replied.every(r => r >= 1 and r <= s.code.issued and repliesTo(s.code, r) == 1)
pure def alwaysPendingHasOneOwner(s: SignIn): bool = {
  val c = s.code
  val owners = (if (c.waiter != 0) 1 else 0) + (if (detachedRpc(c) != 0) 1 else 0)
  c.issued - c.replied.length() == owners and (c.waiter == 0 or (c.waiter != detachedRpc(c) and c.waiter <= c.issued and repliesTo(c, c.waiter) == 0)) and
    (detachedRpc(c) == 0 or (detachedRpc(c) <= c.issued and repliesTo(c, detachedRpc(c)) == 0))
}
pure def alwaysWaiterHasReadyAttempt(s: SignIn): bool = s.code.waiter != 0 implies (s.code.channel != NoChannel and not(s.code.sending))
pure def alwaysWorkOwnsItsCall(s: SignIn): bool =
  (s.code.work.stage == WorkIdle) == (s.code.work == noWork) and (s.code.work.stage == Checking or s.code.work.stage == Granting implies s.code.work.rpc != 0)
pure def sometimesRetryWhileReplyDetached(s: SignIn): bool = s.code.waiter != 0 and detachedRpc(s.code) != 0
```

### Wrong codes are bounded per step, and an unanswered request keeps the step

Each code or factor step allows five invalid codes; the fifth retires the
attempt. A request that got no answer may still have carried the right
code, so it does not use the budget. A required second factor starts a
fresh budget; a passkey factor is not supported here. Only a current,
unexpired attempt hands its grant to the native consent gate, and an
expired code retires the attempt instead of reaching the worker.

```quint
pure def canRequireFactor(s: SignIn, factor: Factor): bool =
  s.code.work.stage == Checking and ownsWork(s.code) and s.code.factor == NoFactor and factor != NoFactor
pure def requireFactor(s: SignIn, factor: Factor): SignIn =
  { ...s, code: withReply(s.code.waiter, { ...s.code, work: noWork, factor: factor, failed: 0, waiter: 0 }) }
pure def canHandoffGrant(s: SignIn): bool = s.code.work.stage == Checking and ownsWork(s.code) and not(s.code.expired)
pure def handoffGrant(s: SignIn): SignIn = { ...s, code: { ...s.code, work: { ...s.code.work, stage: Granting } } }
pure def alwaysAttemptBudget(s: SignIn): bool = s.code.failed >= 0 and s.code.failed <= 4
pure def alwaysGrantOnlyForCurrentAttempt(s: SignIn): bool = s.code.work.stage == Granting implies s.code.work.owner >= 1
pure def sometimesFactorAfterCode(s: SignIn): bool = s.code.factor != NoFactor and s.code.channel != NoChannel
pure def sometimesGrantHandedOff(s: SignIn): bool = s.code.work.stage == Granting and ownsWork(s.code)
pure def sometimesWrongCodesCounted(s: SignIn): bool = s.code.failed >= 2
pure val weight_startCode = 8
pure val weight_codeSent = 8
pure val weight_verify = 8
pure val weight_startWork = 8
pure val weight_wrongCode = 8
pure val weight_noAnswer = 8
pure val weight_deliverRetryReply = 8
pure val weight_finishTerminal = 8
pure val weight_requireFactor = 8
pure val weight_handoffGrant = 8
```

## Story: Return a native result only to the renderer request that asked for it

> As a person signing in, I want the result of the native screens to reach
> the sign-in I started, even if the app view was re-created meanwhile,
> and never a sign-in I abandoned.

### One renderer request is open at a time, and a retired request cannot settle

A request takes a fresh id and names its deployment and port. A second
request for the same deployment and port joins the open one; another pair
is refused as busy without taking an id. Settling or abandoning closes the
request. An activation callback that finishes after its request was
retired, or after it was aborted, settles nothing: the caller retries with
a fresh signal on the same request.

```quint
pure val keyValues = Set("production:A", "staging:A", "production:B", "production:default")
pure val idValues = Set(1, 2, 3)
pure def requestAt(b: Broker, id: int): BrokerRequest =
  b.requests.select(r => r.id == id).nthOr(0, { id: 0, key: "", outcome: RequestRejected, callback: CallbackIdle })
pure def withRequest(id: int, update: BrokerRequest, b: Broker): Broker =
  { ...b, requests: b.requests.listMap(r => if (r.id == id) update else r) }
pure def closedBroker(id: int, outcome: BrokerOutcome, b: Broker): Broker =
  if (b.owner == id) { ...withRequest(id, { ...requestAt(b, id), outcome: outcome }, b), owner: 0, ownerKey: "", subscribed: false, retained: false }
  else b
pure def canOpenRequest(s: SignIn): bool = s.broker.owner == 0
pure def openRequest(s: SignIn, key: str): SignIn = { ...s, broker: { ...s.broker, issued: s.broker.issued + 1, owner: s.broker.issued + 1, ownerKey: key,
  requests: s.broker.requests.append({ id: s.broker.issued + 1, key: key, outcome: RequestPending, callback: CallbackIdle }) } }
pure def canRequestWhileOpen(s: SignIn): bool = s.broker.owner != 0
pure def requestWhileOpen(s: SignIn, key: str): SignIn =
  { ...s, broker: { ...s.broker, route: { kind: if (key == s.broker.ownerKey) JoinRoute else BusyRoute, source: key, ownerKey: s.broker.ownerKey } } }
pure def canSettle(s: SignIn, id: int, resolved: bool): bool = s.broker.owner == id
pure def settle(s: SignIn, id: int, resolved: bool): SignIn =
  { ...s, broker: closedBroker(id, if (resolved) RequestResolved else RequestRejected, s.broker) }
pure def canBeginActivation(s: SignIn, id: int): bool = s.broker.owner == id and requestAt(s.broker, id).callback == CallbackIdle
pure def beginActivation(s: SignIn, id: int): SignIn = { ...s, broker: withRequest(id, { ...requestAt(s.broker, id), callback: CallbackRunning }, s.broker) }
pure def canCancelActivation(s: SignIn, id: int): bool = requestAt(s.broker, id).callback == CallbackRunning
pure def cancelActivation(s: SignIn, id: int): SignIn = { ...s, broker: withRequest(id, { ...requestAt(s.broker, id), callback: CallbackAborted }, s.broker) }
pure def canFinishActivation(s: SignIn, id: int): bool = requestAt(s.broker, id).id == id and requestAt(s.broker, id).callback != CallbackIdle
pure def finishActivation(s: SignIn, id: int, accepted: bool): SignIn = {
  val retiredRequest = s.broker.owner != id or requestAt(s.broker, id).callback == CallbackAborted
  val finished = withRequest(id, { ...requestAt(s.broker, id), callback: CallbackIdle }, s.broker)
  val updated = if (accepted and not(retiredRequest)) closedBroker(id, RequestResolved, finished) else finished
  { ...s, broker: { ...updated, staleSettled: s.broker.staleSettled or (retiredRequest and requestAt(updated, id).outcome != requestAt(s.broker, id).outcome) } }
}
pure def alwaysOneOpenRequest(s: SignIn): bool = {
  val b = s.broker
  b.requests.every(r => (r.outcome == RequestPending) == (r.id == b.owner)) and b.requests.length() == b.issued and
    b.requests.every(r => r.id >= 1 and r.id <= b.issued and b.requests.select(o => o.id == r.id).length() == 1) and
    ((b.owner == 0 and b.ownerKey == "") or (b.owner >= 1 and b.owner <= b.issued and b.ownerKey != ""))
}
pure def alwaysRetiredRequestCannotSettle(s: SignIn): bool = not(s.broker.staleSettled)
pure def sometimesRetiredCallbackFinished(s: SignIn): bool = s.broker.issued == 2 and requestAt(s.broker, 1).outcome == RequestRejected and s.broker.owner == 2
```

### A native return reaches only the open request with the matching deployment and port

The native event arrives already parsed for the listener's deployment;
an omitted port joins only another omitted port and its events arrive on
the default port. A matching return goes to the subscribed view, or is
held until the view subscribes; a return for another deployment or port is
a cold return and never reaches the open request.

```quint
pure val sourceValues = Set("production:A", "staging:A", "production:B")
pure def eventKey(key: str): str = if (key == "production:default") "production:A" else key
pure def nativeReturn(s: SignIn, source: str): SignIn = {
  val expected = eventKey(s.broker.ownerKey)
  val kind = if (not(s.broker.owner != 0 and source == expected)) ColdRoute else if (s.broker.subscribed) ViewRoute else RetainRoute
  { ...s, broker: { ...s.broker, retained: s.broker.retained or kind == RetainRoute, route: { kind: kind, source: source, ownerKey: expected } } }
}
pure def canSubscribe(s: SignIn, id: int): bool = s.broker.owner == id
pure def subscribe(s: SignIn, id: int): SignIn = { ...s, broker: { ...s.broker, subscribed: true, retained: false,
  route: if (s.broker.retained) { kind: ViewRoute, source: eventKey(s.broker.ownerKey), ownerKey: eventKey(s.broker.ownerKey) } else s.broker.route } }
pure def canUnsubscribe(s: SignIn, id: int): bool = s.broker.owner == id
pure def unsubscribe(s: SignIn, id: int): SignIn = { ...s, broker: { ...s.broker, subscribed: false } }
pure def alwaysReturnUsesMatchingOwner(s: SignIn): bool =
  ((s.broker.route.kind == ViewRoute or s.broker.route.kind == RetainRoute or s.broker.route.kind == JoinRoute) implies s.broker.route.source == s.broker.route.ownerKey) and
    ((s.broker.route.kind == ColdRoute or s.broker.route.kind == BusyRoute) implies s.broker.route.source != s.broker.route.ownerKey) and
    (s.broker.retained implies (s.broker.owner != 0 and not(s.broker.subscribed)))
pure def sometimesRetainedReturnDelivered(s: SignIn): bool = s.broker.route.kind == ViewRoute and s.broker.subscribed
```

## Story: Cancel exactly the sign-in I am leaving

> As a person who leaves or restarts sign-in, I want only my own attempt
> cancelled, never a newer one that another screen already started.

### A scoped cancel retires only its own request, and a stale one changes nothing

The controller gives each dispatched operation a request id; the Android
port refuses a new one while another request owns its slot. A cancel
names the request it captured. Its acknowledgement clears the native slot
only when the slot still holds that request; a late cancel for an older
request leaves a newer one alone. A failed cancel is retried before the
next dispatch. Disposing the controller shares the cancellation in flight
and does not wait for it, and work that was only queued owns no native
attempt.

```quint
pure def canReopen(s: SignIn): bool = not(s.controller.mounted)
pure def reopen(s: SignIn): SignIn = { ...s, controller: { ...s.controller, mounted: true, phase: ShowingMethods } }
pure def canQueueMethod(s: SignIn): bool = {
  val c = s.controller
  c.mounted and c.phase == ShowingMethods and c.cleanup.cleanupState != CleanupWaiting and (c.request == 0 or c.cleanup.cleanupState == CleanupFailed)
}
pure def queueMethod(s: SignIn): SignIn = { ...s, controller: { ...s.controller, phase: QueuedMethod,
  cleanup: if (s.controller.cleanup.cleanupState == CleanupFailed) { ...s.controller.cleanup, cleanupState: CleanupWaiting, intent: DispatchIntent } else noCleanup } }
pure def canAdmitMethod(s: SignIn): bool =
  s.controller.mounted and s.controller.phase == QueuedMethod and s.controller.request == 0 and s.controller.cleanup == noCleanup
pure def admitMethod(s: SignIn): SignIn = { ...s, controller: { ...s.controller, issued: s.controller.issued + 1, request: s.controller.issued + 1,
  phase: if (s.controller.native == 0) NativeMethod else ShowingMethods,
  native: if (s.controller.native == 0) s.controller.issued + 1 else s.controller.native } }
pure def canRejectAdmission(s: SignIn): bool = canAdmitMethod(s)
pure def rejectAdmission(s: SignIn): SignIn = { ...s, controller: { ...s.controller, phase: ShowingMethods } }
pure def canNativeReply(s: SignIn): bool = s.controller.phase == NativeMethod and s.controller.cleanup == noCleanup
pure def nativeReply(s: SignIn): SignIn = { ...s, controller: { ...s.controller, phase: ShowingMethods } }
pure def canNativeEnds(s: SignIn): bool = s.controller.native != 0
pure def nativeEnds(s: SignIn): SignIn = { ...s, controller: { ...s.controller, native: 0 } }
pure def scopeCancel(native: int, req: int): int = if (native == req) 0 else native
pure def canBeginCleanup(s: SignIn, intent: CleanupIntent): bool =
  s.controller.mounted and s.controller.cleanup.cleanupState != CleanupWaiting and intent != NoIntent and intent != DispatchIntent and
    (intent != AbortIntent or s.controller.phase == QueuedMethod or s.controller.phase == NativeMethod)
pure def beginCleanup(s: SignIn, intent: CleanupIntent): SignIn = { ...s, controller:
  if (s.controller.request == 0) { ...s.controller, mounted: intent != LeaveIntent, phase: ShowingMethods }
  else { ...s.controller, phase: ShowingMethods, cleanup: { request: s.controller.request, cleanupState: CleanupWaiting, intent: intent } } }
pure def canCleanupReply(s: SignIn, req: int, acknowledged: bool): bool =
  s.controller.cleanup.cleanupState == CleanupWaiting and s.controller.cleanup.request == req
pure def cleanupReply(s: SignIn, req: int, acknowledged: bool): SignIn = { ...s, controller:
  if (acknowledged) { ...s.controller, request: 0, native: scopeCancel(s.controller.native, req),
    receipt: { request: req, before: s.controller.native, after: scopeCancel(s.controller.native, req) },
    mounted: s.controller.cleanup.intent != LeaveIntent, cleanup: noCleanup }
  else { ...s.controller, phase: ShowingMethods, cleanup: { ...s.controller.cleanup, cleanupState: CleanupFailed } } }
pure def canDispose(s: SignIn): bool = s.controller.mounted
pure def dispose(s: SignIn): SignIn = { ...s, controller: { ...s.controller, mounted: false, request: 0, phase: ShowingMethods, cleanup: noCleanup,
  detached: if (s.controller.request == 0) s.controller.detached else s.controller.detached.union(Set(s.controller.request)) } }
pure def canDetachedReply(s: SignIn, req: int, acknowledged: bool): bool = s.controller.detached.contains(req)
pure def detachedReply(s: SignIn, req: int, acknowledged: bool): SignIn = { ...s, controller: { ...s.controller,
  detached: s.controller.detached.exclude(Set(req)),
  native: if (acknowledged) scopeCancel(s.controller.native, req) else s.controller.native,
  receipt: if (acknowledged) { request: req, before: s.controller.native, after: scopeCancel(s.controller.native, req) } else s.controller.receipt } }
pure val reqValues = Set(1, 2, 3)
pure def alwaysDispatchOwnsRequest(s: SignIn): bool = {
  val c = s.controller
  c.request >= 0 and c.request <= c.issued and c.native >= 0 and c.native <= c.issued and c.detached.forall(d => d >= 1 and d <= c.issued) and
    (not(c.mounted) implies (c.request == 0 and c.cleanup == noCleanup)) and (c.phase == NativeMethod implies c.request != 0) and
    not(c.detached.contains(c.request))
}
pure def alwaysCancellationKeepsItsFence(s: SignIn): bool =
  (s.controller.cleanup.cleanupState != NoCleanup implies (s.controller.mounted and s.controller.cleanup.request != 0 and s.controller.cleanup.request == s.controller.request)) and
    ((s.controller.phase == QueuedMethod and s.controller.request != 0) implies (s.controller.cleanup.cleanupState == CleanupWaiting and s.controller.cleanup.intent == DispatchIntent)) and
    (s.controller.cleanup.cleanupState == CleanupFailed implies s.controller.phase == ShowingMethods)
pure def alwaysScopedReceiptPreservesForeignAttempt(s: SignIn): bool = {
  val r = s.controller.receipt
  if (r.request == 0) r == noCancelReceipt else r.after == (if (r.before == r.request) 0 else r.before)
}
pure def sometimesLateCancelSparedNewerRequest(s: SignIn): bool =
  s.controller.receipt.request != 0 and s.controller.receipt.before != s.controller.receipt.request and s.controller.receipt.after != 0
pure def sometimesFailedCancelRetried(s: SignIn): bool = s.controller.cleanup.intent == DispatchIntent
pure val weight_reopen = 5
pure val weight_queueMethod = 5
pure val weight_admitMethod = 5
pure val weight_nativeEnds = 5
pure val weight_dispose = 5
pure val weight_detachedReply = 5
```

### After a resend, verification and cancellation follow the request Android admitted

A resend starts a second native request; an absent or refused reply does
not say which request owns Android's single slot. The code screen verifies
the request it displays, and a result counts only for the request that is
live, with an echo naming it or none. Cancellation fences both requests
and retires each only on its own acknowledged cancel; a missing
acknowledgement is retried for that request alone. The bridge delivers a
request's start before its cancel, so a resend is never admitted after
cancellation retired the sign-in.

```quint
pure def resendDelivered(r: Resend): bool = r.delivery != SentResend
pure def canSendResend(s: SignIn): bool = s.resend.stage == CodeStage and not(s.resend.fenced) and s.resend.delivery == NotSent
pure def sendResend(s: SignIn): SignIn = { ...s, resend: { ...s.resend, stage: SendingStage, delivery: SentResend, known: s.resend.known.union(Set(resendRequest)) } }
pure def canDeliverResend(s: SignIn, admitted: bool): bool = s.resend.delivery == SentResend
pure def deliverResend(s: SignIn, admitted: bool): SignIn = { ...s, resend: { ...s.resend, delivery: if (admitted) AdmittedResend else RefusedResend,
  live: if (admitted) resendRequest else s.resend.live, lateAdmission: s.resend.lateAdmission or (admitted and s.resend.stage == RetiredStage) } }
pure def canDropResend(s: SignIn): bool = s.resend.delivery == SentResend
pure def dropResend(s: SignIn): SignIn = { ...s, resend: { ...s.resend, delivery: DroppedResend } }
pure def canLoseResendReply(s: SignIn): bool = s.resend.stage == SendingStage
pure def loseResendReply(s: SignIn): SignIn = { ...s, resend: { ...s.resend, stage: CodeStage } }
pure def canAcceptResendReply(s: SignIn): bool = s.resend.stage == SendingStage and s.resend.delivery == AdmittedResend and not(s.resend.fenced)
pure def acceptResendReply(s: SignIn): SignIn = { ...s, resend: { ...s.resend, stage: CodeStage, displayed: resendRequest } }
pure def canVerifyDisplayed(s: SignIn): bool = s.resend.stage == CodeStage and not(s.resend.fenced) and s.resend.known.contains(s.resend.displayed)
pure def verifyDisplayed(s: SignIn): SignIn = { ...s, resend: { ...s.resend, stage: VerifyingStage, verifying: s.resend.displayed } }
pure def authenticatedBy(echo: int, r: Resend): Resend =
  { ...r, stage: AuthenticatedStage, live: 0, outcome: { verifiedStep: r.displayed, verified: r.verifying, echo: echo } }
pure def canVerifyReply(s: SignIn, echo: int): bool = s.resend.stage == VerifyingStage and not(s.resend.fenced) and resendDelivered(s.resend)
pure def verifyReply(s: SignIn, echo: int): SignIn = { ...s, resend:
  if (s.resend.live == s.resend.verifying and (echo == 0 or echo == s.resend.verifying)) authenticatedBy(echo, s.resend)
  else { ...s.resend, stage: CodeStage, verifying: 0 } }
pure def canRetainedReply(s: SignIn, echo: int): bool =
  s.resend.stage == VerifyingStage and not(s.resend.fenced) and resendDelivered(s.resend) and s.resend.live == s.resend.verifying and echo == s.resend.verifying
pure def retainedReply(s: SignIn, echo: int): SignIn = { ...s, resend: authenticatedBy(echo, s.resend) }
pure def canBeginCancellation(s: SignIn): bool =
  s.resend.stage != RetiredStage and s.resend.stage != AuthenticatedStage and s.resend.known.size() > 0 and s.resend.pending.size() == 0
pure def beginCancellation(s: SignIn): SignIn = { ...s, resend: { ...s.resend, stage: CancellingStage, pending: s.resend.known, fenced: true, verifying: 0 } }
pure def canCancelReply(s: SignIn, scope: int, acknowledged: bool): bool =
  s.resend.pending.contains(scope) and (not(acknowledged) or scope != resendRequest or resendDelivered(s.resend))
pure def cancelReply(s: SignIn, scope: int, acknowledged: bool): SignIn = {
  val known = if (acknowledged) s.resend.known.exclude(Set(scope)) else s.resend.known
  val after = if (acknowledged and s.resend.live == scope) 0 else s.resend.live
  { ...s, resend: { ...s.resend, pending: s.resend.pending.exclude(Set(scope)), known: known, live: after,
    stage: if (known.size() == 0) RetiredStage else CancellingStage, fenced: known.size() > 0,
    receipt: if (acknowledged) { scope: scope, before: s.resend.live, after: after } else s.resend.receipt } }
}
pure def canFinishNative(s: SignIn): bool = s.resend.live == originalRequest or s.resend.live == resendRequest
pure def finishNative(s: SignIn): SignIn = { ...s, resend: { ...s.resend, live: 0 } }
pure def canForeignStarts(s: SignIn): bool = s.resend.live == 0
pure def foreignStarts(s: SignIn): SignIn = { ...s, resend: { ...s.resend, live: foreignRequest } }
pure val echoValues = Set(0, 1, 2, 3)
pure val scopeValues = Set(1, 2)
pure def alwaysRetirementRequiresReceipts(s: SignIn): bool = {
  val r = s.resend
  r.known.forall(k => k == originalRequest or k == resendRequest) and r.pending.subseteq(r.known) and
    (r.fenced implies (r.stage == CancellingStage and r.known.size() > 0)) and
    (r.stage == RetiredStage implies (r.known.size() == 0 and r.pending.size() == 0 and r.live != originalRequest and r.live != resendRequest))
}
pure def alwaysScopedResendReceipt(s: SignIn): bool = {
  val r = s.resend.receipt
  if (r.scope == 0) r == noResendReceipt else r.after == (if (r.before == r.scope) 0 else r.before)
}
pure def alwaysVerificationUsesDisplayedOwner(s: SignIn): bool =
  (s.resend.stage == VerifyingStage implies s.resend.verifying == s.resend.displayed) and
    (s.resend.outcome != noOutcome implies (s.resend.outcome.verifiedStep == s.resend.outcome.verified and (s.resend.outcome.echo == 0 or s.resend.outcome.echo == s.resend.outcome.verified)))
pure def alwaysNoLateAdmission(s: SignIn): bool = not(s.resend.lateAdmission)
pure def sometimesResendAuthenticated(s: SignIn): bool = s.resend.stage == AuthenticatedStage and s.resend.outcome.verified == resendRequest
pure def sometimesPartialCleanupKeepsResend(s: SignIn): bool = s.resend.fenced and s.resend.known.size() == 1 and s.resend.known.contains(resendRequest)
pure def sometimesCancellationRetired(s: SignIn): bool = s.resend.stage == RetiredStage
pure val weight_sendResend = 5
pure val weight_deliverResend = 5
pure val weight_acceptResendReply = 5
pure val weight_verifyDisplayed = 5
pure val weight_verifyReply = 5
pure val weight_retainedReply = 5
```
