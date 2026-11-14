# Grace OTA WebView health evidence

Grace `48b43b9c` calls `OtaUiProbe` from `MainActivity.java` on resume,
pause, renderer loss, and destruction. `OtaUiProbe.java` imports Eliza
`7743504b`'s `WebViewHealthObserver.java` under
`plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/health`.
`OtaHealthService.java` takes the UI observation through the observer
with a UI deadline capped at 1,500 milliseconds and by the enclosing
request deadline.
The service exposes the result as three fields of native health evidence.
[Installation health](./mobileInstall.md) owns qualification against a
specific installation and recovery plan. This model ends at the three
UI fields. The authenticated request, installed package identity,
runtime and storage observations, and final probation verdict belong
to the surrounding service and updater.

Grace's `OtaUiProbeInstrumentedTest.java` uses the pinned
`WebViewHealthObserverContract.java` for observer lifecycle and held callback
cases, then exercises the product DOM policy. The OTA health runner
`apps/updater/scripts/test-android-ota-health.mjs` stages this test and
the updater integration tests. Grace's `native-shell-state.test.mjs`
exercises activity shell lifecycle in a JVM, and `ota-local-health.test.mjs`
exercises the separate local gateway health port.

## Story: Observe the installed UI without bringing another screen to the foreground

### The observer reads only a current view and reports absent and background accurately

Main-thread lifecycle callbacks bind an Activity and WebView on
resume. A new resume retires the current evaluation, even when the
Activity identity stays the same. Only the current Activity's pause,
renderer loss, or destruction can retire that binding's evaluation.
Pause retains the weak references and marks the binding background.
Destroy clears them. A detached Activity yields `absent`. An Activity
with no live renderer, no active resume, a finishing or destroyed state,
or a view without visibility or focus yields `background`. Neither
receipt says the renderer responded or content was present. The observer
does not launch, resume, or repair the UI.

The native shell provides Activity, WebView and request identities
from actual object references and lifecycle callbacks. It samples
weak-reference presence and foreground facts on the main thread when
dispatching a read. Callback identity cannot come from page data.
An off-main reader posts to the main loop, where admission rejects
a deadline that has already arrived, then reads the current binding.
Blocking the main thread is refused. The model uses the main-loop
admission step to sample facts, with an elapsed monotonic clock and
process-local counters that stand for native identities.

Discovered by the proof: only positive identities represent actual
native objects. Admission treats an absent identity as missing and
never lets an invalid counter qualify a foreground lease.

```quint
type UiReply = NoUiReply | UiAbsent | UiBackground | UiForegroundEmpty | UiForegroundContent |
  UiMainThread | UiExpired | UiBusy | UiWrongOrigin | UiBindingChanged | UiInvalidAnswer | UiEvaluationFailed | UiEnded
type UiProjection = { activityState: str, rendererResponsive: bool, contentPresent: bool }
pure def uiEvidence(reply: UiReply): UiProjection =
  if (reply == UiAbsent) { activityState: "absent", rendererResponsive: false, contentPresent: false }
  else if (reply == UiBackground) { activityState: "background", rendererResponsive: false, contentPresent: false }
  else if (reply == UiForegroundEmpty or reply == UiForegroundContent)
    { activityState: "foreground", rendererResponsive: true, contentPresent: reply == UiForegroundContent }
  else { activityState: "", rendererResponsive: false, contentPresent: false }
pure def lawUiContentRequiresForegroundRenderer(reply: UiReply): bool =
  uiEvidence(reply).contentPresent implies
    uiEvidence(reply).activityState == "foreground" and uiEvidence(reply).rendererResponsive
pure def lawBackgroundHealthCarriesNoRendererEvidence(reply: UiReply): bool =
  reply == UiAbsent or reply == UiBackground implies
    not(uiEvidence(reply).rendererResponsive or uiEvidence(reply).contentPresent)

type UiBinding = { activityRef: int, viewRef: int, resumed: bool, epoch: int }
type UiLease = { id: int, binding: UiBinding, deadline: int, url: str }
type UiSettlement = { leaseId: int, reply: UiReply }
type UiHealth = { clock: int, binding: UiBinding, issued: int, pending: UiLease,
  admission: UiSettlement, settled: UiSettlement }
pure val absentBinding: UiBinding = { activityRef: 0, viewRef: 0, resumed: false, epoch: 0 }
pure val noLease: UiLease = { id: 0, binding: absentBinding, deadline: 0, url: "" }
pure val noSettlement: UiSettlement = { leaseId: 0, reply: NoUiReply }
pure val initial: UiHealth = { clock: 0, binding: absentBinding, issued: 0, pending: noLease,
  admission: noSettlement, settled: noSettlement }
pure def retireUi(reply: UiReply, s: UiHealth): UiHealth =
  if (s.pending.id > 0) {
    ...s, pending: noLease, settled: { leaseId: s.pending.id, reply: reply }
  } else s
pure def canResumeUi(s: UiHealth, activityRef: int, viewRef: int): bool = activityRef > 0 and viewRef > 0
pure def resumeUi(s: UiHealth, activityRef: int, viewRef: int): UiHealth =
  { ...retireUi(UiBindingChanged, s),
    binding: { activityRef: activityRef, viewRef: viewRef, resumed: true, epoch: s.binding.epoch + 1 } }
pure def canLeaveUi(s: UiHealth, activityRef: int, destroyed: bool): bool = activityRef > 0 and activityRef == s.binding.activityRef
pure def leaveUi(s: UiHealth, activityRef: int, destroyed: bool): UiHealth = {
  val binding = if (destroyed) absentBinding else s.binding
  { ...retireUi(UiBindingChanged, s), binding: { ...binding, resumed: false, epoch: s.binding.epoch + 1 } }
}
pure def canAdvanceUiClock(s: UiHealth, elapsed: int): bool = elapsed > s.clock
pure def advanceUiClock(s: UiHealth, elapsed: int): UiHealth = { ...s, clock: elapsed }
pure val activityRefValues = Set(0, 1, 2)
pure val viewRefValues = Set(0, 11, 12)
pure val elapsedValues = Set(1, 1499, 1500, 1501, 3000)
pure def alwaysObservationLeaseKeepsCurrentBinding(s: UiHealth): bool =
  s.pending.id > 0 implies s.pending.binding == s.binding and s.binding.resumed and
    s.binding.activityRef > 0 and s.binding.viewRef > 0
pure def alwaysUiLeaseIdentityIsAllocated(s: UiHealth): bool =
  s.issued >= 0 and s.pending.id >= 0 and s.pending.id <= s.issued and
    s.admission.leaseId >= 0 and s.admission.leaseId <= s.issued and
    s.settled.leaseId >= 0 and s.settled.leaseId <= s.issued
pure def stepLifecycleRetiresTheWebViewEvaluation(before: UiHealth, via: str, after: UiHealth): bool =
  via == "resumeUi" or via == "leaveUi" implies
    after.pending.id == 0 and after.binding.epoch == before.binding.epoch + 1
```

### A foreground read admits one exact-origin evaluation ahead of its deadline

Before evaluating, the main-loop read admits only a live, shown, focused
WebView bound to a resumed Activity. A previous unexpired evaluation
makes another eligible read busy. An expired evaluation is retired
before the next eligible read may take its place. The URL observed
before evaluation must have the configured HTTPS scheme and exact
encoded authority, `https://localhost` in Grace. It may contain a path.
The observer captures the full original URL for the callback check.
The shell checks URL parsing and encoded authority against the configured
origin. Invalid configuration and non-native lifecycle calls are rejected
by the native port before invoking this model.

The native helper instruments a read-only script. The script first requires
the exact JavaScript origin, then Grace's policy requires a visible
`#root main` with nonblank text and a visible button, input, textarea, or
link with an `href`. The shared visibility check rejects a hidden, collapsed,
`display:none`, or zero-opacity ancestor and requires a nonempty bounding
rectangle that intersects the viewport. The model consumes these DOM facts
from evaluation in the captured WebView. The renderer returns a literal
boolean result and supplies no health authority beyond those observations.

```quint
type UiReadFacts = { offMain: bool, activityAlive: bool, viewAlive: bool, activityUsable: bool,
  viewShown: bool, viewFocused: bool, admittedOrigin: bool, observedUrl: str }
pure def classifyUiRead(s: UiHealth, deadline: int, facts: UiReadFacts): UiReply =
  if (not(facts.offMain)) UiMainThread
  else if (deadline <= s.clock) UiExpired
  else if (s.binding.activityRef <= 0 or not(facts.activityAlive)) UiAbsent
  else if (s.binding.viewRef <= 0 or not(s.binding.resumed and facts.viewAlive and facts.activityUsable and
    facts.viewShown and facts.viewFocused)) UiBackground
  else if (s.pending.id > 0 and s.clock < s.pending.deadline) UiBusy
  else if (not(facts.admittedOrigin) or facts.observedUrl == "") UiWrongOrigin
  else NoUiReply
pure def uiReadReachedOrigin(reply: UiReply): bool = reply == UiWrongOrigin or reply == NoUiReply
pure def inspectUi(s: UiHealth, deadline: int, facts: UiReadFacts): UiHealth = {
  val reply = classifyUiRead(s, deadline, facts)
  val ready = if (uiReadReachedOrigin(reply) and s.pending.id > 0 and s.clock >= s.pending.deadline)
    retireUi(UiExpired, s) else s
  val id = s.issued + 1
  { ...ready, issued: id, admission: { leaseId: id, reply: reply },
    pending: if (reply == NoUiReply) { id: id, binding: s.binding, deadline: deadline, url: facts.observedUrl }
      else ready.pending }
}
pure val goodUiFacts: UiReadFacts = { offMain: true, activityAlive: true, viewAlive: true, activityUsable: true,
  viewShown: true, viewFocused: true, admittedOrigin: true, observedUrl: "https://localhost/one" }
pure val factsValues = Set(goodUiFacts, { ...goodUiFacts, offMain: false }, { ...goodUiFacts, activityAlive: false },
  { ...goodUiFacts, viewAlive: false }, { ...goodUiFacts, viewShown: false }, { ...goodUiFacts, viewFocused: false },
  { ...goodUiFacts, admittedOrigin: false, observedUrl: "https://other.example/one" })
pure val deadlineValues = Set(0, 1500, 3000, 4500)
pure def lawUiEvaluationNeedsForegroundAndTime(s: UiHealth, deadline: int, facts: UiReadFacts): bool =
  classifyUiRead(s, deadline, facts) == NoUiReply implies facts.offMain and deadline > s.clock and s.binding.resumed and
    s.binding.activityRef > 0 and s.binding.viewRef > 0 and facts.activityAlive and facts.viewAlive and
    facts.activityUsable and facts.viewShown and facts.viewFocused and facts.admittedOrigin
pure def stepBusyReadPreservesThePendingEvaluation(before: UiHealth, via: str, after: UiHealth): bool =
  via == "inspectUi" and after.admission.reply == UiBusy implies
    before.pending.id > 0 and before.pending.deadline > before.clock and after.pending == before.pending
pure def stepNewUiEvaluationIsBoundToTheRead(before: UiHealth, via: str, after: UiHealth): bool =
  via == "inspectUi" and after.admission.reply == NoUiReply implies
    after.pending.id == after.admission.leaseId and after.pending.id > before.issued and
    after.pending.binding == before.binding and after.pending.deadline > before.clock
type UiVisibility = { present: bool, ancestorsVisible: bool, rectNonempty: bool, intersectsViewport: bool }
pure def healthElementVisible(element: UiVisibility): bool =
  element.present and element.ancestorsVisible and element.rectNonempty and element.intersectsViewport
pure val visibleUiElement: UiVisibility = { present: true, ancestorsVisible: true, rectNonempty: true, intersectsViewport: true }
pure val elementValues = Set(visibleUiElement, { ...visibleUiElement, present: false },
  { ...visibleUiElement, ancestorsVisible: false }, { ...visibleUiElement, rectNonempty: false },
  { ...visibleUiElement, intersectsViewport: false })
type UiDomFacts = { exactJavaScriptOrigin: bool, mainVisible: bool, mainTextPresent: bool, actionVisible: bool }
pure def graceDomAnswer(dom: UiDomFacts): bool =
  dom.exactJavaScriptOrigin and dom.mainVisible and dom.mainTextPresent and dom.actionVisible
pure val healthyDom: UiDomFacts = { exactJavaScriptOrigin: true, mainVisible: true, mainTextPresent: true, actionVisible: true }
pure val domValues = Set(healthyDom, { ...healthyDom, mainVisible: false }, { ...healthyDom, actionVisible: false },
  { ...healthyDom, exactJavaScriptOrigin: false })
pure def lawGraceDomNeedsVisibleInteraction(dom: UiDomFacts): bool =
  graceDomAnswer(dom) implies dom.exactJavaScriptOrigin and dom.mainVisible and dom.mainTextPresent and dom.actionVisible
```

## Story: Keep delayed renderer replies from changing another health observation

### A callback can settle only its original unexpired and unchanged evaluation

The callback checks its own lease, elapsed time, lifecycle generation,
Activity and renderer identity, resumed state, current focus, and the
exact original URL. Only the literal renderer results `true` and `false`
are recognized. Both produce responsive foreground evidence. Only
`true` marks content present. Other values, such as a quoted string,
fail the observation. The source takes visibility and Activity finishing
checks at admission and samples focus and URL again at callback. No DOM
read alone yields a usability or overall update-health verdict.

An evaluation call can throw on the main loop. Deadline or interruption
of the reader schedules retirement of its own unresolved lease on the
main loop. WebView can deliver that callback after retirement. Delivery
or cleanup for any retired lease has no effect on a newer lease, even
when it belongs to the same view and URL. The model retains the last
admission reply and last evaluation settlement as evidence of those
separate outcomes. Receipts are associated with the request that
produced them and never reused as a later request's result.

```quint
type UiCallback = { leaseId: int, currentActivity: int, currentView: int, focused: bool, currentUrl: str, rawAnswer: str }
pure def ownsUiEvaluation(s: UiHealth, id: int): bool = id > 0 and s.pending.id == id
pure def classifyUiCallback(s: UiHealth, callback: UiCallback): UiReply =
  if (s.clock >= s.pending.deadline) UiExpired
  else if (s.binding != s.pending.binding or not(s.binding.resumed and callback.focused) or
    s.binding.activityRef != callback.currentActivity or s.binding.viewRef != callback.currentView or
    s.pending.url != callback.currentUrl) UiBindingChanged
  else if (callback.rawAnswer == "true") UiForegroundContent
  else if (callback.rawAnswer == "false") UiForegroundEmpty
  else UiInvalidAnswer
pure def deliverUiCallback(s: UiHealth, callback: UiCallback): UiHealth =
  if (ownsUiEvaluation(s, callback.leaseId)) retireUi(classifyUiCallback(s, callback), s) else s
pure def failUiEvaluation(s: UiHealth, leaseId: int): UiHealth =
  if (ownsUiEvaluation(s, leaseId)) retireUi(UiEvaluationFailed, s) else s
pure def endUiRead(s: UiHealth, leaseId: int, timedOut: bool): UiHealth =
  if (ownsUiEvaluation(s, leaseId)) retireUi(if (timedOut) UiExpired else UiEnded, s) else s
pure val firstCallback: UiCallback = { leaseId: 1, currentActivity: 1, currentView: 11, focused: true,
  currentUrl: "https://localhost/one", rawAnswer: "true" }
pure val callbackValues = Set(firstCallback, { ...firstCallback, rawAnswer: "false" },
  { ...firstCallback, rawAnswer: "null" }, { ...firstCallback, currentUrl: "https://localhost/two" },
  { ...firstCallback, leaseId: 2 }, { ...firstCallback, currentView: 12 },
  { ...firstCallback, leaseId: 2, currentView: 12 }, { ...firstCallback, focused: false },
  { ...firstCallback, leaseId: 3 }, { ...firstCallback, leaseId: 4 })
pure val leaseIdValues = Set(0, 1, 2, 3, 4)
pure val weight_resumeUi = 8
pure val weight_inspectUi = 18
pure val weight_deliverUiCallback = 18
pure def lawUiReplyRequiresTheUnchangedWebView(s: UiHealth, callback: UiCallback): bool =
  ownsUiEvaluation(s, callback.leaseId) and uiEvidence(classifyUiCallback(s, callback)).rendererResponsive implies
    s.clock < s.pending.deadline and s.pending.binding == s.binding and s.binding.resumed and callback.focused and
    s.binding.activityRef == callback.currentActivity and s.binding.viewRef == callback.currentView and
    s.pending.url == callback.currentUrl and (callback.rawAnswer == "true" or callback.rawAnswer == "false")
pure def lawStaleUiCallbackCannotSettleNewerRead(s: UiHealth, callback: UiCallback): bool =
  not(ownsUiEvaluation(s, callback.leaseId)) implies deliverUiCallback(s, callback) == s
pure def lawStaleReadCleanupCannotSettleNewerRead(s: UiHealth, leaseId: int, timedOut: bool): bool =
  not(ownsUiEvaluation(s, leaseId)) implies endUiRead(s, leaseId, timedOut) == s
pure def stepEvaluatedUiReplyConsumesItsOwnLease(before: UiHealth, via: str, after: UiHealth): bool =
  via == "deliverUiCallback" and before.settled != after.settled implies
    before.pending.id > 0 and after.pending.id == 0 and after.settled.leaseId == before.pending.id and
      (uiEvidence(after.settled.reply).rendererResponsive implies before.clock < before.pending.deadline)
pure def sometimesAbsentUi(s: UiHealth): bool = s.admission.reply == UiAbsent
pure def sometimesBackgroundUi(s: UiHealth): bool = s.admission.reply == UiBackground
pure def sometimesBusyUiRead(s: UiHealth): bool = s.admission.reply == UiBusy
pure def sometimesUiContentPresent(s: UiHealth): bool = s.settled.reply == UiForegroundContent
pure def sometimesResponsiveUiWithoutContent(s: UiHealth): bool = s.settled.reply == UiForegroundEmpty
pure def sometimesUiEvaluationExpires(s: UiHealth): bool = s.settled.reply == UiExpired
pure def sometimesUiChangedWhileReading(s: UiHealth): bool = s.settled.reply == UiBindingChanged
```
