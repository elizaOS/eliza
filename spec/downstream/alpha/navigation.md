# Alpha shell navigation and overlay order

The shared reducer is `packages/ui/src/mobile-shell/navigation.ts` at
AlphaPhone's Eliza pin. `apps/app/src/prototype/model.js` wraps it in
`openView`, `shellNavigate`, and `back`. `test` and the old
`specs/quint/application/ShellNavigation.qnt` cover captured navigation,
focus, and unsent draft preservation. Completed action claims are owned by
[core navigation](../../core/viewNavigation.md). This model owns the live
view, stack and Back priority at the Alpha renderer boundary.

## Story: Move among app surfaces without losing the current composition

### Open uses the product target and caps pushed history at six

Opening a different non-Home view with push keeps the last six previous
renderers. Push on the same renderer or from Home resets history, as does
the default policy. Keep preserves the existing stack and the target
view's retained state. Opening a new target closes the drawer unless
explicitly retained, clears the shade, and uses an explicit assistant
detent or the target's rest detent. A secure camera session can only
navigate to the installed camera/photo surfaces or the development
Inventory view when admitted. Attempting a different available view leads
back to Lock with the unlock instruction. A deferred target is refused
before attempting the secure handoff.

```quint
import product as P from "./product"
type Detent = Pill | Composer | Sheet | Full | UseRest
type HistoryPolicy = ResetStack | PushStack | KeepStack
type OpenRequest = { name: str, history: HistoryPolicy, keepDrawer: bool, rest: bool, assistant: Detent }
type Frame = { viewId: P::CanonicalView, restsAtInput: bool }
type SurfaceResult = Quiet | Opened | TargetUnavailable | UnlockRequired | LeftSurface | VoiceStopped | AssistantClosed | ChildHandled
type ShellNav = { view: Frame, stack: List[Frame], drawer: bool, drawerQuery: str, assistant: Detent, shade: bool, voice: bool, locked: bool, secure: bool, draft: str, lastResult: SurfaceResult }
pure val rootFrame: Frame = { viewId: P::Chat, restsAtInput: true }
pure val initial: ShellNav = { view: rootFrame, stack: List(), drawer: false, drawerQuery: "", assistant: Composer, shade: false, voice: false, locked: false, secure: false, draft: "", lastResult: Quiet }
pure val requestValues = Set(
  { name: "notes", history: PushStack, keepDrawer: false, rest: false, assistant: UseRest },
  { name: "calendar", history: PushStack, keepDrawer: false, rest: true, assistant: UseRest },
  { name: "files", history: KeepStack, keepDrawer: true, rest: false, assistant: Full },
  { name: "workflows", history: ResetStack, keepDrawer: false, rest: false, assistant: UseRest },
  { name: "camera", history: PushStack, keepDrawer: false, rest: false, assistant: UseRest },
  { name: "photos", history: PushStack, keepDrawer: false, rest: false, assistant: UseRest },
  { name: "contacts", history: ResetStack, keepDrawer: false, rest: false, assistant: UseRest },
  { name: "wrong", history: ResetStack, keepDrawer: false, rest: false, assistant: UseRest }
)
pure def restOf(frame: Frame): Detent = if (frame.restsAtInput or frame.viewId == P::Chat) Composer else Pill
pure def scopedStack(s: ShellNav, choice: OpenRequest, viewId: P::CanonicalView): List[Frame] =
  if (choice.history == KeepStack) s.stack
  else if (choice.history == PushStack and s.view.viewId != P::Chat and s.view.viewId != viewId)
    { if (s.stack.length() >= 6) s.stack.removeAt(0).append(s.view) else s.stack.append(s.view) }
  else List()
pure def cameraScope(viewId: P::CanonicalView): bool = viewId == P::Camera or viewId == P::Photos or viewId == P::Inventory
pure def homeNav(value: SurfaceResult, s: ShellNav): ShellNav =
  { ...s, view: rootFrame, stack: List(), drawer: false, drawerQuery: "", assistant: Composer, shade: false, secure: false, locked: s.secure or s.locked, lastResult: value }
pure def canOpen(s: ShellNav): bool = not(s.locked)
pure def open(s: ShellNav, request: OpenRequest, admission: P::ViewAdmission): ShellNav = {
  val viewId = P::targetView(request.name, admission)
  val frame = { viewId: viewId, restsAtInput: request.rest }
  if (viewId == P::UnknownView or viewId == P::Chat) { ...s, lastResult: TargetUnavailable }
  else if (s.secure and not(cameraScope(viewId))) homeNav(UnlockRequired, s)
  else { ...s, view: frame, stack: scopedStack(s, request, viewId), drawer: request.keepDrawer and s.drawer,
    drawerQuery: if (request.keepDrawer) s.drawerQuery else "", assistant: if (request.assistant == UseRest) restOf(frame) else request.assistant,
    shade: false, lastResult: Opened }
}
pure def canOpenSecureCamera(s: ShellNav): bool = s.locked
pure def openSecureCamera(s: ShellNav): ShellNav =
  { ...s, view: { viewId: P::Camera, restsAtInput: false }, stack: List(), secure: true, locked: false, assistant: Pill, lastResult: Opened }
pure def canLock(s: ShellNav): bool = not(s.locked)
pure def lock(s: ShellNav): ShellNav = { ...homeNav(LeftSurface, s), locked: true, voice: false }
pure def canUnlock(s: ShellNav): bool = s.locked
pure def unlock(s: ShellNav): ShellNav = { ...homeNav(Quiet, s), locked: false }
pure def contactsRevoked(s: ShellNav): ShellNav = if (s.view.viewId == P::Contacts) homeNav(LeftSurface, s) else s
pure def alwaysStackIsBounded(s: ShellNav): bool = s.stack.length() <= 6
pure def alwaysSecureViewIsInCameraScope(s: ShellNav): bool = s.secure implies not(s.locked) and cameraScope(s.view.viewId) and s.stack.every(frame => cameraScope(frame.viewId))
pure def alwaysDrawerSearchHasDrawer(s: ShellNav): bool = s.drawer or s.drawerQuery == ""
pure def alwaysDetentIsConcrete(s: ShellNav): bool = s.assistant != UseRest
pure def sometimesSecureOpenRefused(s: ShellNav): bool = s.locked and s.lastResult == UnlockRequired
pure def sometimesReturnStack(s: ShellNav): bool = s.stack.length() >= 2
```

### Back lowers the active overlay before changing the app or clearing a draft

Alpha closes its simulated shade first. On the assistant-only surface at
Home it closes the assistant when voice is off. Otherwise it stops voice
before lowering Full to Sheet and Sheet to the surface rest. On Home,
an open app drawer closes next. An elevated input over a pill-rest view
lowers to a pill. Back then delegates to the active view's own inner
page handler and only pops the shared navigation stack when it declines.
Leaving a secure camera session without a previous view returns to Lock.
Navigation and overlay events retain the same unsent draft. `sendDraft`
is the observed admission of a composed message, not the conversation
transport owner's asynchronous send or response state.

```quint
pure def canSetDrawer(s: ShellNav, opened: bool): bool = not(s.locked)
pure def setDrawer(s: ShellNav, opened: bool): ShellNav = { ...s, drawer: opened, drawerQuery: "" }
pure def canSearchDrawer(s: ShellNav, query: str): bool = s.drawer and not(s.locked)
pure def searchDrawer(s: ShellNav, query: str): ShellNav = { ...s, drawerQuery: query }
pure def canSetAssistant(s: ShellNav, assistant: Detent): bool = not(s.locked)
pure def setAssistant(s: ShellNav, assistant: Detent): ShellNav = { ...s, assistant: if (assistant == UseRest) restOf(s.view) else assistant }
pure def canShowShade(s: ShellNav, development: bool): bool = development and not(s.secure or s.locked)
pure def showShade(s: ShellNav, development: bool): ShellNav = { ...s, shade: true }
pure def canStartVoice(s: ShellNav): bool = not(s.secure or s.locked or s.voice)
pure def startVoice(s: ShellNav): ShellNav = { ...s, voice: true }
pure def canGoHome(s: ShellNav): bool = not(s.locked) and s.view.viewId != P::Chat
pure def goHome(s: ShellNav): ShellNav = homeNav(LeftSurface, s)
pure def canBack(s: ShellNav): bool = not(s.locked)
pure def back(s: ShellNav, assistantSurface: bool, childHandled: bool): ShellNav = {
  val prior = s.stack.nthOr(s.stack.length() - 1, rootFrame)
  if (s.shade) { ...s, shade: false, lastResult: Quiet }
  else if (assistantSurface and s.view.viewId == P::Chat and not(s.voice)) { ...s, lastResult: AssistantClosed }
  else if (s.voice) { ...s, voice: false, lastResult: VoiceStopped }
  else if (s.assistant == Full) { ...s, assistant: Sheet, lastResult: Quiet }
  else if (s.assistant == Sheet) { ...s, assistant: restOf(s.view), lastResult: Quiet }
  else if (s.view.viewId == P::Chat and s.drawer) { ...s, drawer: false, drawerQuery: "", lastResult: Quiet }
  else if (s.assistant == Composer and restOf(s.view) == Pill) { ...s, assistant: Pill, lastResult: Quiet }
  else if (s.view.viewId == P::Chat) s
  else if (childHandled) { ...s, lastResult: ChildHandled }
  else if (s.stack.length() == 0) homeNav(LeftSurface, s)
  else { ...s, view: prior, stack: s.stack.removeAt(s.stack.length() - 1), assistant: restOf(prior), lastResult: LeftSurface }
}
pure def canEditDraft(s: ShellNav): bool = not(s.locked or s.secure)
pure def editDraft(s: ShellNav, text: str): ShellNav = { ...s, draft: text }
pure def canSendDraft(s: ShellNav): bool = not(s.locked or s.secure) and s.draft != ""
pure def sendDraft(s: ShellNav): ShellNav = { ...s, draft: "" }
pure def stepNavigationRetainsDraft(before: ShellNav, via: str, after: ShellNav): bool =
  via == "editDraft" or via == "sendDraft" or after.draft == before.draft
pure def stepShadeConsumesBack(before: ShellNav, via: str, after: ShellNav): bool =
  via == "back" and before.shade implies not(after.shade) and before.view == after.view and before.assistant == after.assistant and before.voice == after.voice
pure def sometimesDraftAwayFromHome(s: ShellNav): bool = s.view.viewId != P::Chat and s.draft != ""
pure def sometimesBackCutsVoice(s: ShellNav): bool = s.lastResult == VoiceStopped
```

### Gestures respect the shell zones and Alpha's launcher ownership

The shared swipe decision uses a 46-pixel travel threshold, 412-pixel
canvas width, 30-pixel edge, and bottom bar starting after pixel 872 by
default. An upward dominant swipe unlocks on Lock or closes the simulated
shade. On Home and app surfaces, a horizontal edge swipe is Back. A
launcher's bottom-bar upward swipe goes Home. An eligible downward
pull requests the system shade before lowering a sheet. The shared
reducer can request Raise Assistant on an empty Home, but Alpha's current
`swipe` host translates only the other emitted actions. Android's system
edge interception occurs before the renderer sees this decision.

```quint
type SwipeSurface = SwipeLock | SwipeHome | SwipeOther
type SwipeChoice = NoSwipe | SwipeUnlock | SwipeCloseShade | SwipeOpenShade | SwipeGoHome | SwipeLower | SwipeRaise | SwipeBack
type Gesture = { screen: SwipeSurface, shade: bool, showsView: bool, assistant: Detent, launcher: bool, shadeControl: bool, productShadePull: bool, x: int, y: int, dx: int, dy: int }
pure val gValues = Set(
  { screen: SwipeHome, shade: false, showsView: false, assistant: Composer, launcher: true, shadeControl: false, productShadePull: false, x: 205, y: 885, dx: 0, dy: -65 },
  { screen: SwipeHome, shade: false, showsView: false, assistant: Composer, launcher: false, shadeControl: false, productShadePull: false, x: 205, y: 885, dx: 0, dy: -65 },
  { screen: SwipeHome, shade: false, showsView: true, assistant: Sheet, launcher: false, shadeControl: false, productShadePull: false, x: 5, y: 400, dx: 80, dy: 2 },
  { screen: SwipeHome, shade: false, showsView: false, assistant: Composer, launcher: true, shadeControl: false, productShadePull: true, x: 205, y: 400, dx: 2, dy: 80 },
  { screen: SwipeLock, shade: false, showsView: false, assistant: Composer, launcher: true, shadeControl: false, productShadePull: false, x: 205, y: 400, dx: 0, dy: -65 }
)
pure def swipe(g: Gesture): SwipeChoice = {
  val ax = if (g.dx < 0) 0 - g.dx else g.dx
  val ay = if (g.dy < 0) 0 - g.dy else g.dy
  val edgeBack = (g.x < 30 and g.dx > 46) or (g.x > 382 and g.dx < -46)
  if (ax < 46 and ay < 46) NoSwipe
  else if (g.screen == SwipeLock) { if (g.dy < -46 and ay > ax) SwipeUnlock else NoSwipe }
  else if (g.screen != SwipeHome) NoSwipe
  else if (g.shade) { if (g.dy < -46 and ay > ax) SwipeCloseShade else if (ax > ay and edgeBack) SwipeBack else NoSwipe }
  else if (ay <= ax) { if (edgeBack) SwipeBack else NoSwipe }
  else if (g.dy > 46 and ((g.shadeControl and g.launcher) or g.productShadePull)) SwipeOpenShade
  else if (g.launcher and g.dy < -46 and g.y > 872) SwipeGoHome
  else if (g.assistant == Sheet and g.dy > 46) SwipeLower
  else if (not(g.showsView) and g.assistant != Sheet and g.assistant != Full and g.dy < -46) SwipeRaise
  else NoSwipe
}
pure def lawOnlyLauncherGetsHomeGesture(g: Gesture): bool = swipe(g) == SwipeGoHome implies g.launcher and g.y > 872
pure def lawLockDoesNotNavigateViews(g: Gesture): bool = g.screen == SwipeLock implies swipe(g) == NoSwipe or swipe(g) == SwipeUnlock
```
