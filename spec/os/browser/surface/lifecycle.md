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
host app keeps running. Each surface instance is reported at most once,
however many renderer callbacks arrive. A purge of a keyed profile closes
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
