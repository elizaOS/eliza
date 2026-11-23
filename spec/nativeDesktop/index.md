# Native desktop

The platform host supplies tray menus, shortcuts, window management, app launch preferences, notifications, power state, clipboard and system handoffs. A desktop package does not convey the host's own sensitive OS permission grants.

## Story: Use desktop controls with truthful capability and result states

> As the desktop owner, I want local app controls to work on the actual desktop host and permission-sensitive features to honor the OS.

### Desktop-only operations need an attached, supported host

Shortcut and tray operations identify their owner-side records. Window geometry and opacity are validated before native writes. The host reports OS grants, process termination and external handoffs separately.

```quint
type DesktopOperation = DesktopTray | DesktopShortcut | DesktopAutoLaunch | DesktopWindow |
  DesktopNotice | DesktopPower | DesktopClipboard | DesktopPath | DesktopLifecycle | DesktopHandoff
type DesktopHost = { attached: bool, nativeDesktop: bool, permissionGranted: bool }
type WindowGeometry = { widthPx: int, heightPx: int, opacityMillionths: int }
pure def mayUseDesktop(host: DesktopHost, op: DesktopOperation): bool =
  host.attached and host.nativeDesktop and
  ((op != DesktopShortcut and op != DesktopClipboard) or host.permissionGranted)
pure def validWindowGeometry(geometry: WindowGeometry): bool =
  geometry.widthPx > 0 and geometry.heightPx > 0 and
  geometry.opacityMillionths >= 0 and geometry.opacityMillionths <= 1000000
pure def lawMissingDesktopHasNoOperations(host: DesktopHost, op: DesktopOperation): bool =
  not(host.nativeDesktop) implies not(mayUseDesktop(host, op))
pure val hostValues = Set(
  { attached: true, nativeDesktop: true, permissionGranted: true },
  { attached: true, nativeDesktop: true, permissionGranted: false },
  { attached: false, nativeDesktop: false, permissionGranted: false })
```
