# Home launcher

A consumer's Home shell calls the shared `createMobileShellLauncher` from
`plugins/plugin-native-system/src/client/launcher.ts` and binds it to its own
product registry; its favorites record, built-in key prefix and default
policy are its own data. This spec owns favorite routing, the installed-app
inventory and the native launch. It follows one current read, one native
launch and one observer; component lists and callback identities are
symbolic.

## Story: Open a Home favorite where it lives

> As the person, I want a Home favorite to open the built-in view or the
> installed app it names, so that a saved choice never launches something
> else.

### An admitted built-in view opens inside the renderer

Home joins the available product entries with installed launchable
components and shows them in saved order. A product favorite opened by its
registered key goes to the product view. An installed-app favorite goes to
the native bridge only if the exact component was observed. A view deferred
by product policy is never read as a native package name, and no bridge call
is inferred from a label.

```quint
type SavedKey = ProductKey | InstalledComponent | UnknownKey
type FavoriteLaunch = OpenRenderer | OpenComponent | Blocked
pure def launchFavorite(key: SavedKey, viewAvailable: bool, componentObserved: bool): FavoriteLaunch =
  if (key == InstalledComponent) { if (componentObserved) OpenComponent else Blocked }
  else if (key == UnknownKey or not(viewAvailable)) Blocked else OpenRenderer
pure def lawProductFavoriteNeverLaunchesNative(key: SavedKey, viewAvailable: bool, componentObserved: bool): bool =
  key != InstalledComponent implies launchFavorite(key, viewAvailable, componentObserved) != OpenComponent
pure def lawDeferredProductNeverOpens(key: SavedKey, componentObserved: bool): bool =
  key != InstalledComponent implies launchFavorite(key, false, componentObserved) == Blocked
```

## Story: Open Home and see the current installed apps and Phone shortcut

> As the person, I want Home to list the apps installed now and my
> default Phone app, so that what I tap is what is really there.

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

The list port supplies the filtered native components and keeps their
order; the model uses a set for membership. A failed read leaves the
built-ins in place.

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
```

## Story: Open only the exact current app or default Phone role

> As the person, I want a tap to open exactly the app I chose, or my
> current default Phone app, and nothing else.

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
```

### Package changes and foreground return refresh until Home retires

The observer follows resume, visibility and, when subscribed, native
package changes. A hidden visibility event refreshes nothing; package
changes and resume refresh even while hidden, and each refresh is a quiet
full read. Retirement disarms the listeners and removes a returned native
handle exactly once, even when registration resolves after retirement; a
rejected registration leaves platform cleanup unknown.

```quint
type ObserverSignal = PackagesChanged | DocumentResumed | DocumentVisible | DocumentHidden
type NativeSubscription = SubscriptionUnavailable | SubscriptionWaiting | SubscriptionFollowing | SubscriptionFailed
type ObserverCleanup = CleanupNotCalled | CleanupPending | CleanupDone | CleanupUnknown
pure def observerRefreshes(signalKind: ObserverSignal, active: bool): bool =
  active and signalKind != DocumentHidden
pure def subscriptionCleanup(active: bool, subscription: NativeSubscription, cleanup: ObserverCleanup): ObserverCleanup =
  if (not(active) and subscription == SubscriptionFollowing and cleanup == CleanupNotCalled) CleanupPending else cleanup
pure def lawRetiredObserverCannotRefresh(signalKind: ObserverSignal): bool = not(observerRefreshes(signalKind, false))
pure def lawRetiredObserverCleanupIsIdempotent(subscription: NativeSubscription, cleanup: ObserverCleanup): bool =
  subscriptionCleanup(false, subscription, subscriptionCleanup(false, subscription, cleanup)) ==
    subscriptionCleanup(false, subscription, cleanup)
```
