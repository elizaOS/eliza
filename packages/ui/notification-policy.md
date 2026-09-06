# Notification and popup policy

Eliza uses the OS notification surface for completed action feedback and
attention-worthy background events. The OS controls banner location, duration,
permissions, Focus/Do Not Disturb, and lock-screen presentation. A renderer must
not create a transparent always-on-top window to imitate an OS notification.

## Shared routes

| Producer | Delivery | Retained app surface |
| --- | --- | --- |
| `setActionNotice` completion or error | `deliverSystemNotification` | Top-right viewport feedback if no native channel accepts it |
| `setActionNotice` with `busy` | App only | Viewport progress feedback |
| Cloud plain-text `toast` | `bridge/toast` → active shell, or shared native delivery | Shell feedback when embedded; themed Sonner when standalone |
| Cloud interactive, custom, explicitly identified, or loading toast | App only | Sonner retains actions, updates, and progress lifecycle |
| Agent notification arrival | Notification store → shared delivery | Persistent Home inbox, including when the OS suppresses banners |
| Low-priority agent notification | Inbox only | No interrupt or unread badge weight |
| Automation and restart notice | Shared delivery through the compatibility callback | Existing automation/restart state remains authoritative |
| Permissions settings notification test | Shared native delivery, without permission prompts | Inline failure if no native channel accepts it; web push opt-in appears only in browsers |
| Delete confirmation | Shared desktop dialog helper | Native message box on desktop; browser/WebView dialog otherwise |
| Permission, file, share, authentication, and payment UI | Owning platform capability | Keep the platform interaction and authorization contract |
| Persistent degraded-state warnings and audio-unlock controls | App only | Keep the recovery control beside the affected feature |
| Menus, tooltips, editing dialogs, approvals, command palette | App primitives | Interactive UI; never convert a required decision to a passive notification |

The shell overlay stack and both fallback renderers portal to `document.body`, outside the shell's
transformed and collapsible chat containers. Desktop feedback anchors at the
top right; mobile uses safe-area offsets and viewport-constrained width. Passive
shell feedback does not intercept clicks. Notification text remains complete.

Cloud producers import `bridge/toast`; `sonner` is the implementation boundary
for the themed fallback and interactive toast lifecycle. Third-party embedded
websites and vendored inference-server UIs retain their own browser UI. They do
not own Eliza's shell notifications.

## Platform mapping

| Platform | Native route | Presentation contract |
| --- | --- | --- |
| macOS | Electrobun `desktopShowNotification` → `Utils.showNotification` | Notification Center/banner; system placement, typically top right |
| Windows | Electrobun 1.18.1 `Shell_NotifyIconW` | Legacy native tray balloon; host title/body limits apply; do not force macOS placement |
| Linux | Electrobun 1.18.1 `notify-send` | Requires the executable and a desktop notification service; placement varies by desktop environment |
| iOS | Capacitor LocalNotifications | UserNotifications banners and notification list; installed plugin defaults include foreground banners |
| Android | Capacitor LocalNotifications | NotificationManager with separate urgency channels and Android notification permission |
| Web/PWA | App feedback; permitted browser notifications for hidden tabs | No permission prompt for routine action feedback |

Android channel importance is persistent and user-adjustable. Ordinary updates
use the existing normal channel; high and urgent events use their existing
attention channels. Changing urgency does not override user settings. Local
notifications are immediate and do not request exact-alarm privileges.

Routine action feedback never requests notification permission. The permission
settings flow owns opt-in. A denied mobile permission does not trigger a second
permission channel. An unavailable permission check cannot count as successful
local delivery. Existing explicit notification arrivals may request a grant
when the permission state permits asking.

## Guarantees and platform limits

- Native acknowledgement means the host accepted a request, not proof a banner
  was visible. OS suppression must not cause a duplicate app alert.
- A failed/unavailable native channel selects the caller's fallback. Inbox
  records remain independent of interrupt delivery.
- Late completion of an older action-feedback request cannot replace newer
  progress or resurrect a notice after its owner unmounts.
- Mobile notification taps use the existing validated deep-link router.
- The current Electrobun utility is fire-and-forget. The desktop manager does
  not provide notification click callbacks, coalescing IDs, or delivery/permission
  receipts, and currently forwards `silent` rather than platform urgency.
  Those limits must be stated in platform verification; the renderer cannot
  infer capabilities from a generated request ID.
- The pinned Windows implementation uses 63-character title and 255-character
  body buffers and does not report `Shell_NotifyIconW` failure. The preferred
  Windows implementation is a modern app-notification adapter with registered
  app identity, activation routing, and observable submission errors. Its
  platform limits must remain separate from complete inbox records and model
  context. The shared renderer delivery API is the integration boundary for
  replacing the legacy host implementation.
- The pinned Linux implementation starts `notify-send` asynchronously and only
  prints a warning on failure. Linux packaging must supply the corresponding
  distribution package (commonly `libnotify-bin` or `libnotify`), and target
  verification must include the notification daemon and desktop session. A
  host adapter that awaits submission and reports failure would let the shared
  renderer select its fallback reliably.
- A body portal escapes app containers but remains inside the application
  window. Only an OS notification can appear outside that window.

## Validation

The regression suites exercise native/fallback selection, mobile denial and
permission-probe failure, stale action delivery, portal ownership under hidden
chat, and real Sonner Undo behavior. The app visual audit and focused desktop
and mobile browser captures validate geometry. Browser captures and simulated
bridge tests are not proof of native delivery: release validation requires a
current installed build on macOS, Windows, Linux, iOS, and Android, including
permission denied, foreground/background delivery, and notification taps where
the host supports them.

Platform references: [Apple notifications](https://developer.apple.com/design/human-interface-guidelines/notifications/),
[Capacitor local notifications](https://capacitorjs.com/docs/apis/local-notifications),
[Android notifications](https://developer.android.com/develop/ui/views/notifications),
[Windows app notifications](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/),
and [freedesktop notification protocol](https://specifications.freedesktop.org/notification/latest/).
Pinned implementation evidence:
[Electrobun 1.18.1 Windows notifications](https://github.com/blackboardsh/electrobun/blob/v1.18.1/package/src/native/win/nativeWrapper.cpp#L9909)
and [Electrobun 1.18.1 Linux notifications](https://github.com/blackboardsh/electrobun/blob/v1.18.1/package/src/native/linux/nativeWrapper.cpp#L8873).
