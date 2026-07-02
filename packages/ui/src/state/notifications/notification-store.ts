import {
  type AgentNotification,
  DEFAULT_NOTIFICATION_CATEGORY,
  DEFAULT_NOTIFICATION_PRIORITY,
  type NotificationCategory,
  type NotificationPriority,
  type UUID,
} from "@elizaos/core";
import { useSyncExternalStore } from "react";
import { client } from "../../api/client";
import { invokeDesktopBridgeRequest } from "../../bridge/electrobun-rpc";
import { showNativeNotification } from "../../bridge/native-notifications";
import {
  type ActionTone,
  TOAST_TTL_MS,
  toastToneForPriority,
} from "../action-notice";

/**
 * Notification center store.
 *
 * Self-contained module store (no React context) feeding the in-app
 * notification center. It hydrates the inbox from `GET /api/notifications`
 * once, subscribes to the live WS `agent_event` stream filtered to
 * `stream === "notification"`, and fans each new notification out to the
 * interrupt sinks (desktop OS notification, mobile native notification, and
 * an optional in-app toast registered by the app shell) based on priority and
 * window focus. The inbox itself is always updated — the center is the
 * source-of-truth surface; the OS/toast sinks are best-effort interrupts.
 */

export interface NotificationState {
  notifications: AgentNotification[];
  unreadCount: number;
  hydrated: boolean;
}

type ToastSink = (text: string, tone?: ActionTone, ttlMs?: number) => void;

let state: NotificationState = {
  notifications: [],
  unreadCount: 0,
  hydrated: false,
};

const listeners = new Set<() => void>();
let initialized = false;
let toastSink: ToastSink | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: Partial<NotificationState>): void {
  state = { ...state, ...next };
  emit();
}

function countUnread(list: AgentNotification[]): number {
  let count = 0;
  for (const n of list) if (!n.readAt) count++;
  return count;
}

/** Insert/replace a notification (collapsing by groupKey), newest-first. */
function upsert(notification: AgentNotification): AgentNotification[] {
  const withoutDuplicate = state.notifications.filter(
    (n) =>
      n.id !== notification.id &&
      !(notification.groupKey && n.groupKey === notification.groupKey),
  );
  return [notification, ...withoutDuplicate].slice(0, 300);
}

function isWindowFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

async function fireDesktopNotification(
  notification: AgentNotification,
): Promise<void> {
  await invokeDesktopBridgeRequest<{ id: string }>({
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
    /* desktop bridge absent (web/mobile) — handled by other sinks */
  });
}

/**
 * Deliver a notification to the interrupt sinks. The inbox is updated
 * separately; this only decides whether to also raise an OS/toast alert.
 */
function deliver(notification: AgentNotification): void {
  const focused = isWindowFocused();
  const interruptive =
    notification.priority === "high" || notification.priority === "urgent";

  // Desktop OS + mobile native: fire when the window is backgrounded, or for
  // interruptive priorities even when focused.
  if (!focused || interruptive) {
    void fireDesktopNotification(notification);
    void showNativeNotification({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      deepLink: notification.deepLink,
      urgent: interruptive,
    }).catch(() => {});
  }

  // In-app toast: interruptive priorities always surface a toast; quieter
  // notifications only toast when the window is focused (so the user who is
  // looking still gets a glance) and otherwise rely on the OS notification.
  if (toastSink && (interruptive || focused)) {
    const text = notification.body
      ? `${notification.title} — ${notification.body}`
      : notification.title;
    toastSink(
      text,
      toastToneForPriority(notification.priority),
      interruptive
        ? TOAST_TTL_MS.notificationInterruptive
        : TOAST_TTL_MS.notification,
    );
  }
}

function ingest(notification: AgentNotification, unreadCount?: number): void {
  const notifications = upsert(notification);
  setState({
    notifications,
    unreadCount:
      typeof unreadCount === "number"
        ? unreadCount
        : countUnread(notifications),
  });
  deliver(notification);
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
 * Validate the untrusted WS notification payload into a typed AgentNotification,
 * or null to drop it. The wire is an external boundary — `id` and `title` are
 * required (a notification without either is unrenderable, so drop it), the
 * category/priority unions fall back to their canonical defaults, `createdAt`
 * falls back to now, and the optional fields pass through only when well-typed.
 * This replaces the previous double-cast that trusted every field but `id`.
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
    readAt: optionalTimestamp(raw.readAt),
    expiresAt: optionalTimestamp(raw.expiresAt),
  };
}

function handleWsAgentEvent(data: Record<string, unknown>): void {
  const event = data as WsAgentEvent;
  if (event.stream !== "notification") return;
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as { notification?: unknown; unreadCount?: unknown })
      : undefined;
  const notification = validateWsNotification(payload?.notification);
  if (!notification) return;
  const unreadCount =
    typeof payload?.unreadCount === "number" ? payload.unreadCount : undefined;
  ingest(notification, unreadCount);
}

async function hydrate(): Promise<void> {
  try {
    const res = await client.listNotifications({ limit: 100 });
    setState({
      notifications: res.notifications,
      unreadCount: res.unreadCount,
      hydrated: true,
    });
  } catch {
    // Inbox endpoint not ready (early boot) — mark hydrated so the UI shows
    // an empty state instead of a perpetual spinner; live events still arrive.
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

/** Register the in-app toast sink (the app shell wires `setActionNotice`). */
export function registerNotificationToastSink(sink: ToastSink | null): void {
  toastSink = sink;
}

// ── Mutations (optimistic; backed by the HTTP API) ──────────────────────────

export async function markNotificationRead(id: string): Promise<void> {
  const now = Date.now();
  const notifications = state.notifications.map((n) =>
    n.id === id && !n.readAt ? { ...n, readAt: now } : n,
  );
  setState({ notifications, unreadCount: countUnread(notifications) });
  await client.markNotificationRead(id).catch(() => {});
}

export async function markAllNotificationsRead(): Promise<void> {
  const now = Date.now();
  const notifications = state.notifications.map((n) =>
    n.readAt ? n : { ...n, readAt: now },
  );
  setState({ notifications, unreadCount: 0 });
  await client.markAllNotificationsRead().catch(() => {});
}

export async function removeNotification(id: string): Promise<void> {
  const notifications = state.notifications.filter((n) => n.id !== id);
  setState({ notifications, unreadCount: countUnread(notifications) });
  await client.removeNotification(id).catch(() => {});
}

export async function clearNotifications(): Promise<void> {
  setState({ notifications: [], unreadCount: 0 });
  await client.clearNotifications().catch(() => {});
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
  toastSink = null;
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
