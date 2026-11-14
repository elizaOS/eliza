# AlphaPhone screen focus

Alpha installs `apps/app/src/runtime/view-focus.ts` from `main.tsx`. The
adapter imports `packages/ui/src/accessibility/screen-focus.ts` from Eliza
and owns screen naming, startup readiness and the launcher Home signal.
The sources are pinned at Alpha `8d44dfe52` and Eliza `c518127a`.
[Shell navigation](./navigation.md) owns which view is in front. This
model owns the focus observer and its scheduled restoration after a
change. The document, paint observations and actual DOM focus remain
effect boundaries.

## Story: Know where I am after Home, rotation or a change of screen

### A ready observer schedules restoration for a change and keeps navigation priority over resize

An installation has one owner. A repeated install returns the same
uninstaller. Uninstall cancels its scheduled frame and disconnects its
listeners. Calling an old uninstaller after a replacement is harmless. The frame
callback belongs to its installation.
The first active-view value read on startup establishes readiness. A
change between previously reported and currently reported views requests
restoration. Launcher Home requests restoration even when Home is
already active.

An inline modal is seen once per observer and per element, including
matching elements already present at installation. A newly seen match
requests restoration. Label and exposure are checked when resolving
the next target. Resize differs from a view change. It requests a check
only when the observer saw an element receive focus and that element
differs from the current active element. The scheduled attempt can move
focus only after that captured element loses exposure. A resize may
replace its own wait but leaves an existing navigation or modal wait
in place.

```quint
type View = Starting | Home | App
type Cause = Idle | Navigation | Resize
type FocusTarget = NoTarget | HomeTarget | TitleTarget | RegionTarget | ModalTarget
type FocusObserver = { generation: int, installed: bool, view: View, cause: Cause, pending: int, delayFrame: bool, targetKind: FocusTarget }
pure val initial: FocusObserver = { generation: 0, installed: false, view: Starting, cause: Idle, pending: 0, delayFrame: false, targetKind: NoTarget }
pure val ownerIdValues = Set(1, 2, 3)
pure def canInstallObserver(s: FocusObserver): bool = not(s.installed)
pure def installObserver(s: FocusObserver): FocusObserver = { ...s, generation: s.generation + 1, installed: true, targetKind: NoTarget }
pure def canUninstallObserver(s: FocusObserver, ownerId: int): bool = s.installed and ownerId == s.generation
pure def uninstallObserver(s: FocusObserver, ownerId: int): FocusObserver =
  { ...s, installed: false, cause: Idle, pending: 0, delayFrame: false }
pure def startWait(cause: Cause, s: FocusObserver): FocusObserver =
  { ...s, cause: cause, pending: 12, delayFrame: true }
pure def awaiting(s: FocusObserver): bool = s.cause != Idle
pure def canPublishView(s: FocusObserver, view: View): bool = view != s.view
pure def publishView(s: FocusObserver, view: View): FocusObserver = {
  val nextView = { ...s, view: view }
  if (s.installed and s.view != Starting and view != Starting) startWait(Navigation, nextView) else nextView
}
pure def canRequestNavigation(s: FocusObserver): bool = s.installed and s.view != Starting
pure def requestNavigation(s: FocusObserver): FocusObserver = startWait(Navigation, s)
pure def canRequestResize(s: FocusObserver, heldElsewhere: bool): bool =
  s.installed and s.view != Starting and heldElsewhere and s.cause != Navigation
pure def requestResize(s: FocusObserver, heldElsewhere: bool): FocusObserver = startWait(Resize, s)
pure def alwaysOwnerOwnsFrames(s: FocusObserver): bool =
  if (awaiting(s)) s.installed and s.pending >= 1 and s.pending <= 12
  else s.pending == 0 and not(s.delayFrame)
pure def alwaysInstalledHasGeneration(s: FocusObserver): bool = s.generation >= 0 and (s.installed implies s.generation > 0)
pure def stepResizeCannotNarrowNavigation(before: FocusObserver, via: str, after: FocusObserver): bool =
  via == "requestResize" implies before.cause != Navigation
pure def stepFirstViewDoesNotSchedule(before: FocusObserver, via: str, after: FocusObserver): bool =
  via == "publishView" and before.view == Starting implies after.pending == before.pending
pure def sometimesResizeWait(s: FocusObserver): bool = s.cause == Resize
pure def sometimesNavigationWait(s: FocusObserver): bool = s.cause == Navigation
```

### Dropped focus follows the frontmost eligible surface and keeps existing tab order

Body, document root, detached, retired and unpainted elements count as
dropped focus. A control with real focus ends the wait. An exposed
native dialog, conversation or voice surface owns its focus. Without one,
the last exposed matching inline modal with a real accessible label
wins. The Alpha host otherwise names Home, the first visible nonblank
app title, or the app region with an aria-label. A missing eligible
element leaves the observer waiting. Geometry and DOM ancestry are
evaluated by the host, with visibility and the document's own
`HTMLElement` used for candidate exposure.

A scheduled wait crosses one frame before its first attempt in the
following frame. Each allowed frame checks readiness, dropped focus and
the current target. It may retry up to twelve attempts if the new name
takes time to appear or the target fails to receive focus. A target
gets `tabindex="-1"` only if it lacks an explicit tabindex and has
negative tabIndex. Focus uses `preventScroll` and the current
`activeElement` confirms whether the transfer took. Alpha draws a
screen ring on focus-visible only after keyboard navigation with Tab or
an arrow key. Pointer down clears keyboard-navigation evidence.
`targetKind` records the last confirmed restoration by the observer.
Per-frame evidence reports the browser's current active element.

```quint
type ScreenEvidence = { selfManaged: bool, namedModal: bool, exposedHome: bool, namedTitle: bool, namedRegion: bool }
type FrameEvidence = { screenNames: ScreenEvidence, dropped: bool, resizeTargetLost: bool, focusSucceeded: bool }
pure val screenEvidenceValues = Set(
  { selfManaged: false, namedModal: false, exposedHome: true, namedTitle: true, namedRegion: true },
  { selfManaged: false, namedModal: true, exposedHome: true, namedTitle: true, namedRegion: true },
  { selfManaged: true, namedModal: true, exposedHome: true, namedTitle: true, namedRegion: true },
  { selfManaged: false, namedModal: false, exposedHome: false, namedTitle: false, namedRegion: true },
  { selfManaged: false, namedModal: false, exposedHome: false, namedTitle: false, namedRegion: false }
)
pure val frameEvidenceValues = Set(
  { screenNames: { selfManaged: false, namedModal: false, exposedHome: true, namedTitle: true, namedRegion: true }, dropped: true, resizeTargetLost: true, focusSucceeded: true },
  { screenNames: { selfManaged: false, namedModal: true, exposedHome: true, namedTitle: true, namedRegion: true }, dropped: true, resizeTargetLost: true, focusSucceeded: true },
  { screenNames: { selfManaged: false, namedModal: false, exposedHome: true, namedTitle: false, namedRegion: true }, dropped: true, resizeTargetLost: false, focusSucceeded: false },
  { screenNames: { selfManaged: false, namedModal: false, exposedHome: true, namedTitle: true, namedRegion: true }, dropped: false, resizeTargetLost: true, focusSucceeded: true },
  { screenNames: { selfManaged: true, namedModal: true, exposedHome: true, namedTitle: true, namedRegion: true }, dropped: true, resizeTargetLost: true, focusSucceeded: true }
)
pure def chooseTarget(view: View, screenEvidence: ScreenEvidence): FocusTarget =
  if (view == Starting or screenEvidence.selfManaged) NoTarget
  else if (screenEvidence.namedModal) ModalTarget
  else if (view == Home) if (screenEvidence.exposedHome) HomeTarget else NoTarget
  else if (screenEvidence.namedTitle) TitleTarget
  else if (screenEvidence.namedRegion) RegionTarget else NoTarget
pure def offeredTarget(s: FocusObserver, frameEvidence: FrameEvidence): FocusTarget =
  if (s.delayFrame or not(frameEvidence.dropped) or (s.cause == Resize and not(frameEvidence.resizeTargetLost))) NoTarget
  else chooseTarget(s.view, frameEvidence.screenNames)
pure def canRunFrame(s: FocusObserver, ownerId: int): bool = s.installed and ownerId == s.generation and awaiting(s)
pure def runFrame(s: FocusObserver, ownerId: int, frameEvidence: FrameEvidence): FocusObserver = {
  val target = offeredTarget(s, frameEvidence)
  val acquired = target != NoTarget and frameEvidence.focusSucceeded
  if (s.delayFrame) { ...s, delayFrame: false }
  else if (not(frameEvidence.dropped) or acquired or s.pending == 1)
    { ...s, cause: Idle, pending: 0, delayFrame: false, targetKind: if (acquired) target else s.targetKind }
  else { ...s, pending: s.pending - 1 }
}
pure def addProgrammaticTabIndex(explicitIndex: bool, nativeIndex: int): bool = not(explicitIndex) and nativeIndex < 0
pure def showScreenRing(keyboardNavigation: bool, focusVisible: bool): bool = keyboardNavigation and focusVisible
pure def lawSelfManagedSurfaceKeepsFocus(view: View, screenEvidence: ScreenEvidence): bool =
  screenEvidence.selfManaged implies chooseTarget(view, screenEvidence) == NoTarget
pure def lawLabelledModalWins(view: View, screenEvidence: ScreenEvidence): bool =
  view != Starting and not(screenEvidence.selfManaged) and screenEvidence.namedModal implies chooseTarget(view, screenEvidence) == ModalTarget
pure def lawExposedResizeSourceIsNotStolen(s: FocusObserver, frameEvidence: FrameEvidence): bool =
  s.cause == Resize and not(frameEvidence.resizeTargetLost) implies offeredTarget(s, frameEvidence) == NoTarget
pure def lawRealFocusIsNotStolen(s: FocusObserver, frameEvidence: FrameEvidence): bool =
  not(frameEvidence.dropped) implies offeredTarget(s, frameEvidence) == NoTarget
pure def lawOldObserverCannotRunFrame(s: FocusObserver, ownerId: int): bool =
  ownerId != s.generation implies not(canRunFrame(s, ownerId))
pure def lawPreserveExistingTabIndex(explicitIndex: bool, nativeIndex: int): bool =
  explicitIndex or nativeIndex >= 0 implies not(addProgrammaticTabIndex(explicitIndex, nativeIndex))
pure def stepOnlyFrameRecordsFocus(before: FocusObserver, via: str, after: FocusObserver): bool =
  after.targetKind != NoTarget and after.targetKind != before.targetKind implies via == "runFrame"
pure def sometimesRestoresFocus(s: FocusObserver): bool = s.targetKind != NoTarget
```

The original `ScreenFocusOwnership.qnt` and
`test/quint-screen-focus-ownership.test.mjs` exercise startup, navigation
over resize, voluntary blur, existing focus, label fallback, drawer focus
and an old uninstaller through the pinned Alpha adapter and pinned Eliza
observer. Their synthetic frame clock and geometry are source-refinement
evidence. Native TalkBack announcements and real WebView painting remain
device conformance.
