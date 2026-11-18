# Browser dock

The app opens a website in the build-pinned owned browser beside itself
(Android activity embedding, the browser on the left and the app's helper
pane on the right) or, where the host has no room or no embedding, full
screen. While the browser is docked, the app can hide its pane behind a
small return badge drawn over other apps, bring the pane back full screen
from that badge, and restore the split. This spec owns the dock's states,
its refusals and the helper events; `../address.md` owns the address
check, and `lifecycle.md` the in-app surfaces it does not touch.
The shell resolves Android's split support, the window width in whole dp,
the browser's trust and the overlay permission, and reports the host's
embedding as Android sends it. Sources: `BrowserDockController.kt`,
`BrowserHelperEntry.kt`, `BrowserSurfacePlugin.kt` and `definitions.ts` of
`plugin-native-browser-surface`.

## Story: Open a website in the owned browser beside my app

> As the person, I want a website to open beside the app where the screen
> allows it, so that I can follow the app's help while I use the site.

### Opening dispatches the owned browser at a panel width that fits, and refuses with a code the app can fall back from

`openDockedBrowser` takes a web address (`../address.md`), the helper pane
width (`panelWidthDp`, 400 when absent) and the window's width in whole dp.
Without activity embedding it is refused `BROWSER_DOCK_UNAVAILABLE`; a pane
narrower than 320 dp or wider than 640 dp, or a window that leaves the
browser less than 480 dp, is refused `BROWSER_DOCK_SIZE_UNAVAILABLE`. On
either refusal the app opens the browser full screen instead, and nothing
here changes. An untrusted or missing browser is refused by the shell
before this, and the app does not fall back from it. A dispatched opening
replaces the earlier split request, closes any helper window and reports
`browserHelperWindowClosed` with reason `website-opened`.

```quint
import address.* from "../address"
type DockSplit = NoSplit | SplitRequested({ panelWidthDp: int }) | SplitEmbedded({ panelWidthDp: int, helperShown: bool })
type HelperWindow = NoHelperWindow | BadgeWindow | FullScreenWindow
type BrowserDock = { split: DockSplit, helperWindow: HelperWindow, overlayPermission: bool }
type DockRefusal = DockUnavailable | DockSizeUnavailable
type WindowClosedReason = WebsiteOpened | PermissionRevoked
type DockNotice = Dispatched({ panelWidthDp: int }) | DockRefused({ reason: DockRefusal }) | HelperReturned | HelperWindowClosed({ reason: WindowClosedReason })
type DockChange = { state: BrowserDock, out: List[DockNotice] }
pure val initial: BrowserDock = { split: NoSplit, helperWindow: NoHelperWindow, overlayPermission: false }
pure def isEmbedded(split: DockSplit): bool = match split { | SplitEmbedded(e) => true | _ => false }
pure def helperShownIn(split: DockSplit): bool = match split { | SplitEmbedded(e) => e.helperShown | _ => false }
pure def panelWidthOf(split: DockSplit): int = match split { | SplitRequested(r) => r.panelWidthDp | SplitEmbedded(e) => e.panelWidthDp | _ => 0 }
pure def panelFits(panelWidthDp: int, windowWidthDp: int): bool = panelWidthDp >= 320 and panelWidthDp <= 640 and windowWidthDp - panelWidthDp >= 480
pure def canOpenDockedBrowser(s: BrowserDock, address: WebAddress): bool = isWebAddress(address)
pure def openDockedBrowser(s: BrowserDock, address: WebAddress, panelWidthDp: int, windowWidthDp: int, splitAvailable: bool): DockChange =
  if (not(splitAvailable)) { state: s, out: List(DockRefused({ reason: DockUnavailable })) }
  else if (not(panelFits(panelWidthDp, windowWidthDp))) { state: s, out: List(DockRefused({ reason: DockSizeUnavailable })) }
  else { state: { ...s, split: SplitRequested({ panelWidthDp: panelWidthDp }), helperWindow: NoHelperWindow },
    out: List(Dispatched({ panelWidthDp: panelWidthDp }), HelperWindowClosed({ reason: WebsiteOpened })) }
pure def isRefusal(n: DockNotice): bool = match n { | DockRefused(r) => true | _ => false }
pure def alwaysRequestedPaneFits(s: BrowserDock): bool = s.split == NoSplit or (panelWidthOf(s.split) >= 320 and panelWidthOf(s.split) <= 640)
pure def stepRefusedOpeningChangesNothing(before: BrowserDock, via: str, after: BrowserDock, out: List[DockNotice]): bool =
  out.some(n => isRefusal(n)) implies (after == before and out.length() == 1)
pure val panelWidthDpValues = Set(400, 200)
pure val windowWidthDpValues = Set(1280, 700)
pure def sometimesDispatchedNotYetDocked(s: BrowserDock): bool = s.split != NoSplit and not(isEmbedded(s.split))
```

### A dispatched opening is not a split until the host reports the activity embedded

Dispatch proves only that the browser was asked to open. The pane counts
as docked only after the host reports the app's activity embedded beside
the browser; a report that it is no longer embedded (the browser closed or
the split ended) leaves the request open for a later embedding, which
shows the pane again.

```quint
pure def canEmbeddingReported(s: BrowserDock, embedded: bool): bool = s.split != NoSplit
pure def embeddingReported(s: BrowserDock, embedded: bool): BrowserDock =
  if (embedded and not(isEmbedded(s.split))) { ...s, split: SplitEmbedded({ panelWidthDp: panelWidthOf(s.split), helperShown: true }) }
  else if (not(embedded) and isEmbedded(s.split)) { ...s, split: SplitRequested({ panelWidthDp: panelWidthOf(s.split) }) }
  else s
pure def stepDispatchIsNotASplit(before: BrowserDock, via: str, after: BrowserDock): bool =
  (isEmbedded(after.split) and not(isEmbedded(before.split))) implies via == "embeddingReported"
pure def sometimesDocked(s: BrowserDock): bool = isEmbedded(s.split) and helperShownIn(s.split) and s.helperWindow == NoHelperWindow
```

### The dock state is none, docked, collapsed, badge or full screen, read from the split and the helper window

A shown helper window wins: the full-screen helper, then the badge. Without
one, an embedded split is docked while the pane shows and collapsed while
the browser fills the window; anything else is none.

```quint
type DockState = NotDocked | Docked | Collapsed | BadgeShown | HelperFullScreen
pure def dockState(s: BrowserDock): DockState =
  if (s.helperWindow == FullScreenWindow) HelperFullScreen
  else if (s.helperWindow == BadgeWindow) BadgeShown
  else if (isEmbedded(s.split)) (if (helperShownIn(s.split)) Docked else Collapsed)
  else NotDocked
pure def sometimesCollapsed(s: BrowserDock): bool = dockState(s) == Collapsed
```

## Story: Hide the app behind a return badge and come back

> As the person, I want to give the whole screen to the website and still
> have one tap back to the app's help, so that I am never stranded in the
> browser.

### The return badge and the full-screen helper are shown only while the app holds the draw-over permission

Hiding the pane with the entry needs the overlay permission and an
embedded split: it shows the badge (the shell refuses a blank label or
one over 32 characters, and a blank description or one over 120), then
collapses the split. When the permission is revoked, the next reconcile
(the permission watcher or the app's resume) removes the badge and the
full-screen helper, restores the pane beside the browser and reports
`browserHelperWindowClosed` with reason `permission-revoked`; a split
Android will not restore is reported by the shell as
`browserHelperReturnFailed`.

```quint
pure def canHideBrowserDockWithEntry(s: BrowserDock): bool = s.overlayPermission and isEmbedded(s.split)
pure def hideBrowserDockWithEntry(s: BrowserDock): BrowserDock =
  { ...s, split: SplitEmbedded({ panelWidthDp: panelWidthOf(s.split), helperShown: false }), helperWindow: BadgeWindow }
pure def canOverlayPermissionChanged(s: BrowserDock, granted: bool): bool = s.overlayPermission != granted
pure def overlayPermissionChanged(s: BrowserDock, granted: bool): DockChange =
  if (not(granted) and s.helperWindow != NoHelperWindow)
    { state: { ...s, overlayPermission: false, helperWindow: NoHelperWindow,
        split: if (isEmbedded(s.split)) SplitEmbedded({ panelWidthDp: panelWidthOf(s.split), helperShown: true }) else s.split },
      out: List(HelperWindowClosed({ reason: PermissionRevoked })) }
  else { state: { ...s, overlayPermission: granted }, out: List() }
pure def alwaysHelperWindowOnlyWithPermission(s: BrowserDock): bool = s.helperWindow != NoHelperWindow implies s.overlayPermission
pure def sometimesBadgeShown(s: BrowserDock): bool = dockState(s) == BadgeShown
```

### Tapping the badge brings the helper back full screen and reports browserHelperReturned once

The full-screen helper covers the browser with the app's own view; the
browser keeps its page.

```quint
pure def canBadgeTapped(s: BrowserDock): bool = s.helperWindow == BadgeWindow and s.overlayPermission
pure def badgeTapped(s: BrowserDock): DockChange = { state: { ...s, helperWindow: FullScreenWindow }, out: List(HelperReturned) }
pure def sometimesHelperFullScreen(s: BrowserDock): bool = dockState(s) == HelperFullScreen
```

### Hiding with the entry, restoring from it and the visibility toggle change only the helper's visibility, never the split or the website

None of them navigates, reopens or replaces the split: each needs the
split the host reported embedded and keeps its pane width. Restoring from
the entry shows the pane and removes the badge and the full-screen helper;
`setBrowserDockVisible` shows or collapses the pane and leaves any helper
window as it is.

```quint
pure def canRestoreBrowserDockFromEntry(s: BrowserDock): bool = isEmbedded(s.split)
pure def restoreBrowserDockFromEntry(s: BrowserDock): BrowserDock =
  { ...s, split: SplitEmbedded({ panelWidthDp: panelWidthOf(s.split), helperShown: true }), helperWindow: NoHelperWindow }
pure def canSetBrowserDockVisible(s: BrowserDock, visible: bool): bool = isEmbedded(s.split)
pure def setBrowserDockVisible(s: BrowserDock, visible: bool): BrowserDock =
  { ...s, split: SplitEmbedded({ panelWidthDp: panelWidthOf(s.split), helperShown: visible }) }
pure def isDockControl(via: str): bool =
  via == "hideBrowserDockWithEntry" or via == "restoreBrowserDockFromEntry" or via == "setBrowserDockVisible"
pure def stepDockControlsChangeOnlyTheHelper(before: BrowserDock, via: str, after: BrowserDock): bool =
  isDockControl(via) implies (isEmbedded(after.split) and panelWidthOf(after.split) == panelWidthOf(before.split) and
    after.overlayPermission == before.overlayPermission and (via == "setBrowserDockVisible" implies after.helperWindow == before.helperWindow))
```

### Each helper event fires once for the change it reports

`browserHelperReturned` fires only when the badge becomes the full-screen
helper; `browserHelperWindowClosed` fires once for each dispatched opening
and once when a revoked permission closes a shown helper window.
Destroying the plugin removes every helper window and forgets the split
and reports nothing.

```quint
pure def pluginDestroyed(s: BrowserDock): BrowserDock = { ...s, split: NoSplit, helperWindow: NoHelperWindow }
pure def countOf(out: List[DockNotice], n: DockNotice): int = out.select(x => x == n).length()
pure def stepHelperEventsFireOncePerChange(before: BrowserDock, via: str, after: BrowserDock, out: List[DockNotice]): bool =
  countOf(out, HelperReturned) == (if (before.helperWindow == BadgeWindow and after.helperWindow == FullScreenWindow) 1 else 0) and
  countOf(out, HelperWindowClosed({ reason: WebsiteOpened })) == countOf(out, Dispatched({ panelWidthDp: panelWidthOf(after.split) })) and
  countOf(out, HelperWindowClosed({ reason: PermissionRevoked })) ==
    (if (before.helperWindow != NoHelperWindow and after.helperWindow == NoHelperWindow and not(after.overlayPermission)) 1 else 0)
```
