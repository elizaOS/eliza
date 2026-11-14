# Grace website manual activity

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` composes `apps/app/host/website-guide-helper.ts` with `plugins/plugin-personal-assistant/native-host/guided-website-workflow.mjs` at Eliza `7743504b7c936a764b3938a44cad918808b621df`. The browser supplies evidence of form submits and recording gaps. The guide decides when to ask and when an observed event can belong to a form step it showed the person. The evidence never proves the site accepted a submission or that the person authorized a new action. Other specifications own payment classification, dispatch and result reconciliation.

## Story: Ask about manual activity when the browser's record leaves it uncertain

### Upstream validates evidence and scopes the question to the exact recorded activity

An absent evidence record calls for no activity question. A present record has a form-submit array of at most 256 entries. Each event has string origin and document ID, safe integer epoch and observed timestamp, and either no credential marker or the marker `true`. The activity has boolean overflow and capture-gap flags. If gap IDs are present, there are at most 256 and each is 36 lowercase hex or hyphen units. Nonempty IDs require the gap flag. The upstream event validator does not require an event ID on the recorded submit itself. Malformed evidence fails the look and clears guidance.

A valid record asks about overflow, gaps that remain unexplained, or an earlier-epoch noncredential submit on the current page origin. The upstream question key covers every event in supplied order, including events that did not trigger a question, the overflow bit and unresolved gaps. The gap component includes this epoch, document and the exact gap ID list, using an anonymous entry when IDs are unavailable. An exact existing answer suppresses its question. An answer to this question is task-scoped, with any explicitly stale epoch on receipt still refused. No form values enter the key or the model.

```quint
type BrowserSubmit = { formSubmit: bool, originString: bool, documentString: bool, origin: str, documentId: str, epoch: int, observedAt: int, credentialMarkerValid: bool, credential: bool, idPresent: bool, eventId: str }
type GapId = { idString: bool, idUnits: int, lowerHexOrHyphen: bool }
type Activity = { present: bool, eventsArray: bool, events: List[BrowserSubmit], overflowBoolean: bool, overflow: bool, gapBoolean: bool, captureGap: bool, idsPresent: bool, idsArray: bool, gapIds: List[GapId] }
pure def safeBrowserInt(number: int): bool = number >= -9007199254740991 and number <= 9007199254740991
pure def admissibleSubmit(submit: BrowserSubmit): bool = submit.formSubmit and submit.originString and submit.documentString and safeBrowserInt(submit.epoch) and safeBrowserInt(submit.observedAt) and submit.credentialMarkerValid
pure def activityValid(activity: Activity): bool =
  activity.eventsArray and activity.events.length() <= 256 and activity.events.every(admissibleSubmit) and activity.overflowBoolean and activity.gapBoolean and
  (not(activity.idsPresent) or (activity.idsArray and activity.gapIds.length() <= 256 and activity.gapIds.every(id => id.idString and id.idUnits == 36 and id.lowerHexOrHyphen) and (activity.gapIds.length() == 0 or activity.captureGap)))
pure def earlierSubmit(submit: BrowserSubmit, origin: str, epoch: int): bool = not(submit.credential) and submit.origin == origin and submit.epoch < epoch
pure def activityQuestion(activity: Activity, origin: str, epoch: int, remainingGaps: int, answered: bool): str =
  if (not(activity.present)) "continue"
  else if (not(activityValid(activity))) "invalid-evidence"
  else if (not(answered) and (activity.overflow or remainingGaps > 0 or activity.events.some(submit => earlierSubmit(submit, origin, epoch)))) "manual-activity"
  else "continue"
pure def lawMalformedEvidenceCannotBeAcknowledged(activity: Activity, origin: str, epoch: int, remainingGaps: int, answered: bool): bool =
  activity.present and not(activityValid(activity)) implies activityQuestion(activity, origin, epoch, remainingGaps, answered) == "invalid-evidence"
pure def lawOverflowNeedsAnExactAnswer(activity: Activity, origin: str, epoch: int, remainingGaps: int): bool =
  activity.present and activityValid(activity) and activity.overflow implies activityQuestion(activity, origin, epoch, remainingGaps, false) == "manual-activity"
pure val submitOne: BrowserSubmit = { formSubmit: true, originString: true, documentString: true, origin: "site", documentId: "doc1", epoch: 1, observedAt: 5, credentialMarkerValid: true, credential: false, idPresent: true, eventId: "event1" }
pure val emptyActivity: Activity = { present: true, eventsArray: true, events: List(), overflowBoolean: true, overflow: false, gapBoolean: true, captureGap: false, idsPresent: false, idsArray: true, gapIds: List() }
pure val activityValues = Set(emptyActivity, { ...emptyActivity, overflow: true }, { ...emptyActivity, captureGap: true }, { ...emptyActivity, events: List(submitOne) }, { ...emptyActivity, events: List({ ...submitOne, credential: true }) }, { ...emptyActivity, events: List({ ...submitOne, credentialMarkerValid: false }) }, { ...emptyActivity, events: List({ ...submitOne, idPresent: false }) }, { ...emptyActivity, idsPresent: true, gapIds: List({ idString: true, idUnits: 36, lowerHexOrHyphen: true }) })
pure val originValues = Set("site", "foreign")
pure val epochValues = Set(0, 1, 2, 3)
pure val remainingGapsValues = Set(0, 1, 2)
```

### A named gap can follow the upstream's own pointed form for only one observation

The workflow consumes its pointed-form record at entry to the next refresh even if that refresh later fails. It may explain precisely one remaining named gap if the point was shown before any unresolved gap, the browser stayed in that epoch and document, and the canonical address changed. Addresses exclude fragments. The explained identity is the tuple of epoch, document and gap ID. An unnamed gap stays unexplained by this upstream route. Overflow or a qualifying older submit still gives the question after this exemption. This predicate takes the number and name status after filtering already explained gaps.

```quint
type UpstreamPoint = { pointExists: bool, gapAlreadyOpen: bool, sameEpoch: bool, pointedDocumentString: bool, sameDocument: bool, pointAddressPresent: bool, readAddressPresent: bool, addressChanged: bool }
pure def explainsNamedGap(point: UpstreamPoint, remainingGaps: int, namedGap: bool): bool =
  remainingGaps == 1 and namedGap and point.pointExists and not(point.gapAlreadyOpen) and point.sameEpoch and point.pointedDocumentString and point.sameDocument and point.pointAddressPresent and point.readAddressPresent and point.addressChanged
pure def lawAnonymousGapIsNeverExplained(point: UpstreamPoint, remainingGaps: int): bool = not(explainsNamedGap(point, remainingGaps, false))
pure def lawOtherDocumentCannotExplainGap(point: UpstreamPoint, remainingGaps: int, namedGap: bool): bool =
  not(point.sameDocument and point.sameEpoch) implies not(explainsNamedGap(point, remainingGaps, namedGap))
pure val activePoint: UpstreamPoint = { pointExists: true, gapAlreadyOpen: false, sameEpoch: true, pointedDocumentString: true, sameDocument: true, pointAddressPresent: true, readAddressPresent: true, addressChanged: true }
pure val pointValues = Set(activePoint, { ...activePoint, gapAlreadyOpen: true }, { ...activePoint, sameDocument: false }, { ...activePoint, addressChanged: false }, { ...activePoint, pointExists: false })
```

## Story: Let a known harmless form step explain only its own readback

### Each observed submit must fit its own closed window

Grace opens an in-memory window only for a shown person step on a known form at the task origin, on a page whose form controls neither pay nor send and whose protected classifications name no card, bank, account or routing field. The chosen step itself must neither pay nor send. Each opening retains the step identity, epoch, document, origin and the event IDs already present. Showing the same open step again retains its original window. Grace keeps at most 64 windows, dropping the oldest on overflow.

A different shown step closes open windows at its current event IDs. A failed read poisons the window. A close in the same epoch and document also poisons it if the page's form controls are no longer quiet or the new step may pay or send. The window only matches a recorded string event ID absent at opening and present at closing with the exact origin, epoch and document. For automatic attribution the current read must be at the task origin, have no gap flag, no named gaps, explicitly report no overflow and have at least one earlier qualifying submit. Every earlier qualifying submit then takes the first unused matching window in displayed order. The same window is never reused in one evaluation. Credential and other-origin events do not participate. Neither time order nor a count of submits can replace their event IDs.

```quint
type SubmitWindow = { stepKey: str, origin: str, documentId: str, epoch: int, beforeIds: List[str], afterIds: List[str], closed: bool, poisoned: bool }
type ShownFormStep = { stepKey: str, origin: str, documentId: str, epoch: int, idsKnown: bool, ids: List[str], isPerson: bool, knownControl: bool, hasFormIndex: bool, sameTaskOrigin: bool, quiet: bool, commits: bool }
pure def openCandidate(shown: ShownFormStep): bool = shown.stepKey != "" and shown.isPerson and shown.knownControl and shown.hasFormIndex and shown.sameTaskOrigin and shown.quiet and not(shown.commits) and shown.idsKnown
pure def closesWindow(window: SubmitWindow, shown: ShownFormStep): bool =
  not(window.closed) and (shown.stepKey == "" or window.stepKey != shown.stepKey)
pure def closeForStep(window: SubmitWindow, shown: ShownFormStep): SubmitWindow =
  if (not(closesWindow(window, shown))) window else {
    ...window, closed: true, afterIds: if (shown.idsKnown) shown.ids else List(),
    poisoned: window.poisoned or not(shown.idsKnown) or (window.epoch == shown.epoch and window.documentId == shown.documentId and (not(shown.quiet) or shown.commits))
  }
pure def openedWindow(shown: ShownFormStep): SubmitWindow = { stepKey: shown.stepKey, origin: shown.origin, documentId: shown.documentId, epoch: shown.epoch, beforeIds: shown.ids, afterIds: List(), closed: false, poisoned: false }
pure def recordShown(windows: List[SubmitWindow], shown: ShownFormStep): List[SubmitWindow] = {
  val closed = windows.listMap(window => closeForStep(window, shown))
  if (not(openCandidate(shown)) or closed.some(window => not(window.closed) and window.stepKey == shown.stepKey)) closed
  else if (closed.length() >= 64) closed.removeAt(0).append(openedWindow(shown))
  else closed.append(openedWindow(shown))
}
pure def fitsWindow(submit: BrowserSubmit, window: SubmitWindow): bool =
  submit.idPresent and window.closed and not(window.poisoned) and window.epoch == submit.epoch and window.documentId == submit.documentId and window.origin == submit.origin and not(window.beforeIds.includes(submit.eventId)) and window.afterIds.includes(submit.eventId)
type MatchingWindow = { index: int, picked: int }
pure def firstUnusedMatch(windows: List[SubmitWindow], submit: BrowserSubmit, used: List[int]): int =
  windows.foldl({ index: 0, picked: -1 }, (walk, window) => { index: walk.index + 1, picked: if (walk.picked >= 0) walk.picked else if (not(used.includes(walk.index)) and fitsWindow(submit, window)) walk.index else -1 }).picked
type WindowAttribution = { used: List[int], unassigned: bool, sawEarlier: bool }
pure val noAttribution: WindowAttribution = { used: List(), unassigned: false, sawEarlier: false }
pure def attributeSubmit(walk: WindowAttribution, submit: BrowserSubmit, windows: List[SubmitWindow], origin: str, epoch: int): WindowAttribution = {
  val matchIndex = if (earlierSubmit(submit, origin, epoch) and not(walk.unassigned)) firstUnusedMatch(windows, submit, walk.used) else -1
  if (walk.unassigned or not(earlierSubmit(submit, origin, epoch))) walk
  else if (matchIndex < 0) { ...walk, unassigned: true, sawEarlier: true }
  else { used: walk.used.append(matchIndex), unassigned: false, sawEarlier: true }
}
pure def pointedOnly(activity: Activity, windows: List[SubmitWindow], origin: str, epoch: int, sameTaskOrigin: bool): bool = {
  val attributed = activity.events.foldl(noAttribution, (walk, submit) => attributeSubmit(walk, submit, windows, origin, epoch))
  activity.present and activityValid(activity) and sameTaskOrigin and not(activity.overflow or activity.captureGap) and activity.gapIds.length() == 0 and attributed.sawEarlier and not(attributed.unassigned)
}
pure def lawEventMustAppearWithinWindow(submit: BrowserSubmit, window: SubmitWindow): bool =
  fitsWindow(submit, window) implies window.afterIds.includes(submit.eventId) and not(window.beforeIds.includes(submit.eventId)) and window.closed and not(window.poisoned)
pure def lawSameDocumentUnsafeCloseIsPoisoned(window: SubmitWindow, shown: ShownFormStep): bool =
  closesWindow(window, shown) and window.epoch == shown.epoch and window.documentId == shown.documentId and (not(shown.quiet) or shown.commits) implies closeForStep(window, shown).poisoned
pure def lawOverflowOrGapCannotBeAttributed(activity: Activity, windows: List[SubmitWindow], origin: str, epoch: int, sameTaskOrigin: bool): bool =
  activity.overflow or activity.captureGap or activity.gapIds.length() != 0 implies not(pointedOnly(activity, windows, origin, epoch, sameTaskOrigin))
pure val showsHarmless: ShownFormStep = { stepKey: "search", origin: "site", documentId: "doc1", epoch: 1, idsKnown: true, ids: List(), isPerson: true, knownControl: true, hasFormIndex: true, sameTaskOrigin: true, quiet: true, commits: false }
pure val closedSearch: SubmitWindow = { stepKey: "search", origin: "site", documentId: "doc1", epoch: 1, beforeIds: List(), afterIds: List("event1"), closed: true, poisoned: false }
pure val shownValues = Set(showsHarmless, { ...showsHarmless, stepKey: "result", ids: List("event1") }, { ...showsHarmless, stepKey: "pay", ids: List("event1"), commits: true }, { ...showsHarmless, stepKey: "", idsKnown: false }, { ...showsHarmless, sameTaskOrigin: false })
pure val windowValues = Set(closedSearch, { ...closedSearch, closed: false }, { ...closedSearch, poisoned: true })
pure val windowsValues = Set(List(), List(closedSearch), List({ ...closedSearch, closed: false }), List({ ...closedSearch, poisoned: true }))
pure val submitValues = Set(submitOne, { ...submitOne, documentId: "doc2" }, { ...submitOne, idPresent: false }, { ...submitOne, origin: "foreign" })
```

### A host answer can cover a harmless landing and expires at the next risky page change

A separate Grace host check can acknowledge the exact `manual-activity` question for a harmless person step's landing. The original shown page was quiet and had no capture gap. The expected landing is either the next address allowed by the step or a same-address page change when the step allows any landing. The browser must report a gap at the current task origin with a readable event array, no overflow and no earlier same-origin noncredential event. This path can cover an anonymous gap. The guide uses the question key it actually received and then reads again. It does not invent permission or waive any later question.

A changed or unreadable page without a waiting step withdraws host answers. With a waiting step, such a change withdraws them if the step may pay or send, belongs to Grace, or was shown on a page that was not quiet. A different readable address always withdraws the old answers. A landing outside the address allowed by a waiting step asks about the page change. Person-supplied acknowledgements are owned by the upstream workflow and are excluded from the host withdrawal. These rules cover answer custody; a separate policy determines whether the selected control can pay or send.

```quint
type WaitingPage = { waits: bool, theirs: bool, commits: bool, quietBefore: bool, gapBefore: bool, leadsAnywhere: bool, exactDestination: bool, readable: bool, pageUnchanged: bool, addressPresent: bool, addressChanged: bool }
pure def landingEligible(waiting: WaitingPage): bool =
  waiting.waits and waiting.readable and waiting.theirs and not(waiting.commits or waiting.gapBefore) and waiting.quietBefore and
  (if (waiting.addressPresent and waiting.addressChanged) waiting.leadsAnywhere or waiting.exactDestination
   else not(waiting.pageUnchanged) and waiting.leadsAnywhere)
pure def onlyLandingGap(activity: Activity, origin: str, epoch: int, sameTaskOrigin: bool): bool =
  activity.present and activityValid(activity) and activity.captureGap and not(activity.overflow) and sameTaskOrigin and not(activity.events.some(submit => earlierSubmit(submit, origin, epoch)))
pure def hostCoversLanding(waiting: WaitingPage, activity: Activity, origin: str, epoch: int, sameTaskOrigin: bool, manualQuestion: bool): bool =
  manualQuestion and landingEligible(waiting) and onlyLandingGap(activity, origin, epoch, sameTaskOrigin)
pure def withdrawHostAnswer(waiting: WaitingPage): bool =
  if (not(waiting.waits)) not(waiting.readable and waiting.pageUnchanged)
  else (not(waiting.readable and waiting.pageUnchanged) and (waiting.commits or not(waiting.theirs) or not(waiting.quietBefore))) or (waiting.readable and waiting.addressPresent and waiting.addressChanged)
pure def lawCommitLandingNeverExplainsGap(waiting: WaitingPage, activity: Activity, origin: str, epoch: int, sameTaskOrigin: bool, manualQuestion: bool): bool =
  waiting.commits or not(waiting.quietBefore) implies not(hostCoversLanding(waiting, activity, origin, epoch, sameTaskOrigin, manualQuestion))
pure def lawUnreadableRiskyPageDropsHostAnswer(waiting: WaitingPage): bool =
  not(waiting.readable) and (not(waiting.waits) or waiting.commits or not(waiting.theirs) or not(waiting.quietBefore)) implies withdrawHostAnswer(waiting)
pure val expectedLanding: WaitingPage = { waits: true, theirs: true, commits: false, quietBefore: true, gapBefore: false, leadsAnywhere: true, exactDestination: false, readable: true, pageUnchanged: false, addressPresent: true, addressChanged: true }
pure val waitingValues = Set(expectedLanding, { ...expectedLanding, leadsAnywhere: false }, { ...expectedLanding, commits: true }, { ...expectedLanding, gapBefore: true }, { ...expectedLanding, quietBefore: false }, { ...expectedLanding, readable: false }, { ...expectedLanding, waits: false }, { ...expectedLanding, addressChanged: false }, { ...expectedLanding, addressChanged: false, pageUnchanged: true })
```
