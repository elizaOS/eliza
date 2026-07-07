/**
 * Web Push subscription manager for the installed **web** PWA (iOS 16.4+).
 *
 * This is the client half of the web-push lane: it feature-detects push
 * support, requests notification permission (behind an explicit user gesture —
 * iOS rejects a non-gesture `subscribe`), creates/reads/removes the
 * `PushSubscription`, and reports a single `WebPushState` the settings toggle
 * renders. It is deliberately transport-agnostic: POSTing the subscription to
 * the cloud + the sender service land in the web-push cloud PR (PR-2+). Here we
 * only own the browser-side subscription lifecycle.
 *
 * Native (Capacitor) push has its own APNs/FCM path in `push-registration.ts`;
 * this module is for the pure web PWA where that plugin is absent. The two are
 * mutually exclusive by platform.
 *
 * Every DOM/global seam is injectable so the state machine is fully unit
 * testable without a real ServiceWorker/PushManager.
 */

import { getBootConfig } from "../../config/boot-config";

/** Coarse subscription state surfaced to the settings UI. */
export type WebPushState =
  | "unsupported" // no PushManager / SW / Notification, or not standalone
  | "unconfigured" // supported but no VAPID public key wired up
  | "denied" // Notification.permission === "denied"
  | "default" // supported + configured, not yet subscribed (can prompt)
  | "subscribed"; // an active PushSubscription exists

/** The four global seams, injectable for tests. */
export interface WebPushDeps {
  /** `window.Notification` (or a stub). */
  getNotification: () => typeof Notification | undefined;
  /** Ready service-worker registration, or null if none. */
  getRegistration: () => Promise<ServiceWorkerRegistration | null>;
  /** VAPID public key from boot config (base64url), or undefined. */
  getVapidPublicKey: () => string | undefined;
  /** Whether the app is running as an installed standalone PWA. */
  isStandalone: () => boolean;
}

/** Base64url → Uint8Array for `applicationServerKey`. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

function defaultIsStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  // iOS Safari sets navigator.standalone; other browsers expose the media query.
  if (nav?.standalone === true) return true;
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches
  );
}

export const defaultWebPushDeps: WebPushDeps = {
  getNotification: () =>
    typeof Notification !== "undefined" ? Notification : undefined,
  getRegistration: async () => {
    if (
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator) ||
      !navigator.serviceWorker
    ) {
      return null;
    }
    const reg = await navigator.serviceWorker.ready;
    return reg ?? null;
  },
  getVapidPublicKey: () => {
    const key = getBootConfig().webPushVapidPublicKey;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  },
  isStandalone: defaultIsStandalone,
};

/** Whether the runtime can do web push at all (SW + PushManager + Notification). */
export function isWebPushSupported(
  deps: WebPushDeps = defaultWebPushDeps,
): boolean {
  if (typeof window === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;
  if (typeof PushManager === "undefined") return false;
  if (!deps.getNotification()) return false;
  // iOS only allows web push for an installed (standalone) PWA.
  return deps.isStandalone();
}

/**
 * Resolve the current subscription state without prompting or mutating
 * anything. Safe to call on mount / focus to render the toggle.
 */
export async function getWebPushState(
  deps: WebPushDeps = defaultWebPushDeps,
): Promise<WebPushState> {
  if (!isWebPushSupported(deps)) return "unsupported";
  if (!deps.getVapidPublicKey()) return "unconfigured";

  const Notif = deps.getNotification();
  if (Notif?.permission === "denied") return "denied";

  const reg = await deps.getRegistration();
  const existing = reg ? await reg.pushManager.getSubscription() : null;
  if (existing) return "subscribed";

  return "default";
}

/** Read the active subscription (or null). Never prompts. */
export async function getWebPushSubscription(
  deps: WebPushDeps = defaultWebPushDeps,
): Promise<PushSubscription | null> {
  if (!isWebPushSupported(deps)) return null;
  const reg = await deps.getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/**
 * Subscribe to web push. MUST be called from within an explicit user gesture
 * (iOS rejects otherwise). Requests notification permission if needed, then
 * creates the `PushSubscription` with `userVisibleOnly: true` and the VAPID
 * `applicationServerKey`. Returns the resulting state; on `subscribed` it also
 * returns the subscription so the caller can POST it to the cloud (that POST is
 * out of scope for this PR).
 */
export async function subscribeWebPush(
  deps: WebPushDeps = defaultWebPushDeps,
): Promise<{ state: WebPushState; subscription: PushSubscription | null }> {
  if (!isWebPushSupported(deps)) {
    return { state: "unsupported", subscription: null };
  }
  const vapid = deps.getVapidPublicKey();
  if (!vapid) return { state: "unconfigured", subscription: null };

  const Notif = deps.getNotification();
  if (!Notif) return { state: "unsupported", subscription: null };

  // Reuse an existing grant; otherwise prompt (inside the caller's gesture).
  let permission: NotificationPermission = Notif.permission;
  if (permission === "default") {
    permission = await Notif.requestPermission();
  }
  if (permission !== "granted") {
    return {
      state: permission === "denied" ? "denied" : "default",
      subscription: null,
    };
  }

  const reg = await deps.getRegistration();
  if (!reg) return { state: "unsupported", subscription: null };

  const existing = await reg.pushManager.getSubscription();
  if (existing) return { state: "subscribed", subscription: existing };

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapid),
  });
  return { state: "subscribed", subscription };
}

/**
 * Unsubscribe from web push. Returns the resulting state. Pruning the
 * subscription server-side is the cloud PR's job; here we only tear down the
 * browser subscription.
 */
export async function unsubscribeWebPush(
  deps: WebPushDeps = defaultWebPushDeps,
): Promise<WebPushState> {
  if (!isWebPushSupported(deps)) return "unsupported";
  const reg = await deps.getRegistration();
  const existing = reg ? await reg.pushManager.getSubscription() : null;
  if (existing) {
    await existing.unsubscribe();
  }
  return getWebPushState(deps);
}
