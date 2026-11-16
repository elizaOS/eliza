# Installed WebView health evidence

A consumer's main activity reports resume, pause, renderer loss and
destruction to its UI health observer, which reads the installed app's
WebView without changing what the person sees. The result is three fields
of native health evidence, read within a UI deadline the
[runtime health service](./runtimeHealth.md) caps; the
[installation journal](./install.md) qualifies them against a plan.

## Story: Observe the installed UI without bringing another screen to the foreground

> As the updater, I want to observe the installed app's interface without
> changing what the device owner sees, so that health checking never
> interrupts them and reports an absent or background screen honestly.

### The observer reads only a current view and reports absent and background accurately

Main-thread lifecycle callbacks bind an Activity and WebView on
resume. A new resume retires the current evaluation, even when the
Activity identity stays the same. Only the current Activity's pause,
renderer loss, or destruction can retire that binding's evaluation.
Pause retains the weak references and marks the binding background.
Destroy clears them. A detached Activity yields absent. An Activity with
no live renderer, no active resume, a finishing or destroyed state, or a
view without visibility or focus yields background. Neither says the
renderer responded or content was present. The observer does not launch,
resume or repair the UI. Activity, WebView and request identities come
from native object references and lifecycle callbacks, never from page
data; a read posted from off the main thread is admitted on the main loop
against an elapsed monotonic clock, and blocking the main thread is
refused.

```quint
type UiReply = NoUiReply | UiAbsent | UiBackground | UiForegroundEmpty | UiForegroundContent |
  UiMainThread | UiExpired | UiBusy | UiWrongOrigin | UiBindingChanged | UiInvalidAnswer | UiEvaluationFailed | UiEnded
type ActivityState = ActivityUnknown | ActivityAbsent | ActivityBackground | ActivityForeground
type UiProjection = { activityState: ActivityState, rendererResponsive: bool, contentPresent: bool }
pure def uiEvidence(reply: UiReply): UiProjection =
  if (reply == UiAbsent) { activityState: ActivityAbsent, rendererResponsive: false, contentPresent: false }
  else if (reply == UiBackground) { activityState: ActivityBackground, rendererResponsive: false, contentPresent: false }
  else if (reply == UiForegroundEmpty or reply == UiForegroundContent)
    { activityState: ActivityForeground, rendererResponsive: true, contentPresent: reply == UiForegroundContent }
  else { activityState: ActivityUnknown, rendererResponsive: false, contentPresent: false }
pure def lawUiContentRequiresForegroundRenderer(reply: UiReply): bool =
  uiEvidence(reply).contentPresent implies
    uiEvidence(reply).activityState == ActivityForeground and uiEvidence(reply).rendererResponsive
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
pure def stepLifecycleRetiresTheWebViewEvaluation(before: UiHealth, via: str, after: UiHealth): bool =
  via == "resumeUi" or via == "leaveUi" implies
    after.pending.id == 0 and after.binding.epoch == before.binding.epoch + 1
```

### Only an issued positive identity stands for a native object

Discovered by the proof: without it, an absent identity or a counter
never issued could qualify a foreground lease. Every lease, admission and
settlement names an identity no greater than the last one issued, and
zero means none.

```quint
pure def alwaysUiLeaseIdentityIsAllocated(s: UiHealth): bool =
  s.issued >= 0 and s.pending.id >= 0 and s.pending.id <= s.issued and
    s.admission.leaseId >= 0 and s.admission.leaseId <= s.issued and
    s.settled.leaseId >= 0 and s.settled.leaseId <= s.issued
```

### A foreground read admits one exact-origin evaluation ahead of its deadline

Before evaluating, the main-loop read admits only a live, shown, focused
WebView bound to a resumed Activity. A previous unexpired evaluation
makes another eligible read busy. An expired evaluation is retired
before the next eligible read may take its place. The URL observed
before evaluation must have the configured HTTPS scheme and exact
encoded authority, for example `https://localhost`; it may contain a path,
and the full URL is captured for the callback check.

A read-only script first requires the exact JavaScript origin; the health
DOM policy then requires a visible main region with nonblank text and a
visible button, input, textarea or link. A visible element is present,
has no hidden ancestor, and has a nonempty rectangle that intersects the
viewport. The renderer returns a literal boolean and supplies no health
authority beyond those observations.

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
pure def domPolicyAnswer(dom: UiDomFacts): bool =
  dom.exactJavaScriptOrigin and dom.mainVisible and dom.mainTextPresent and dom.actionVisible
pure val healthyDom: UiDomFacts = { exactJavaScriptOrigin: true, mainVisible: true, mainTextPresent: true, actionVisible: true }
pure val domValues = Set(healthyDom, { ...healthyDom, mainVisible: false }, { ...healthyDom, actionVisible: false },
  { ...healthyDom, exactJavaScriptOrigin: false })
```

## Story: Keep delayed renderer replies from changing another health observation

> As the updater, I want a late renderer reply to settle only the
> observation that asked for it, so that one check's answer never decides
> another's.

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
pure val weight_inspectUi = 8
pure val weight_deliverUiCallback = 8
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
