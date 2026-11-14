# Alpha Maps screen-off guidance and location custody

AlphaPhone `8d44dfe5` uses the Eliza `c518127a` Maps screen through
`apps/app/src/prototype/maps-adapter.ts` and `apps/app/src/maps/screen.ts`.
The pinned producer paths under `plugins/plugin-maps/src/client` are
`maps-screen.ts`, `background-navigation.ts` and `native-location.ts`.
`AlphaMapsTransportPlugin.java` and `AlphaNavigationService.java` supply
the Android bridge. Grace `48b43b9c` has no product caller for this Maps
session. [Alpha Maps](./alpha/maps.md) owns the reviewed route, fix
precision for planning, reroute ownership and resident relay. This
contract begins with the person's explicit Start on a selected route.

## Story: Keep guiding with the screen off when the exact native session can continue

### Pending native startup, confirmed startup and a live permission prompt keep distinct authority

Start requires a selected place and ready route. It initializes one
screen session, starts continuous location and requests screen-off
support concurrently. A new request retires its previous generation.
The background client sets aside an exact native reservation after the
prior Stop barrier. Its `active` method includes that reservation before
availability and listener setup have settled. The screen reports
background running only after `startNavigation` resolves. A nonnative
surface, missing service, listener failure, start refusal or exact stop
before completion cannot confirm screen-off guidance. The bridge attaches
its stop listener before starting the service.

Hiding the page first retires active sharing. Guidance may keep the
screen controller when there is an exact native reservation, even before
start confirmation, or when either location path owns an OS permission
prompt or waits for foreground following its grant. Without either
hold, hide ends foreground guidance, stops the navigation location
watch and releases the view. A startup refusal drops to foreground-only
when visible. It retires a hidden view unless one of the permission
holds is still active. An asynchronous non-notification native loss
falls back if the view is active and releases it if inactive, even when
permission is held. A notification Stop ends the matching guidance
instead of falling back. Explicit End, provider replacement or disposal
retire the screen state and watch. Arrival retires both native work ports
while retaining the arrival presentation until End or another Start.
Leaving for another app view retires view work and agent location while
keeping existing guidance. Document `pagehide`, provider replacement
and disposal release it. A hidden foreground-only route does not resume
of its own accord.

This machine models the renderer and native-reservation handshake.
Alpha's active view requires both a visible document and Maps selected.
Document visibility can change after Maps left the foreground view.
Native Activity focus and dispatch belong to the platform boundary.

```quint
type GuidancePhase = NoGuidance | LiveGuidance | Arrival
type BackgroundPhase = NoBackground | Reserving | AwaitingNative | ScreenOff
type StopReason = NotificationStop | ServiceLost
type Navigation = { phase: GuidancePhase, generation: int, route: int, visible: bool, mapsSelected: bool, background: BackgroundPhase,
  watchOwned: bool, locationPrompt: bool, controllerPrompt: bool, fallback: bool }
pure val initial: Navigation = { phase: NoGuidance, generation: 0, route: 0, visible: true, mapsSelected: true, background: NoBackground,
  watchOwned: false, locationPrompt: false, controllerPrompt: false, fallback: false }
pure def activeView(s: Navigation): bool = s.visible and s.mapsSelected
pure def locationHeld(s: Navigation): bool = s.locationPrompt or s.controllerPrompt
pure def nativeHeld(s: Navigation): bool = s.phase == LiveGuidance and (s.background == AwaitingNative or s.background == ScreenOff)
pure def ended(remainsVisible: bool, s: Navigation): Navigation =
  { ...initial, generation: s.generation + 1, visible: remainsVisible, mapsSelected: s.mapsSelected }
pure def canStartGuidance(s: Navigation, route: int, selected: bool): bool = activeView(s) and selected and route > 0
pure def startGuidance(s: Navigation, route: int, selected: bool): Navigation =
  { ...initial, generation: s.generation + 1, route: route, phase: LiveGuidance, background: Reserving, watchOwned: true }
pure def canReserveBackground(s: Navigation, owner: int): bool = s.phase == LiveGuidance and s.background == Reserving and owner == s.generation
pure def reserveBackground(s: Navigation, owner: int): Navigation = { ...s, background: AwaitingNative }
pure def canFinishBackground(s: Navigation, owner: int): bool = s.phase == LiveGuidance and owner == s.generation and
  (s.background == Reserving or s.background == AwaitingNative)
pure def finishBackground(s: Navigation, owner: int, nativeStarted: bool): Navigation =
  if (nativeStarted and s.background == AwaitingNative) { ...s, background: ScreenOff, fallback: false }
  else if (not(activeView(s) or locationHeld(s))) ended(s.visible, s)
  else { ...s, background: NoBackground, fallback: true }
pure def canLoseBackground(s: Navigation, owner: int): bool = nativeHeld(s) and owner == s.generation
pure def loseBackground(s: Navigation, owner: int, reason: StopReason): Navigation =
  if (reason == NotificationStop or not(activeView(s))) ended(s.visible, s)
  else { ...s, background: NoBackground, fallback: true }
pure def canHideGuidance(s: Navigation): bool = s.visible
pure def hideGuidance(s: Navigation): Navigation =
  if (nativeHeld(s) or locationHeld(s) or s.phase == NoGuidance) { ...s, visible: false }
  else ended(false, s)
pure def canShowGuidance(s: Navigation): bool = not(s.visible)
pure def showGuidance(s: Navigation): Navigation = { ...s, visible: true }
pure def canObservePermissionHold(s: Navigation, owner: int, locationPrompt: bool, controllerPrompt: bool): bool =
  s.phase == LiveGuidance and owner == s.generation and (locationPrompt != s.locationPrompt or controllerPrompt != s.controllerPrompt)
pure def observePermissionHold(s: Navigation, owner: int, locationPrompt: bool, controllerPrompt: bool): Navigation =
  { ...s, locationPrompt: locationPrompt, controllerPrompt: controllerPrompt }
pure def canEndGuidance(s: Navigation): bool = s.phase != NoGuidance
pure def endGuidance(s: Navigation): Navigation = ended(s.visible, s)
pure def canLeaveMaps(s: Navigation): bool = s.mapsSelected
pure def leaveMaps(s: Navigation): Navigation = { ...s, mapsSelected: false }
pure def canSelectMaps(s: Navigation): bool = not(s.mapsSelected)
pure def selectMaps(s: Navigation): Navigation = { ...s, mapsSelected: true }
pure def canArrive(s: Navigation, owner: int, exactRoute: bool, usableFix: bool): bool =
  s.phase == LiveGuidance and owner == s.generation and exactRoute and usableFix
pure def arrive(s: Navigation, owner: int, exactRoute: bool, usableFix: bool): Navigation =
  { ...s, phase: Arrival, background: NoBackground, watchOwned: false, locationPrompt: false, controllerPrompt: false, fallback: false }
pure def canWatchFailed(s: Navigation, owner: int): bool = s.phase == LiveGuidance and owner == s.generation
pure def watchFailed(s: Navigation, owner: int): Navigation = ended(s.visible, s)
pure def canProviderRetires(s: Navigation): bool = s.phase != NoGuidance
pure def providerRetires(s: Navigation): Navigation = ended(s.visible, s)
pure val routeValues = Set(0, 1, 2)
pure val ownerValues = Set(0, 1, 2, 3)
pure val weight_startGuidance = 4
pure val weight_reserveBackground = 10
pure val weight_finishBackground = 12
pure val weight_loseBackground = 12
pure def alwaysOwnedWorkNeedsGuidance(s: Navigation): bool =
  (s.watchOwned == (s.phase == LiveGuidance)) and (s.background != NoBackground implies s.phase == LiveGuidance)
pure def alwaysGuidanceRetainsRoute(s: Navigation): bool = s.phase != NoGuidance implies s.route > 0
pure def alwaysForegroundFallbackKeepsWatch(s: Navigation): bool = s.fallback implies s.watchOwned and s.background == NoBackground
pure def stepScreenOffNeedsStartConfirmation(before: Navigation, via: str, after: Navigation): bool =
  before.background != ScreenOff and after.background == ScreenOff implies via == "finishBackground" and before.background == AwaitingNative
pure def stepNeitherServiceLossNorHideStartsWatch(before: Navigation, via: str, after: Navigation): bool =
  (via == "loseBackground" or via == "hideGuidance") and not(before.watchOwned) implies not(after.watchOwned)
pure def sometimesScreenOffKeepsHiddenNavigation(s: Navigation): bool = not(s.visible) and s.background == ScreenOff
pure def sometimesVisibleFallbackKeepsWatch(s: Navigation): bool = activeView(s) and s.fallback and s.watchOwned
```

### A retired native acknowledgement cannot stop the successor

The renderer emits native updates only for changed title or text. An
instruction that changes during a pending Start is kept for the exact
reservation and sent after its acknowledgement. Update false, throw or
invalid readback loses only the still-current session that sent it.
A matching native `navigationStopped` notification retires that
listener and cannot cause a duplicate native Stop. Stopping while
`startNavigation` is held can reach Android before the service acquires
the session. A later successful acknowledgement stops that *retired ID*
again, leaving any successor. A listener whose subscription resolves
after retirement is removed by its own cleanup barrier. The tested
projection abstracts those handles and payloads as exact reservation IDs.

Android availability names a declared location-type foreground service.
Start requires a live bridge, declared service, a canonical 8–80
character session ID and coarse or fine location permission. This
admission supplies no fresh precise fix. The service uses its own random
authority along with the session ID and bridge owner. Old updates and
notification Stop commands cannot affect the current owner. A stale
queued START may have to satisfy Android's service protocol, but only
publishes the current notification. Task removal retires the service
only for the exact recorded root Activity, and service destruction or
renderer destruction cannot retire a successor. A failed exact STOP
may fall back to unscoped stop only when there is no successor.
Starting a new route remains explicit. The model checks ownership and
fallback admission; notification presentation and Android deadlines
remain platform effects.

```quint
type NativeStartFacts = { declared: bool, locationGranted: bool, bridgeLive: bool, validSessionText: bool }
type NativeOwner = { sessionId: int, bridge: int, authority: int, root: int, foregroundOwner: int }
pure def admitsNativeStart(facts: NativeStartFacts): bool = facts.declared and facts.locationGranted and facts.bridgeLive and facts.validSessionText
pure def exactBridgeSession(active: NativeOwner, bridge: int, sessionId: int): bool = active.sessionId > 0 and active.bridge == bridge and active.sessionId == sessionId
pure def exactCommand(active: NativeOwner, authority: int, sessionId: int): bool = active.sessionId > 0 and active.authority == authority and active.sessionId == sessionId
pure def shouldStopRetiredStart(requested: int, currentOwner: int, accepted: bool): bool = requested > 0 and requested != currentOwner and accepted
pure def acceptsUpdateLoss(issued: int, currentOwner: int, confirmedActive: bool): bool = issued > 0 and issued == currentOwner and not(confirmedActive)
pure def unscopedServiceStopAllowed(successor: int): bool = successor == 0
pure def taskRemovalOwns(active: NativeOwner, removedRoot: int): bool =
  active.sessionId > 0 and active.foregroundOwner == active.sessionId and removedRoot > 0 and removedRoot == active.root
pure val factsValues = Set({ declared: true, locationGranted: true, bridgeLive: true, validSessionText: true },
  { declared: true, locationGranted: false, bridgeLive: true, validSessionText: true })
pure val activeValues = Set({ sessionId: 1, bridge: 1, authority: 1, root: 1, foregroundOwner: 1 },
  { sessionId: 2, bridge: 2, authority: 2, root: 2, foregroundOwner: 1 })
pure def lawNativeCommandCannotStopSuccessor(active: NativeOwner, authority: int, sessionId: int): bool =
  active.sessionId != sessionId or active.authority != authority implies not(exactCommand(active, authority, sessionId))
pure def lawStaleUpdateCannotEndSuccessor(issued: int, currentOwner: int, confirmedActive: bool): bool =
  issued != currentOwner implies not(acceptsUpdateLoss(issued, currentOwner, confirmedActive))
pure def lawTaskRemovalNeedsExactRoot(active: NativeOwner, removedRoot: int): bool =
  taskRemovalOwns(active, removedRoot) implies removedRoot == active.root and active.foregroundOwner == active.sessionId
```

## Story: Keep one location watch and clean up stale callbacks and handles

### Location events require the live watch attempt and cleanup preserves failures

Each `NativeMapsLocation` instance admits only one start setup at a time.
It increments generation before asynchronous cleanup and waits for the
previous registered listeners and watch to settle. Explicit Stop retires
its current attempt before cleanup. A rejected unregister or clear is
reported as unconfirmed cleanup. Native permission prompts cannot be
cancelled through the browser request API. A web permission request is
cancelled with its exact request ID. Cancellation also releases the
post-permission foreground wait. A late permission reply cannot open a
watch for a retired attempt. A permission grant received while hidden
continues waiting until visible. An already granted permission bypasses
that explicit prompt-handoff wait.

The fix listener and error listener are registered before creating
`watchPosition` with high accuracy, at least 1,000 ms between fixes and
minimum distance zero. A listener received after retirement is removed.
A late watch ID is cleared even if that attempt never became current.
The upstream fix event has no watch ID. Its callback is bound to the
registration's captured owner. A stale callback cannot publish. The
watch rejects invalid coordinates, negative or nonfinite accuracy,
nonfinite time, fixes older than 30 seconds and fixes more than five
seconds in the future. Approximate or unknown precision can be reported
by the watch and is then rejected by turn guidance, which pauses voice
and waits for a fresh precise fix. A native location error or invalid
fix from the current listener requests cleanup; if this was still the
screen session it also ends guidance. One-shot location ends after its
first accepted fix. Continuous navigation keeps its watch until End,
arrival, error or owned release.

```quint
type WatchNext = HoldForForeground | DenyWatch | AttachWatchListeners | RefuseWatch | ClearLateWatch | AdoptWatch
type WatchInputs = { sameAttempt: bool, admittedSetup: bool, bridgeAvailable: bool, cleanupConfirmed: bool,
   permissionGranted: bool, justPrompted: bool, hidden: bool }
type LocationFix = { exactCallback: bool, coordinateValid: bool, finiteAccuracy: bool, finiteTime: bool,
   reportedAccuracy: int, age: int, precise: bool }
pure def nextWatch(inputs: WatchInputs): WatchNext =
  if (not(inputs.sameAttempt and inputs.admittedSetup and inputs.bridgeAvailable and inputs.cleanupConfirmed)) RefuseWatch
  else if (not(inputs.permissionGranted)) DenyWatch
  else if (inputs.justPrompted and inputs.hidden) HoldForForeground else AttachWatchListeners
pure def finishWatch(sameAttempt: bool, exactWatchId: bool): WatchNext =
  if (not(exactWatchId)) RefuseWatch else if (sameAttempt) AdoptWatch else ClearLateWatch
pure def reportableFix(fix: LocationFix): bool = fix.exactCallback and fix.coordinateValid and fix.finiteAccuracy and fix.finiteTime and
  fix.reportedAccuracy >= 0 and fix.age >= -5000 and fix.age <= 30000
pure def guidesFix(fix: LocationFix): bool = reportableFix(fix) and fix.precise and fix.reportedAccuracy <= 50
pure val inputsValues = Set({ sameAttempt: true, admittedSetup: true, bridgeAvailable: true, cleanupConfirmed: true,
    permissionGranted: true, justPrompted: true, hidden: true },
  { sameAttempt: true, admittedSetup: true, bridgeAvailable: true, cleanupConfirmed: true,
    permissionGranted: true, justPrompted: false, hidden: true },
  { sameAttempt: false, admittedSetup: true, bridgeAvailable: true, cleanupConfirmed: true,
    permissionGranted: true, justPrompted: true, hidden: true })
pure val preciseFix: LocationFix = { exactCallback: true, coordinateValid: true, finiteAccuracy: true, finiteTime: true, reportedAccuracy: 20, age: 0, precise: true }
pure val fixValues = Set(preciseFix, { ...preciseFix, precise: false }, { ...preciseFix, age: 30001 }, { ...preciseFix, exactCallback: false })
pure def lawPromptGrantDoesNotStartWatchWhileHidden(inputs: WatchInputs): bool =
  inputs.justPrompted and inputs.hidden implies nextWatch(inputs) != AttachWatchListeners
pure def lawRetiredWatchCompletionClearsItsOwnId(exactWatchId: bool): bool = exactWatchId implies finishWatch(false, exactWatchId) == ClearLateWatch
pure def lawLateListenerCannotGuide(fix: LocationFix): bool = not(fix.exactCallback) implies not(guidesFix(fix))
```
