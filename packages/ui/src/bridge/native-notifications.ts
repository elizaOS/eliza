/**
 * Cross-platform native notification bridge: shows OS/mobile notifications and
 * routes their tap deep-links back into the app.
 *
 * Two exports with distinct roles in the store's delivery policy (native-first,
 * glass-fallback — see notification-store `deliver`):
 *
 *   - `showNativeNotification` — the OS-native channels, first that succeeds:
 *     `@capacitor/local-notifications` (canonical iOS + Android channels), then
 *     `ElizaIntent` (bespoke iOS companion wired to `UNUserNotificationCenter`).
 *     On native platforms this IS the notification surface.
 *   - `showWebNotification` — the browser `Notification` API, used only as the
 *     hidden-tab fallback on platforms with no native channel (the in-app glass
 *     banner is the visible-tab surface there).
 *
 * Plugins are read from the runtime Capacitor registry (`Capacitor.Plugins`),
 * so this module statically imports nothing optional — the web/desktop bundle
 * is unaffected when the native plugins are absent, and every path no-ops
 * gracefully rather than throwing.
 *
 * Delivery loudness follows the notification's priority: on Android each
 * priority tier maps to its own channel (urgent = heads-up + sound, normal =
 * sound without heads-up, low = silent) because channel importance is fixed at
 * creation and user-adjustable per channel — one channel for everything would
 * make backups heads-up or approvals silent, with no way for the user to tune
 * them apart. Web maps low priority to a silent notification.
 */
import { Capacitor } from "@capacitor/core";
import type { NotificationPriority } from "@elizaos/core";
import { navigateDeepLink } from "../state/notifications/navigate-deep-link";
import { getNativePlugin } from "./native-plugins";

export interface NativeNotificationRequest {
  /** Stable string id (used to derive a numeric LocalNotifications id). */
  id: string;
  title: string;
  body?: string;
  /** App route / URL to open on tap. */
  deepLink?: string;
  /** Drives the delivery loudness (Android channel, web silence). */
  priority: NotificationPriority;
  /**
   * Coalescing key. When set, the OS surface is tagged by it so a superseding
   * same-group arrival REPLACES the prior notification (matching the inbox's
   * groupKey collapse) instead of stacking a duplicate. Falls back to `id`.
   */
  groupKey?: string;
}

interface LocalNotificationsPluginLike extends Record<string, unknown> {
  schedule: (options: {
    notifications: Array<{
      id: number;
      title: string;
      body: string;
      schedule?: { at: Date };
      channelId?: string;
      extra?: Record<string, unknown>;
    }>;
  }) => Promise<unknown>;
  checkPermissions?: () => Promise<{ display: string }>;
  requestPermissions?: () => Promise<{ display: string }>;
  createChannel?: (channel: {
    id: string;
    name: string;
    importance: number;
    visibility?: number;
  }) => Promise<void>;
}

interface ElizaIntentPluginLike extends Record<string, unknown> {
  receiveIntent: (intent: {
    kind: "reminder";
    payload: Record<string, unknown>;
    issuedAtIso: string;
  }) => Promise<{ accepted: boolean; reason: string }>;
}

/** Derive a stable 31-bit positive int id from the notification's string id. */
function numericId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 2_000_000_000 || 1;
}

function hasMethod<T>(value: unknown, method: keyof T): value is T {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[method as string] === "function"
  );
}

/**
 * Android channels, one per loudness tier. Importance is fixed at channel
 * creation on Android, so tiers must be distinct channels; users can then
 * tune each tier independently in system settings. Importance scale:
 * 5 = MAX (heads-up + sound), 4 = HIGH (heads-up), 3 = DEFAULT (sound),
 * 2 = LOW (no sound). Visibility 1 = public (lockscreen).
 */
const ANDROID_CHANNELS: Record<
  NotificationPriority,
  { id: string; name: string; importance: number }
> = {
  urgent: { id: "eliza_alerts", name: "Eliza alerts", importance: 5 },
  high: { id: "eliza_notifications", name: "Eliza", importance: 4 },
  normal: { id: "eliza_updates", name: "Eliza updates", importance: 3 },
  low: { id: "eliza_quiet", name: "Eliza background", importance: 2 },
};

const ensuredChannels = new Set<string>();

/** Test-only: clear the per-tier channel-creation cache between tests so a
 *  cached channel from an earlier case doesn't skip a later createChannel. */
export function __resetEnsuredChannelsForTests(): void {
  ensuredChannels.clear();
}

/**
 * `channelId`: the channel to schedule against (undefined off Android, where no
 * channel is needed). `unusable`: true only when a REQUIRED Android channel
 * could not be created — the caller must NOT schedule against it and must NOT
 * report success, because on Android 8+ the NotificationManager silently drops
 * a post to a nonexistent channel (it does NOT fall back to a default), so a
 * fabricated "delivered" would suppress the glass fallback and lose the alert.
 */
async function ensureAndroidChannel(
  plugin: LocalNotificationsPluginLike,
  priority: NotificationPriority,
): Promise<{ channelId?: string; unusable: boolean }> {
  if (Capacitor.getPlatform() !== "android") return { unusable: false };
  const channel = ANDROID_CHANNELS[priority] ?? ANDROID_CHANNELS.normal;
  if (ensuredChannels.has(channel.id))
    return { channelId: channel.id, unusable: false };
  // Old plugin without createChannel (pre-8 targets ignore channels entirely) —
  // scheduling with/without the id posts to the app default; best-effort keep.
  if (typeof plugin.createChannel !== "function")
    return { channelId: channel.id, unusable: false };
  try {
    await plugin.createChannel({
      id: channel.id,
      name: channel.name,
      importance: channel.importance,
      visibility: 1,
    });
    ensuredChannels.add(channel.id);
    return { channelId: channel.id, unusable: false };
  } catch {
    // The channel genuinely could not be created on an 8+ device; a post here
    // would be dropped. Signal unusable so delivery falls through to glass.
    return { channelId: channel.id, unusable: true };
  }
}

async function tryLocalNotifications(
  req: NativeNotificationRequest,
): Promise<boolean> {
  const plugin =
    getNativePlugin<LocalNotificationsPluginLike>("LocalNotifications");
  if (!hasMethod<LocalNotificationsPluginLike>(plugin, "schedule")) {
    return false;
  }

  // Ensure permission (Android 13+ POST_NOTIFICATIONS / iOS alert grant).
  if (typeof plugin.checkPermissions === "function") {
    try {
      const status = await plugin.checkPermissions();
      if (
        status.display !== "granted" &&
        typeof plugin.requestPermissions === "function"
      ) {
        const requested = await plugin.requestPermissions();
        if (requested.display !== "granted") return false;
      }
    } catch {
      // error-policy:J4 permission probe failed — attempt to schedule anyway;
      // the OS drops it if ungranted, and the other sinks must not be blocked.
    }
  }

  const channel = await ensureAndroidChannel(plugin, req.priority);
  // A required Android channel that couldn't be created means the OS would drop
  // the post — don't claim success; let the store's glass fallback deliver.
  if (channel.unusable) return false;

  await plugin.schedule({
    notifications: [
      {
        // Coalesce by groupKey so a superseding same-group arrival reuses the
        // same OS notification id (replace) instead of stacking a new one.
        id: numericId(req.groupKey ?? req.id),
        title: req.title,
        body: req.body ?? "",
        ...(channel.channelId ? { channelId: channel.channelId } : {}),
        ...(req.deepLink ? { extra: { deepLink: req.deepLink } } : {}),
      },
    ],
  });
  return true;
}

async function tryElizaIntent(
  req: NativeNotificationRequest,
): Promise<boolean> {
  if (Capacitor.getPlatform() !== "ios") return false;
  const plugin = getNativePlugin<ElizaIntentPluginLike>("ElizaIntent");
  if (!hasMethod<ElizaIntentPluginLike>(plugin, "receiveIntent")) {
    return false;
  }
  const result = await plugin.receiveIntent({
    kind: "reminder",
    payload: {
      title: req.title,
      body: req.body ?? "",
      priority: req.priority,
      ...(req.deepLink ? { deepLinkOnTap: req.deepLink } : {}),
    },
    issuedAtIso: new Date().toISOString(),
  });
  return result.accepted === true;
}

/**
 * Show a browser `Notification`. The web/PWA fallback surface for a hidden tab
 * — the in-app glass banner covers the visible tab, and the native platforms
 * never reach this. Returns whether the notification was shown.
 */
export function showWebNotification(req: NativeNotificationRequest): boolean {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission !== "granted") return false;
  try {
    const notification = new Notification(req.title, {
      // Coalesce by groupKey: a same-tag notification replaces the prior one in
      // the OS tray, matching the inbox's groupKey collapse (a burst → one).
      tag: req.groupKey ?? req.id,
      body: req.body,
      // Low-priority background chatter must not chime on every delivery.
      silent: req.priority === "low",
    });
    if (req.deepLink) {
      const deepLink = req.deepLink;
      notification.onclick = () => {
        try {
          window.focus();
          // Scheme-checked: a producer-supplied deepLink must never reach a raw
          // top-window navigation (javascript: → XSS, arbitrary https → open
          // redirect). navigateDeepLink drops anything but app routes / http(s).
          navigateDeepLink(deepLink);
        } catch {
          // error-policy:J6 best-effort tap navigation; the app is already
          // focused and the dashboard notification center still lists it.
        }
      };
    }
    return true;
  } catch {
    // error-policy:J4 constructor failure reads as "web channel unavailable";
    // the caller falls back to the in-app glass surface.
    return false;
  }
}

/**
 * Show a native OS notification (Capacitor channels only — the web
 * `Notification` API is a separate fallback, {@link showWebNotification}).
 * Returns the channel that handled it, or `"none"` if no native channel was
 * available; the caller decides whether the in-app glass surface takes over.
 */
export async function showNativeNotification(
  req: NativeNotificationRequest,
): Promise<"local" | "intent" | "none"> {
  // error-policy:J4 documented first-that-succeeds channel chain; a failed
  // channel falls through and an all-failed dispatch returns "none" (the
  // dashboard notification center is the source of truth either way).
  try {
    if (await tryLocalNotifications(req)) return "local";
  } catch {
    /* fall through to next channel */
  }
  try {
    if (await tryElizaIntent(req)) return "intent";
  } catch {
    /* fall through to next channel */
  }
  return "none";
}
