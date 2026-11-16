# Embedded website command receiver

The native website guide can drive the embedded WebView through this
receiver when the owned Chromium is unavailable or the embedded page is
the selected surface. [Website command transport](../../agent/nativeHost/surfaceChannel.md)
owns channel delivery, and the consumer's website guidance owns decisions
and consent. This spec owns the receiver's admission, its exact native
observation and its effect receipt.

## Story: Receive a copied command for the selected page and its current task

> As the person, I want the guide to act only on the page I selected and
> only for the task I approved, so that a stale, forged or replayed
> command never touches a website.

### The receiver admits only fixed commands and keeps a separate binding queue

The receiver copies its input before queuing it. A task binding runs on
its own queue; current-page, task-guide and page commands share a serial
queue, and either continues after an earlier failure. A page command
needs its exact envelope, a task context, a valid page ID and one of the
fixed actions snapshot, click, fill, select, scroll and follow; anything
else is blocked by policy, and a protected-value fill or a caller-supplied
policy bypass is refused. Current-page takes only its type and ID and
reports the selected page's ID, HTTPS origin and title, or none for a
missing, non-HTTPS or credential-bearing page. A task-guide reply that
offers answers or approval UI is unsupported: answers belong to the
trusted host.

```quint
type ReceivedKind = TaskBind | CurrentPageRequest | TaskGuide | PageCommandRequest | UnknownKind
type SurfaceAction = SnapshotAction | ClickAction | FillAction | SelectAction | ScrollAction | FollowAction | OtherAction
type SurfaceRoute = RouteBindingQueue | RouteReadPage | RouteGuideCodec | RoutePageCommand | RouteStale | RouteInvalid | RouteUnsupported | RouteBlocked
type SurfaceRequest = { kind: ReceivedKind, idValid: bool, exactEnvelope: bool, commandObject: bool, commandKeys: bool, pageIdValid: bool, hasTask: bool, subaction: SurfaceAction, offerUi: bool }
pure def surfaceRequest(req: SurfaceRequest, alive: bool): SurfaceRoute =
  if (req.kind == TaskBind) RouteBindingQueue
  else if (not(alive)) RouteStale
  else if (not(req.idValid)) RouteInvalid
  else if (req.kind == CurrentPageRequest) (if (req.exactEnvelope) RouteReadPage else RouteInvalid)
  else if (req.kind == TaskGuide) (if (req.offerUi) RouteUnsupported else RouteGuideCodec)
  else if (req.kind != PageCommandRequest or not(req.exactEnvelope)) RouteInvalid
  else if (not(req.commandObject and req.commandKeys and req.pageIdValid and req.hasTask and req.subaction != OtherAction)) RouteBlocked
  else RoutePageCommand
type PageReport = PageNone | PageStale | PageParseError | PageReported
type CurrentPage = { selected: bool, leaseCurrent: bool, pageIdValid: bool, parsed: bool, https: bool, noCredentials: bool }
pure def currentPageReceipt(pageFacts: CurrentPage, aliveAfter: bool): PageReport =
  if (not(aliveAfter)) PageStale
  else if (not(pageFacts.selected)) PageNone
  else if (not(pageFacts.pageIdValid and pageFacts.leaseCurrent)) PageStale
  else if (not(pageFacts.parsed)) PageParseError
  else if (not(pageFacts.https and pageFacts.noCredentials)) PageNone
  else PageReported
pure def lawNoSurfaceApprovalUi(req: SurfaceRequest, alive: bool): bool =
  alive and req.idValid and req.kind == TaskGuide and req.offerUi implies surfaceRequest(req, alive) == RouteUnsupported
pure def lawPageCommandNeedsTaskKeysAndListedAction(req: SurfaceRequest, alive: bool): bool =
  surfaceRequest(req, alive) == RoutePageCommand implies req.hasTask and req.commandKeys and req.subaction != OtherAction
pure val supportedRequest: SurfaceRequest = { kind: PageCommandRequest, idValid: true, exactEnvelope: true, commandObject: true, commandKeys: true, pageIdValid: true, hasTask: true, subaction: SnapshotAction, offerUi: false }
pure val reqValues = Set(supportedRequest, { ...supportedRequest, idValid: false }, { ...supportedRequest, exactEnvelope: false }, { ...supportedRequest, commandKeys: false }, { ...supportedRequest, hasTask: false }, { ...supportedRequest, subaction: OtherAction }, { ...supportedRequest, kind: TaskBind }, { ...supportedRequest, kind: CurrentPageRequest }, { ...supportedRequest, kind: TaskGuide, offerUi: true })
pure val selectedPage: CurrentPage = { selected: true, leaseCurrent: true, pageIdValid: true, parsed: true, https: true, noCredentials: true }
pure val pageFactsValues = Set(selectedPage, { ...selectedPage, selected: false }, { ...selectedPage, leaseCurrent: false }, { ...selectedPage, pageIdValid: false }, { ...selectedPage, parsed: false }, { ...selectedPage, https: false }, { ...selectedPage, noCredentials: false })
```

### Binding replacement fences the old page before cleanup and never revives an older binding

A task binding has an exact envelope, an owner and task context, an
epoch, a revision, a future expiry, its authorized HTTPS origins and its
reviewed targets. A replacement needs a greater revision, even for
another task; for the same task a lower epoch is refused, and the same
epoch is allowed only to renew an expired, unrevoked binding with an
identical context, never to revoke it. An admitted replacement installs a
revoked copy and drops the observation before awaiting cleanup, then
records the replacement and rechecks the receiver before making it
available; a failure after that fence never restores the old binding. A
scoped command needs the exact context, the same live binding, an
effective deadline (the earlier of the command's and the binding's) still
ahead, an allowed current origin and, when it names one, a reviewed
target. An owner-bound hide or pause may pass after expiry or an origin
change, and grants no action.

```quint
type BindingRequest = { validEnvelope: bool, activeReceiver: bool, previous: bool, sameTask: bool, priorRevoked: bool, priorExpired: bool, newRevoked: bool, exactRenewal: bool, newRevision: int, oldRevision: int, newEpoch: int, oldEpoch: int }
type BindingReceipt = BindingBlocked | ReplacementFenced | BindingUnbound | BindingBound
pure def renewBinding(reqBind: BindingRequest): bool =
  reqBind.previous and reqBind.sameTask and reqBind.priorExpired and not(reqBind.priorRevoked or reqBind.newRevoked) and reqBind.exactRenewal
pure def bindingAdmitted(reqBind: BindingRequest): bool =
  reqBind.validEnvelope and reqBind.activeReceiver and
  (not(reqBind.previous) or (reqBind.newRevision > reqBind.oldRevision and
   (not(reqBind.sameTask) or reqBind.newEpoch > reqBind.oldEpoch or (reqBind.newEpoch == reqBind.oldEpoch and renewBinding(reqBind)))))
pure def bindingReceipt(admitted: bool, cleanupSucceeded: bool, stored: bool, receiverStillCurrent: bool, revoked: bool): BindingReceipt =
  if (not(admitted)) BindingBlocked
  else if (not(cleanupSucceeded and stored)) ReplacementFenced
  else if (not(receiverStillCurrent)) BindingBlocked
  else if (revoked) BindingUnbound else BindingBound
type SurfaceScope = { liveBindingSame: bool, exactContext: bool, revoked: bool, bindingDeadline: int, commandDeadlinePresent: bool, commandDeadlineSafe: bool, commandDeadline: int, clock: int, originAllowed: bool, cleanup: bool, selectorSyntaxOkay: bool, reviewedTargetOrOmitted: bool }
pure def effectiveDeadline(scope: SurfaceScope): int =
  if (scope.commandDeadlinePresent and scope.commandDeadline < scope.bindingDeadline) scope.commandDeadline else scope.bindingDeadline
pure def currentScope(scope: SurfaceScope): bool =
  scope.liveBindingSame and scope.exactContext and (not(scope.commandDeadlinePresent) or (scope.commandDeadlineSafe and scope.commandDeadline > scope.clock)) and
  scope.selectorSyntaxOkay and scope.reviewedTargetOrOmitted and
  (scope.cleanup or (not(scope.revoked) and effectiveDeadline(scope) > scope.clock and scope.originAllowed))
pure def lawRevokeNeedsNewEpoch(reqBind: BindingRequest): bool =
  reqBind.previous and reqBind.sameTask and reqBind.newRevoked and reqBind.newEpoch <= reqBind.oldEpoch implies not(bindingAdmitted(reqBind))
pure def lawExpiredScopeIsCleanupOnly(scope: SurfaceScope): bool =
  currentScope(scope) and scope.bindingDeadline <= scope.clock implies scope.cleanup
pure def lawBoundNeedsCleanupStoreAndCurrentReceiver(admitted: bool, cleanupSucceeded: bool, stored: bool, receiverStillCurrent: bool, revoked: bool): bool =
  bindingReceipt(admitted, cleanupSucceeded, stored, receiverStillCurrent, revoked) == BindingBound implies
    admitted and cleanupSucceeded and stored and receiverStillCurrent and not(revoked)
pure val laterBind: BindingRequest = { validEnvelope: true, activeReceiver: true, previous: true, sameTask: true, priorRevoked: false, priorExpired: false, newRevoked: false, exactRenewal: false, newRevision: 4, oldRevision: 3, newEpoch: 2, oldEpoch: 1 }
pure val reqBindValues = Set(laterBind, { ...laterBind, newEpoch: 0 }, { ...laterBind, newEpoch: 1 }, { ...laterBind, newEpoch: 1, priorExpired: true, exactRenewal: true }, { ...laterBind, newEpoch: 1, priorExpired: true, exactRenewal: true, newRevoked: true }, { ...laterBind, newRevision: 2 }, { ...laterBind, sameTask: false, newEpoch: 0 })
pure val liveScope: SurfaceScope = { liveBindingSame: true, exactContext: true, revoked: false, bindingDeadline: 400, commandDeadlinePresent: true, commandDeadlineSafe: true, commandDeadline: 500, clock: 300, originAllowed: true, cleanup: false, selectorSyntaxOkay: true, reviewedTargetOrOmitted: true }
pure val scopeValues = Set(liveScope, { ...liveScope, bindingDeadline: 300 }, { ...liveScope, bindingDeadline: 300, cleanup: true }, { ...liveScope, revoked: true }, { ...liveScope, commandDeadline: 300 }, { ...liveScope, liveBindingSame: false }, { ...liveScope, exactContext: false }, { ...liveScope, originAllowed: false }, { ...liveScope, originAllowed: false, cleanup: true }, { ...liveScope, reviewedTargetOrOmitted: false })
```

## Story: Observe the main frame and dispatch an effect once under its exact evidence

> As the person, I want a copied command to act on the page only once,
> and only on the main frame it observed, so that a retry never clicks
> twice and a changed page is never acted on blind.

### Request identity is consumed independently of the page selector

A request ID already admitted is refused as uncertain, whatever happened
to it. The binding scope and the selected page must be current before an
ID is first recorded; a failure before recording leaves it available,
and from recording on it is spent. A snapshot drops the page's old
observation before the native read and keeps the new one only while
authority stays current and native returns a complete main-frame result
for the scoped origin; each node is then named by snapshot, main frame
and node ID.

```quint
type RequestAdmission = { idSpent: bool, scopeAllowed: bool, selectionCurrent: bool, pageMatches: bool, actorCurrent: bool }
type AdmitDecision = AdmitUncertain | AdmitBlocked | AdmitStale | AdmitAccepted
pure def admitSurfaceRequest(admitFacts: RequestAdmission): AdmitDecision =
  if (admitFacts.idSpent) AdmitUncertain
  else if (not(admitFacts.scopeAllowed)) AdmitBlocked
  else if (not(admitFacts.selectionCurrent and admitFacts.pageMatches and admitFacts.actorCurrent)) AdmitStale
  else AdmitAccepted
type SnapshotFacts = { currentAfter: bool, mainFrame: bool, documentString: bool, complete: bool, snapshotString: bool, elementArray: bool, addressParsed: bool, matchesScopedOrigin: bool }
type SnapshotReceipt = SnapshotStale | SnapshotIncomplete | SnapshotParseError | SnapshotAccepted
pure def snapshotReceipt(snapshotFacts: SnapshotFacts): SnapshotReceipt =
  if (not(snapshotFacts.currentAfter)) SnapshotStale
  else if (not(snapshotFacts.mainFrame and snapshotFacts.documentString and snapshotFacts.complete and snapshotFacts.snapshotString and snapshotFacts.elementArray)) SnapshotIncomplete
  else if (not(snapshotFacts.addressParsed)) SnapshotParseError
  else if (not(snapshotFacts.matchesScopedOrigin)) SnapshotIncomplete
  else SnapshotAccepted
pure def lawAdmittedIdentityCannotBeRetried(admitFacts: RequestAdmission): bool =
  admitFacts.idSpent implies admitSurfaceRequest(admitFacts) == AdmitUncertain
pure def lawForeignOriginSnapshotIsIncomplete(snapshotFacts: SnapshotFacts): bool =
  not(snapshotFacts.matchesScopedOrigin) implies snapshotReceipt(snapshotFacts) != SnapshotAccepted
pure val admissionOkay: RequestAdmission = { idSpent: false, scopeAllowed: true, selectionCurrent: true, pageMatches: true, actorCurrent: true }
pure val admitFactsValues = Set(admissionOkay, { ...admissionOkay, idSpent: true, scopeAllowed: false }, { ...admissionOkay, scopeAllowed: false }, { ...admissionOkay, selectionCurrent: false }, { ...admissionOkay, pageMatches: false }, { ...admissionOkay, actorCurrent: false })
pure val completeSnapshot: SnapshotFacts = { currentAfter: true, mainFrame: true, documentString: true, complete: true, snapshotString: true, elementArray: true, addressParsed: true, matchesScopedOrigin: true }
pure val snapshotFactsValues = Set(completeSnapshot, { ...completeSnapshot, currentAfter: false }, { ...completeSnapshot, mainFrame: false }, { ...completeSnapshot, complete: false }, { ...completeSnapshot, matchesScopedOrigin: false }, { ...completeSnapshot, addressParsed: false })
```

### Native input consumes the observation and cleanup never upgrades uncertainty

An effect needs the matching observation the page still holds, an exact
main-frame selector naming its snapshot, a ready guidance preview under
the same action ticket and input authority checked again before
dispatch. Dispatch removes the observation, then calls native. The effect
is received only with a current task scope, selection and feedback
ticket, the exact original document and native confirming the dispatch;
otherwise the outcome is uncertain. After a preview or attempted input
the guidance ticket is cancelled, and a failed cleanup after attempted
input is uncertain whatever native said; before input, cleanup reports
its own error. Closing the receiver retires it, drops observations and
revokes its bindings before guidance is hidden on every surface.

```quint
type PageEffect = { observationPresent: bool, observedLeaseCurrent: bool, selectorValid: bool, sameSnapshot: bool, underlyingCurrent: bool, previewReady: bool, currentBeforeDispatch: bool }
pure def eligibleSelector(effectFacts: PageEffect): bool =
  effectFacts.observationPresent and effectFacts.observedLeaseCurrent and effectFacts.selectorValid and effectFacts.sameSnapshot
pure def inputAuthorized(effectFacts: PageEffect): bool =
  eligibleSelector(effectFacts) and effectFacts.underlyingCurrent and effectFacts.previewReady and effectFacts.currentBeforeDispatch
type InputReceipt = { inputAttempted: bool, nativeReturned: bool, scopeCurrent: bool, feedbackCurrent: bool, sameDocument: bool, nativeDispatched: bool, cleanupOkay: bool }
type EffectReceipt = EffectReceived | EffectUncertain | EffectNativeError | EffectCleanupError
pure def actionReceipt(receipt: InputReceipt): EffectReceipt =
  if (not(receipt.cleanupOkay)) (if (receipt.inputAttempted) EffectUncertain else EffectCleanupError)
  else if (not(receipt.nativeReturned)) EffectNativeError
  else if (not(receipt.inputAttempted and receipt.scopeCurrent and receipt.feedbackCurrent and receipt.sameDocument and receipt.nativeDispatched)) EffectUncertain
  else EffectReceived
pure def lawCleanupCannotRelabelAttemptedInput(receipt: InputReceipt): bool =
  receipt.inputAttempted and not(receipt.cleanupOkay) implies actionReceipt(receipt) == EffectUncertain
pure def lawUncertainNativeReplyCannotSucceed(receipt: InputReceipt): bool =
  receipt.nativeReturned and not(receipt.scopeCurrent and receipt.feedbackCurrent and receipt.sameDocument and receipt.nativeDispatched) implies actionReceipt(receipt) != EffectReceived
pure val effectReady: PageEffect = { observationPresent: true, observedLeaseCurrent: true, selectorValid: true, sameSnapshot: true, underlyingCurrent: true, previewReady: true, currentBeforeDispatch: true }
pure val effectFactsValues = Set(effectReady, { ...effectReady, observationPresent: false }, { ...effectReady, sameSnapshot: false }, { ...effectReady, selectorValid: false }, { ...effectReady, observedLeaseCurrent: false }, { ...effectReady, previewReady: false }, { ...effectReady, currentBeforeDispatch: false })
pure val goodEffect: InputReceipt = { inputAttempted: true, nativeReturned: true, scopeCurrent: true, feedbackCurrent: true, sameDocument: true, nativeDispatched: true, cleanupOkay: true }
pure val receiptValues = Set(goodEffect, { ...goodEffect, nativeDispatched: false }, { ...goodEffect, inputAttempted: false, nativeReturned: false }, { ...goodEffect, sameDocument: false }, { ...goodEffect, scopeCurrent: false }, { ...goodEffect, feedbackCurrent: false }, { ...goodEffect, nativeReturned: false }, { ...goodEffect, cleanupOkay: false }, { ...goodEffect, inputAttempted: false, nativeReturned: false, cleanupOkay: false })
```

### The receiver retains spent requests through every replacement and retirement

The receiver follows one selected page and one ordinary command at a
time, with the queued copy, the spent request identities, the live
binding revision and the cached observation. A binding replacement or
retirement, even while a command awaits native input, fences the
observation without forgetting a spent identity, and a missing native
response never becomes a received effect.

```quint
type QueuedSurface = { requestId: int, isSnapshot: bool, requestedSnapshot: int }
type ReceiverPhase = ReceiverIdle | ReceiverQueued | ReceiverReading | ReceiverChecking | ReceiverDispatched
type ReceiverReceipt = NoReceipt | ReceiptUncertain | ReceiptNotAdmitted | ReceiptSnapshot | ReceiptUnconfirmedSnapshot | ReceiptStale | ReceiptEffect
type SurfaceReceiver = { closed: bool, live: bool, bindingRevision: int, replacing: bool, observedSnapshot: int, observedRevision: int, phase: ReceiverPhase, spent: List[int], queued: QueuedSurface, inputRevision: int, receipt: ReceiverReceipt }
pure val emptyCommand: QueuedSurface = { requestId: 0, isSnapshot: true, requestedSnapshot: 0 }
pure val initial: SurfaceReceiver = { closed: false, live: false, bindingRevision: 0, replacing: false, observedSnapshot: 0, observedRevision: 0, phase: ReceiverIdle, spent: List(), queued: emptyCommand, inputRevision: 0, receipt: NoReceipt }
pure def canFenceBinding(receiver: SurfaceReceiver, revision: int): bool =
  not(receiver.closed or receiver.replacing) and revision > receiver.bindingRevision
pure def fenceBinding(receiver: SurfaceReceiver, revision: int): SurfaceReceiver =
  { ...receiver, bindingRevision: revision, live: false, replacing: true, observedSnapshot: 0, observedRevision: 0 }
pure def canSettleBinding(receiver: SurfaceReceiver): bool = receiver.replacing and not(receiver.closed)
pure def settleBinding(receiver: SurfaceReceiver, keepLive: bool): SurfaceReceiver =
  { ...receiver, replacing: false, live: keepLive }
pure def canQueueSurface(receiver: SurfaceReceiver, incoming: QueuedSurface): bool =
  not(receiver.closed) and receiver.phase == ReceiverIdle and incoming.requestId > 0
pure def queueSurface(receiver: SurfaceReceiver, incoming: QueuedSurface): SurfaceReceiver =
  { ...receiver, phase: ReceiverQueued, queued: incoming, receipt: NoReceipt }
pure def canAdmitSurface(receiver: SurfaceReceiver): bool = receiver.phase == ReceiverQueued and not(receiver.closed)
pure def admitSurface(receiver: SurfaceReceiver, stillSelected: bool): SurfaceReceiver =
  if (receiver.spent.includes(receiver.queued.requestId)) { ...receiver, phase: ReceiverIdle, receipt: ReceiptUncertain }
  else if (not(receiver.live and stillSelected)) { ...receiver, phase: ReceiverIdle, receipt: ReceiptNotAdmitted }
  else if (receiver.queued.isSnapshot) { ...receiver, phase: ReceiverReading, observedSnapshot: 0, observedRevision: 0, inputRevision: receiver.bindingRevision, spent: receiver.spent.append(receiver.queued.requestId) }
  else { ...receiver, phase: ReceiverChecking, inputRevision: receiver.bindingRevision, spent: receiver.spent.append(receiver.queued.requestId) }
pure def canAcceptSnapshot(receiver: SurfaceReceiver): bool = receiver.phase == ReceiverReading
pure def acceptSnapshot(receiver: SurfaceReceiver, nativeSnapshot: int, complete: bool): SurfaceReceiver =
  if (not(receiver.closed) and receiver.live and receiver.inputRevision == receiver.bindingRevision and complete and nativeSnapshot > 0)
    { ...receiver, phase: ReceiverIdle, observedSnapshot: nativeSnapshot, observedRevision: receiver.bindingRevision, receipt: ReceiptSnapshot }
  else { ...receiver, phase: ReceiverIdle, receipt: ReceiptUnconfirmedSnapshot }
pure def canDispatchSurface(receiver: SurfaceReceiver): bool = receiver.phase == ReceiverChecking
pure def dispatchSurface(receiver: SurfaceReceiver, previewReady: bool): SurfaceReceiver =
  if (not(receiver.closed) and receiver.live and receiver.inputRevision == receiver.bindingRevision and previewReady and receiver.observedSnapshot > 0 and receiver.queued.requestedSnapshot == receiver.observedSnapshot)
    { ...receiver, phase: ReceiverDispatched, observedSnapshot: 0, observedRevision: 0 }
  else { ...receiver, phase: ReceiverIdle, receipt: ReceiptStale }
pure def canSettleInput(receiver: SurfaceReceiver): bool = receiver.phase == ReceiverDispatched
pure def settleInput(receiver: SurfaceReceiver, nativeAcknowledged: bool, cleanupOkay: bool): SurfaceReceiver =
  { ...receiver, phase: ReceiverIdle, receipt: if (not(receiver.closed) and receiver.live and receiver.inputRevision == receiver.bindingRevision and nativeAcknowledged and cleanupOkay) ReceiptEffect else ReceiptUncertain }
pure def canRetireSurface(receiver: SurfaceReceiver): bool = not(receiver.closed)
pure def retireSurface(receiver: SurfaceReceiver): SurfaceReceiver =
  { ...receiver, closed: true, live: false, observedSnapshot: 0, observedRevision: 0, replacing: false, phase: if (receiver.phase == ReceiverQueued) ReceiverIdle else receiver.phase }
pure def alwaysInProgressHasConsumedIdentity(receiver: SurfaceReceiver): bool =
  (receiver.phase == ReceiverReading or receiver.phase == ReceiverChecking or receiver.phase == ReceiverDispatched) implies receiver.spent.includes(receiver.queued.requestId)
pure def alwaysCachedObservationBelongsToBinding(receiver: SurfaceReceiver): bool =
  receiver.observedSnapshot > 0 implies receiver.live and not(receiver.closed or receiver.replacing) and receiver.observedRevision == receiver.bindingRevision
pure def alwaysDispatchedHasConsumedRequest(receiver: SurfaceReceiver): bool =
  receiver.phase == ReceiverDispatched implies receiver.spent.includes(receiver.queued.requestId) and receiver.observedSnapshot == 0
pure def stepSpentRequestsAreNeverRestored(before: SurfaceReceiver, after: SurfaceReceiver): bool =
  before.spent.every(age => after.spent.includes(age))
pure def stepRetirementDoesNotRevive(before: SurfaceReceiver, after: SurfaceReceiver): bool =
  before.closed implies after.closed and not(after.live)
pure def sometimesSnapshotCached(receiver: SurfaceReceiver): bool = receiver.observedSnapshot > 0
pure def sometimesEffectReceived(receiver: SurfaceReceiver): bool = receiver.receipt == ReceiptEffect
pure def sometimesEffectUncertain(receiver: SurfaceReceiver): bool = receiver.receipt == ReceiptUncertain
pure def sometimesDispatchedThenRetired(receiver: SurfaceReceiver): bool = receiver.phase == ReceiverDispatched and receiver.closed
pure val revisionValues = Set(1, 2, 3, 4)
pure val nativeSnapshotValues = Set(1, 2)
pure val incomingValues = Set(
  { requestId: 1, isSnapshot: true, requestedSnapshot: 0 },
  { requestId: 2, isSnapshot: false, requestedSnapshot: 1 },
  { requestId: 3, isSnapshot: false, requestedSnapshot: 2 },
  { requestId: 4, isSnapshot: true, requestedSnapshot: 0 })
pure val weight_queueSurface = 6
pure val weight_admitSurface = 6
pure val weight_acceptSnapshot = 6
pure val weight_dispatchSurface = 6
pure val weight_settleInput = 6
```

### A retired or replacing receiver holds no live binding

Discovered by the proof: without it, a receiver could be closed or
mid-replacement and still treat a binding as live, so an in-flight
command could act after its binding was fenced.

```quint
pure def alwaysInactiveWhileFenced(receiver: SurfaceReceiver): bool =
  receiver.closed or receiver.replacing implies not(receiver.live)
```
