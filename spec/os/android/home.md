# Home launcher

What a Home screen shows of the apps on the device and how a tap opens one.
A product's Home puts its own built-in views and the installed Android apps
in one list; the built-in views and the saved favorites are the product's
data, kept by the shell. This machine follows one Home: the installed-app
read with the default Phone handler beside it, one native launch at a time,
and the refreshes that follow Android's package changes. Sources are
`SystemLauncherApps.java` and the launcher client of the system plugin.

An installed entry is one launcher activity, identified by package, activity
and Android user (a work, private or clone profile has its own entries);
a label never identifies it. The list port filters malformed entries, the
host app itself and Android's app-details stand-in, keeps the first of each
key and gives each a small component number, which is what the model holds.
Android re-resolves the exact component when it launches, so an entry that
was removed, disabled or whose profile is locked is refused with a stable
code (`not-installed`, `disabled`, `no-launcher`, `profile-locked`,
`profile-unavailable`, `failed`) instead of opening something else. The
Phone shortcut sends the dial role itself, so Android opens whichever
handler is the default now. A launch is a handoff
(`bridge.md`): `Opened` means Android showed the app, nothing more.

## Story: Show my apps and open the one I chose

> As an owner, I want Home to list the apps installed now and my default
> Phone app, and a tap to open exactly the entry I chose, so that what I
> see and open is what is really on my device.

### An inventory read publishes only after its list and dial-role replies settle

Opening the app drawer, or a Home that must show an installed favorite,
starts a read; it shows loading and clears the last error. Every read takes
a new read ticket, and a reply that names an older ticket, or arrives after
Home retired, is refused. The list and dial replies arrive in either order;
the read publishes when both have. A listed reply makes the inventory ready
with exactly the listed apps. A refused or malformed list makes it failed
and drops every earlier native app, so an old list is never shown as
current; the same read can still confirm a Phone handler. A dial error,
missing bridge support or no handler all leave no Phone shortcut. The
built-in views stay in place whatever the read does.

```quint
import bridge.* from "./bridge"
type InventoryStatus = InventoryIdle | InventoryLoading | InventoryReady | InventoryFailed
type DialRole = DialAvailable | DialUnavailable
type ReplyStatus = Awaited | Answered | Declined
type Handoff = NoHandoff | OpeningApp | OpeningDial
type LaunchError = NoLaunchError | NoLongerInstalled | AppRefused | DialRefused
type LauncherInventory = {
  homeShown: bool, inventory: InventoryStatus, apps: Set[int], dial: DialRole,
  readTicket: int, reading: bool, listReply: ReplyStatus, listed: Set[int], dialReply: ReplyStatus,
  handoff: Handoff, ticket: int, error: LaunchError
}
pure val initial: LauncherInventory = {
  homeShown: false, inventory: InventoryIdle, apps: Set(), dial: DialUnavailable,
  readTicket: 0, reading: false, listReply: Awaited, listed: Set(), dialReply: Awaited,
  handoff: NoHandoff, ticket: 0, error: NoLaunchError
}
pure def beginRead(quiet: bool, s: LauncherInventory): LauncherInventory = {
  val keep = quiet and s.inventory != InventoryIdle
  { ...s, readTicket: s.readTicket + 1, reading: true, listReply: Awaited, listed: Set(), dialReply: Awaited,
    inventory: if (keep) s.inventory else InventoryLoading, error: if (keep) s.error else NoLaunchError }
}
pure def settleRead(listReply: ReplyStatus, listed: Set[int], dialReply: ReplyStatus, s: LauncherInventory): LauncherInventory =
  if (listReply == Awaited or dialReply == Awaited) { ...s, listReply: listReply, listed: listed, dialReply: dialReply }
  else {
    ...s, inventory: if (listReply == Answered) InventoryReady else InventoryFailed,
    apps: if (listReply == Answered) listed else Set(), dial: if (dialReply == Answered) DialAvailable else DialUnavailable,
    reading: false, listReply: Awaited, listed: Set(), dialReply: Awaited
  }
pure def canShowHome(s: LauncherInventory): bool = not(s.homeShown)
pure def showHome(s: LauncherInventory): LauncherInventory = { ...s, homeShown: true }
pure def canLoadInventory(s: LauncherInventory): bool = s.homeShown
pure def loadInventory(s: LauncherInventory): LauncherInventory = beginRead(false, s)
pure def awaitsReply(ticket: int, reply: ReplyStatus, s: LauncherInventory): bool = s.reading and ticket == s.readTicket and reply == Awaited
pure def canReceiveList(s: LauncherInventory, ticket: int): bool = awaitsReply(ticket, s.listReply, s)
pure def receiveList(s: LauncherInventory, ticket: int, listed: Set[int]): LauncherInventory = settleRead(Answered, listed, s.dialReply, s)
pure def canReceiveListFailure(s: LauncherInventory, ticket: int): bool = awaitsReply(ticket, s.listReply, s)
pure def receiveListFailure(s: LauncherInventory, ticket: int): LauncherInventory = settleRead(Declined, Set(), s.dialReply, s)
pure def canReceiveDial(s: LauncherInventory, ticket: int): bool = awaitsReply(ticket, s.dialReply, s)
pure def receiveDial(s: LauncherInventory, ticket: int, role: DialRole): LauncherInventory =
  settleRead(s.listReply, s.listed, if (role == DialAvailable) Answered else Declined, s)
pure def sameApps(a: Set[int], b: Set[int]): bool = a.subseteq(b) and b.subseteq(a)
pure def alwaysReadAwaitsItsReplies(s: LauncherInventory): bool =
  s.readTicket >= 0 and not(s.listReply != Awaited and s.dialReply != Awaited) and
  (s.reading or (s.listReply == Awaited and s.dialReply == Awaited)) and (s.listReply == Answered or s.listed.size() == 0)
pure def alwaysUnreadInventoryAndFailedListHoldNoApps(s: LauncherInventory): bool =
  (s.inventory == InventoryIdle implies (s.apps.size() == 0 and s.dial == DialUnavailable)) and
  (s.inventory == InventoryFailed implies s.apps.size() == 0)
pure def stepInventoryChangesOnlyOnLoadOrCompleteRead(before: LauncherInventory, via: str, after: LauncherInventory): bool =
  (before.inventory != after.inventory or not(sameApps(before.apps, after.apps)) or before.dial != after.dial) implies
    (via == "loadInventory" or (before.reading and not(after.reading) and after.readTicket == before.readTicket))
pure def sometimesInventoryReadyWithPhone(s: LauncherInventory): bool = s.inventory == InventoryReady and s.apps.size() > 0 and s.dial == DialAvailable
pure def sometimesFailedListKeepsPhone(s: LauncherInventory): bool = s.inventory == InventoryFailed and s.dial == DialAvailable
pure val listedValues = Set(Set(), Set(1), Set(1, 2))
pure val ticketValues = Set(0, 1, 2, 3)
```

### A launch settles under the ticket it captured, and a late reply cannot set an error on a newer ticket

A tap opens an installed app only when its exact entry is in the current
list; an entry that is gone reports that it is no longer installed without
asking Android. The Phone shortcut needs a confirmed dial handler. While a
launch is in flight another tap does nothing. Each launch takes a new
ticket, and only a reply under the ticket in flight settles it. `Opened`
clears the launch. `Refused` reports the refusal and starts a quiet read of
both the list and the dial role, since the entry or handler may be gone.
Retiring Home drops the launch in flight without undoing it: Android may
already have opened the app, but its reply changes nothing. Typing a search
dismisses the error and leaves a running read alone.

```quint
pure def canOpenApp(s: LauncherInventory, component: int): bool = s.homeShown and s.handoff == NoHandoff
pure def openApp(s: LauncherInventory, component: int): LauncherInventory =
  if (routeTap(InstalledApp({ componentId: component }), Set(), s.apps) == AskAndroid) { ...s, handoff: OpeningApp, ticket: s.ticket + 1, error: NoLaunchError }
  else { ...s, error: NoLongerInstalled }
pure def canOpenDial(s: LauncherInventory): bool = s.homeShown and s.handoff == NoHandoff and s.dial == DialAvailable
pure def openDial(s: LauncherInventory): LauncherInventory = { ...s, handoff: OpeningDial, ticket: s.ticket + 1, error: NoLaunchError }
pure def canSettleHandoff(s: LauncherInventory, ticket: int, answer: HandoffOutcome): bool = s.handoff != NoHandoff and ticket == s.ticket
pure def settleHandoff(s: LauncherInventory, ticket: int, answer: HandoffOutcome): LauncherInventory =
  if (answer == Opened) { ...s, handoff: NoHandoff }
  else beginRead(true, { ...s, handoff: NoHandoff, error: if (s.handoff == OpeningDial) DialRefused else AppRefused })
pure def canDismissError(s: LauncherInventory): bool = s.error != NoLaunchError
pure def dismissError(s: LauncherInventory): LauncherInventory = { ...s, error: NoLaunchError }
pure def alwaysHandoffBelongsToAShownHome(s: LauncherInventory): bool =
  s.ticket >= 0 and (s.handoff != NoHandoff implies (s.homeShown and s.inventory != InventoryIdle and s.error == NoLaunchError))
pure def stepOnlyARefusedHandoffReportsAndRefreshes(before: LauncherInventory, via: str, after: LauncherInventory): bool =
  via == "settleHandoff" implies (after.handoff == NoHandoff and ((after.error != NoLaunchError) iff (after.readTicket == before.readTicket + 1)))
pure def stepDismissingKeepsTheRead(before: LauncherInventory, via: str, after: LauncherInventory): bool =
  via == "dismissError" implies (after.readTicket == before.readTicket and after.reading == before.reading)
pure def sometimesAppOpening(s: LauncherInventory): bool = s.handoff == OpeningApp
pure def sometimesDialOpening(s: LauncherInventory): bool = s.handoff == OpeningDial
pure def sometimesRefusalRefreshes(s: LauncherInventory): bool = s.error == AppRefused and s.reading
pure def sometimesGoneEntryRefusedLocally(s: LauncherInventory): bool = s.error == NoLongerInstalled and s.handoff == NoHandoff
pure val componentValues = Set(1, 2, 3)
```

### Package changes and foreground return refresh until Home retires

Android's package and profile changes, and Home coming back to the
foreground, each start a quiet read: the visible list and error stay until
the read publishes. A page that turns hidden refreshes nothing, and nothing
refreshes before the first read. Retiring Home stops following changes and
ends the read in flight; a later Home can show the same inventory again.
The shell removes Android's change listener exactly once, also when its
registration resolves after Home retired.

```quint
type HomeSignal = PackagesChanged | HomeResumed | HomeHidden
pure def canRefreshHome(s: LauncherInventory, signal: HomeSignal): bool =
  s.homeShown and signal != HomeHidden and s.inventory != InventoryIdle
pure def refreshHome(s: LauncherInventory, signal: HomeSignal): LauncherInventory = beginRead(true, s)
pure def canRetireHome(s: LauncherInventory): bool = s.homeShown
pure def retireHome(s: LauncherInventory): LauncherInventory =
  { ...s, homeShown: false, reading: false, listReply: Awaited, listed: Set(), dialReply: Awaited, handoff: NoHandoff }
pure def alwaysRetiredHomeReadsNothing(s: LauncherInventory): bool = not(s.homeShown) implies (not(s.reading) and s.handoff == NoHandoff)
pure def stepRefreshKeepsWhatIsShown(before: LauncherInventory, via: str, after: LauncherInventory): bool =
  via == "refreshHome" implies (after.inventory == before.inventory and after.error == before.error and sameApps(after.apps, before.apps))
pure def sometimesRetiredAfterShowingApps(s: LauncherInventory): bool = not(s.homeShown) and s.inventory == InventoryReady
pure def sometimesQuietRefreshOverReadyList(s: LauncherInventory): bool = s.reading and s.inventory == InventoryReady and s.apps.size() > 0
```

### An admitted built-in view opens in the renderer and never reaches Android

A built-in view is opened by its registered key in the renderer, and only
while the product admits it; a view the product deferred is not opened at
all. Its key is never read as a package name and no native launch is
inferred from a label. An installed entry goes to Android only while it is
in the current list, which is how `openApp` decides.

```quint
type HomeEntry = BuiltinView({ viewId: int }) | InstalledApp({ componentId: int })
type TapRoute = OpenInRenderer | AskAndroid | NotOpenable
pure def routeTap(entry: HomeEntry, admittedViews: Set[int], apps: Set[int]): TapRoute = match entry {
  | BuiltinView(v) => if (admittedViews.contains(v.viewId)) OpenInRenderer else NotOpenable
  | InstalledApp(a) => if (apps.contains(a.componentId)) AskAndroid else NotOpenable
}
pure def lawBuiltinViewNeverReachesAndroid(viewId: int, admittedViews: Set[int], apps: Set[int]): bool = {
  val route = routeTap(BuiltinView({ viewId: viewId }), admittedViews, apps)
  route != AskAndroid and ((route == OpenInRenderer) iff admittedViews.contains(viewId))
}
pure def lawInstalledEntryNeverOpensInTheRenderer(componentId: int, admittedViews: Set[int], apps: Set[int]): bool =
  routeTap(InstalledApp({ componentId: componentId }), admittedViews, apps) != OpenInRenderer
pure val viewIdValues = Set(1, 2)
pure val admittedViewsValues = Set(Set(), Set(1), Set(1, 2))
pure val appsValues = Set(Set(), Set(1), Set(2))
```
