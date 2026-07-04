/**
 * Cross-platform native notification bridge: shows OS/mobile notifications and
 * routes their tap deep-links back into the app.
 */
import { Capacitor } from "@capacitor/core";
import { navigateDeepLink } from "../state/notifications/navigate-deep-link";
import { getNativePlugin } from "./native-plugins";

/**
 * Cross-platform native notification bridge.
 *
 * Surfaces an `AgentNotification` as an OS-level notification on a mobile
 * device. Resolution order (first that succeeds wins):
 *
 *   1. `@capacitor/local-notifications` (`LocalNotifications`) — the canonical
 *      cross-platform plugin (iOS + Android channels). Used when the native
 *      build registered it.
 *   2. `ElizaIntent` (iOS) — the bespoke companion plugin already wired to
 *      `UNUserNotificationCenter`; covers iOS builds that ship the companion
 *      but not LocalNotifications.
 *   3. Web `Notification` API — desktop browsers / PWA shells.
 *
 * Plugins are read from the runtime Capacitor registry (`Capacitor.Plugins`),
 * so this module statically imports nothing optional — the web/desktop bundle
 * is unaffected when the native plugins are absent, and every path no-ops
 * gracefully rather than throwing.
 */

interface NativeNotificationRequest {
  /** Stable string id (used to derive a numeric LocalNotifications id). */
  id: string;
  title: string;
  body?: string;
  /** App route / URL to open on tap. */
  deepLink?: string;
  /** Higher urgency maps to a more interruptive channel/sound. */
  urgent?: boolean;
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

const ANDROID_CHANNEL_ID = "eliza_notifications";
let channelEnsured = false;

async function ensureAndroidChannel(
  plugin: LocalNotificationsPluginLike,
): Promise<void> {
  if (channelEnsured || Capacitor.getPlatform() !== "android") return;
  if (typeof plugin.createChannel !== "function") return;
  try {
    // importance 4 = HIGH (heads-up), visibility 1 = public.
    await plugin.createChannel({
      id: ANDROID_CHANNEL_ID,
      name: "Eliza",
      importance: 4,
      visibility: 1,
    });
    channelEnsured = true;
  } catch {
    // Channel creation is best-effort; the default channel still delivers.
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
      // Permission probe failed — attempt to schedule anyway; the OS will
      // drop it if ungranted, and we don't want to block the other sinks.
    }
  }

  await ensureAndroidChannel(plugin);

  await plugin.schedule({
    notifications: [
      {
        id: numericId(req.id),
        title: req.title,
        body: req.body ?? "",
        channelId: ANDROID_CHANNEL_ID,
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
      ...(req.deepLink ? { deepLinkOnTap: req.deepLink } : {}),
    },
    issuedAtIso: new Date().toISOString(),
  });
  return result.accepted === true;
}

function tryWebNotification(req: NativeNotificationRequest): boolean {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission !== "granted") return false;
  try {
    const notification = new Notification(req.title, {
      body: req.body,
      tag: req.id,
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
          /* ignore navigation failure */
        }
      };
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Show a native OS notification. Returns the channel that handled it, or
 * `"none"` if no native channel was available (the in-app center still has it).
 */
export async function showNativeNotification(
  req: NativeNotificationRequest,
): Promise<"local" | "intent" | "web" | "none"> {
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
  if (tryWebNotification(req)) return "web";
  return "none";
}

/** Whether a native local-notification channel is available on this platform. */
export function hasNativeNotificationChannel(): boolean {
  if (!Capacitor.isNativePlatform()) return false;
  const local =
    getNativePlugin<LocalNotificationsPluginLike>("LocalNotifications");
  if (hasMethod<LocalNotificationsPluginLike>(local, "schedule")) return true;
  if (Capacitor.getPlatform() === "ios") {
    const intent = getNativePlugin<ElizaIntentPluginLike>("ElizaIntent");
    return hasMethod<ElizaIntentPluginLike>(intent, "receiveIntent");
  }
  return false;
}

/** Request native notification permission up-front (best-effort, idempotent). */
export async function requestNativeNotificationPermission(): Promise<boolean> {
  const plugin =
    getNativePlugin<LocalNotificationsPluginLike>("LocalNotifications");
  if (typeof plugin.requestPermissions === "function") {
    try {
      const status = await plugin.requestPermissions();
      return status.display === "granted";
    } catch {
      return false;
    }
  }
  return false;
}
