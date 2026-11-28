# Native desktop

The native desktop bridge exposes system tray controls, global shortcuts, auto-launch, window bounds and visibility, notifications, power state, clipboard, safe external URL launch, and explicit permission probing on desktop hosts and browser fallbacks.

## Story: Manage desktop tray, shortcuts, window state, and notifications safely

> As the desktop owner, I want tray icons, shortcuts, window opacity and fullscreen modes, notifications, and external URL opens governed by explicit bounds and lifecycle checks so that desktop host state never drifts out of range or launches unsafe URL schemes.

### Desktop host state keeps opacity, shortcut counts, notifications, and lifecycle transitions bounded

Creating (`createTray`) and destroying (`destroyTray`) the tray toggle `trayActive` without duplicating an existing tray. Registering (`registerShortcut`) and unregistering (`unregisterShortcut`) global shortcuts keep `shortcutCount` within `0..32`, and showing (`showNotification`) and closing (`closeNotification`) notifications keep `activeNotifications` within `0..64`. Window opacity (`setWindowOpacity`) requires `0 <= opacityHundredths <= 100`, toggling fullscreen (`setFullscreen`) clears `minimized`, toggling visibility (`setWindowVisibility`) clears `minimized` when hidden, every transition strictly increments `generation`, and `safeExternalScheme` permits only `http`, `https`, and `mailto`.

```quint
type DesktopState = {
  trayActive: bool,
  shortcutCount: int,
  autoLaunchEnabled: bool,
  visible: bool,
  minimized: bool,
  maximized: bool,
  fullscreen: bool,
  opacityHundredths: int,
  activeNotifications: int,
  generation: int,
}

pure val initial: DesktopState = {
  trayActive: false,
  shortcutCount: 0,
  autoLaunchEnabled: false,
  visible: true,
  minimized: false,
  maximized: false,
  fullscreen: false,
  opacityHundredths: 100,
  activeNotifications: 0,
  generation: 0,
}

pure def validOpacity(opacityHundredths: int): bool =
  opacityHundredths >= 0 and opacityHundredths <= 100

pure def safeExternalScheme(scheme: str): bool =
  scheme == "http" or scheme == "https" or scheme == "mailto"

pure def canCreateTray(s: DesktopState): bool = not(s.trayActive)
pure def createTray(s: DesktopState): DesktopState = {
  ...s, trayActive: true, generation: s.generation + 1,
}

pure def canDestroyTray(s: DesktopState): bool = s.trayActive
pure def destroyTray(s: DesktopState): DesktopState = {
  ...s, trayActive: false, generation: s.generation + 1,
}

pure def canRegisterShortcut(s: DesktopState): bool = s.shortcutCount < 32
pure def registerShortcut(s: DesktopState): DesktopState = {
  ...s, shortcutCount: s.shortcutCount + 1, generation: s.generation + 1,
}

pure def canUnregisterShortcut(s: DesktopState): bool = s.shortcutCount > 0
pure def unregisterShortcut(s: DesktopState): DesktopState = {
  ...s, shortcutCount: s.shortcutCount - 1, generation: s.generation + 1,
}

pure def canSetWindowVisibility(s: DesktopState, visible: bool): bool = visible != s.visible
pure def setWindowVisibility(s: DesktopState, visible: bool): DesktopState = {
  ...s,
  visible: visible,
  minimized: if (not(visible)) false else s.minimized,
  generation: s.generation + 1,
}

pure def canSetWindowOpacity(s: DesktopState, opacityHundredths: int): bool =
  validOpacity(opacityHundredths) and opacityHundredths != s.opacityHundredths
pure def setWindowOpacity(s: DesktopState, opacityHundredths: int): DesktopState = {
  ...s, opacityHundredths: opacityHundredths, generation: s.generation + 1,
}

pure def canSetFullscreen(s: DesktopState, flag: bool): bool = flag != s.fullscreen
pure def setFullscreen(s: DesktopState, flag: bool): DesktopState = {
  ...s,
  fullscreen: flag,
  minimized: if (flag) false else s.minimized,
  generation: s.generation + 1,
}

pure def canShowNotification(s: DesktopState): bool = s.activeNotifications < 64
pure def showNotification(s: DesktopState): DesktopState = {
  ...s, activeNotifications: s.activeNotifications + 1, generation: s.generation + 1,
}

pure def canCloseNotification(s: DesktopState): bool = s.activeNotifications > 0
pure def closeNotification(s: DesktopState): DesktopState = {
  ...s, activeNotifications: s.activeNotifications - 1, generation: s.generation + 1,
}

pure def alwaysOpacityBounded(s: DesktopState): bool =
  s.opacityHundredths >= 0 and s.opacityHundredths <= 100

pure def alwaysCountsNonnegative(s: DesktopState): bool =
  s.shortcutCount >= 0 and s.shortcutCount <= 32 and
  s.activeNotifications >= 0 and s.activeNotifications <= 64 and
  s.generation >= 0

pure def alwaysFullscreenNotMinimized(s: DesktopState): bool =
  s.fullscreen implies not(s.minimized)

pure def stepDesktopGenerationIncreases(before: DesktopState, after: DesktopState): bool =
  after.generation > before.generation

pure def lawUnsafeExternalSchemeRejected(scheme: str): bool =
  (scheme != "http" and scheme != "https" and scheme != "mailto") implies not(safeExternalScheme(scheme))

pure def sometimesTrayAndShortcutActive(s: DesktopState): bool =
  s.trayActive and s.shortcutCount >= 1

pure def sometimesNotificationShown(s: DesktopState): bool =
  s.activeNotifications >= 1

pure val opacityHundredthsValues = Set(-1, 0, 50, 100, 101)
pure val schemeValues = Set("http", "https", "mailto", "javascript", "file")
```
