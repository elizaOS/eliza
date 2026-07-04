# Notifications on the elizaOS forks (Linux + AOSP)

How agent notifications reach the OS-level notification systems on the two
elizaOS operating-system products — **elizaOS Live** (the Debian/GNOME USB
distribution, `packages/os/linux`) and **elizaOS Android** (the AOSP fork,
`packages/os/android`) — and where the fork boundary deliberately is.

## The shared model (all platforms)

There is exactly one notification pipeline, and the forks do not add another:

1. **Producer** — anything with a runtime handle calls
   `NotificationService.notify(...)`
   (`packages/core/src/services/notification.ts`). The service persists the
   inbox (source of truth, survives restart) and fans out live over the agent
   event bus / WebSocket.
2. **In-app surface** — the dashboard notification center
   (`packages/ui/src/components/shell/NotificationsHomeCenter.tsx`), pinned on
   the launcher home below the time/weather base. This is the durable,
   actionable inbox on every platform; OS-level alerts are best-effort
   interrupts on top of it.
3. **OS sinks** — the client store
   (`packages/ui/src/state/notifications/notification-store.ts`) raises an
   OS-level alert when the window is backgrounded, or immediately for
   `high`/`urgent` priorities, through:
   - the Electrobun desktop bridge (`desktopShowNotification` RPC →
     `Utils.showNotification`), and
   - the mobile/native bridge
     (`packages/ui/src/bridge/native-notifications.ts`).
4. **Remote push** — APNs/FCM delivery for devices whose agent runs elsewhere
   (`packages/agent/src/services/push/`). Not fork-specific.

Priority is the only loudness signal, and it maps mechanically per platform:

| `AgentNotification.priority` | Android channel (importance) | freedesktop urgency | web `Notification` |
| --- | --- | --- | --- |
| `urgent` | `eliza_alerts` (5, MAX — heads-up + sound) | `critical` | audible |
| `high` | `eliza_notifications` (4, HIGH — heads-up) | `normal` | audible |
| `normal` | `eliza_updates` (3, DEFAULT — sound, no heads-up) | `normal` | audible |
| `low` | `eliza_quiet` (2, LOW — silent) | `low`, silent | `silent: true` |

## elizaOS Live (Linux / GNOME)

The distribution boots a stock GNOME desktop with the elizaOS desktop app as
the home surface (`packages/os/linux/README.md`). GNOME Shell already ships a
spec-compliant `org.freedesktop.Notifications` D-Bus daemon with its own
banner + message-tray persistence, so the design is **pass-through, not
replacement**:

- The desktop app raises notifications through Electrobun's native path
  (`packages/app-core/platforms/electrobun/src/rpc-handlers.ts` →
  `Utils.showNotification`), which lands on the session's freedesktop daemon —
  GNOME banners, lockscreen policy, and Do-Not-Disturb all behave as the user
  expects from any Linux app.
- The urgency column above is applied at the RPC boundary
  (`fireDesktopNotification` in `notification-store.ts` maps priority →
  `low`/`normal`/`critical` + `silent`), which is the exact vocabulary of the
  freedesktop spec — nothing fork-specific required.
- **Amnesia interaction**: in the default RAM-only boot, GNOME's tray history
  is lost with the session, and so is any unsynced local state — the durable
  inbox is the agent's `NotificationService` store, which lives (or dies) with
  the chosen persistence mode alongside the rest of `~/.eliza/`. This is the
  correct amnesia semantic: notifications are exactly as persistent as the
  agent they belong to.

**Non-goals**: shipping a custom notification daemon, patching GNOME Shell's
shade, or mirroring GNOME's tray history into the app. One daemon (GNOME's),
one inbox (the agent's).

## elizaOS Android (AOSP fork)

Two directions, deliberately asymmetric:

**Outbound (agent → system shade)** uses only public Android API — the
Capacitor `LocalNotifications` plugin posting to `NotificationManager` with
the per-priority channels from the table above
(`packages/ui/src/bridge/native-notifications.ts`). Channels give the user
per-tier control in system settings (silence background chatter, keep
approvals heads-up). Because this path needs no privilege, it is identical on
the AOSP fork, the Play build, and any stock-Android install — the fork adds
nothing here, which is what keeps the app portable.

Since Eliza is the **home app** on the fork, the launcher dashboard widget is
the primary notification surface; the system shade is the secondary surface
for when the user is inside another app, plus the lockscreen. Both render the
same inbox rows (the shade via the channel post, the dashboard via WS/HTTP),
and opening either converges on the same store, so read/dismiss state never
forks.

**Inbound (system → agent)** is the AOSP-only privilege:
`ElizaNotificationListenerService` — declared in the fork's control-surface
manifest (`packages/os/android/vendor/eliza/manifests/aosp-assistant-full-control.json`)
and stripped from Play/cloud builds — lets the agent read *other apps'*
notifications as context (the "what's happening on this device" signal).
Listener-derived context feeds the agent loop; it is **not** injected into the
user-facing notification inbox, which only carries notifications the agent
deliberately produced. Mixing the two would turn the dashboard center into a
worse copy of the system shade.

**Non-goals**: forking SystemUI's shade or lockscreen UI, a second in-app
notification store, or replaying listener-captured third-party notifications
into the agent inbox.

## Verifying a change

- Unit: `packages/ui/src/bridge/native-notifications.test.ts` (channel
  routing), `packages/ui/src/state/notifications/notification-store.test.ts`
  (sink gating), `packages/agent/src/api/notification-routes.test.ts`.
- Dev seeding: `POST /api/notifications/dev/seed` (non-production builds) or
  Settings → Backup & Reset → Developer tools → "Seed test notifications"
  paints every priority tier for on-device shade/channel verification.
- Desktop: the app menu's "Send Test Notification" item exercises the
  Electrobun → OS daemon path directly.
