# Browser surface lifecycle

The browser surface plugin layers one isolated native web surface per
browser tab over the consumer's host WebView, in the host Activity beside
the renderer that commands it. The consumer's renderer owns the tabs; this
spec owns which surfaces exist, which renderer realm may command them,
what the page may receive, Back and the keyboard around the host renderer,
and the helper entry window. Every surface carries an explicit process and
storage policy. [Page requests](./pageRequests.md) owns what a page asks
of the person, and [browser storage](../storage.md) owns profile purges.

## Story: Command only the surfaces of my current renderer

> As the consumer's renderer, I want a reload to take over my own surfaces
> cleanly, so that a stale realm's commands, or commands sent while the
> host renderer is gone, never act on a website.

### A command applies only with the live renderer's current session and epoch, and reconciling an owner destroys every surface it does not list

A renderer identifies itself by owner, a unique session token per
JavaScript realm and a monotonic epoch. `reconcileOwner` adopts a session
and an epoch no older than the current one, and destroys every surface of
a prior realm and every surface it does not list in `desiredIds`, before
the new session issues work. A session that has been replaced, or whose
renderer went away, is retired for good: it can never reconcile or
command again. Any other command names the session and the
epoch it was issued under; native rejects one from another session or an
older epoch, and every command is rejected after the plugin is destroyed.
When Android reports the host renderer process gone, every surface command
is refused until a new realm, with a new session, has reconciled its
owner; nothing sent while it was gone runs later, because it names the old
session. Commands of the new realm then run again. `createSurface` also needs an explicit process and
storage policy and a free id.

```quint
type SurfaceLayer = AboveHost | BelowHost
type NativeSurface = { id: int, session: int, gen: int, layer: SurfaceLayer, profileKey: str, presented: bool, paused: bool,
  occlusionSet: bool, width: int, height: int }
type HelperView = HelperNone | HelperPending | HelperVisible
type BackPhase = BackIdle | BackOfferedToUi | BackToPage | BackToActivity | BackHandledByUi
type HelperEntry = { permission: bool, watcher: bool, entry: HelperView, full: HelperView, overlayParent: bool,
  reconcilePending: bool, inputPending: bool, unsafeInputRestart: bool }
type SurfaceHost = { destroyed: bool, rendererLive: bool, retired: Set[int], session: int, epoch: int, surfaces: List[NativeSurface], issued: int,
  crashReports: List[int], purgeClosed: List[int], helper: HelperEntry, back: BackPhase, pageCanGoBack: bool,
  keyboardVisible: bool, keyboardHeight: int, keyboardReports: int }
pure val idleHelper: HelperEntry = { permission: true, watcher: true, entry: HelperNone, full: HelperNone, overlayParent: false,
  reconcilePending: false, inputPending: false, unsafeInputRestart: false }
pure val initial: SurfaceHost = { destroyed: false, rendererLive: true, retired: Set(), session: 0, epoch: 0, surfaces: List(), issued: 0,
  crashReports: List(), purgeClosed: List(), helper: idleHelper, back: BackIdle, pageCanGoBack: false,
  keyboardVisible: false, keyboardHeight: 0, keyboardReports: 0 }
pure def hasSurface(s: SurfaceHost, id: int): bool = s.surfaces.some(x => x.id == id)
pure def admitsCommand(s: SurfaceHost, session: int, epoch: int): bool =
  not(s.destroyed) and s.rendererLive and session > 0 and session == s.session and epoch == s.epoch
pure def canRendererGone(s: SurfaceHost): bool = s.rendererLive and not(s.destroyed)
pure def retire(s: SurfaceHost): Set[int] = if (s.session > 0) s.retired.union(Set(s.session)) else s.retired
pure def rendererGone(s: SurfaceHost): SurfaceHost = { ...s, rendererLive: false, retired: retire(s) }
pure def canReconcileOwner(s: SurfaceHost, session: int, epoch: int, desiredIds: Set[int]): bool =
  not(s.destroyed) and session > 0 and epoch >= s.epoch and epoch > 0 and not(s.retired.contains(session))
pure def reconcileOwner(s: SurfaceHost, session: int, epoch: int, desiredIds: Set[int]): SurfaceHost =
  { ...s, rendererLive: true, session: session, epoch: epoch, retired: if (session == s.session) s.retired else retire(s), surfaces: s.surfaces.select(x => x.session == session and desiredIds.contains(x.id)) }
pure def canCreateSurface(s: SurfaceHost, session: int, epoch: int, id: int, explicitPolicy: bool, layer: SurfaceLayer, profileKey: str): bool =
  admitsCommand(s, session, epoch) and id > 0 and explicitPolicy and not(hasSurface(s, id))
pure def createSurface(s: SurfaceHost, session: int, epoch: int, id: int, explicitPolicy: bool, layer: SurfaceLayer, profileKey: str): SurfaceHost =
  { ...s, issued: s.issued + 1, surfaces: s.surfaces.append({ id: id, session: session, gen: s.issued + 1, layer: layer, profileKey: profileKey,
    presented: false, paused: false, occlusionSet: false, width: 0, height: 0 }) }
pure def canDestroySurface(s: SurfaceHost, session: int, epoch: int, id: int): bool = admitsCommand(s, session, epoch) and hasSurface(s, id)
pure def destroySurface(s: SurfaceHost, session: int, epoch: int, id: int): SurfaceHost = { ...s, surfaces: s.surfaces.select(x => x.id != id) }
pure def alwaysSurfacesBelongToCurrentSession(s: SurfaceHost): bool = s.surfaces.every(x => x.session == s.session)
pure def uniqueIds(ids: List[int]): bool = ids.every(n => ids.select(m => m == n).length() == 1)
pure def alwaysSurfaceIdsUnique(s: SurfaceHost): bool = uniqueIds(s.surfaces.listMap(x => x.id))
pure def alwaysDestroyedPluginHoldsNothing(s: SurfaceHost): bool = s.destroyed implies s.surfaces.length() == 0
pure def stepEpochNeverGoesBack(before: SurfaceHost, after: SurfaceHost): bool = after.epoch >= before.epoch
pure def stepNoCommandWhileRendererGone(before: SurfaceHost, via: str, after: SurfaceHost): bool =
  (via == "createSurface" or via == "destroySurface" or via == "presentSurface" or via == "setBounds" or
    via == "setOcclusion" or via == "pauseSurface" or via == "resumeSurface") implies before.rendererLive
pure def alwaysLiveSessionIsNotRetired(s: SurfaceHost): bool = s.rendererLive implies not(s.retired.contains(s.session))
pure def stepRetiredSessionNeverReturns(before: SurfaceHost, after: SurfaceHost): bool =
  before.retired.subseteq(after.retired) and not(before.retired.contains(after.session) and after.session != before.session)
pure def sometimesRendererGoneWithSurfaces(s: SurfaceHost): bool = not(s.rendererLive) and s.surfaces.length() > 0 and not(admitsCommand(s, s.session, s.epoch))
pure def sometimesNewRealmRunsAfterOldRetired(s: SurfaceHost): bool =
  s.rendererLive and s.retired.size() > 0 and s.surfaces.length() > 0
pure def sometimesReloadedRendererKeepsListedSurface(s: SurfaceHost): bool = s.epoch > 1 and s.surfaces.some(x => x.session == s.session)
pure val sessionValues = Set(1, 2, 3)
pure val epochValues = Set(1, 2, 3)
pure val idValues = Set(0, 1, 2)
pure val desiredIdsValues = Set(Set(), Set(1), Set(1, 2))
pure val profileKeyValues = Set("", "account1")
```

## Story: Let the page take input only where and when I can see it

> As the person, I want taps to reach a website only when its page is
> presented, running and not under host chrome.

### Presenting one surface hides its siblings, and a page takes input only while presented, resumed and after its occlusion is set

`presentSurface` atomically hides every sibling and presents the named
surface, or none to show the host. `setBounds` places one surface at a
positive size in host pixels with its outer clip, and touches no other
surface. The page takes no input until the first `setOcclusionRects` after
creation, and the rects stay host-owned. `pauseSurface` treats the page as
hidden, takes focus and the keyboard from it and stops its touches until
`resumeSurface`; presenting does not resume it. A paused page still reads
and navigates.

```quint
pure def pageTakesInput(x: NativeSurface): bool = x.presented and not(x.paused) and x.occlusionSet and x.width > 0 and x.height > 0
pure def canPresentSurface(s: SurfaceHost, session: int, epoch: int, id: int): bool = admitsCommand(s, session, epoch) and (id == 0 or hasSurface(s, id))
pure def presentSurface(s: SurfaceHost, session: int, epoch: int, id: int): SurfaceHost =
  { ...s, surfaces: s.surfaces.listMap(x => { ...x, presented: x.id == id }) }
pure def canSetBounds(s: SurfaceHost, session: int, epoch: int, id: int, width: int, height: int): bool =
  admitsCommand(s, session, epoch) and hasSurface(s, id) and width > 0 and height > 0
pure def setBounds(s: SurfaceHost, session: int, epoch: int, id: int, width: int, height: int): SurfaceHost =
  { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id) { ...x, width: width, height: height } else x) }
pure def canSetOcclusion(s: SurfaceHost, session: int, epoch: int, id: int): bool = admitsCommand(s, session, epoch) and hasSurface(s, id)
pure def setOcclusion(s: SurfaceHost, session: int, epoch: int, id: int): SurfaceHost =
  { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id) { ...x, occlusionSet: true } else x) }
pure def canPauseSurface(s: SurfaceHost, session: int, epoch: int, id: int): bool = admitsCommand(s, session, epoch) and s.surfaces.some(x => x.id == id and not(x.paused))
pure def pauseSurface(s: SurfaceHost, session: int, epoch: int, id: int): SurfaceHost =
  { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id) { ...x, paused: true } else x) }
pure def canResumeSurface(s: SurfaceHost, session: int, epoch: int, id: int): bool = admitsCommand(s, session, epoch) and s.surfaces.some(x => x.id == id and x.paused)
pure def resumeSurface(s: SurfaceHost, session: int, epoch: int, id: int): SurfaceHost =
  { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id) { ...x, paused: false } else x) }
pure val widthValues = Set(0, 360)
pure val heightValues = Set(0, 280, 640)
pure def alwaysAtMostOnePresented(s: SurfaceHost): bool = s.surfaces.select(x => x.presented).length() <= 1
pure def stepBoundsTouchOneSurface(before: SurfaceHost, via: str, after: SurfaceHost): bool =
  via == "setBounds" implies after.surfaces.select(x => not(before.surfaces.includes(x))).length() <= 1
pure def stepPresentingNeverResumes(before: SurfaceHost, via: str, after: SurfaceHost): bool =
  via == "presentSurface" implies after.surfaces.every(x => before.surfaces.some(y => y.id == x.id and y.paused == x.paused))
pure def sometimesPageTakesInput(s: SurfaceHost): bool = s.surfaces.some(x => pageTakesInput(x))
pure def sometimesPresentedButPaused(s: SurfaceHost): bool = s.surfaces.some(x => x.presented and x.paused)
```

## Story: Learn once when a page crashed or its profile was purged

> As the consumer's renderer, I want to hear exactly once that a surface
> closed by itself, so I can recreate it or show that it is gone.

### A crashed surface is closed before it is reported, and each surface's crash is reported once

When a page's renderer crashes or Android reclaims it, the surface is
already closed and its id is free when `surfaceCrashed` is sent, and the
host app keeps running. Each surface instance has a generation issued for
it alone, and is reported at most once, however many renderer callbacks
arrive. Every reported crash names a generation that was issued. A purge of a keyed profile closes
every surface on that profile and reports each as `surfaceClosed` with
reason `profile-purged`.

```quint
pure def canCrashSurface(s: SurfaceHost, id: int): bool = hasSurface(s, id)
pure def crashSurface(s: SurfaceHost, id: int): SurfaceHost = {
  val gone = s.surfaces.select(x => x.id == id)
  { ...s, surfaces: s.surfaces.select(x => x.id != id),
    crashReports: s.crashReports.concat(gone.listMap(x => x.gen).select(g => not(s.crashReports.includes(g)))) }
}
pure def canPurgeProfileSurfaces(s: SurfaceHost, profileKey: str): bool = not(s.destroyed) and profileKey != ""
pure def purgeProfileSurfaces(s: SurfaceHost, profileKey: str): SurfaceHost =
  { ...s, surfaces: s.surfaces.select(x => x.profileKey != profileKey),
    purgeClosed: s.purgeClosed.concat(s.surfaces.select(x => x.profileKey == profileKey).listMap(x => x.id)) }
pure def alwaysCrashReportedOnce(s: SurfaceHost): bool = uniqueIds(s.crashReports)
pure def alwaysGenerationNamesOneSurface(s: SurfaceHost): bool =
  s.surfaces.every(x => x.gen <= s.issued and s.surfaces.every(y => y.gen == x.gen implies y.id == x.id)) and s.crashReports.every(g => g <= s.issued)
pure def alwaysReportedCrashIsClosed(s: SurfaceHost): bool = s.crashReports.every(g => not(s.surfaces.some(x => x.gen == g)))
pure def stepPurgeReportsEveryClosedSurface(before: SurfaceHost, via: str, after: SurfaceHost): bool =
  via == "purgeProfileSurfaces" implies after.surfaces.every(x => before.surfaces.includes(x)) and
    after.purgeClosed.length() - before.purgeClosed.length() == before.surfaces.length() - after.surfaces.length()
pure def sometimesCrashReported(s: SurfaceHost): bool = s.crashReports.length() > 0
pure def sometimesPurgeClosedSurface(s: SurfaceHost): bool = s.purgeClosed.length() > 0
```

## Story: Show the browser helper entry and full-screen overlay without trapping input

> As the person, I want the floating browser helper to appear only while
> the app may draw over other apps, and the keyboard to come back safely
> when the overlay goes away.

### The helper overlay owns its parent only while shown, and input is restored only after the view is back in the Activity

The helper entry shows only while the draw-over permission is held; WindowManager may
attach it in a later main-thread turn. Full screen moves the view into the
overlay; a refused window restores the original parent before the call
fails. Removing full screen, releasing, a revoked permission or destroying
the plugin returns the view to the Activity and only then restores input.
A permission change is reconciled while the watcher is registered, and a
revoked permission eventually leaves nothing shown. Destroying the plugin
removes every view and the watcher and closes every surface.

```quint
pure def canShowHelperEntry(s: SurfaceHost): bool = not(s.destroyed) and s.helper.permission and s.helper.entry == HelperNone
pure def showHelperEntry(s: SurfaceHost): SurfaceHost = { ...s, helper: { ...s.helper, entry: HelperPending } }
pure def canAttachHelperEntry(s: SurfaceHost): bool = s.helper.entry == HelperPending
pure def attachHelperEntry(s: SurfaceHost): SurfaceHost = { ...s, helper: { ...s.helper, entry: HelperVisible } }
pure def canRemoveHelperEntry(s: SurfaceHost): bool = s.helper.entry != HelperNone
pure def removeHelperEntry(s: SurfaceHost): SurfaceHost = { ...s, helper: { ...s.helper, entry: HelperNone } }
pure def canShowHelperFullScreen(s: SurfaceHost, accepted: bool): bool =
  not(s.destroyed) and s.helper.permission and s.helper.entry != HelperNone and s.helper.full == HelperNone
pure def showHelperFullScreen(s: SurfaceHost, accepted: bool): SurfaceHost =
  if (accepted) { ...s, helper: { ...s.helper, entry: HelperNone, full: HelperPending, overlayParent: true } } else s
pure def canAttachHelperFullScreen(s: SurfaceHost): bool = s.helper.full == HelperPending
pure def attachHelperFullScreen(s: SurfaceHost): SurfaceHost = { ...s, helper: { ...s.helper, full: HelperVisible } }
pure def helperReturned(h: HelperEntry): HelperEntry =
  { ...h, entry: HelperNone, full: HelperNone, overlayParent: false, inputPending: h.inputPending or h.full != HelperNone }
pure def canRemoveHelperFullScreen(s: SurfaceHost): bool = s.helper.full != HelperNone
pure def removeHelperFullScreen(s: SurfaceHost): SurfaceHost = { ...s, helper: { ...s.helper, full: HelperNone, overlayParent: false, inputPending: true } }
pure def releaseHelper(s: SurfaceHost): SurfaceHost = { ...s, helper: helperReturned(s.helper) }
pure def canChangeOverlayPermission(s: SurfaceHost, granted: bool): bool = not(s.destroyed) and s.helper.permission != granted
pure def changeOverlayPermission(s: SurfaceHost, granted: bool): SurfaceHost =
  { ...s, helper: { ...s.helper, permission: granted, reconcilePending: s.helper.watcher } }
pure def canReconcileHelper(s: SurfaceHost): bool = s.helper.reconcilePending
pure def reconcileHelper(s: SurfaceHost): SurfaceHost =
  if (not(s.helper.permission) and not(s.destroyed)) { ...s, helper: { ...helperReturned(s.helper), reconcilePending: false } }
  else { ...s, helper: { ...s.helper, reconcilePending: false } }
pure def canRestoreInput(s: SurfaceHost): bool = s.helper.inputPending
pure def restoreInput(s: SurfaceHost): SurfaceHost =
  { ...s, helper: { ...s.helper, inputPending: false,
    unsafeInputRestart: s.helper.unsafeInputRestart or (not(s.destroyed) and s.helper.full == HelperNone and s.helper.overlayParent) } }
pure def canDestroyPlugin(s: SurfaceHost): bool = not(s.destroyed)
pure def destroyPlugin(s: SurfaceHost): SurfaceHost =
  { ...s, destroyed: true, surfaces: List(), helper: { ...helperReturned(s.helper), watcher: false } }
pure val fair_reconcileHelper = "weak"
pure def alwaysHelperViewCustody(s: SurfaceHost): bool = (s.helper.full != HelperNone) == s.helper.overlayParent
pure def alwaysDestroyedHelperReleased(s: SurfaceHost): bool =
  s.destroyed implies s.helper.entry == HelperNone and s.helper.full == HelperNone and not(s.helper.watcher)
pure def alwaysInputRestoredSafely(s: SurfaceHost): bool = not(s.helper.unsafeInputRestart)
pure def leadsToRevokedHelperHides(s: SurfaceHost, later: SurfaceHost): bool =
  not(s.helper.permission) implies later.helper.permission or (later.helper.entry == HelperNone and later.helper.full == HelperNone)
pure def sometimesHelperFullScreen(s: SurfaceHost): bool = s.helper.full == HelperVisible
pure def sometimesRevokedHelperReturnsInput(s: SurfaceHost): bool = not(s.helper.permission) and s.helper.inputPending
```

## Story: Keep the browser safe and responsive around the host renderer

> As the person, I want Back to do what the app shows me first and the
> page to make room for the keyboard, so that the browser never surprises
> me while the app's own screen is restarting.

### Back is offered to the app's own screen first

A Back press is offered to the renderer first. Only when the renderer
declines does the page go back in its own history, if it can, and only
when neither can does Android's default Back run. A press while the
renderer is gone goes straight to the page or Android, never to a
renderer that cannot answer.

```quint
pure def canPressBack(s: SurfaceHost, pageCanGoBack: bool): bool = s.back != BackOfferedToUi
pure def pressBack(s: SurfaceHost, pageCanGoBack: bool): SurfaceHost =
  if (s.rendererLive) { ...s, back: BackOfferedToUi, pageCanGoBack: pageCanGoBack }
  else { ...s, back: if (pageCanGoBack) BackToPage else BackToActivity, pageCanGoBack: pageCanGoBack }
pure def canUiAnswersBack(s: SurfaceHost, handled: bool): bool = s.back == BackOfferedToUi
pure def uiAnswersBack(s: SurfaceHost, handled: bool): SurfaceHost =
  { ...s, back: if (handled) BackHandledByUi else if (s.pageCanGoBack) BackToPage else BackToActivity }
pure def stepActivityBackOnlyAfterUiAndPageDecline(before: SurfaceHost, via: str, after: SurfaceHost): bool =
  after.back == BackToActivity and before.back != BackToActivity implies not(after.pageCanGoBack) and
    (via == "uiAnswersBack" or not(before.rendererLive))
pure def stepUiOfferedBeforePage(before: SurfaceHost, via: str, after: SurfaceHost): bool =
  after.back == BackToPage and before.back != BackToPage implies via == "uiAnswersBack" or not(before.rendererLive)
pure def sometimesUiHandlesBack(s: SurfaceHost): bool = s.back == BackHandledByUi
pure def sometimesPageGoesBack(s: SurfaceHost): bool = s.back == BackToPage
```

### Every keyboard change is reported once, with its height in host pixels

When the on-screen keyboard opens, closes or changes height, the plugin
sends one `keyboardChanged` with whether it is visible and its height in
host CSS pixels, zero when hidden. An unchanged keyboard sends nothing.

```quint
pure def canKeyboardChanged(s: SurfaceHost, visible: bool, height: int): bool = height >= 0
pure def keyboardChanged(s: SurfaceHost, visible: bool, height: int): SurfaceHost = {
  val shown = if (visible) height else 0
  if (visible == s.keyboardVisible and shown == s.keyboardHeight) s
  else { ...s, keyboardVisible: visible, keyboardHeight: shown, keyboardReports: s.keyboardReports + 1 }
}
pure def alwaysHiddenKeyboardHasNoHeight(s: SurfaceHost): bool = not(s.keyboardVisible) implies s.keyboardHeight == 0
pure def stepReportOnlyOnChange(before: SurfaceHost, after: SurfaceHost): bool =
  after.keyboardReports > before.keyboardReports implies
    after.keyboardReports == before.keyboardReports + 1 and (after.keyboardVisible != before.keyboardVisible or after.keyboardHeight != before.keyboardHeight)
pure def sometimesKeyboardReported(s: SurfaceHost): bool = s.keyboardVisible and s.keyboardHeight > 0
```

## Story: Tell my events and results apart from every other renderer's

> As the consumer's renderer, I want to know which surface, realm and
> command each event and result belongs to, so I never act on another
> renderer's page or on a command that did not take effect.

### The plugin registers as ElizaSurfaceManager, and a renderer uses an event only when it names the renderer's own owner, session and epoch

The plugin is registered under the one name `ElizaSurfaceManager`. Every
surface event carries the surface id with the owner, session and epoch of
the realm that owns it, and every listener hears every surface's events.
A renderer therefore uses an event only when it reports a surface that
exists and names the renderer's own owner, session and epoch; anything
else is another realm's and is ignored.

```quint
pure val surfacePluginName: str = "ElizaSurfaceManager"
type RendererIdentity = { owner: str, session: int, epoch: int }
type SurfaceEvent = { id: int, owner: str, session: int, epoch: int, exists: bool }
pure def eventIsMine(ev: SurfaceEvent, me: RendererIdentity): bool =
  ev.exists and ev.id > 0 and ev.owner == me.owner and ev.session == me.session and ev.epoch == me.epoch
pure def lawAnotherRealmsEventIsIgnored(ev: SurfaceEvent, me: RendererIdentity): bool =
  eventIsMine(ev, me) implies ev.owner == me.owner and ev.session == me.session and ev.epoch == me.epoch and ev.exists
pure val meValues = Set({ owner: "browser", session: 1, epoch: 1 }, { owner: "browser", session: 2, epoch: 2 })
pure val evValues = Set({ id: 1, owner: "browser", session: 1, epoch: 1, exists: true }, { id: 1, owner: "browser", session: 1, epoch: 1, exists: false },
  { id: 1, owner: "other", session: 1, epoch: 1, exists: true }, { id: 2, owner: "browser", session: 2, epoch: 1, exists: true })
```

### A command resolves only once it has taken effect, and a refused command is a failure that changes nothing

Commands of one renderer run in the order it sent them, one at a time on
the host's main thread. A command resolves only after its effect is in
place, so the resolution of `setOcclusionRects` is the renderer's
acknowledgement that the page now yields to exactly those rects. A
command from a stale realm, for a surface it does not own, or with
invalid arguments (an occlusion rect with a negative or non-finite size,
for example) rejects, and the renderer treats the rejection as a failure:
what was in effect stays.

```quint
type CommandResult = Resolved | Rejected
type CommandAttempt = { admitted: bool, argumentsValid: bool }
pure def commandResult(attempt: CommandAttempt): CommandResult = if (attempt.admitted and attempt.argumentsValid) Resolved else Rejected
pure def inEffectAfter(attempt: CommandAttempt, before: int, sent: int): int = if (commandResult(attempt) == Resolved) sent else before
pure def lawResolvedMeansInEffect(attempt: CommandAttempt, before: int, sent: int): bool =
  (commandResult(attempt) == Resolved implies inEffectAfter(attempt, before, sent) == sent) and
  (commandResult(attempt) == Rejected implies inEffectAfter(attempt, before, sent) == before)
pure val attemptValues = Set({ admitted: true, argumentsValid: true }, { admitted: false, argumentsValid: true }, { admitted: true, argumentsValid: false })
pure val beforeValues = Set(0, 1)
pure val sentValues = Set(1, 2)
```

### Two surfaces share website storage only through the same profile key

A surface created with a profile key uses the one persistent profile of
its owner and that key, so its sign-ins survive across openings; a
surface without a key gets a fresh profile of its own that is cleared
when it closes. Two surfaces therefore share cookies and storage only
when they name the same key.

```quint
type SurfaceProfile = { key: str, fresh: int }
pure def profileOf(profileKey: str, gen: int): SurfaceProfile = if (profileKey == "") { key: "", fresh: gen } else { key: profileKey, fresh: 0 }
pure def lawProfilesSharedOnlyByKey(keyA: str, genA: int, keyB: str, genB: int): bool =
  profileOf(keyA, genA) == profileOf(keyB, genB) implies genA == genB or (keyA != "" and keyA == keyB)
pure val keyAValues = Set("", "account1", "account2")
pure val keyBValues = Set("", "account1")
pure val genAValues = Set(1, 2)
pure val genBValues = Set(1, 2)
```

### navigationChanged reports the surface's state as it was when sent, and a refused certificate is a security block, never the site

`navigationChanged` carries `exists`, the current address, `progress`
from 0 to 100, `securityBlocked`, the main-frame `pageError`, the text
zoom and the history flags as they were when it was sent; a surface that
is gone reports only that it does not exist. A page whose certificate was
refused is never passed: the surface shows an error page in its place and
reports it as blocked.

```quint
type PageLoadFacts = { certificateRefused: bool, loadFailed: bool, progress: int }
type NavigationChanged = { exists: bool, progress: int, securityBlocked: bool, pageError: bool, showsSite: bool }
pure def navigationChanged(page: PageLoadFacts): NavigationChanged =
  { exists: true, progress: page.progress, securityBlocked: page.certificateRefused,
    pageError: page.loadFailed or page.certificateRefused, showsSite: not(page.loadFailed or page.certificateRefused) }
pure val goneSurfaceState: NavigationChanged = { exists: false, progress: 0, securityBlocked: false, pageError: false, showsSite: false }
pure def lawRefusedCertificateIsNeverTheSite(page: PageLoadFacts): bool =
  page.certificateRefused implies navigationChanged(page).securityBlocked and not(navigationChanged(page).showsSite)
pure val pageValues = Set({ certificateRefused: false, loadFailed: false, progress: 100 }, { certificateRefused: true, loadFailed: false, progress: 100 },
  { certificateRefused: false, loadFailed: true, progress: 40 })
```

## Story: Read, capture and adjust only the page I can see

> As the consumer's renderer, I want to read the page's text, capture a
> masked picture of it, zoom its text and widen a running task's origins
> only under fixed bounds, so nothing secret or hidden leaves the surface.

### Reading and capturing need the shown, loaded page, and a paused page is never captured or driven

`readPage` reads visible text from the surface's own page, never the host
renderer, and needs the page shown, fully loaded and without a load error.
`captureSurface` needs the same and also an Activity in the foreground,
a running page and a non-empty surface. While the surface is paused,
`captureSurface`, `controlPage`, `observeHistory` and `navigateHistory`
reject, while `readPage`, `navigate`, `reloadSurface`, `goBack`,
`goForward` and `stopLoading` still run. `setTaskOrigins` needs a surface
created to intercept navigation, and `clearSurfaceStorage` refuses a
surface on the host's own storage.

```quint
type SurfaceCommand = ReadPageCommand | CaptureCommand | ControlPageCommand | ObserveHistoryCommand | NavigateHistoryCommand
  | LoadCommand | StopLoadingCommand | TextZoomCommand | TaskOriginsCommand | ClearStorageCommand
type CommandFacts = { foregrounded: bool, paused: bool, loaded: bool, pageFailed: bool, activityResumed: bool, sized: bool, intercepts: bool, sharedStorage: bool }
pure def pauseRejects(command: SurfaceCommand): bool =
  command == CaptureCommand or command == ControlPageCommand or command == ObserveHistoryCommand or command == NavigateHistoryCommand
pure def shownLoadedPage(facts: CommandFacts): bool = facts.foregrounded and facts.loaded and not(facts.pageFailed)
pure def commandRuns(command: SurfaceCommand, facts: CommandFacts): bool =
  if (facts.paused and pauseRejects(command)) false
  else if (command == ReadPageCommand) shownLoadedPage(facts)
  else if (command == CaptureCommand) shownLoadedPage(facts) and facts.activityResumed and facts.sized
  else if (command == TaskOriginsCommand) facts.intercepts
  else if (command == ClearStorageCommand) not(facts.sharedStorage)
  else true
pure def lawPausedPageIsNeverCapturedOrDriven(command: SurfaceCommand, facts: CommandFacts): bool =
  facts.paused and pauseRejects(command) implies not(commandRuns(command, facts))
pure def lawPausedPageStillReadsAndMoves(facts: CommandFacts): bool =
  commandRuns(LoadCommand, facts) and commandRuns(StopLoadingCommand, facts) and (shownLoadedPage(facts) implies commandRuns(ReadPageCommand, facts))
pure def lawReadAndCaptureNeedTheShownLoadedPage(command: SurfaceCommand, facts: CommandFacts): bool =
  (command == ReadPageCommand or command == CaptureCommand) and commandRuns(command, facts) implies shownLoadedPage(facts)
pure def lawTaskOriginsNeedAnInterceptingSurface(facts: CommandFacts): bool = commandRuns(TaskOriginsCommand, facts) implies facts.intercepts
pure val shownFacts: CommandFacts = { foregrounded: true, paused: false, loaded: true, pageFailed: false, activityResumed: true, sized: true, intercepts: true, sharedStorage: false }
pure val factsValues = Set(shownFacts, { ...shownFacts, paused: true }, { ...shownFacts, foregrounded: false }, { ...shownFacts, loaded: false },
  { ...shownFacts, pageFailed: true }, { ...shownFacts, activityResumed: false }, { ...shownFacts, intercepts: false, sharedStorage: true })
```

### A capture returns an image only when every mask was in place on an unchanged page

A capture always covers password, payment card, one-time-code and new or
current password fields, up to 32 more selectors the renderer names, and,
unless the renderer opts out, every frame the page cannot read. The
covers go on before the copy and come off right after, and host chrome is
painted over. When a cover cannot be placed the capture fails rather than
return an unmasked image; when the page changed, was hidden or paused
while capturing it is stale; after five seconds it times out. The image is
at most `maxEdge` pixels on its long edge (256 to 2048) and never scaled
up, with JPEG quality from 30 to 90. A read is discarded in the same way
when the page changed while reading. Neither result is stored in a
thread or a task journal.

```quint
type CaptureOutcome = CaptureImage | CaptureMaskFailed | CaptureStale | CaptureUnavailable | CaptureTimedOut | CaptureInvalid
type CaptureRun = { admitted: bool, runs: bool, inTime: bool, secretFieldsCovered: bool, maskFrames: bool, framesCovered: bool, pageUnchanged: bool }
type CaptureRequest = { maxEdge: int, quality: int, extraSelectors: int }
pure def captureRequestAdmitted(request: CaptureRequest): bool =
  request.maxEdge >= 256 and request.maxEdge <= 2048 and request.quality >= 30 and request.quality <= 90 and request.extraSelectors >= 0 and request.extraSelectors <= 32
pure def captureOutcome(capture: CaptureRun): CaptureOutcome =
  if (not(capture.admitted)) CaptureInvalid
  else if (not(capture.runs)) CaptureUnavailable
  else if (not(capture.inTime)) CaptureTimedOut
  else if (not(capture.secretFieldsCovered and (capture.framesCovered or not(capture.maskFrames)))) CaptureMaskFailed
  else if (not(capture.pageUnchanged)) CaptureStale
  else CaptureImage
pure def capturedEdge(maxEdge: int, pageEdge: int): int = if (pageEdge < maxEdge) pageEdge else maxEdge
type ReadOutcome = ReadText | ReadDiscarded | ReadUnavailable
pure def readOutcome(runs: bool, inTime: bool, pageUnchanged: bool): ReadOutcome =
  if (not(runs)) ReadUnavailable else if (inTime and pageUnchanged) ReadText else ReadDiscarded
pure def lawImageOnlyWhenMaskedAndCurrent(capture: CaptureRun): bool =
  captureOutcome(capture) == CaptureImage implies capture.admitted and capture.runs and capture.secretFieldsCovered and (capture.framesCovered or not(capture.maskFrames)) and capture.pageUnchanged
pure def lawCaptureIsNeverScaledUp(maxEdge: int, pageEdge: int): bool =
  capturedEdge(maxEdge, pageEdge) <= maxEdge and capturedEdge(maxEdge, pageEdge) <= pageEdge
pure def lawReadTextOnlyFromTheSamePage(runs: bool, inTime: bool, pageUnchanged: bool): bool =
  readOutcome(runs, inTime, pageUnchanged) == ReadText implies runs and inTime and pageUnchanged
pure def lawCaptureBoundsAreFixed(request: CaptureRequest): bool =
  captureRequestAdmitted(request) implies request.maxEdge <= 2048 and request.quality >= 30 and request.extraSelectors <= 32
pure val goodRun: CaptureRun = { admitted: true, runs: true, inTime: true, secretFieldsCovered: true, maskFrames: true, framesCovered: true, pageUnchanged: true }
pure val captureValues = Set(goodRun, { ...goodRun, secretFieldsCovered: false }, { ...goodRun, framesCovered: false }, { ...goodRun, framesCovered: false, maskFrames: false },
  { ...goodRun, pageUnchanged: false }, { ...goodRun, inTime: false }, { ...goodRun, runs: false }, { ...goodRun, admitted: false })
pure val requestValues = Set({ maxEdge: 1024, quality: 70, extraSelectors: 0 }, { maxEdge: 4096, quality: 70, extraSelectors: 0 }, { maxEdge: 1024, quality: 10, extraSelectors: 33 })
pure val maxEdgeValues = Set(256, 1024, 2048)
pure val pageEdgeValues = Set(200, 1024, 3000)
```

### Text zoom stays within 50 to 300 percent, and a task widens navigation only to at most 16 exact HTTPS origins

`setTextZoom` takes a percentage from 50 to 300, where 100 is the page's
own size. `setTaskOrigins` gives an intercepting surface the exact HTTPS
origins of the renderer's running task, at most 16: a page on one of them
may move to another without a held navigation, any other origin is still
held, and an empty list ends the extension. Nothing is added without
this call, and it does not outlive the surface.

```quint
pure def textZoomAdmitted(percent: int): bool = percent >= 50 and percent <= 300
pure def taskOriginsAdmitted(count: int, exactHttps: bool): bool = count >= 0 and count <= 16 and exactHttps
pure def lawTextZoomBounded(percent: int): bool = textZoomAdmitted(percent) implies percent >= 50 and percent <= 300 and textZoomAdmitted(100)
pure def lawTaskOriginsBounded(count: int, exactHttps: bool): bool =
  taskOriginsAdmitted(count, exactHttps) implies exactHttps and count <= 16 and taskOriginsAdmitted(0, true)
pure val percentValues = Set(40, 50, 100, 300, 301)
pure val countValues = Set(0, 16, 17)
```
