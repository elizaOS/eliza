/**
 * Client store for agent notifications: validates untrusted WS payloads into
 * typed AgentNotification records, tracks unread state, and delivers each
 * arrival to one interrupt surface, native-first (OS notification on
 * desktop/mobile, in-app glass banner as the web fallback). Subscribed via
 * useSyncExternalStore.
 */
import {
  type AgentNotification,
  DEFAULT_NOTIFICATION_CATEGORY,
  DEFAULT_NOTIFICATION_PRIORITY,
  type NotificationCategory,
  type NotificationPriority,
  type UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/logger";
import { useSyncExternalStore } from "react";
import { client } from "../../api/client";
import { invokeDesktopBridgeRequest } from "../../bridge/electrobun-rpc";
import {
  showNativeNotification,
  showWebNotification,
} from "../../bridge/native-notifications";
import { pushNotificationBanner } from "./notification-banner-store";

/**
 * Notification center store.
 *
 * Self-contained module store (no React context) feeding the in-app
 * notification center. It hydrates the inbox from `GET /api/notifications`
 * once, subscribes to the live WS `agent_event` stream filtered to
 * `stream === "notification"`, and delivers each new notification to exactly
 * one interrupt surface, native-first: the OS notification on desktop
 * (Electrobun) and mobile (Capacitor), falling back to the in-app glass banner
 * on the web and wherever no native channel delivered. The inbox itself is
 * always updated — the center is the source-of-truth surface; the interrupt
 * surfaces are best-effort.
 */

export interface NotificationState {
  notifications: AgentNotification[];
  unreadCount: number;
  hydrated: boolean;
}

let state: NotificationState = {
  notifications: [],
  unreadCount: 0,
  hydrated: false,
};

const listeners = new Set<() => void>();
let initialized = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: Partial<NotificationState>): void {
  state = { ...state, ...next };
  emit();
}

function countUnread(list: AgentNotification[]): number {
  let count = 0;
  for (const n of list) {
    // §C.1 Silent tier (`low`) lands in the inbox but carries no badge weight.
    if (!n.readAt && n.priority !== "low") count++;
  }
  return count;
}

/** Insert/replace a notification (collapsing by groupKey), newest-first. */
function upsert(
  notification: AgentNotification,
  options: { preserveOrder?: boolean } = {},
): AgentNotification[] {
  const matches = (n: AgentNotification): boolean =>
    n.id === notification.id ||
    !!(notification.groupKey && n.groupKey === notification.groupKey);

  // Read-state / metadata updates must not move the row under the user's finger
  // (§C.2). Replace in place when the row already exists; only insert if this
  // client missed the original notification.
  if (options.preserveOrder) {
    let replaced = false;
    const next = state.notifications.map((n) => {
      if (!matches(n)) return n;
      replaced = true;
      return notification;
    });
    return (replaced ? next : [notification, ...next]).slice(0, 300);
  }

  const withoutDuplicate = state.notifications.filter((n) => !matches(n));
  return [notification, ...withoutDuplicate].slice(0, 300);
}

function isWindowFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Fire the Electrobun host's OS notification. Resolves true only when the
 * desktop bridge exists and handled the request (the RPC helper resolves null
 * when the bridge is absent, i.e. web/mobile).
 */
async function fireDesktopNotification(
  notification: AgentNotification,
): Promise<boolean> {
  const result = await invokeDesktopBridgeRequest<{ id: string }>({
    rpcMethod: "desktopShowNotification",
    ipcChannel: "desktop:showNotification",
    params: {
      title: notification.title,
      body: notification.body,
      urgency:
        notification.priority === "urgent"
          ? "critical"
          : notification.priority === "low"
            ? "low"
            : "normal",
      silent: notification.priority === "low",
    },
  }).catch(() => {
    // error-policy:J6 best-effort OS-interrupt sink; a failing desktop bridge
    // reads as "no native surface" so the glass fallback takes over.
    return null;
  });
  return result !== null;
}

/**
 * Deliver a notification to exactly one interrupt surface, native-first. The
 * inbox is updated separately in ingest; this only raises the alert.
 *
 * Policy: platforms with an OS-native channel (Electrobun desktop, Capacitor
 * mobile) alert through it — the OS owns loudness/heads-up semantics via the
 * priority mapping, and the in-app glass banner stays out of the way (no
 * double alert). Where no native channel delivers (web, or a denied/absent
 * bridge), the glass banner is the surface while the window is visible; a
 * hidden tab falls back to the browser Notification API, and only if that also
 * fails does the banner queue so a returning user still gets the heads-up.
 */
async function deliver(notification: AgentNotification): Promise<void> {
  // §C.1 Silent tier is inbox-only: no OS/native interrupt, no toast, no badge.
  if (notification.priority === "low") return;

  if (await fireDesktopNotification(notification)) return;

  const request = {
    id: notification.id,
    title: notification.title,
    body: notification.body,
    deepLink: notification.deepLink,
    priority: notification.priority,
    // Coalesce the OS surface the way the inbox does: a superseding
    // same-groupKey arrival must REPLACE the prior OS notification (shared tag),
    // not stack a second one for a single inbox row.
    groupKey: notification.groupKey,
  };
  // error-policy:J6 best-effort OS-interrupt sink; the inbox (set separately
  // in ingest) is the source of truth, so a failed native alert must not
  // disturb delivery — it reads as "none" and the glass fallback takes over.
  const nativeChannel = await showNativeNotification(request).catch(
    () => "none" as const,
  );
  if (nativeChannel !== "none") return;

  if (isWindowFocused()) {
    pushNotificationBanner(notification);
    return;
  }
  if (!showWebNotification(request)) {
    pushNotificationBanner(notification);
  }
}

function ingest(
  notification: AgentNotification,
  unreadCount?: number,
  options: { deliver?: boolean } = {},
): void {
  const notifications = upsert(notification, {
    preserveOrder: options.deliver === false,
  });
  setState({
    notifications,
    unreadCount:
      typeof unreadCount === "number"
        ? unreadCount
        : countUnread(notifications),
  });
  if (options.deliver !== false) {
    void deliver(notification);
  }
}

interface WsAgentEvent {
  stream?: string;
  payload?: unknown;
}

const NOTIFICATION_CATEGORIES: ReadonlySet<string> =
  new Set<NotificationCategory>([
    "reminder",
    "task",
    "workflow",
    "agent",
    "approval",
    "message",
    "health",
    "system",
    "general",
  ]);
const NOTIFICATION_PRIORITIES: ReadonlySet<string> =
  new Set<NotificationPriority>(["low", "normal", "high", "urgent"]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function optionalTimestamp(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Pass through the producer `data` bag only when it is a plain object (the wire
 * is untrusted). Carries reserved keys like `count` (§C.3) to the row; a scalar
 * or array `data` is malformed and dropped rather than rendered as garbage.
 */
function optionalDataObject(
  value: unknown,
): AgentNotification["data"] | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AgentNotification["data"])
    : undefined;
}

/**
 * Validate the untrusted WS notification payload into a typed AgentNotification,
 * or null to drop it. The wire is an external boundary — `id` and `title` are
 * required (a notification without either is unrenderable, so drop it), the
 * category/priority unions fall back to their canonical defaults, `createdAt`
 * falls back to now, and the optional fields pass through only when well-typed.
 */
function validateWsNotification(value: unknown): AgentNotification | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.title !== "string") return null;
  const category =
    typeof raw.category === "string" &&
    NOTIFICATION_CATEGORIES.has(raw.category)
      ? (raw.category as NotificationCategory)
      : DEFAULT_NOTIFICATION_CATEGORY;
  const priority =
    typeof raw.priority === "string" &&
    NOTIFICATION_PRIORITIES.has(raw.priority)
      ? (raw.priority as NotificationPriority)
      : DEFAULT_NOTIFICATION_PRIORITY;
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : Date.now();
  return {
    id: raw.id as UUID,
    title: raw.title,
    category,
    priority,
    source: optionalString(raw.source) ?? "unknown",
    createdAt,
    body: optionalString(raw.body),
    deepLink: optionalString(raw.deepLink),
    icon: optionalString(raw.icon),
    groupKey: optionalString(raw.groupKey),
    data: optionalDataObject(raw.data),
    readAt: optionalTimestamp(raw.readAt),
    expiresAt: optionalTimestamp(raw.expiresAt),
  };
}

function handleWsAgentEvent(data: Record<string, unknown>): void {
  const event = data as WsAgentEvent;
  if (event.stream !== "notification") return;
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as {
          notification?: unknown;
          unreadCount?: unknown;
          type?: unknown;
        })
      : undefined;
  const notification = validateWsNotification(payload?.notification);
  if (!notification) return;
  const unreadCount =
    typeof payload?.unreadCount === "number" ? payload.unreadCount : undefined;
  const deliverUpdate = payload?.type !== "notification_update";
  ingest(notification, unreadCount, { deliver: deliverUpdate });
}

async function hydrate(): Promise<void> {
  try {
    const res = await client.listNotifications({ limit: 100 });
    setState({
      notifications: res.notifications,
      unreadCount: res.unreadCount,
      hydrated: true,
    });
  } catch (err) {
    // error-policy:J1 transport boundary: the inbox HTTP hydrate failed
    // (endpoint not ready at early boot, or a real 5xx/network fault). Surface
    // it — a silent swallow here is the banned "not loaded reads as empty".
    // Recovery is designed: mark hydrated so the surface renders (not a
    // perpetual spinner) and the live WS stream, subscribed independently in
    // initNotifications, still populates the inbox from the next event on.
    logger.warn(
      { err },
      "[notification-store] inbox hydrate failed; live WS stream will populate",
    );
    setState({ hydrated: true });
  }
}

/** Idempotent boot: hydrate the inbox and subscribe to live notifications. */
export function initNotifications(): void {
  if (initialized) return;
  initialized = true;
  void hydrate();
  client.onWsEvent("agent_event", handleWsAgentEvent);
}

let devSeedAttempted = false;

/**
 * Dev-only: populate the demo spread when the inbox is empty so the home
 * notification surface is visible by default while developing. The boot wiring
 * calls this only in dev builds (`import.meta.env.DEV`); the server's
 * `/dev/seed` route is itself non-production (404s in prod), so this stays a
 * no-op outside dev. Runs at most once per session and never seeds over a real
 * inbox — production is strictly data-driven.
 */
export async function seedDevNotificationsIfEmpty(): Promise<void> {
  if (devSeedAttempted) return;
  devSeedAttempted = true;
  // Hydrate first so we only seed a genuinely-empty inbox, never over real rows.
  if (!state.hydrated) await hydrate();
  if (state.notifications.length > 0) return;
  try {
    const res = await client.seedDevNotifications();
    setState({
      notifications: res.notifications,
      unreadCount: countUnread(res.notifications),
      hydrated: true,
    });
  } catch {
    // Prod 404s the seed route (or it is otherwise unavailable) — stay
    // data-driven; a dev seed failure must never break boot.
  }
}

// ── Mutations (optimistic; backed by the HTTP API) ──────────────────────────

/**
 * Roll the optimistic state back to `previous` and log at error level when a
 * mutation's HTTP write fails. Reverting is the user-visible surfacing: a
 * failed "mark read" returns the item to unread and a failed delete makes it
 * reappear, so the inbox never silently diverges from server truth. Callers
 * fire-and-forget (`void`), so this never rethrows.
 */
function revertMutation(
  previous: NotificationState,
  op: string,
  err: unknown,
): void {
  setState({
    notifications: previous.notifications,
    unreadCount: previous.unreadCount,
  });
  logger.error({ err }, `[notification-store] ${op} failed; reverted`);
}

export async function markNotificationRead(id: string): Promise<void> {
  const previous = state;
  const now = Date.now();
  const notifications = state.notifications.map((n) =>
    n.id === id && !n.readAt ? { ...n, readAt: now } : n,
  );
  setState({ notifications, unreadCount: countUnread(notifications) });
  try {
    await client.markNotificationRead(id);
  } catch (err) {
    revertMutation(previous, "markNotificationRead", err);
  }
}

export async function markAllNotificationsRead(): Promise<void> {
  const previous = state;
  const now = Date.now();
  const notifications = state.notifications.map((n) =>
    n.readAt ? n : { ...n, readAt: now },
  );
  setState({ notifications, unreadCount: 0 });
  try {
    await client.markAllNotificationsRead();
  } catch (err) {
    revertMutation(previous, "markAllNotificationsRead", err);
  }
}

export async function removeNotification(id: string): Promise<void> {
  const previous = state;
  const notifications = state.notifications.filter((n) => n.id !== id);
  setState({ notifications, unreadCount: countUnread(notifications) });
  try {
    await client.removeNotification(id);
  } catch (err) {
    revertMutation(previous, "removeNotification", err);
  }
}

export async function clearNotifications(): Promise<void> {
  const previous = state;
  setState({ notifications: [], unreadCount: 0 });
  try {
    await client.clearNotifications();
  } catch (err) {
    revertMutation(previous, "clearNotifications", err);
  }
}

// ── React binding ───────────────────────────────────────────────────────────

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): NotificationState {
  return state;
}

export function useNotifications(): NotificationState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only reset hook. */
export function __resetNotificationStoreForTests(): void {
  state = { notifications: [], unreadCount: 0, hydrated: false };
  initialized = false;
  devSeedAttempted = false;
  listeners.clear();
}

/** Test-only direct ingest (bypasses WS). */
export function __ingestNotificationForTests(
  notification: AgentNotification,
  unreadCount?: number,
): void {
  ingest(notification, unreadCount);
}

/** Test-only: drive the hydration flag to exercise the not-loaded vs empty UI. */
export function __setHydratedForTests(value: boolean): void {
  setState({ hydrated: value });
}

/** Test-only snapshot of the live store state (the WS-validation path asserts the
 *  coerced fields directly rather than through a sink). */
export function __getStateForTests(): NotificationState {
  return state;
}

type NotificationStoreTestBridge = {
  ingestNotificationForTests: (
    notification: AgentNotification,
    unreadCount?: number,
  ) => void;
  resetNotificationStoreForTests: () => void;
  getStateForTests: () => NotificationState;
};

function publishNotificationStoreTestBridge(): void {
  const g = globalThis as Record<PropertyKey, unknown>;
  g[Symbol.for("elizaos.ui.notification-store-tests")] = {
    ingestNotificationForTests: __ingestNotificationForTests,
    resetNotificationStoreForTests: __resetNotificationStoreForTests,
    getStateForTests: __getStateForTests,
  } satisfies NotificationStoreTestBridge;
}

publishNotificationStoreTestBridge();
