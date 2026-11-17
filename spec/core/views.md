# View declarations and completed-action handoffs

Sources are `views/{declarations,surface-manifest,host-external-contract,view-interact-protocol,view-action-handoff,completed-action-navigation}.ts` and `events.ts`. Preserve GUI/TUI/XR modality resolution, view visibility, exact capability ids, surface ownership and renderer-safe imports. Client ids route requests and supply no authority by themselves. The request machine is a request-local epoch observation, not a second renderer cache. [Renderer navigation](./viewNavigation.md) owns the authoritative window, path, epoch and deduplication state; a host must obtain the current delivery fence from that owner. This projection does not prove the window/DOM adapter.

## Story: Deliver a completed action to the intended view

> As a user, I want a completed action to reach the view that requested it,
> so that it neither overrides navigation I made since nor lands in the
> wrong view.

### Completion requires matching request renderer installation and view identities

Prepared navigation binds the request id, completed-action handoff id, client id, installation id, view id and GUI view type. The parser accepts successful qualifying VIEWS, APP-browser and BROWSER-workspace legacy actions according to the source rules, scanning newest first. Only VIEWS-family actions may carry prepared bindings, with request id equal to handoff id and exact raw GUI/view identity. Invalid prepared bindings are skipped. Duplicate handoffs remain suppressed while retained by the bounded source cache. A changed navigation epoch invalidates the captured navigation permission even if the path later returns to its original value.

```quint
type ViewPhase = Available | Pending | Delivered | Retired
type ViewRequest = { phase: ViewPhase, requestId: str, clientId: str, installationId: str, viewId: str, epoch: int, capturedEpoch: int }
pure val initial: ViewRequest = { phase: Available, requestId: "", clientId: "", installationId: "", viewId: "", epoch: 0, capturedEpoch: 0 }
pure def canRequest(v: ViewRequest, requestId: str, clientId: str, installationId: str, viewId: str): bool = v.phase == Available and requestId != "" and clientId != "" and installationId != "" and viewId != ""
pure def request(v: ViewRequest, requestId: str, clientId: str, installationId: str, viewId: str): ViewRequest = { ...v, phase: Pending, requestId: requestId, clientId: clientId, installationId: installationId, viewId: viewId, capturedEpoch: v.epoch }
pure def navigate(v: ViewRequest): ViewRequest = { ...v, epoch: v.epoch + 1 }
pure def canDeliver(v: ViewRequest, requestId: str, clientId: str, installationId: str, viewId: str): bool = v.phase == Pending and v.epoch == v.capturedEpoch and v.requestId == requestId and v.clientId == clientId and v.installationId == installationId and v.viewId == viewId
pure def deliver(v: ViewRequest, requestId: str, clientId: str, installationId: str, viewId: str): ViewRequest = { ...v, phase: Delivered }
pure def canRetire(v: ViewRequest): bool = v.phase == Pending
pure def retire(v: ViewRequest): ViewRequest = { ...v, phase: Retired }
pure def alwaysEpochMonotonic(v: ViewRequest): bool = v.epoch >= v.capturedEpoch and v.capturedEpoch >= 0
pure def stepDeliveryUsesCapturedEpoch(before: ViewRequest, via: str, after: ViewRequest): bool = via == "deliver" implies before.epoch == before.capturedEpoch
pure def stepTerminalHandoffStaysTerminal(before: ViewRequest, after: ViewRequest): bool = (before.phase == Delivered or before.phase == Retired) implies before.phase == after.phase
pure def sometimesViewDelivered(v: ViewRequest): bool = v.phase == Delivered
pure def sometimesViewRetired(v: ViewRequest): bool = v.phase == Retired
```


### Candidate observations preserve conditional reflection and codec order

The pure parser reads potential observations, not raw JavaScript objects. An adapter must preserve the source's own-data-descriptor reads, strict literal-true comparisons, trimming/case conversion, and the two distinct identifier grammars. `actionName` is trimmed uppercase; `mode`, `subaction` and `targetId` are trimmed lowercase; the selected view id, URL, declared path and subview are trimmed without case changes. Handoff/request ids use `[A-Za-z0-9._:-]{1,128}` without trimming; client/installation ids use `[A-Za-z0-9._-]{1,128}` without trimming. Empty strings denote absent or invalid observations. Binding view id and type are raw string observations, with no normalization.

`faults` records potential failures of named reads/codecs. It is not permission to inspect them eagerly. The source can throw from array classification, initial length/coercion, index/property reflection or URI encoding, and this parser classifies the first failure that the source would actually observe. Its original error object and propagation remain host obligations. Unused binding fields and older candidates must remain unread. `encodedUrl` is the exact `encodeURIComponent` observation for the actual trimmed URL, including malformed-UTF16 failure. A browser URL path is represented as `BrowserUrlPath(encodedUrl)` and projects to the fixed `/browser?browse=` prefix followed by that exact encoding; declared and absent paths are separate variants. These reflection, lexical and URI/string-projection ports, and their demand-driven extraction from raw objects, remain explicit adapter contracts; the typed policy is not a universal JavaScript parser refinement theorem.

```quint
type HandoffStage = NoFault | ArrayCheck | ArrayLengthRead | CandidateIndex | SuccessRead | ActionNameRead | ValuesRead | ModeRead | SubactionRead | TargetRead | ViewIdRead | UrlRead | ViewPathRead | UriEncode | SubviewRead | HandoffIdRead | PreparedRead | BindingRead | RequestIdRead | ClientIdRead | InstallationIdRead | BindingViewRead | BindingTypeRead | DeliveredRead
type HandoffCandidate = { faults: Set[HandoffStage], successLiteralTrue: bool, actionName: str, mode: str, subaction: str, targetId: str, viewId: str, url: str, encodedUrl: str, declaredViewPath: str, subview: str, normalizedHandoffId: str, preparedLiteralTrue: bool, normalizedRequestId: str, parsedClientId: str, parsedInstallationId: str, rawBindingViewId: str, rawBindingViewType: str, deliveredLiteralTrue: bool }
type HandoffPath = AbsentViewPath | DeclaredViewPath({path: str}) | BrowserUrlPath({encodedUrl: str})
type HandoffTarget = {viewId: str, viewPath: HandoffPath, subview: str}
type LegacyHandoff = {target: HandoffTarget, handoffId: str, delivered: bool}
type PreparedHandoff = {target: HandoffTarget, handoffId: str, clientId: str, installationId: str, delivered: bool}
type GuiViewType = | Gui
type PreparedBinding = {requestId: str, clientId: str, installationId: str, viewId: str, viewType: GuiViewType}
type HandoffResult = NoHandoff | HandoffFailed({stage: HandoffStage}) | LegacySelected({handoff: LegacyHandoff}) | PreparedSelected({handoff: PreparedHandoff})
type ActionResultsObservation = NotAnArray | ArrayCheckFailed | ArrayLengthFailed | ActionResults({candidates: List[HandoffCandidate]})
pure val emptyCandidate: HandoffCandidate = {faults: Set(), successLiteralTrue: false, actionName: "", mode: "", subaction: "", targetId: "", viewId: "", url: "", encodedUrl: "", declaredViewPath: "", subview: "", normalizedHandoffId: "", preparedLiteralTrue: false, normalizedRequestId: "", parsedClientId: "", parsedInstallationId: "", rawBindingViewId: "", rawBindingViewType: "", deliveredLiteralTrue: false}
pure val noReadFault: HandoffStage = NoFault
pure val deliveredReadStage: HandoffStage = DeliveredRead
pure val bindingViewReadStage: HandoffStage = BindingViewRead
pure val bindingTypeReadStage: HandoffStage = BindingTypeRead
pure val uriEncodeStage: HandoffStage = UriEncode
pure def firstFault(candidate: HandoffCandidate, stages: List[HandoffStage]): HandoffStage = stages.foldl(noReadFault, (found, stage) => if (found == NoFault and candidate.faults.contains(stage)) stage else found)
```

### Eligible actions retain legacy paths and derive canonical prepared identity

Success must be literal true and the selected trimmed view id must be nonempty. VIEWS permits mode show/open; VIEWS_SHOW permits show. APP permits launch of browser. BROWSER, BROWSER_OPEN, BROWSER_NAVIGATE and BROWSER_SHOW require workspace, subaction open/navigate/show and browser. Unprepared legacy results retain optional path, subview, handoff and delivered observations and ignore binding fields.

Every eligible action reads URL then declared path. A browser-workspace URL is encoded before reading subview, handoff id or prepared fields; URI failure therefore precedes prepared rejection. For literal prepared true the parser reads binding/request/client/installation before checking eligibility and identities. It then reads raw binding view id, and only on equality raw view type. Prepared navigation requires VIEWS-family, a valid nonempty handoff id, the same normalized request id, valid client/installation ids, raw binding view id equal to the selected trimmed id, and raw view type exactly gui. Delivered is read only after this succeeds or the legacy path is chosen.

The prepared result stores each identity once. Its request id and GUI binding are derived, so neither can disagree with the handoff. Matching that tuple uses the existing request guard; the authoritative renderer fence is still a host obligation of the navigation owner.

```quint
pure def isViewsCandidate(candidate: HandoffCandidate): bool = (candidate.actionName == "VIEWS" and (candidate.mode == "show" or candidate.mode == "open")) or (candidate.actionName == "VIEWS_SHOW" and candidate.mode == "show")
pure def isAppBrowserCandidate(candidate: HandoffCandidate): bool = candidate.actionName == "APP" and candidate.mode == "launch" and candidate.viewId == "browser"
pure def isBrowserWorkspaceCandidate(candidate: HandoffCandidate): bool = Set("BROWSER", "BROWSER_OPEN", "BROWSER_NAVIGATE", "BROWSER_SHOW").contains(candidate.actionName) and candidate.targetId == "workspace" and Set("open", "navigate", "show").contains(candidate.subaction) and candidate.viewId == "browser"
pure def qualifiesCandidate(candidate: HandoffCandidate): bool = candidate.viewId != "" and (isViewsCandidate(candidate) or isAppBrowserCandidate(candidate) or isBrowserWorkspaceCandidate(candidate))
pure def candidateTarget(candidate: HandoffCandidate): HandoffTarget = {viewId: candidate.viewId, viewPath: if (isBrowserWorkspaceCandidate(candidate) and candidate.url != "") BrowserUrlPath({encodedUrl: candidate.encodedUrl}) else if (candidate.declaredViewPath == "") AbsentViewPath else DeclaredViewPath({path: candidate.declaredViewPath}), subview: candidate.subview}
pure def preparedBinding(handoff: PreparedHandoff): PreparedBinding = {requestId: handoff.handoffId, clientId: handoff.clientId, installationId: handoff.installationId, viewId: handoff.target.viewId, viewType: Gui}
pure def matchesPreparedHandoff(v: ViewRequest, handoff: PreparedHandoff): bool = canDeliver(v, handoff.handoffId, handoff.clientId, handoff.installationId, handoff.target.viewId)
pure def finishCandidate(candidate: HandoffCandidate, prepared: bool): HandoffResult =
  if (candidate.faults.contains(deliveredReadStage)) HandoffFailed({stage: DeliveredRead})
  else if (prepared) PreparedSelected({handoff: {target: candidateTarget(candidate), handoffId: candidate.normalizedHandoffId, clientId: candidate.parsedClientId, installationId: candidate.parsedInstallationId, delivered: candidate.deliveredLiteralTrue}})
  else LegacySelected({handoff: {target: candidateTarget(candidate), handoffId: candidate.normalizedHandoffId, delivered: candidate.deliveredLiteralTrue}})
pure def parsePreparedCandidate(candidate: HandoffCandidate): HandoffResult = {
  val bindingFault = firstFault(candidate, List(BindingRead, RequestIdRead, ClientIdRead, InstallationIdRead))
  if (bindingFault != NoFault) HandoffFailed({stage: bindingFault})
  else if (not(isViewsCandidate(candidate)) or candidate.normalizedHandoffId == "" or candidate.normalizedRequestId != candidate.normalizedHandoffId or candidate.parsedClientId == "" or candidate.parsedInstallationId == "") NoHandoff
  else if (candidate.faults.contains(bindingViewReadStage)) HandoffFailed({stage: BindingViewRead})
  else if (candidate.rawBindingViewId != candidate.viewId) NoHandoff
  else if (candidate.faults.contains(bindingTypeReadStage)) HandoffFailed({stage: BindingTypeRead})
  else if (candidate.rawBindingViewType != "gui") NoHandoff
  else finishCandidate(candidate, true)
}
pure def parseCandidate(candidate: HandoffCandidate): HandoffResult = {
  val entryFault = firstFault(candidate, List(CandidateIndex, SuccessRead))
  val coreFault = firstFault(candidate, List(ActionNameRead, ValuesRead, ModeRead, SubactionRead, TargetRead, ViewIdRead))
  val pathFault = firstFault(candidate, List(UrlRead, ViewPathRead))
  val tailFault = firstFault(candidate, List(SubviewRead, HandoffIdRead, PreparedRead))
  if (entryFault != NoFault) HandoffFailed({stage: entryFault})
  else if (not(candidate.successLiteralTrue)) NoHandoff
  else if (coreFault != NoFault) HandoffFailed({stage: coreFault})
  else if (not(qualifiesCandidate(candidate))) NoHandoff
  else if (pathFault != NoFault) HandoffFailed({stage: pathFault})
  else if (isBrowserWorkspaceCandidate(candidate) and candidate.url != "" and candidate.faults.contains(uriEncodeStage)) HandoffFailed({stage: UriEncode})
  else if (tailFault != NoFault) HandoffFailed({stage: tailFault})
  else if (candidate.preparedLiteralTrue) parsePreparedCandidate(candidate)
  else finishCandidate(candidate, false)
}
pure def selectedPrepared(result: HandoffResult): bool = match result { | PreparedSelected(_) => true | _ => false }
pure def selectedLegacy(result: HandoffResult): bool = match result { | LegacySelected(_) => true | _ => false }
pure def lawPreparedBindingIsDerived(handoff: PreparedHandoff): bool = preparedBinding(handoff).requestId == handoff.handoffId and preparedBinding(handoff).viewType == Gui and preparedBinding(handoff).viewId == handoff.target.viewId
pure def lawSelectedCandidatesQualify(candidate: HandoffCandidate): bool = (selectedPrepared(parseCandidate(candidate)) or selectedLegacy(parseCandidate(candidate))) implies candidate.successLiteralTrue and qualifiesCandidate(candidate)
pure def lawPreparedCandidatesHaveExactBinding(candidate: HandoffCandidate): bool = selectedPrepared(parseCandidate(candidate)) implies (candidate.preparedLiteralTrue and isViewsCandidate(candidate) and candidate.normalizedHandoffId != "" and candidate.normalizedRequestId == candidate.normalizedHandoffId and candidate.parsedClientId != "" and candidate.parsedInstallationId != "" and candidate.rawBindingViewId == candidate.viewId and candidate.rawBindingViewType == "gui")
pure def lawLegacyCandidatesAreUnprepared(candidate: HandoffCandidate): bool = selectedLegacy(parseCandidate(candidate)) implies not(candidate.preparedLiteralTrue)
pure def lawUnpreparedEligibleCandidateIsLegacy(candidate: HandoffCandidate): bool = (candidate.faults.size() == 0 and candidate.successLiteralTrue and qualifiesCandidate(candidate) and not(candidate.preparedLiteralTrue)) implies selectedLegacy(parseCandidate(candidate))
pure def lawUriFailurePrecedesPreparedCheck(candidate: HandoffCandidate): bool = {
  val parsed = parseCandidate({...candidate, faults: Set(UriEncode), successLiteralTrue: true, actionName: "BROWSER", targetId: "workspace", subaction: "open", viewId: "browser", url: "url", preparedLiteralTrue: true})
  match parsed { | HandoffFailed(failure) => failure.stage == UriEncode | _ => false }
}
```

### The newest selected result prevents every older read

Input observations retain the source array's oldest-to-newest order. The pure scan reverses only that typed list, then stops parsing as soon as a newer candidate selects a result or observes a failure. An invalid newer candidate permits the next older candidate. A selected newer handoff ignores every older fault; an observed newer failure prevents fallback. The adapter must scan the actual raw array and extract fields on demand in this same order, including array-index reads, rather than materialize eager raw candidates.

```quint
pure def continueScan(found: HandoffResult, candidate: HandoffCandidate): HandoffResult = match found { | NoHandoff => parseCandidate(candidate) | _ => found }
pure def scanCandidates(candidates: List[HandoffCandidate]): HandoffResult = {
  val newestFirst = candidates.foldl(List(), (rows, candidate) => List(candidate).concat(rows))
  newestFirst.foldl(NoHandoff, (found, candidate) => continueScan(found, candidate))
}
pure def findViewActionHandoff(observation: ActionResultsObservation): HandoffResult = match observation { | NotAnArray => NoHandoff | ArrayCheckFailed => HandoffFailed({stage: ArrayCheck}) | ArrayLengthFailed => HandoffFailed({stage: ArrayLengthRead}) | ActionResults(input) => scanCandidates(input.candidates) }
pure def lawCompletedScanDoesNotReadOlder(found: HandoffResult, candidate: HandoffCandidate): bool = match found { | NoHandoff => true | _ => continueScan(found, candidate) == found }
pure def lawNewestCandidateHasPriority(candidates: List[HandoffCandidate], candidate: HandoffCandidate): bool = {
  val parsed = parseCandidate(candidate)
  val selected = scanCandidates(candidates.append(candidate))
  match parsed { | NoHandoff => selected == scanCandidates(candidates) | _ => selected == parsed }
}
pure val legacyBrowserCandidate: HandoffCandidate = {...emptyCandidate, successLiteralTrue: true, actionName: "APP", mode: "launch", viewId: "browser"}
pure val preparedViewsCandidate: HandoffCandidate = {...emptyCandidate, successLiteralTrue: true, actionName: "VIEWS", mode: "show", viewId: "files", normalizedHandoffId: "handoff:1", preparedLiteralTrue: true, normalizedRequestId: "handoff:1", parsedClientId: "client-1", parsedInstallationId: "install-1", rawBindingViewId: "files", rawBindingViewType: "gui"}
pure val candidateValues = Set(emptyCandidate, legacyBrowserCandidate, preparedViewsCandidate, {...preparedViewsCandidate, normalizedRequestId: "wrong"}, {...emptyCandidate, faults: Set(SuccessRead)})
pure val candidatesValues = Set(List(), List(legacyBrowserCandidate), List({...preparedViewsCandidate, normalizedRequestId: "wrong"}, preparedViewsCandidate), List({...emptyCandidate, faults: Set(SuccessRead)}, preparedViewsCandidate))
pure val handoffValues = Set({target: {viewId: "files", viewPath: AbsentViewPath, subview: ""}, handoffId: "handoff:1", clientId: "client-1", installationId: "install-1", delivered: false})
pure val foundValues = Set(NoHandoff, parseCandidate(legacyBrowserCandidate), parseCandidate(preparedViewsCandidate), HandoffFailed({stage: SuccessRead}))
```

## Story: Offer a caller only the actions its view allows

> As the owner, a view sees only the actions its declaration allows, so an
> action meant for another view is never offered there.

### A view offers only registered actions its declaration lists

A view's declaration lists the actions it scopes. Within that view, the
caller is offered exactly the registered actions the declaration lists; an
unlisted action is unavailable there whatever the caller's role. Whether
the caller's role may run an offered action is [action
planning](./actionPlanning.md)'s check.

```quint
pure def offeredInView(viewActions: Set[str], registeredActions: Set[str]): Set[str] = registeredActions.intersect(viewActions)
pure def lawUnlistedActionUnavailable(viewActions: Set[str], registeredActions: Set[str], actionName: str): bool =
  not(viewActions.contains(actionName)) implies not(offeredInView(viewActions, registeredActions).contains(actionName))
pure val viewActionsValues = Set(Set(), Set("reply"), Set("reply", "manage"))
pure val registeredActionsValues = Set(Set("reply", "manage", "browse"), Set("reply"))
pure val actionNameValues = Set("reply", "manage", "browse")
```
