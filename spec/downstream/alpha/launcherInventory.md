# Alpha Home launcher inventory and Android handoff

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` mounts the
launcher in `apps/app/src/prototype/home-shell.ts:70–75,117–128,149–156`.
Eliza `c518127a025ab173874af9c7d304f26b25213b0d` supplies
`packages/ui/src/mobile-shell/mobile-launcher.ts:128–174` and
`plugins/plugin-native-system/src/client/launcher.ts:67–89,124–130,352–655,664–726`.
[Home favorites](./launcher.md) owns saved order, migration and built-in
view routing. This model covers the inventory used for native app and
Phone handoff. It follows one current read, one native launch and one
observer. Installed component lists and callback identities are symbolic.

## Story: Open Home and see the current installed apps and Phone shortcut

### An inventory read publishes only after its list and dial-role replies settle

Home starts its first read when it needs an installed favorite, and
opening the drawer explicitly loads. A quiet refresh before initial
load does nothing. A later quiet refresh leaves the visible inventory
and last error in place while loading. Every started read makes
earlier list and dial replies stale. The read waits for both replies,
in either order. A current successful list places built-ins first,
filters malformed and aliased native entries, and takes the first
occurrence of each exact key. The key is package, optional activity
and optional Android user or profile. Display labels do not identify
targets. A rejected or malformed list reports failure and drops
previous native apps. The same current dial read can still confirm
a default handler. Dial errors, missing bridge support and an
unavailable role all leave no handler.

The list port supplies the already-filtered exact native components.
The model uses a set for membership and preserves list ordering as a
port obligation. A failed read leaves the separately owned built-ins.

```quint
type InventoryStatus = InventoryIdle | InventoryLoading | InventoryReady | InventoryFailed
type HandoffError = NoHandoffError | StaleComponent | ComponentRefused | DialRefused
type HandoffTarget = NoTarget | AndroidComponent({ componentId: int }) | DialRole
type ListOutcome = NoListReply | NativeList({ entries: Set[int] }) | NativeListFailed
type DialOutcome = NoDialReply | CurrentDial({ handlerId: int }) | DialUnavailable
type LauncherInventory = { inventoryStatus: InventoryStatus, nativeApps: Set[int], dial: int, error: HandoffError,
  readGeneration: int, readActive: bool, listOutcome: ListOutcome, dialOutcome: DialOutcome,
  lifetime: int, nextHandoff: int, handoff: int, target: HandoffTarget }
pure val initial: LauncherInventory = { inventoryStatus: InventoryIdle, nativeApps: Set(), dial: 0, error: NoHandoffError,
  readGeneration: 0, readActive: false, listOutcome: NoListReply, dialOutcome: NoDialReply,
  lifetime: 0, nextHandoff: 0, handoff: 0, target: NoTarget }
pure def beginInventoryRead(quiet: bool, s: LauncherInventory): LauncherInventory =
  { ...s, readGeneration: s.readGeneration + 1, readActive: true, listOutcome: NoListReply, dialOutcome: NoDialReply,
    inventoryStatus: if (quiet and s.inventoryStatus != InventoryIdle) s.inventoryStatus else InventoryLoading,
    error: if (quiet and s.inventoryStatus != InventoryIdle) s.error else NoHandoffError }
pure def canRefreshLauncher(s: LauncherInventory, quiet: bool): bool = not(quiet) or s.inventoryStatus != InventoryIdle
pure def refreshLauncher(s: LauncherInventory, quiet: bool): LauncherInventory = beginInventoryRead(quiet, s)
pure def installedDial(dialOutcome: DialOutcome): int = match dialOutcome { | CurrentDial(handler) => handler.handlerId | _ => 0 }
pure def waitingList(listOutcome: ListOutcome): bool = match listOutcome { | NoListReply => true | _ => false }
pure def waitingDial(dialOutcome: DialOutcome): bool = match dialOutcome { | NoDialReply => true | _ => false }
pure def reconcileInventoryRead(listOutcome: ListOutcome, dialOutcome: DialOutcome, s: LauncherInventory): LauncherInventory =
  if (waitingList(listOutcome) or waitingDial(dialOutcome)) { ...s, listOutcome: listOutcome, dialOutcome: dialOutcome }
  else match listOutcome {
    | NativeList(apps) => { ...s, inventoryStatus: InventoryReady, nativeApps: apps.entries, dial: installedDial(dialOutcome),
        readActive: false, listOutcome: NoListReply, dialOutcome: NoDialReply }
    | _ => { ...s, inventoryStatus: InventoryFailed, nativeApps: Set(), dial: installedDial(dialOutcome),
        readActive: false, listOutcome: NoListReply, dialOutcome: NoDialReply }
  }
pure def canObserveLauncherList(s: LauncherInventory): bool = s.readActive and waitingList(s.listOutcome)
pure def observeLauncherList(s: LauncherInventory, exactRead: bool, listOutcome: ListOutcome): LauncherInventory =
  if (exactRead and not(waitingList(listOutcome))) reconcileInventoryRead(listOutcome, s.dialOutcome, s) else s
pure def canObserveDialRole(s: LauncherInventory): bool = s.readActive and waitingDial(s.dialOutcome)
pure def observeDialRole(s: LauncherInventory, exactRead: bool, dialOutcome: DialOutcome): LauncherInventory =
  if (not(exactRead) or waitingDial(dialOutcome)) s
  else if (installedDial(dialOutcome) <= 0) reconcileInventoryRead(s.listOutcome, DialUnavailable, s)
  else reconcileInventoryRead(s.listOutcome, dialOutcome, s)
pure def alwaysFailedListDropsNativeApps(s: LauncherInventory): bool =
  s.inventoryStatus == InventoryFailed implies s.nativeApps.size() == 0
pure def alwaysReadRepliesOwnCurrentAttempt(s: LauncherInventory): bool =
  if (s.readActive) waitingList(s.listOutcome) or waitingDial(s.dialOutcome)
  else waitingList(s.listOutcome) and waitingDial(s.dialOutcome)
pure def sometimesInventoryIsReady(s: LauncherInventory): bool = s.inventoryStatus == InventoryReady
pure val listOutcomeValues = Set(NoListReply, NativeListFailed, NativeList({ entries: Set() }),
  NativeList({ entries: Set(1, 2) }), NativeList({ entries: Set(2, 3) }))
pure val dialOutcomeValues = Set(NoDialReply, DialUnavailable, CurrentDial({ handlerId: 1 }), CurrentDial({ handlerId: 2 }))
pure val weight_observeLauncherList = 4
pure val weight_observeDialRole = 4
```

### A quiet read reuses icons only for exact unchanged entries

If icons are disabled the bridge receives a plain list request. If icons
are enabled, a full read or a controller that has not reached ready
requests icons. A quiet ready read with reuse enabled first requests a
plain list. A valid unfamiliar component or a change in its lock bit
then triggers one full icon read. Otherwise the reader keeps icons
only for the exact keys still listed. Removal alone does not force
an icon read. A malformed light list is forwarded to the usual list
failure instead of retrying with icons.

```quint
type IconReadPlan = ReadWithoutIcons | ReadWithIcons | CheckKnownIcons
pure def iconReadPlan(icons: bool, reuseIcons: bool, inventoryStatus: InventoryStatus): IconReadPlan =
  if (not(icons)) ReadWithoutIcons
  else if (reuseIcons and inventoryStatus == InventoryReady) CheckKnownIcons else ReadWithIcons
pure def needsIconReload(validLightList: bool, newComponent: bool, changedLockBit: bool): bool =
  validLightList and (newComponent or changedLockBit)
pure def lawInvalidListDoesNotRequestIconsAgain(newComponent: bool, changedLockBit: bool): bool =
  not(needsIconReload(false, newComponent, changedLockBit))
```

## Story: Open only the exact current app or default Phone role

### Native launch settles under its captured lifetime

An app tap requires the exact listed component identity. A removed
component reports it is no longer installed without calling Android.
Package, activity and user are forwarded from that component. Phone
requires an observed available dial role and the bridge's open-role
method. It sends the role itself, so Android resolves the current
handler. An in-flight app or dial launch blocks another native launch.

A current success clears the pending launch. A current refusal clears
it, preserves the launch error and starts a quiet full inventory read.
The read refreshes both components and dial role. Search can clear the
error without retiring that read. Launching again takes a new tap.
When Home unmounts it retires both pending-read generation and
handoff lifetime. A retired launch may already have reached Android.
Its late reply cannot clear a successor, report a stale error or start
a refresh. A later mount can reuse the controller and its previous
visible state. The model takes exact callback custody from the port.

```quint
pure def startNativeHandoff(target: HandoffTarget, s: LauncherInventory): LauncherInventory =
  { ...s, nextHandoff: s.nextHandoff + 1, handoff: s.nextHandoff + 1, target: target, error: NoHandoffError }
pure def canOpenLauncherComponent(s: LauncherInventory, component: int): bool = s.handoff == 0 and component > 0
pure def openLauncherComponent(s: LauncherInventory, component: int): LauncherInventory =
  if (s.nativeApps.contains(component)) startNativeHandoff(AndroidComponent({ componentId: component }), s)
  else { ...s, error: StaleComponent }
pure def canOpenLauncherDial(s: LauncherInventory, bridgeHasDial: bool): bool =
  s.handoff == 0 and s.dial > 0 and bridgeHasDial
pure def openLauncherDial(s: LauncherInventory, bridgeHasDial: bool): LauncherInventory = startNativeHandoff(DialRole, s)
pure def canSettleNativeHandoff(s: LauncherInventory): bool = s.handoff > 0
pure def settleNativeHandoff(s: LauncherInventory, exactHandoff: bool, succeeded: bool): LauncherInventory = {
  val destination = s.target
  val refusal = match destination { | DialRole => DialRefused | _ => ComponentRefused }
  if (not(exactHandoff)) s
  else if (succeeded) { ...s, handoff: 0, target: NoTarget }
  else beginInventoryRead(true, { ...s, handoff: 0, target: NoTarget, error: refusal })
}
pure def retireLauncherPending(s: LauncherInventory): LauncherInventory =
  { ...s, readGeneration: s.readGeneration + 1, readActive: false, listOutcome: NoListReply, dialOutcome: NoDialReply,
    lifetime: s.lifetime + 1, handoff: 0, target: NoTarget }
pure def clearLauncherError(s: LauncherInventory): LauncherInventory = { ...s, error: NoHandoffError }
pure def targetAbsent(target: HandoffTarget): bool = match target { | NoTarget => true | _ => false }
pure def alwaysLauncherHandoffHasTarget(s: LauncherInventory): bool =
  s.nextHandoff >= 0 and s.handoff >= 0 and ((s.handoff == 0) == targetAbsent(s.target))
pure def stepClearingErrorKeepsRead(before: LauncherInventory, via: str, after: LauncherInventory): bool =
  via == "clearLauncherError" implies before.readGeneration == after.readGeneration and before.readActive == after.readActive
pure def sometimesNativeHandoffPending(s: LauncherInventory): bool = s.handoff > 0
pure val componentValues = Set(0, 1, 2, 3)
pure val weight_openLauncherComponent = 3
pure val weight_openLauncherDial = 3
```

### Package changes and foreground return share one debounced refresh

The observer installs document resume and visibility listeners and may
subscribe to native package changes. A hidden visibility event schedules
nothing. Package changes and resume can schedule while hidden. Signals
share one 120 ms timeout. A package change upgrades any pending refresh
to a full read. Once native subscription is following changes, other
resumes request icon reuse. Without it, a resume requests a full read.

Retirement disarms the timer and document listeners. A returned native
handle is removed once, including when registration resolves after
retirement. Rejection leaves platform cleanup unknown. The model represents the
observer's scheduling and cleanup decisions over native handle facts.

```quint
type ObserverSignal = PackagesChanged | DocumentResumed | DocumentVisible | DocumentHidden
type ObserverRefresh = NoObserverRefresh | FullObserverRefresh | ReuseObserverIcons
type NativeSubscription = SubscriptionUnavailable | SubscriptionWaiting | SubscriptionFollowing | SubscriptionFailed
type ObserverCleanup = CleanupNotCalled | CleanupPending | CleanupDone | CleanupUnknown
pure def scheduleObserverRefresh(signalKind: ObserverSignal, active: bool): bool =
  active and signalKind != DocumentHidden
pure def observerRefresh(active: bool, pending: bool, packagesChanged: bool, subscription: NativeSubscription): ObserverRefresh =
  if (not(active and pending)) NoObserverRefresh
  else if (packagesChanged or subscription != SubscriptionFollowing) FullObserverRefresh else ReuseObserverIcons
pure def subscriptionCleanup(active: bool, subscription: NativeSubscription, cleanup: ObserverCleanup): ObserverCleanup =
  if (not(active) and subscription == SubscriptionFollowing and cleanup == CleanupNotCalled) CleanupPending else cleanup
pure def lawRetiredObserverCannotRefresh(pending: bool, packagesChanged: bool, subscription: NativeSubscription): bool =
  observerRefresh(false, pending, packagesChanged, subscription) == NoObserverRefresh
pure def lawRetiredObserverCleanupIsIdempotent(subscription: NativeSubscription, cleanup: ObserverCleanup): bool =
  subscriptionCleanup(false, subscription, subscriptionCleanup(false, subscription, cleanup)) ==
    subscriptionCleanup(false, subscription, cleanup)
```

Pinned `test/quint-launcher-ownership.test.mjs` and
`test/quint-launcher-observer.test.mjs` execute the shared launcher and
bridge with controlled list, role, platform launch, timer and listener
ports. They check exact dispatch arguments and late settlements.
Installed app launches and Android profile availability remain device
observations.
