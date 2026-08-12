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
  type StewardSessionTransition,
  subscribeStewardSessionTransitions,
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
  mutationFailure: NotificationMutationFailure | null;
}

export type NotificationMutationOperation =
  | "mark-read"
  | "mark-all-read"
  | "remove"
  | "remove-batch"
  | "clear";

/** Safe user-facing failure for a notification collection mutation. */
export interface NotificationMutationFailure {
  operation: NotificationMutationOperation;
  message: string;
  failedCount: number;
}

/** Typed rejection paired with the store's visible mutation-failure state. */
export class NotificationMutationError extends Error {
  readonly failure: NotificationMutationFailure;

  constructor(failure: NotificationMutationFailure, cause: unknown) {
    super(failure.message, { cause });
    this.name = "NotificationMutationError";
    this.failure = failure;
  }
}

/** A queued write whose captured authority no longer owns the store. */
export class NotificationMutationSupersededError extends Error {
  readonly operation: NotificationMutationOperation;
  readonly capturedRevision: number;
  readonly currentRevision: number;

  constructor(
    operation: NotificationMutationOperation,
    capturedRevision: number,
    currentRevision: number,
  ) {
    super("Notification mutation authority changed before completion");
    this.name = "NotificationMutationSupersededError";
    this.operation = operation;
    this.capturedRevision = capturedRevision;
    this.currentRevision = currentRevision;
  }
}

let state: NotificationState = {
  notifications: [],
  unreadCount: 0,
  hydrated: false,
  hydrationStatus: "idle",
  hydrationAttempts: 0,
  hydrationError: null,
  mutationFailure: null,
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
let lastStewardSessionRevision = 0;
let notificationMutationTail = Promise.resolve();
let notificationMutationQueueDepth = 0;
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
 *  authority. Shared by auth reconciliation and synchronous Steward-session
 *  invalidation (#18542). */
function clearForAuthorityChange(): void {
  if (hydrationRetryTimer) {
    clearTimeout(hydrationRetryTimer);
    hydrationRetryTimer = null;
  }
  hydrationInFlight = null;
  hydrationReadinessDeadlineAt = 0;
  hydrationGeneration += 1;

  setState({
    notifications: [],
    unreadCount: 0,
    hydrated: false,
    hydrationStatus: "idle",
    hydrationAttempts: 0,
    hydrationError: null,
    mutationFailure: null,
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
function onStewardSessionTransition(
  transition: StewardSessionTransition,
): void {
  if (
    (transition.kind !== "present" && transition.kind !== "cleared") ||
    !Number.isSafeInteger(transition.revision) ||
    transition.revision <= lastStewardSessionRevision
  ) {
    return;
  }
  lastStewardSessionRevision = transition.revision;

  if (transition.kind === "present") {
    // Token rotation does not prove an identity change, so retain the inbox;
    // pending optimistic writes are the exception because their result belongs
    // to the preceding credential revision and cannot safely survive as truth.
    const hasPendingMutation = notificationMutationQueueDepth > 0;
    if (currentAuthorityKey !== null) {
      bindLiveNotificationStream(currentAuthorityKey);
      client.rotateConnection();
      if (hasPendingMutation) {
        clearForAuthorityChange();
        void requestHydration();
      }
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
    const notifications = mergeNotificationLists(
      state.notifications,
      res.notifications,
    );
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
  if (currentAuthorityKey === INVALIDATED_AUTHORITY_KEY) {
    return Promise.resolve();
  }
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
    subscribeStewardSessionTransitions(onStewardSessionTransition),
  );
  if (typeof window !== "undefined") {
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

/** Immutable authority captured synchronously when a public write is queued. */
interface MutationAuthoritySnapshot {
  key: string | null;
  revision: number;
}

/** Optimistic pre-write state paired with its enqueue-time authority. */
interface MutationSnapshot {
  authority: MutationAuthoritySnapshot;
  state: NotificationState;
}

function captureMutationAuthority(): MutationAuthoritySnapshot {
  return Object.freeze({
    key: currentAuthorityKey,
    revision: currentAuthorityRevision,
  });
}

function assertMutationAuthority(
  authority: MutationAuthoritySnapshot,
  operation: NotificationMutationOperation,
  phase: "queue" | "request" | "result" | "rollback",
): void {
  if (
    authority.key !== currentAuthorityKey ||
    authority.revision !== currentAuthorityRevision
  ) {
    logger.warn(
      {
        operation,
        phase,
        capturedRevision: authority.revision,
        currentRevision: currentAuthorityRevision,
      },
      "[notification-store] stale-authority mutation aborted",
    );
    throw new NotificationMutationSupersededError(
      operation,
      authority.revision,
      currentAuthorityRevision,
    );
  }
}

/**
 * Serialize every notification write through one queue. Authority identity and
 * revision are captured before observing the predecessor tail, so queued A
 * work cannot wake under B (or a later A revision) and address that authority's
 * same-id row. The queue itself is never replaced on an authority switch.
 */
async function serializeNotificationMutation<T>(
  operation: NotificationMutationOperation,
  run: (authority: MutationAuthoritySnapshot) => Promise<T>,
): Promise<T> {
  const authority = captureMutationAuthority();
  const predecessor = notificationMutationTail;
  const waitsForPredecessor = notificationMutationQueueDepth > 0;
  notificationMutationQueueDepth += 1;
  let release!: () => void;
  notificationMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (waitsForPredecessor) await predecessor;
  try {
    assertMutationAuthority(authority, operation, "queue");
    if (state.mutationFailure !== null) setState({ mutationFailure: null });
    assertMutationAuthority(authority, operation, "queue");
    return await run(authority);
  } finally {
    notificationMutationQueueDepth -= 1;
    release();
  }
}

async function runMutationRequest<T>(
  authority: MutationAuthoritySnapshot,
  operation: NotificationMutationOperation,
  request: () => Promise<T>,
): Promise<T> {
  assertMutationAuthority(authority, operation, "request");
  const result = await request();
  assertMutationAuthority(authority, operation, "result");
  return result;
}

function snapshotForMutation(
  authority: MutationAuthoritySnapshot,
): MutationSnapshot {
  return { authority, state };
}

function applyMutationRollback(
  snapshot: MutationSnapshot,
  operation: NotificationMutationOperation,
  rollback: () => void,
): void {
  assertMutationAuthority(snapshot.authority, operation, "rollback");
  rollback();
}

const MUTATION_FAILURE_MESSAGES: Record<NotificationMutationOperation, string> =
  {
    "mark-read":
      "The notification could not be marked read. Its previous state was restored.",
    "mark-all-read":
      "Notifications could not be marked read. Their previous state was restored.",
    remove: "The notification could not be dismissed. It was restored.",
    "remove-batch":
      "Some notifications could not be dismissed. Failed items were restored.",
    clear: "Notifications could not be cleared. They were restored.",
  };

function reportMutationFailure(
  authority: MutationAuthoritySnapshot,
  operation: NotificationMutationOperation,
  failedCount: number,
  cause: unknown,
): never {
  assertMutationAuthority(authority, operation, "result");
  const failure: NotificationMutationFailure = {
    operation,
    message: MUTATION_FAILURE_MESSAGES[operation],
    failedCount,
  };
  setState({ mutationFailure: failure });
  assertMutationAuthority(authority, operation, "result");
  logger.error(
    { err: cause, operation, failedCount },
    "[notification-store] notification mutation failed; optimistic fields restored",
  );
  throw new NotificationMutationError(failure, cause);
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
  return serializeNotificationMutation("mark-read", async (authority) => {
    const snapshot = snapshotForMutation(authority);
    const now = Date.now();
    const notifications = state.notifications.map((notification) =>
      notification.id === id && !notification.readAt
        ? { ...notification, readAt: now }
        : notification,
    );
    setState({ notifications, unreadCount: countUnread(notifications) });
    try {
      await runMutationRequest(authority, "mark-read", () =>
        client.markNotificationRead(id),
      );
    } catch (error) {
      // error-policy:J4 the owned field is restored and mutationFailure renders
      // as a role=alert before this boundary rethrows a typed failure.
      applyMutationRollback(snapshot, "mark-read", () => {
        const previous = snapshot.state.notifications.find(
          (notification) => notification.id === id,
        );
        const restored = state.notifications.map((notification) =>
          notification.id === id && notification.readAt === now && previous
            ? { ...notification, readAt: previous.readAt }
            : notification,
        );
        setState({
          notifications: restored,
          unreadCount: countUnread(restored),
        });
      });
      reportMutationFailure(authority, "mark-read", 1, error);
    }
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  return serializeNotificationMutation("mark-all-read", async (authority) => {
    const snapshot = snapshotForMutation(authority);
    const now = Date.now();
    const notifications = state.notifications.map((notification) =>
      notification.readAt ? notification : { ...notification, readAt: now },
    );
    setState({ notifications, unreadCount: 0 });
    try {
      await runMutationRequest(authority, "mark-all-read", () =>
        client.markAllNotificationsRead(),
      );
    } catch (error) {
      // error-policy:J4 only still-owned optimistic readAt values roll back;
      // mutationFailure renders the distinct alert before the typed rethrow.
      applyMutationRollback(snapshot, "mark-all-read", () => {
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
        setState({
          notifications: restored,
          unreadCount: countUnread(restored),
        });
      });
      reportMutationFailure(
        authority,
        "mark-all-read",
        snapshot.state.notifications.length,
        error,
      );
    }
  });
}

export async function removeNotification(id: string): Promise<void> {
  return serializeNotificationMutation("remove", async (authority) => {
    const snapshot = snapshotForMutation(authority);
    const notifications = state.notifications.filter(
      (notification) => notification.id !== id,
    );
    setState({ notifications, unreadCount: countUnread(notifications) });
    assertMutationAuthority(authority, "remove", "result");
    if (ephemeralNotificationIds.delete(id)) return;
    try {
      await runMutationRequest(authority, "remove", () =>
        client.removeNotification(id),
      );
    } catch (error) {
      // error-policy:J4 the failed row returns additively and mutationFailure
      // renders the distinct alert before this boundary rethrows.
      applyMutationRollback(snapshot, "remove", () =>
        restoreRemovedRows(snapshot, new Set([id])),
      );
      reportMutationFailure(authority, "remove", 1, error);
    }
  });
}

/** Remove a producer stack with one optimistic update and one rollback point. */
export async function removeNotifications(
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  return serializeNotificationMutation("remove-batch", async (authority) => {
    const idSet = new Set(ids);
    const snapshot = snapshotForMutation(authority);
    const notifications = state.notifications.filter(
      (notification) => !idSet.has(notification.id),
    );
    setState({ notifications, unreadCount: countUnread(notifications) });
    assertMutationAuthority(authority, "remove-batch", "result");
    const ephemeralIds = ids.filter((id) =>
      ephemeralNotificationIds.delete(id),
    );
    const ephemeralIdSet = new Set(ephemeralIds);
    const persistedIds = ids.filter((id) => !ephemeralIdSet.has(id));
    if (persistedIds.length === 0) return;

    const results = await runMutationRequest(authority, "remove-batch", () =>
      Promise.allSettled(
        persistedIds.map((id) => client.removeNotification(id)),
      ),
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
    // Partial success is authoritative: only failed persisted rows return;
    // successful deletes and local-only ephemeral deletes stay removed.
    applyMutationRollback(snapshot, "remove-batch", () =>
      restoreRemovedRows(snapshot, failedIds),
    );
    reportMutationFailure(
      authority,
      "remove-batch",
      failedIds.size,
      new AggregateError(
        failures,
        "Notification batch delete partially failed",
      ),
    );
  });
}

export async function clearNotifications(): Promise<void> {
  return serializeNotificationMutation("clear", async (authority) => {
    const snapshot = snapshotForMutation(authority);
    const previousEphemeralIds = [...ephemeralNotificationIds];
    setState({ notifications: [], unreadCount: 0 });
    assertMutationAuthority(authority, "clear", "result");
    ephemeralNotificationIds.clear();
    try {
      await runMutationRequest(authority, "clear", () =>
        client.clearNotifications(),
      );
    } catch (error) {
      // error-policy:J4 restored rows merge with live arrivals and
      // mutationFailure renders the distinct alert before the typed rethrow.
      applyMutationRollback(snapshot, "clear", () => {
        for (const id of previousEphemeralIds) ephemeralNotificationIds.add(id);
        restoreRemovedRows(
          snapshot,
          new Set(snapshot.state.notifications.map(({ id }) => id)),
        );
      });
      reportMutationFailure(
        authority,
        "clear",
        snapshot.state.notifications.length,
        error,
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
  lastStewardSessionRevision = 0;
  notificationMutationTail = Promise.resolve();
  notificationMutationQueueDepth = 0;
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
    mutationFailure: null,
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

/** Test-only visible mutation failure used by the notification-center render. */
export function __setMutationFailureForTests(
  failure: NotificationMutationFailure,
): void {
  setState({ mutationFailure: failure });
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
