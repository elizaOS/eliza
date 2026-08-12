/**
 * Client store for agent notifications: validates untrusted WS payloads into
 * typed AgentNotification records, tracks unread state, and delivers each
 * arrival to an OS notification when the host provides one. The persistent
 * Home notification center is the only in-app surface. Subscribed via
 * useSyncExternalStore.
 *
 * The store is keyed to a live "authority" (active agent-base + authenticated
 * identity/session, #18391): switching agent, base URL, or user, or logging
 * out, synchronously clears the inbox, invalidates in-flight hydration and
 * the live WS binding, and re-hydrates fresh for the new authority. A refresh
 * that resolves to the same authority is a no-op.
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
import {
  STEWARD_SESSION_TRANSITION_EVENT,
  type StewardSessionTransition,
} from "@elizaos/shared/steward-session-client";
import { useSyncExternalStore } from "react";
import { client } from "../../api/client";
import { isApiError } from "../../api/client-types-core";
import { invokeDesktopBridgeRequest } from "../../bridge/electrobun-rpc";
import {
  showNativeNotification,
  showWebNotification,
} from "../../bridge/native-notifications";
import { APP_RESUME_EVENT } from "../../events";
import {
  type AuthStatusState,
  getAuthStatusSnapshot,
  isAuthenticatedNow,
  subscribeAuthStatus,
} from "../../hooks/useAuthStatus";
import { protectedAgentProbesEnabled } from "../../hooks/useProtectedAgentProbesEnabled";

/**
 * Notification center store.
 *
 * Self-contained module store (no React context) feeding the in-app
 * notification center. It hydrates the inbox from `GET /api/notifications`
 * once, subscribes to the live WS `agent_event` stream filtered to
 * `stream === "notification"`, and offers each new notification to an OS
 * surface on desktop, mobile, or a hidden browser tab. The inbox itself is
 * always updated and remains the sole in-app source-of-truth surface.
 */

export interface NotificationState {
  notifications: AgentNotification[];
  unreadCount: number;
  hydrated: boolean;
  hydrationStatus:
    | "idle"
    | "loading"
    | "retrying"
    | "ready"
    | "disabled"
    | "failed";
  hydrationAttempts: number;
  hydrationError: string | null;
}

let state: NotificationState = {
  notifications: [],
  unreadCount: 0,
  hydrated: false,
  hydrationStatus: "idle",
  hydrationAttempts: 0,
  hydrationError: null,
};

const listeners = new Set<() => void>();
const ephemeralNotificationIds = new Set<string>();
let initialized = false;
const HYDRATION_MAX_ATTEMPTS = 5;
const HYDRATION_BASE_DELAY_MS = 500;
const HYDRATION_MAX_DELAY_MS = 30_000;
const HYDRATION_JITTER_RATIO = 0.2;
// A booting notification service depends on the agent runtime's cold start.
// Give that explicit server state a bounded startup window without weakening
// the five-attempt budget for unrelated failures.
const HYDRATION_SERVICE_READINESS_BUDGET_MS = 90_000;
let hydrationInFlight: Promise<void> | null = null;
let hydrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
let hydrationReadinessDeadlineAt = 0;
let hydrationGeneration = 0;
let liveEventRevision = 0;
const notificationCleanups: Array<() => void> = [];
// Identifies the active agent-base + authenticated identity/session (#18391).
// "anon" stands in for the identity/session component while unauthenticated,
// so an agent/base switch is still isolated even with nobody signed in (e.g.
// a local, non-Cloud origin). Null until initNotifications() seeds it.
let currentAuthorityKey: string | null = null;
// The base URL component of currentAuthorityKey, tracked separately so
// reconcileAuthority can tell an auth-only switch (base unchanged) from a
// base switch (already handled by client.onBaseUrlChange's own transport
// teardown) — see reconcileAuthority (#18542).
let currentAuthorityBaseUrl: string | null = null;
// Monotonic even when the visible authority key cycles A -> X -> A, so a
// callback retained from the first A can never become current again.
let currentAuthorityRevision = 0;
let lastStewardSessionEpoch = 0;
// Unsubscribes the currently-bound live WS notification handler; rebound on
// every authority change so a handler closure from a superseded authority can
// never reach ingest(), even if a message is somehow still in flight.
let notificationEventUnsub: (() => void) | null = null;

/**
 * Whether the inbox hydrate may hit the protected `GET /api/notifications` now.
 * Same origin-aware gate the React shell hooks use, read without a hook so the
 * store can consult it from its module-scope hydrate path.
 */
function notificationProbesEnabled(): boolean {
  return protectedAgentProbesEnabled(
    isAuthenticatedNow(),
    typeof window !== "undefined" ? window.location.origin : null,
  );
}

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
    // reads as "no native surface" so another OS channel may be attempted.
    return null;
  });
  return result !== null;
}

/**
 * Offer a notification to an OS interrupt surface. The inbox is updated
 * separately in ingest and remains visible even when no OS channel is
 * available.
 *
 * Policy: platforms with an OS-native channel (Electrobun desktop, Capacitor
 * mobile) alert through it — the OS owns loudness/heads-up semantics via the
 * priority mapping. A focused web app does not duplicate the Home inbox with a
 * floating alert. A hidden tab may use the browser Notification API.
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
  // disturb delivery — it reads as "none" and a hidden browser tab may still
  // raise its own OS notification.
  const nativeChannel = await showNativeNotification(request).catch(
    () => "none" as const,
  );
  if (nativeChannel !== "none") return;

  if (!isWindowFocused()) showWebNotification(request);
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
  liveEventRevision += 1;
  ingest(notification, unreadCount, { deliver: deliverUpdate });
}

/**
 * Bind the live WS notification handler to one authority. The returned
 * closure captures `authorityKey` and self-drops if the store has since moved
 * on — a defense-in-depth guard alongside the unsubscribe/resubscribe in
 * {@link bindLiveNotificationStream}, so a handler reference obtained before a
 * switch can never apply a stale event even if invoked directly.
 */
function createWsAgentEventHandler(
  authorityKey: string,
  authorityRevision: number,
): (data: Record<string, unknown>) => void {
  return (data) => {
    if (
      authorityKey !== currentAuthorityKey ||
      authorityRevision !== currentAuthorityRevision
    ) {
      return;
    }
    handleWsAgentEvent(data);
  };
}

function bindLiveNotificationStream(authorityKey: string): void {
  currentAuthorityRevision += 1;
  notificationEventUnsub?.();
  notificationEventUnsub = client.onWsEvent(
    "agent_event",
    createWsAgentEventHandler(authorityKey, currentAuthorityRevision),
  );
}

/**
 * Non-secret identity for the active authority: the agent-base plus the
 * authenticated identity/session when present, or a fixed "anon" placeholder
 * otherwise. Never derived from a bearer token or other credential material.
 */
function computeAuthorityKey(
  authStatus: AuthStatusState,
  baseUrl: string,
): string {
  const identityPart =
    authStatus.phase === "authenticated"
      ? `${authStatus.identity.id}::${authStatus.session.id}`
      : "anon";
  return `${baseUrl}::${identityPart}`;
}

/** Cancel retry/hydration ownership and clear rows/unread state for a new
 *  authority. Shared by {@link reconcileAuthority} and {@link
 *  invalidateAuthorityForCredentialChange} (#18542). */
function clearForAuthorityChange(): void {
  if (hydrationRetryTimer) {
    clearTimeout(hydrationRetryTimer);
    hydrationRetryTimer = null;
  }
  hydrationInFlight = null;
  hydrationReadinessDeadlineAt = 0;
  hydrationGeneration += 1;
  notificationMutationTail = Promise.resolve();

  setState({
    notifications: [],
    unreadCount: 0,
    hydrated: false,
    hydrationStatus: "idle",
    hydrationAttempts: 0,
    hydrationError: null,
  });
  ephemeralNotificationIds.clear();
}

/**
 * Re-key the store to the authority implied by the latest auth status and the
 * client's current base URL. A no-op when the authority is unchanged (e.g. a
 * same-session background auth refresh). On a real change: rebind the live WS
 * handler, cancel retry/hydration ownership so a stale in-flight response is
 * discarded by {@link runHydrationAttempt}'s generation check, synchronously
 * clear rows/unread state, and hydrate fresh for the new authority.
 *
 * A subsequent switch that keeps the same base URL (an in-place identity
 * change) rotates the underlying connection too: `setBaseUrl`/
 * `repointBaseUrl` already close-before-reopen for a base change, but nothing
 * else touches the transport for an auth-only one, so a message already in
 * flight on the still-open socket could otherwise reach the freshly-rebound
 * (and therefore current-looking) WS handler and be accepted as the new
 * authority's data (#18542).
 */
function reconcileAuthority(authStatus: AuthStatusState): void {
  const baseUrl = client.getBaseUrl();
  const nextKey = computeAuthorityKey(authStatus, baseUrl);
  if (nextKey === currentAuthorityKey) return;
  const previousKey = currentAuthorityKey;
  // Anonymous sockets are still credential-bearing transports after login;
  // rotate every same-base authority switch, including anon -> authenticated.
  // A preceding explicit clear already rotated while the async auth probe was
  // pending, so the sentinel transition is the one safe exception.
  const rotatesTransport =
    previousKey !== null &&
    previousKey !== INVALIDATED_AUTHORITY_KEY &&
    currentAuthorityBaseUrl === baseUrl;
  currentAuthorityKey = nextKey;
  currentAuthorityBaseUrl = baseUrl;
  bindLiveNotificationStream(nextKey);
  clearForAuthorityChange();
  if (rotatesTransport) {
    client.rotateConnection();
  }
  void requestHydration();
}

// Cannot equal any real `computeAuthorityKey` result (those are always
// `<baseUrl>::<identityPart>`), so it always compares unequal and forces a
// real reconcile once the next authority is confirmed.
const INVALIDATED_AUTHORITY_KEY = "credential-invalidated";

/**
 * `useAuthStatus` deliberately keeps the previous authenticated snapshot
 * until the async `/api/auth/me` probe resolves, so a real logout is
 * invisible to {@link reconcileAuthority} for the duration of that
 * round-trip — the inbox and live delivery would keep serving the outgoing
 * authority's data (#18542). The Steward storage authority emits a typed,
 * non-secret transition synchronously: an explicit clear invalidates to a
 * sentinel before that probe completes, while a present/refresh transition
 * rotates transport without guessing that the unrelated agent API bearer
 * represents a Steward login or logout.
 */
function onStewardSessionTransition(event: Event): void {
  const detail = (event as CustomEvent<StewardSessionTransition>).detail;
  if (
    !detail ||
    (detail.state !== "present" && detail.state !== "cleared") ||
    !Number.isSafeInteger(detail.sessionEpoch) ||
    detail.sessionEpoch <= lastStewardSessionEpoch
  ) {
    return;
  }
  lastStewardSessionEpoch = detail.sessionEpoch;

  if (detail.state === "present") {
    // Token rotation does not prove an identity change, so retain the inbox;
    // rotate/rebind transport now and let the typed auth snapshot decide
    // whether a later clear + hydrate is necessary.
    if (currentAuthorityKey !== null) {
      bindLiveNotificationStream(currentAuthorityKey);
      client.rotateConnection();
    }
    return;
  }

  if (currentAuthorityKey === INVALIDATED_AUTHORITY_KEY) return;
  currentAuthorityKey = INVALIDATED_AUTHORITY_KEY;
  bindLiveNotificationStream(currentAuthorityKey);
  clearForAuthorityChange();
  client.rotateConnection();
}

function mergeNotificationLists(
  existing: AgentNotification[],
  persisted: AgentNotification[],
): AgentNotification[] {
  const combined = [...existing, ...persisted].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  const seenIds = new Set<string>();
  const seenGroups = new Set<string>();
  const merged: AgentNotification[] = [];
  for (const notification of combined) {
    if (seenIds.has(notification.id)) continue;
    if (notification.groupKey && seenGroups.has(notification.groupKey))
      continue;
    seenIds.add(notification.id);
    if (notification.groupKey) seenGroups.add(notification.groupKey);
    merged.push(notification);
    if (merged.length === 300) break;
  }
  return merged;
}

function mergeHydratedNotifications(
  persisted: AgentNotification[],
): AgentNotification[] {
  return mergeNotificationLists(state.notifications, persisted);
}

function isRetryableHydrationError(error: unknown): boolean {
  if (!isApiError(error)) return true;
  if (error.kind === "network" || error.kind === "timeout") return true;
  return (
    error.status === 408 ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

function isNotificationServiceStarting(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 503 &&
    error.code === "NOTIFICATION_SERVICE_NOT_READY"
  );
}

function hydrationRetryDelayMs(error: unknown, attempt: number): number {
  const exponential = Math.min(
    HYDRATION_MAX_DELAY_MS,
    HYDRATION_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
  );
  const jitter = exponential * HYDRATION_JITTER_RATIO * (Math.random() * 2 - 1);
  const jittered = Math.max(0, Math.round(exponential + jitter));
  const advertised =
    isApiError(error) && typeof error.retryAfter === "number"
      ? error.retryAfter * 1_000
      : 0;
  return Math.min(HYDRATION_MAX_DELAY_MS, Math.max(jittered, advertised));
}

function hydrationErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Notification inbox hydration failed";
}

async function runHydrationAttempt(generation: number): Promise<void> {
  const attempt = state.hydrationAttempts + 1;
  const liveRevisionAtStart = liveEventRevision;
  if (attempt === 1) {
    hydrationReadinessDeadlineAt =
      Date.now() + HYDRATION_SERVICE_READINESS_BUDGET_MS;
  }
  setState({
    hydrated: false,
    hydrationStatus: attempt === 1 ? "loading" : "retrying",
    hydrationAttempts: attempt,
  });
  try {
    const res = await client.listNotifications({ limit: 100 });
    if (generation !== hydrationGeneration) return;
    if (hydrationRetryTimer) {
      clearTimeout(hydrationRetryTimer);
      hydrationRetryTimer = null;
    }
    const notifications = mergeHydratedNotifications(res.notifications);
    const hydrationStatus =
      res.serviceStatus === "disabled" ? "disabled" : "ready";
    hydrationReadinessDeadlineAt = 0;
    setState({
      notifications,
      unreadCount:
        liveEventRevision === liveRevisionAtStart
          ? res.unreadCount
          : state.unreadCount,
      hydrated: true,
      hydrationStatus,
      hydrationError: null,
    });
    if (attempt > 1) {
      logger.info(
        { attempt, hydrationStatus },
        "[notification-store] inbox hydration recovered",
      );
    }
  } catch (err) {
    // error-policy:J1 transport boundary — bounded background retries keep the
    // live subscription active while surfacing terminal failure in store state.
    if (generation !== hydrationGeneration) return;
    const message = hydrationErrorMessage(err);
    const serviceStarting = isNotificationServiceStarting(err);
    const retryableByKind = isRetryableHydrationError(err);
    const remainingReadinessMs = hydrationReadinessDeadlineAt - Date.now();
    let delayMs: number | null = null;
    if (serviceStarting && remainingReadinessMs > 0) {
      delayMs = Math.min(
        hydrationRetryDelayMs(err, attempt),
        remainingReadinessMs,
      );
    } else if (
      !serviceStarting &&
      retryableByKind &&
      attempt < HYDRATION_MAX_ATTEMPTS
    ) {
      delayMs = hydrationRetryDelayMs(err, attempt);
    }
    if (delayMs === null) {
      hydrationReadinessDeadlineAt = 0;
      logger.error(
        {
          err,
          attempt,
          retryableByKind,
          readinessBudgetExhausted:
            serviceStarting && remainingReadinessMs <= 0,
          serviceStarting,
        },
        "[notification-store] inbox hydration terminal failure",
      );
      setState({
        hydrated: false,
        hydrationStatus: "failed",
        hydrationError: message,
      });
      return;
    }

    logger.warn(
      { err, attempt, delayMs },
      "[notification-store] inbox hydration failed; retry scheduled",
    );
    setState({
      hydrationStatus: "retrying",
      hydrationError: message,
    });
    hydrationRetryTimer = setTimeout(() => {
      hydrationRetryTimer = null;
      void requestHydration();
    }, delayMs);
  }
}

function requestHydration(): Promise<void> {
  if (!notificationProbesEnabled()) {
    // No session yet on the shared Cloud app — skip the protected fetch (it
    // would 401 and Chromium logs the console error). initNotifications()'s
    // persistent auth-status subscription re-triggers this once a session
    // lands post-sign-in via reconcileAuthority() (#16242).
    return Promise.resolve();
  }
  if (hydrationInFlight) return hydrationInFlight;
  if (state.hydrationStatus === "failed") return Promise.resolve();
  const generation = hydrationGeneration;
  const run = runHydrationAttempt(generation);
  let tracked: Promise<void>;
  tracked = run.finally(() => {
    if (hydrationInFlight === tracked) hydrationInFlight = null;
  });
  hydrationInFlight = tracked;
  return tracked;
}

/** Retry a terminal inbox load after a user or lifecycle recovery signal. */
export function retryNotificationHydration(): Promise<void> {
  if (state.hydrationStatus !== "failed") return Promise.resolve();
  hydrationReadinessDeadlineAt = 0;
  setState({
    hydrated: false,
    hydrationStatus: "idle",
    hydrationAttempts: 0,
    hydrationError: null,
  });
  return requestHydration();
}

/** Idempotent boot: hydrate the inbox and subscribe to live notifications. */
export function initNotifications(): void {
  if (initialized) return;
  initialized = true;
  currentAuthorityBaseUrl = client.getBaseUrl();
  currentAuthorityKey = computeAuthorityKey(
    getAuthStatusSnapshot(),
    currentAuthorityBaseUrl,
  );
  bindLiveNotificationStream(currentAuthorityKey);
  notificationCleanups.push(
    () => notificationEventUnsub?.(),
    client.onWsEvent("ws-reconnected", () => {
      void retryNotificationHydration();
    }),
    subscribeAuthStatus(reconcileAuthority),
    client.onBaseUrlChange(() => reconcileAuthority(getAuthStatusSnapshot())),
  );
  if (typeof window !== "undefined") {
    window.addEventListener(
      STEWARD_SESSION_TRANSITION_EVENT,
      onStewardSessionTransition,
    );
    notificationCleanups.push(() =>
      window.removeEventListener(
        STEWARD_SESSION_TRANSITION_EVENT,
        onStewardSessionTransition,
      ),
    );
    const retryOnline = () => void retryNotificationHydration();
    window.addEventListener("online", retryOnline);
    notificationCleanups.push(() =>
      window.removeEventListener("online", retryOnline),
    );
  }
  if (typeof document !== "undefined") {
    const retryOnResume = () => void retryNotificationHydration();
    document.addEventListener(APP_RESUME_EVENT, retryOnResume);
    notificationCleanups.push(() =>
      document.removeEventListener(APP_RESUME_EVENT, retryOnResume),
    );
  }
  void requestHydration();
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
  if (!state.hydrated) await requestHydration();
  if (state.hydrationStatus !== "ready" || state.hydrationError !== null) {
    return;
  }
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

/** An optimistic mutation's pre-write state, tagged with the authority it was
 *  captured under so a response that settles after an authority switch can
 *  recognize its snapshot is stale (#18542). */
interface MutationSnapshot {
  authorityKey: string | null;
  state: NotificationState;
}

let notificationMutationTail = Promise.resolve();

function snapshotForMutation(): MutationSnapshot {
  return { authorityKey: currentAuthorityKey, state };
}

/**
 * Roll the optimistic state back to the snapshot and log at error level when a
 * mutation's HTTP write fails. Reverting is the user-visible surfacing: a
 * failed "mark read" returns the item to unread and a failed delete makes it
 * reappear, so the inbox never silently diverges from server truth. Callers
 * fire-and-forget (`void`), so this never rethrows.
 *
 * If the authority has changed since the snapshot was captured (the request
 * that failed belonged to a prior authority A, but the store has since
 * switched to and hydrated authority B), applying the snapshot would overwrite
 * B's rows with A's — discard the rollback instead (#18542).
 */
function mutationStillOwnsAuthority(
  snapshot: MutationSnapshot,
  op: string,
  err: unknown,
): boolean {
  if (snapshot.authorityKey !== currentAuthorityKey) {
    logger.warn(
      { err },
      `[notification-store] ${op} failed after an authority switch; stale rollback discarded`,
    );
    return false;
  }
  return true;
}

/**
 * Serialize notification writes within one authority. Mark-all, clear, and
 * per-row actions overlap the same server collection, so a single queue is the
 * smallest authority that prevents one failed optimistic write from racing a
 * later successful write. Authority changes replace the queue immediately.
 */
async function serializeNotificationMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = notificationMutationTail;
  let release!: () => void;
  notificationMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
}

function restoreRemovedRows(
  snapshot: MutationSnapshot,
  ids: ReadonlySet<string>,
): void {
  const rows = snapshot.state.notifications.filter((notification) =>
    ids.has(notification.id),
  );
  if (rows.length === 0) return;
  const notifications = mergeNotificationLists(state.notifications, rows);
  setState({ notifications, unreadCount: countUnread(notifications) });
}

export async function markNotificationRead(id: string): Promise<void> {
  return serializeNotificationMutation(async () => {
    const snapshot = snapshotForMutation();
    const now = Date.now();
    const notifications = state.notifications.map((notification) =>
      notification.id === id && !notification.readAt
        ? { ...notification, readAt: now }
        : notification,
    );
    setState({ notifications, unreadCount: countUnread(notifications) });
    try {
      await client.markNotificationRead(id);
    } catch (err) {
      // error-policy:J4 restore only this optimistic field when its write
      // fails; a live update with different bytes remains authoritative.
      if (!mutationStillOwnsAuthority(snapshot, "markNotificationRead", err))
        return;
      const previous = snapshot.state.notifications.find(
        (notification) => notification.id === id,
      );
      const restored = state.notifications.map((notification) =>
        notification.id === id && notification.readAt === now && previous
          ? { ...notification, readAt: previous.readAt }
          : notification,
      );
      setState({ notifications: restored, unreadCount: countUnread(restored) });
      logger.error(
        { err },
        "[notification-store] markNotificationRead failed; reverted row",
      );
    }
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  return serializeNotificationMutation(async () => {
    const snapshot = snapshotForMutation();
    const now = Date.now();
    const notifications = state.notifications.map((notification) =>
      notification.readAt ? notification : { ...notification, readAt: now },
    );
    setState({ notifications, unreadCount: 0 });
    try {
      await client.markAllNotificationsRead();
    } catch (err) {
      // error-policy:J4 reverse only fields still owned by this optimistic
      // write, preserving any live notification update that arrived later.
      if (
        !mutationStillOwnsAuthority(snapshot, "markAllNotificationsRead", err)
      )
        return;
      const previousById = new Map(
        snapshot.state.notifications.map((notification) => [
          notification.id,
          notification,
        ]),
      );
      const restored = state.notifications.map((notification) => {
        const previous = previousById.get(notification.id);
        return notification.readAt === now && previous
          ? { ...notification, readAt: previous.readAt }
          : notification;
      });
      setState({ notifications: restored, unreadCount: countUnread(restored) });
      logger.error(
        { err },
        "[notification-store] markAllNotificationsRead failed; reverted rows",
      );
    }
  });
}

export async function removeNotification(id: string): Promise<void> {
  return serializeNotificationMutation(async () => {
    const snapshot = snapshotForMutation();
    const notifications = state.notifications.filter(
      (notification) => notification.id !== id,
    );
    setState({ notifications, unreadCount: countUnread(notifications) });
    if (ephemeralNotificationIds.delete(id)) return;
    try {
      await client.removeNotification(id);
    } catch (err) {
      // error-policy:J4 the failed row reappears without replacing unrelated
      // rows or live events received while the request was in flight.
      if (!mutationStillOwnsAuthority(snapshot, "removeNotification", err))
        return;
      restoreRemovedRows(snapshot, new Set([id]));
      logger.error(
        { err },
        "[notification-store] removeNotification failed; restored row",
      );
    }
  });
}

/** Remove a producer stack with one optimistic update and one rollback point. */
export async function removeNotifications(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  return serializeNotificationMutation(async () => {
    const idSet = new Set(ids);
    const snapshot = snapshotForMutation();
    const notifications = state.notifications.filter(
      (notification) => !idSet.has(notification.id),
    );
    setState({ notifications, unreadCount: countUnread(notifications) });
    const ephemeralIds = ids.filter((id) =>
      ephemeralNotificationIds.delete(id),
    );
    const ephemeralIdSet = new Set(ephemeralIds);
    const persistedIds = ids.filter((id) => !ephemeralIdSet.has(id));
    if (persistedIds.length === 0) return;

    const results = await Promise.allSettled(
      persistedIds.map((id) => client.removeNotification(id)),
    );
    const failedIds = new Set<string>();
    const failures: unknown[] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const id = persistedIds[index];
        if (id) failedIds.add(id);
        failures.push(result.reason);
      }
    });
    if (failedIds.size === 0) return;
    const representativeError = failures[0];
    if (
      !mutationStillOwnsAuthority(
        snapshot,
        "removeNotifications",
        representativeError,
      )
    )
      return;
    // Partial success is authoritative: only failed persisted rows return;
    // successful deletes and local-only ephemeral deletes stay removed.
    restoreRemovedRows(snapshot, failedIds);
    logger.error(
      { errors: failures, failedCount: failedIds.size },
      "[notification-store] removeNotifications partially failed; restored failed rows",
    );
  });
}

export async function clearNotifications(): Promise<void> {
  return serializeNotificationMutation(async () => {
    const snapshot = snapshotForMutation();
    const previousEphemeralIds = [...ephemeralNotificationIds];
    setState({ notifications: [], unreadCount: 0 });
    ephemeralNotificationIds.clear();
    try {
      await client.clearNotifications();
    } catch (err) {
      // error-policy:J4 restore the cleared rows additively so a live arrival
      // during the request is not overwritten by the older snapshot.
      if (!mutationStillOwnsAuthority(snapshot, "clearNotifications", err))
        return;
      for (const id of previousEphemeralIds) ephemeralNotificationIds.add(id);
      restoreRemovedRows(
        snapshot,
        new Set(snapshot.state.notifications.map(({ id }) => id)),
      );
      logger.error(
        { err },
        "[notification-store] clearNotifications failed; restored rows",
      );
    }
  });
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
  for (const cleanup of notificationCleanups.splice(0)) cleanup();
  hydrationGeneration += 1;
  if (hydrationRetryTimer) clearTimeout(hydrationRetryTimer);
  hydrationRetryTimer = null;
  hydrationInFlight = null;
  hydrationReadinessDeadlineAt = 0;
  currentAuthorityKey = null;
  currentAuthorityBaseUrl = null;
  currentAuthorityRevision = 0;
  lastStewardSessionEpoch = 0;
  notificationMutationTail = Promise.resolve();
  notificationEventUnsub?.();
  notificationEventUnsub = null;
  liveEventRevision = 0;
  state = {
    notifications: [],
    unreadCount: 0,
    hydrated: false,
    hydrationStatus: "idle",
    hydrationAttempts: 0,
    hydrationError: null,
  };
  initialized = false;
  devSeedAttempted = false;
  ephemeralNotificationIds.clear();
  listeners.clear();
}

/** Test-only direct ingest (bypasses WS). */
export function __ingestNotificationForTests(
  notification: AgentNotification,
  unreadCount?: number,
): void {
  ingest(notification, unreadCount);
}

/** Browser-QA ingest whose mutations intentionally stay local. */
export function __ingestEphemeralNotificationForTests(
  notification: AgentNotification,
  unreadCount?: number,
): void {
  ephemeralNotificationIds.add(notification.id);
  ingest(notification, unreadCount, { deliver: false });
}

/** Test-only: drive the hydration flag to exercise the not-loaded vs empty UI. */
export function __setHydratedForTests(value: boolean): void {
  setState({ hydrated: value });
}

/** Test-only terminal state used to verify the designed unavailable surface. */
export function __setHydrationFailureForTests(message: string): void {
  setState({
    hydrated: false,
    hydrationStatus: "failed",
    hydrationAttempts: HYDRATION_MAX_ATTEMPTS,
    hydrationError: message,
  });
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
  ingestEphemeralNotificationForTests: (
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
    ingestEphemeralNotificationForTests: __ingestEphemeralNotificationForTests,
    resetNotificationStoreForTests: __resetNotificationStoreForTests,
    getStateForTests: __getStateForTests,
  } satisfies NotificationStoreTestBridge;
}

publishNotificationStoreTestBridge();
