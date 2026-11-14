# Grace embedded website command receiver

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` imports `createSurfaceTaskHandler` from Eliza `7743504b7c936a764b3938a44cad918808b621df` in `apps/app/src/embedded-browser-client.ts`. The native website guide can use this WebView receiver if the owned Chromium is unavailable or if the embedded page is the selected surface. The two browser transports have different capabilities. [Website command transport](../surfaceTransport.md) owns channel delivery. [Website guidance](websiteGuide.md) owns decisions and consent. This specification owns the embedded receiver's admission, exact native observation and effect receipt.

## Story: Receive a copied command for the selected page and its current task

### The receiver admits only fixed commands and keeps a separate binding queue

The receiver clones its entire input before queuing it. A task binding runs on the binding queue. Current-page, task-guide and page commands use a separate serial queue. Either queue can continue after an earlier failure. An incoming revoke can fence a command already awaiting native work. The host adapter allows only snapshot, click, fill, select, scroll and follow with a task context and a page ID. The embedded host refuses protected-value fills before transport. The receiver independently rejects a protected-value field and any caller-supplied policy or validation bypass. On the receiver a message ID and page ID are one through 128 permitted ASCII characters. The input decoder supplies the exact-key and ID facts.

Current-page accepts only type and ID. A missing selected page or a parsed non-HTTPS or credential-bearing address returns null. An unreadable address raises the parser error. A live selection reports page ID, normalized HTTPS origin and title. The Grace renderer limits the title to 200 units. Task-guide replies with answers or offer tone are refused; an answer belongs to the trusted host.

```quint
type SurfaceRequest = { kind: str, idValid: bool, exactEnvelope: bool, commandObject: bool, commandKeys: bool, pageIdValid: bool, hasTask: bool, subaction: str, offerUi: bool }
pure def fixedSurfaceAction(subaction: str): bool =
  Set("snapshot", "click", "fill", "select", "scroll", "follow").contains(subaction)
pure def surfaceRequest(req: SurfaceRequest, alive: bool): str =
  if (req.kind == "task-bind") "binding-queue"
  else if (not(alive)) "STALE_REF"
  else if (not(req.idValid)) "INVALID_REQUEST"
  else if (req.kind == "current-page") (if (req.exactEnvelope) "read-page" else "INVALID_REQUEST")
  else if (req.kind == "task-guide") (if (req.offerUi) "UNSUPPORTED" else "guide-codec")
  else if (req.kind != "command" or not(req.exactEnvelope)) "INVALID_REQUEST"
  else if (not(req.commandObject and req.commandKeys and req.pageIdValid and req.hasTask and fixedSurfaceAction(req.subaction))) "POLICY_BLOCKED"
  else "page-command"
type CurrentPage = { selected: bool, leaseCurrent: bool, pageIdValid: bool, parsed: bool, https: bool, noCredentials: bool }
pure def currentPageReceipt(pageFacts: CurrentPage, aliveAfter: bool): str =
  if (not(aliveAfter)) "STALE_REF"
  else if (not(pageFacts.selected)) "none"
  else if (not(pageFacts.pageIdValid and pageFacts.leaseCurrent)) "STALE_REF"
  else if (not(pageFacts.parsed)) "parse-error"
  else if (not(pageFacts.https and pageFacts.noCredentials)) "none"
  else "page"
pure def lawNoSurfaceApprovalUi(req: SurfaceRequest, alive: bool): bool =
  alive and req.idValid and req.kind == "task-guide" and req.offerUi implies surfaceRequest(req, alive) == "UNSUPPORTED"
pure def lawSurfaceRequiresFixedTaskAction(req: SurfaceRequest, alive: bool): bool =
  surfaceRequest(req, alive) == "page-command" implies req.hasTask and req.commandKeys and fixedSurfaceAction(req.subaction)
pure val supportedRequest: SurfaceRequest = { kind: "command", idValid: true, exactEnvelope: true, commandObject: true, commandKeys: true, pageIdValid: true, hasTask: true, subaction: "snapshot", offerUi: false }
pure val reqValues = Set(supportedRequest, { ...supportedRequest, idValid: false }, { ...supportedRequest, exactEnvelope: false }, { ...supportedRequest, commandKeys: false }, { ...supportedRequest, hasTask: false }, { ...supportedRequest, subaction: "navigate" }, { ...supportedRequest, kind: "task-bind" }, { ...supportedRequest, kind: "current-page" }, { ...supportedRequest, kind: "task-guide", offerUi: true })
pure val selectedPage: CurrentPage = { selected: true, leaseCurrent: true, pageIdValid: true, parsed: true, https: true, noCredentials: true }
pure val pageFactsValues = Set(selectedPage, { ...selectedPage, selected: false }, { ...selectedPage, leaseCurrent: false }, { ...selectedPage, pageIdValid: false }, { ...selectedPage, parsed: false }, { ...selectedPage, https: false }, { ...selectedPage, noCredentials: false })
```

### Binding replacement fences the old page before cleanup and never revives an older binding

Browser task binding validates its exact envelope, owner/task context, safe epoch and revision, future expiry, exact HTTPS origin or two through sixteen distinct authorized origins, and at most sixty-four reviewed targets. A target has a nonempty selector of at most 256 units and an admitted action. A replacement needs a greater binding revision even when changing tasks. With the same task ID a lower epoch is refused. A same-epoch replacement is allowed only to renew an expired, unrevoked binding with identical context, origin, ordered origins and targets, display name and commit pattern. Revocation at the same epoch is refused.

An admitted replacement installs a revoked copy first and drops the observation before awaiting guide removal. It then records the replacement and rechecks receiver authority before making it available. A failure after the fence does not restore the old binding. A returned binding receipt contains bound, binding revision, tab, task and epoch. A scoped command needs exact context, the same live binding object, a future effective deadline, an allowed current origin, an admitted subaction, and the reviewed selector when one is supplied. The effective deadline is the earlier of command and binding deadlines. An owner-bound hide or pause can pass after expiry and origin change and has no action authority. A task-guide show or prepared action still requires the current selected page and matching observed document. The shared binding codec and one-use commit grant own grant validation; a command with a grant can spend it during scope admission before a target is ultimately acted on.

```quint
type BindingRequest = { validEnvelope: bool, activeReceiver: bool, previous: bool, sameTask: bool, priorRevoked: bool, priorExpired: bool, newRevoked: bool, exactRenewal: bool, newRevision: int, oldRevision: int, newEpoch: int, oldEpoch: int }
pure def renewBinding(reqBind: BindingRequest): bool =
  reqBind.previous and reqBind.sameTask and reqBind.priorExpired and not(reqBind.priorRevoked or reqBind.newRevoked) and reqBind.exactRenewal
pure def bindingAdmitted(reqBind: BindingRequest): bool =
  reqBind.validEnvelope and reqBind.activeReceiver and
  (not(reqBind.previous) or (reqBind.newRevision > reqBind.oldRevision and
   (not(reqBind.sameTask) or reqBind.newEpoch > reqBind.oldEpoch or (reqBind.newEpoch == reqBind.oldEpoch and renewBinding(reqBind)))))
pure def bindingReceipt(admitted: bool, cleanupSucceeded: bool, stored: bool, receiverStillCurrent: bool, revoked: bool): str =
  if (not(admitted)) "POLICY_BLOCKED"
  else if (not(cleanupSucceeded and stored)) "replacement-fenced"
  else if (not(receiverStillCurrent)) "POLICY_BLOCKED"
  else if (revoked) "unbound" else "bound"
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
pure def lawNoReplyRestoresOldBinding(admitted: bool, cleanupSucceeded: bool, stored: bool, receiverStillCurrent: bool, revoked: bool): bool =
  bindingReceipt(admitted, cleanupSucceeded, stored, receiverStillCurrent, revoked) == "bound" implies admitted and cleanupSucceeded and stored and receiverStillCurrent and not(revoked)
pure val laterBind: BindingRequest = { validEnvelope: true, activeReceiver: true, previous: true, sameTask: true, priorRevoked: false, priorExpired: false, newRevoked: false, exactRenewal: false, newRevision: 4, oldRevision: 3, newEpoch: 2, oldEpoch: 1 }
pure val reqBindValues = Set(laterBind, { ...laterBind, newEpoch: 0 }, { ...laterBind, newEpoch: 1 }, { ...laterBind, newEpoch: 1, priorExpired: true, exactRenewal: true }, { ...laterBind, newEpoch: 1, priorExpired: true, exactRenewal: true, newRevoked: true }, { ...laterBind, newRevision: 2 }, { ...laterBind, sameTask: false, newEpoch: 0 })
pure val liveScope: SurfaceScope = { liveBindingSame: true, exactContext: true, revoked: false, bindingDeadline: 400, commandDeadlinePresent: true, commandDeadlineSafe: true, commandDeadline: 500, clock: 300, originAllowed: true, cleanup: false, selectorSyntaxOkay: true, reviewedTargetOrOmitted: true }
pure val scopeValues = Set(liveScope, { ...liveScope, bindingDeadline: 300 }, { ...liveScope, bindingDeadline: 300, cleanup: true }, { ...liveScope, revoked: true }, { ...liveScope, commandDeadline: 300 }, { ...liveScope, liveBindingSame: false }, { ...liveScope, exactContext: false }, { ...liveScope, originAllowed: false }, { ...liveScope, originAllowed: false, cleanup: true }, { ...liveScope, reviewedTargetOrOmitted: false })
```

## Story: Observe the main frame and dispatch an effect once under its exact evidence

### Request identity is consumed independently of the page selector

The receiver checks exact envelope and fixed operation first. It rejects a previously admitted ID as uncertain, including a previous snapshot ID or an ID whose attempt did not reach native action. Binding scope and selected page lease must be current before an ID is first recorded. A scope or selection failure before recording leaves it available. From recording onward, a malformed snapshot or stale selector cannot make the same ID available again. This record survives rebinding within the handler and belongs to the current handler lifetime.

For a snapshot, the old observation for that page is removed before the native read. The new observation is admitted only after authority stays current and native returns a complete main-frame result, string document ID, string snapshot ID, an elements array, and the scoped origin. A malformed URL raises its parser error when those preceding shape predicates pass. One frame with ID zero is returned. Each node's raw ID is removed and the selector is formed from snapshot ID, main frame and node ID. Recognized blocker references are rewritten under the same snapshot. The cached document ID comes from the native reply. The decoder's exact shapes and reference formatting are represented by boundary facts and identities.

```quint
type RequestAdmission = { idSpent: bool, scopeAllowed: bool, selectionCurrent: bool, pageMatches: bool, actorCurrent: bool }
pure def admitSurfaceRequest(admitFacts: RequestAdmission): str =
  if (admitFacts.idSpent) "UNCERTAIN_OUTCOME"
  else if (not(admitFacts.scopeAllowed)) "POLICY_BLOCKED"
  else if (not(admitFacts.selectionCurrent and admitFacts.pageMatches and admitFacts.actorCurrent)) "STALE_REF"
  else "admit"
type SnapshotFacts = { currentAfter: bool, mainFrame: bool, documentString: bool, complete: bool, snapshotString: bool, elementArray: bool, addressParsed: bool, matchesScopedOrigin: bool }
pure def snapshotReceipt(snapshotFacts: SnapshotFacts): str =
  if (not(snapshotFacts.currentAfter)) "STALE_REF"
  else if (not(snapshotFacts.mainFrame and snapshotFacts.documentString and snapshotFacts.complete and snapshotFacts.snapshotString and snapshotFacts.elementArray)) "INCOMPLETE_SNAPSHOT"
  else if (not(snapshotFacts.addressParsed)) "parse-error"
  else if (not(snapshotFacts.matchesScopedOrigin)) "INCOMPLETE_SNAPSHOT"
  else "snapshot"
pure def lawAdmittedIdentityCannotBeRetried(admitFacts: RequestAdmission): bool =
  admitFacts.idSpent implies admitSurfaceRequest(admitFacts) == "UNCERTAIN_OUTCOME"
pure def lawSnapshotIsCompleteAndScoped(snapshotFacts: SnapshotFacts): bool =
  snapshotReceipt(snapshotFacts) == "snapshot" implies snapshotFacts.currentAfter and snapshotFacts.mainFrame and snapshotFacts.documentString and snapshotFacts.complete and snapshotFacts.snapshotString and snapshotFacts.elementArray and snapshotFacts.addressParsed and snapshotFacts.matchesScopedOrigin
pure val admissionOkay: RequestAdmission = { idSpent: false, scopeAllowed: true, selectionCurrent: true, pageMatches: true, actorCurrent: true }
pure val admitFactsValues = Set(admissionOkay, { ...admissionOkay, idSpent: true, scopeAllowed: false }, { ...admissionOkay, scopeAllowed: false }, { ...admissionOkay, selectionCurrent: false }, { ...admissionOkay, pageMatches: false }, { ...admissionOkay, actorCurrent: false })
pure val completeSnapshot: SnapshotFacts = { currentAfter: true, mainFrame: true, documentString: true, complete: true, snapshotString: true, elementArray: true, addressParsed: true, matchesScopedOrigin: true }
pure val snapshotFactsValues = Set(completeSnapshot, { ...completeSnapshot, currentAfter: false }, { ...completeSnapshot, mainFrame: false }, { ...completeSnapshot, complete: false }, { ...completeSnapshot, matchesScopedOrigin: false }, { ...completeSnapshot, addressParsed: false })
```

### Native input consumes the observation and cleanup never upgrades uncertainty

An effect needs a matching cached observation still held by the observed page and an exact main-frame selector naming its snapshot. Guidance validates the target with native before painting and must report ready under the same action ticket. Input authority is checked again before dispatch. Dispatch removes the cached observation, then calls native with the old document ID, snapshot ID, node ID and trusted action-ticket ID. Receipt needs a current task scope and selection, current feedback ticket, the exact original document, and native `dispatched: true`. A changed document, stale scope or missing dispatch acknowledgement on a returned reply yields uncertain outcome. A native rejection is propagated unless cleanup fails after input was attempted. The Grace native adapter itself reports uncertainty when the lease is lost while an input awaits native response.

After preview or attempted input, the receiver cancels its guidance ticket. Failed post-dispatch cleanup yields uncertainty even if native reported success or a different error. Before dispatch, cleanup can still report its own typed error. No cleanup grants an effect. Receiver close marks the handler retired, drops observations and revokes current bindings before asking the native cleanup port to hide guidance on every listed surface, including parked pages. Cleanup has its own account and renderer checks. It cannot read or act on the parked document.

```quint
type PageEffect = { observationPresent: bool, observedLeaseCurrent: bool, selectorValid: bool, sameSnapshot: bool, underlyingCurrent: bool, previewReady: bool, currentBeforeDispatch: bool }
pure def eligibleSelector(effectFacts: PageEffect): bool =
  effectFacts.observationPresent and effectFacts.observedLeaseCurrent and effectFacts.selectorValid and effectFacts.sameSnapshot
pure def inputAuthorized(effectFacts: PageEffect): bool =
  eligibleSelector(effectFacts) and effectFacts.underlyingCurrent and effectFacts.previewReady and effectFacts.currentBeforeDispatch
type InputReceipt = { inputAttempted: bool, nativeReturned: bool, nativeError: str, scopeCurrent: bool, feedbackCurrent: bool, sameDocument: bool, nativeDispatched: bool, cleanupOkay: bool, cleanupError: str }
type EffectOutcome = { received: bool, code: str }
pure def actionReceipt(receipt: InputReceipt): EffectOutcome =
  if (not(receipt.cleanupOkay)) { received: false, code: if (receipt.inputAttempted) "UNCERTAIN_OUTCOME" else receipt.cleanupError }
  else if (not(receipt.nativeReturned)) { received: false, code: receipt.nativeError }
  else if (not(receipt.inputAttempted and receipt.scopeCurrent and receipt.feedbackCurrent and receipt.sameDocument and receipt.nativeDispatched)) { received: false, code: "UNCERTAIN_OUTCOME" }
  else { received: true, code: "" }
pure def lawEffectRequiresExactObservation(effectFacts: PageEffect): bool =
  inputAuthorized(effectFacts) implies eligibleSelector(effectFacts) and effectFacts.previewReady and effectFacts.currentBeforeDispatch
pure def lawCleanupCannotRelabelAttemptedInput(receipt: InputReceipt): bool =
  receipt.inputAttempted and not(receipt.cleanupOkay) implies not(actionReceipt(receipt).received) and actionReceipt(receipt).code == "UNCERTAIN_OUTCOME"
pure def lawUncertainNativeReplyCannotSucceed(receipt: InputReceipt): bool =
  receipt.nativeReturned and not(receipt.scopeCurrent and receipt.feedbackCurrent and receipt.sameDocument and receipt.nativeDispatched) implies not(actionReceipt(receipt).received)
pure val effectReady: PageEffect = { observationPresent: true, observedLeaseCurrent: true, selectorValid: true, sameSnapshot: true, underlyingCurrent: true, previewReady: true, currentBeforeDispatch: true }
pure val effectFactsValues = Set(effectReady, { ...effectReady, observationPresent: false }, { ...effectReady, sameSnapshot: false }, { ...effectReady, selectorValid: false }, { ...effectReady, observedLeaseCurrent: false }, { ...effectReady, previewReady: false }, { ...effectReady, currentBeforeDispatch: false })
pure val goodEffect: InputReceipt = { inputAttempted: true, nativeReturned: true, nativeError: "STALE_REF", scopeCurrent: true, feedbackCurrent: true, sameDocument: true, nativeDispatched: true, cleanupOkay: true, cleanupError: "STALE_REF" }
pure val receiptValues = Set(goodEffect, { ...goodEffect, nativeDispatched: false }, { ...goodEffect, inputAttempted: false, nativeReturned: false }, { ...goodEffect, sameDocument: false }, { ...goodEffect, scopeCurrent: false }, { ...goodEffect, feedbackCurrent: false }, { ...goodEffect, nativeReturned: false }, { ...goodEffect, cleanupOkay: false }, { ...goodEffect, inputAttempted: false, nativeReturned: false, cleanupOkay: false })
```

### The receiver retains spent requests through every replacement and retirement

The machine follows one selected page and one ordinary command at a time. It keeps metadata for the queued copy, the admitted identities, the live binding revision and cached observation. An independently admitted binding replacement or retirement fences the observation without removing prior receipt IDs. It may occur while a command is awaiting native input. A missing native response leaves the command outside the successful receipt branch. The route-level command decoder, native callback errors and cleanup classification are modeled by the preceding rules. Discovered by the proof: a retired or replacing receiver holds no live binding. Reading, checking and dispatched commands already consumed their request identities. These facts distinguish an actual in-flight command from an arbitrary record.

```quint
type QueuedSurface = { requestId: int, isSnapshot: bool, requestedSnapshot: int }
type SurfaceReceiver = { closed: bool, live: bool, bindingRevision: int, replacing: bool, observedSnapshot: int, observedRevision: int, phase: str, spent: List[int], queued: QueuedSurface, inputRevision: int, receipt: str }
pure val emptyCommand: QueuedSurface = { requestId: 0, isSnapshot: true, requestedSnapshot: 0 }
pure val initial: SurfaceReceiver = { closed: false, live: false, bindingRevision: 0, replacing: false, observedSnapshot: 0, observedRevision: 0, phase: "idle", spent: List(), queued: emptyCommand, inputRevision: 0, receipt: "" }
pure def canFenceBinding(receiver: SurfaceReceiver, revision: int): bool =
  not(receiver.closed or receiver.replacing) and revision > receiver.bindingRevision
pure def fenceBinding(receiver: SurfaceReceiver, revision: int): SurfaceReceiver =
  { ...receiver, bindingRevision: revision, live: false, replacing: true, observedSnapshot: 0, observedRevision: 0 }
pure def canSettleBinding(receiver: SurfaceReceiver): bool = receiver.replacing and not(receiver.closed)
pure def settleBinding(receiver: SurfaceReceiver, keepLive: bool): SurfaceReceiver =
  { ...receiver, replacing: false, live: keepLive }
pure def canQueueSurface(receiver: SurfaceReceiver, incoming: QueuedSurface): bool =
  not(receiver.closed) and receiver.phase == "idle" and incoming.requestId > 0
pure def queueSurface(receiver: SurfaceReceiver, incoming: QueuedSurface): SurfaceReceiver =
  { ...receiver, phase: "queued", queued: incoming, receipt: "" }
pure def canAdmitSurface(receiver: SurfaceReceiver): bool = receiver.phase == "queued" and not(receiver.closed)
pure def admitSurface(receiver: SurfaceReceiver, stillSelected: bool): SurfaceReceiver =
  if (receiver.spent.includes(receiver.queued.requestId)) { ...receiver, phase: "idle", receipt: "UNCERTAIN_OUTCOME" }
  else if (not(receiver.live and stillSelected)) { ...receiver, phase: "idle", receipt: "not-admitted" }
  else if (receiver.queued.isSnapshot) { ...receiver, phase: "reading", observedSnapshot: 0, observedRevision: 0, inputRevision: receiver.bindingRevision, spent: receiver.spent.append(receiver.queued.requestId) }
  else { ...receiver, phase: "checking", inputRevision: receiver.bindingRevision, spent: receiver.spent.append(receiver.queued.requestId) }
pure def canAcceptSnapshot(receiver: SurfaceReceiver): bool = receiver.phase == "reading"
pure def acceptSnapshot(receiver: SurfaceReceiver, nativeSnapshot: int, complete: bool): SurfaceReceiver =
  if (not(receiver.closed) and receiver.live and receiver.inputRevision == receiver.bindingRevision and complete and nativeSnapshot > 0)
    { ...receiver, phase: "idle", observedSnapshot: nativeSnapshot, observedRevision: receiver.bindingRevision, receipt: "snapshot" }
  else { ...receiver, phase: "idle", receipt: "unconfirmed-snapshot" }
pure def canDispatchSurface(receiver: SurfaceReceiver): bool = receiver.phase == "checking"
pure def dispatchSurface(receiver: SurfaceReceiver, previewReady: bool): SurfaceReceiver =
  if (not(receiver.closed) and receiver.live and receiver.inputRevision == receiver.bindingRevision and previewReady and receiver.observedSnapshot > 0 and receiver.queued.requestedSnapshot == receiver.observedSnapshot)
    { ...receiver, phase: "dispatched", observedSnapshot: 0, observedRevision: 0 }
  else { ...receiver, phase: "idle", receipt: "STALE_REF" }
pure def canSettleInput(receiver: SurfaceReceiver): bool = receiver.phase == "dispatched"
pure def settleInput(receiver: SurfaceReceiver, nativeAcknowledged: bool, cleanupOkay: bool): SurfaceReceiver =
  { ...receiver, phase: "idle", receipt: if (not(receiver.closed) and receiver.live and receiver.inputRevision == receiver.bindingRevision and nativeAcknowledged and cleanupOkay) "effect-receipt" else "UNCERTAIN_OUTCOME" }
pure def canRetireSurface(receiver: SurfaceReceiver): bool = not(receiver.closed)
pure def retireSurface(receiver: SurfaceReceiver): SurfaceReceiver =
  { ...receiver, closed: true, live: false, observedSnapshot: 0, observedRevision: 0, replacing: false, phase: if (receiver.phase == "queued") "idle" else receiver.phase }
pure def alwaysInactiveWhileFenced(receiver: SurfaceReceiver): bool =
  receiver.closed or receiver.replacing implies not(receiver.live)
pure def alwaysInProgressHasConsumedIdentity(receiver: SurfaceReceiver): bool =
  Set("reading", "checking", "dispatched").contains(receiver.phase) implies receiver.spent.includes(receiver.queued.requestId)
pure def alwaysCachedObservationBelongsToBinding(receiver: SurfaceReceiver): bool =
  receiver.observedSnapshot > 0 implies receiver.live and not(receiver.closed or receiver.replacing) and receiver.observedRevision == receiver.bindingRevision
pure def alwaysDispatchedHasConsumedRequest(receiver: SurfaceReceiver): bool =
  receiver.phase == "dispatched" implies receiver.spent.includes(receiver.queued.requestId) and receiver.observedSnapshot == 0
pure def stepSpentRequestsAreNeverRestored(before: SurfaceReceiver, after: SurfaceReceiver): bool =
  before.spent.every(age => after.spent.includes(age))
pure def stepRetirementDoesNotRevive(before: SurfaceReceiver, after: SurfaceReceiver): bool =
  before.closed implies after.closed and not(after.live)
pure def sometimesSnapshotCached(receiver: SurfaceReceiver): bool = receiver.observedSnapshot > 0
pure def sometimesEffectReceived(receiver: SurfaceReceiver): bool = receiver.receipt == "effect-receipt"
pure def sometimesEffectUncertain(receiver: SurfaceReceiver): bool = receiver.receipt == "UNCERTAIN_OUTCOME"
pure def sometimesDispatchedThenRetired(receiver: SurfaceReceiver): bool = receiver.phase == "dispatched" and receiver.closed
pure val revisionValues = Set(1, 2, 3, 4)
pure val nativeSnapshotValues = Set(1, 2)
pure val incomingValues = Set(
  { requestId: 1, isSnapshot: true, requestedSnapshot: 0 },
  { requestId: 2, isSnapshot: false, requestedSnapshot: 1 },
  { requestId: 3, isSnapshot: false, requestedSnapshot: 2 },
  { requestId: 4, isSnapshot: true, requestedSnapshot: 0 },
  { requestId: 5, isSnapshot: false, requestedSnapshot: 1 },
  { requestId: 6, isSnapshot: false, requestedSnapshot: 2 })
pure val weight_fenceBinding = 5
pure val weight_settleBinding = 12
pure val weight_queueSurface = 12
pure val weight_admitSurface = 18
pure val weight_acceptSnapshot = 18
pure val weight_dispatchSurface = 18
pure val weight_settleInput = 18
pure val weight_retireSurface = 5
```

The state model uses a single ordinary command slot. The pinned receiver queues ordinary requests serially without that slot limit. The receiver tests exercise host calls against its pinned implementation with controlled native ports. They give no measurement of WebView rendering or native process behavior. The Android instrumentation fixture separately exercises the real authenticated channel, native WebView observation, parked cleanup, and action readback.
