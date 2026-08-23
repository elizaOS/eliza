/**
 * Typed constants for eliza:* custom events dispatched across the app.
 *
 * The cross-platform event names + detail payloads + dispatch helpers live in
 * `@elizaos/shared/events` (the single source of truth, also consumed by the
 * server). This module re-exports them and adds the UI-only events that have no
 * server producer (focus-connector, voice-control, tutorial chat-control, and
 * the shared→dedicated cloud-agent handoff phases). The `Eliza*EventName` unions
 * here widen the shared unions with those UI-only events, so the local
 * `dispatchAppEvent` / `dispatchWindowEvent` accept them.
 */

import { logger } from "@elizaos/logger";
import {
  CONNECT_EVENT,
  createNavigateViewEvent,
  NAVIGATE_VIEW_EVENT,
  type NavigateViewDetail,
  type NavigateViewEvent,
  type ElizaDocumentEventName as SharedDocumentEventName,
  type ElizaWindowEventName as SharedWindowEventName,
} from "@elizaos/shared/events";
import { requestNotificationCenterOpen } from "../state/notifications/notification-center-open-request";

export {
  // Agent / bridge
  AGENT_READY_EVENT,
  APP_EMOTE_EVENT,
  APP_PAUSE_EVENT,
  // App state
  APP_RESUME_EVENT,
  type AppEmoteEventDetail,
  BRIDGE_READY_EVENT,
  CHAT_AVATAR_VOICE_EVENT,
  type ChatAvatarVoiceEventDetail,
  // App lifecycle
  COMMAND_PALETTE_EVENT,
  CONNECT_EVENT,
  createNavigateViewEvent,
  // Shared dispatch helpers
  dispatchAppEmoteEvent,
  dispatchElizaCloudStatusUpdated,
  dispatchNavigateViewEvent,
  ELIZA_CLOUD_STATUS_UPDATED_EVENT,
  type ElizaCloudStatusUpdatedDetail,
  EMOTE_PICKER_EVENT,
  FIRST_RUN_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT,
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
  NAVIGATE_VIEW_EVENT,
  type NavigateViewDetail,
  type NavigateViewEvent,
  type NavigateViewType,
  NETWORK_STATUS_CHANGE_EVENT,
  type NetworkStatusChangeDetail,
  PUSH_TO_TALK_HOLD_EVENT,
  PUSH_TO_TALK_TOGGLE_EVENT,
  type PushToTalkHoldDetail,
  // Sidebar sync
  SELF_STATUS_SYNC_EVENT,
  SHARE_TARGET_EVENT,
  STOP_EMOTE_EVENT,
  TRAY_ACTION_EVENT,
  // Voice / config
  VOICE_CONFIG_UPDATED_EVENT,
  // Avatar / VRM
  VRM_TELEPORT_COMPLETE_EVENT,
} from "@elizaos/shared/events";
export { useEmitViewEvent, useViewEvent } from "../hooks/useViewEvent";
export * from "../views/view-event-bus";
export * from "../views/view-event-types";

// ── UI-only events (no server producer) ──────────────────────────────────

export const FOCUS_CONNECTOR_EVENT = "eliza:focus-connector" as const;
export const DESKTOP_CONTENT_WORKSPACE_HANDOFF_EVENT =
  "eliza:desktop-content-workspace-handoff" as const;
const FOCUS_CONNECTOR_STORAGE_KEY = "elizaos:focus-connector";

/** Explicitly expand the detached desktop ChatOverlay without toggling it. */
export const CHAT_OVERLAY_OPEN_EVENT = "eliza:chat-overlay-open" as const;

export interface FocusConnectorEventDetail {
  connectorId: string;
}

/**
 * A server-side agent action (START/STOP_TRANSCRIPTION) drives the shell's
 * transcription capture through this event: the `voice-control` agent-event
 * stream is re-dispatched here, and {@link useShellController} toggles the mic
 * accordingly. Keeps the agent→shell command decoupled (same pattern as the
 * tutorial/slash navigation events).
 */
export const VOICE_CONTROL_EVENT = "eliza:voice-control" as const;
export interface VoiceControlEventDetail {
  command: "start" | "stop";
}

/** Dispatch a transcription start/stop command to the shell. */
export function dispatchVoiceControl(detail: VoiceControlEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(VOICE_CONTROL_EVENT, { detail }));
}

// ── Shared → dedicated cloud-agent handoff ───────────────────────────────
/**
 * First-run provisions a personal cloud agent and lands the user in chat on the
 * shared REST adapter while the dedicated container boots; a background
 * supervisor then copies the conversation into the container and swaps the live
 * client over. That swap used to be silent (`.catch(() => {})`). This event is
 * the typed seam onto which the handoff's lifecycle is surfaced so chat-state /
 * a progress indicator can render it instead of the user seeing nothing.
 */
export const CLOUD_HANDOFF_PHASE_EVENT = "eliza:cloud-handoff-phase" as const;

/**
 * `migrating` — personal container is provisioning; user is on the shared
 * adapter. `switched` — conversation copied and the live client moved to the
 * dedicated container (`switched-empty` when there was nothing to copy yet).
 * `timed-out` / `failed` — the container never became ready (or an I/O step
 * threw); the user safely stays on the working shared adapter.
 * `insufficient-credits` — the dedicated upgrade was refused by the credit gate
 * (HTTP 402): the user keeps the free shared agent, but this is a FIRST-CLASS
 * state (a distinct "add credits for your own dedicated agent" surface), never a
 * silent permanent shared fallback. Mirrors `ConversationHandoffStatus` plus the
 * `migrating` in-flight phase and the `insufficient-credits` monetization gate.
 */
export type CloudHandoffPhase =
  | "migrating"
  | "switched"
  | "switched-empty"
  | "timed-out"
  | "failed"
  | "insufficient-credits";

export interface CloudHandoffPhaseDetail {
  agentId: string;
  phase: CloudHandoffPhase;
  /** Messages copied into the dedicated container on `switched`. */
  imported?: number;
  /** Error message on `failed`. */
  error?: string;
}

/**
 * Re-run a `timed-out`/`failed` shared→dedicated handoff for `agentId`. The
 * failure surface (banner) dispatches this when the user asks to retry; the
 * handoff runner that armed the retry re-invokes the (idempotent) supervisor,
 * so a transient container-boot failure isn't a silent permanent fallback.
 */
export const CLOUD_HANDOFF_RETRY_EVENT = "eliza:cloud-handoff-retry" as const;

export interface CloudHandoffRetryDetail {
  agentId: string;
}

export const CHAT_PREFILL_EVENT = "eliza:chat:prefill" as const;
/**
 * Open (expand) the floating chat from anywhere — fired when the launcher's
 * "Messages" tile is tapped so landing on `/chat` lands the user IN an open
 * conversation, not on the wordless home with a collapsed pill. The always-
 * mounted {@link ChatOverlay} is the one listener.
 */
export const CHAT_OPEN_EVENT = "eliza:chat:open" as const;
/** Collapse the floating chat so a control-heavy surface can take focus. */
export const CHAT_CLOSE_EVENT = "eliza:chat:close" as const;
/** Open the keyword message-search panel (fired by the chat search affordance). */
export const CHAT_MESSAGE_SEARCH_EVENT = "eliza:chat:message-search" as const;
/**
 * Open the notification center from anywhere (#10706). The notification center
 * is the dashboard widget (NotificationsHomeCenter) pinned on the home surface,
 * so this surface-agnostic window event — fired by the desktop-native
 * "Notifications" menu/tray item and the `<scheme>://notifications` deep link —
 * navigates to the home dashboard. The headless NotificationsShellBoot is the
 * one listener.
 */
export const OPEN_NOTIFICATION_CENTER_EVENT =
  "eliza:notifications:open" as const;

export interface ChatPrefillEventDetail {
  text: string;
  /** Select the inserted draft after focusing the composer. Defaults to false. */
  select?: boolean;
}

/** Dispatch a request to open the floating chat and prefill its composer. */
export function dispatchChatPrefill(detail: ChatPrefillEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_PREFILL_EVENT, { detail }));
}

/** Dispatch a request to open (expand) the floating chat. See {@link CHAT_OPEN_EVENT}. */
export function dispatchChatOpen(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT));
}

/** Request the floating chat to collapse. Onboarding may deliberately ignore it. */
export function dispatchChatClose(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_CLOSE_EVENT));
}

/** Request the notification center to open (surface-agnostic — see
 * {@link OPEN_NOTIFICATION_CENTER_EVENT}). */
export function dispatchOpenNotificationCenter(): void {
  if (typeof window === "undefined") return;
  // Retain before dispatch: iOS can replay a cold appUrlOpen while React has
  // mounted but before NotificationsShellBoot's effect attaches its listener.
  requestNotificationCenterOpen();
  window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATION_CENTER_EVENT));
}

// ── Android hardware back ─────────────────────────────────────────────────
/**
 * The Android hardware/gesture back press, surfaced to shell consumers BEFORE
 * the app's default back behavior runs (#9148). Native (`main.tsx`) dispatches
 * this on the Capacitor `backButton` event; a consumer with an open,
 * back-dismissable surface — today the {@link ChatOverlay} chat sheet
 * — closes ONE layer and flips `detail.handled = true`. The dispatcher reads
 * `handled` synchronously (custom events dispatch synchronously, so every
 * listener has run by the time `dispatchEvent` returns) and only falls through
 * to `history.back()` / `minimizeApp()` when nothing consumed the press. This
 * gives Android hardware-back the same "dismiss the open sheet first" behavior
 * desktop/web get from Escape. Web/desktop simply never dispatch it, so the
 * fall-through path is unchanged there.
 */
export const ELIZA_BACK_INTENT_EVENT = "eliza:back-intent" as const;

export interface BackIntentEventDetail {
  /**
   * A consumer flips this to `true` when it handles the back press (e.g. by
   * closing an open sheet). While it stays `false` the dispatcher falls through
   * to the app's default back behavior — so a back press at rest still
   * navigates / backgrounds the app as before.
   */
  handled: boolean;
}

/**
 * Dispatch the Android back-intent to shell consumers and report whether one of
 * them handled it (closed a surface). Returns `false` when nothing consumed the
 * press — including off-window (SSR) — so the caller can fall through to its
 * default back behavior. See {@link ELIZA_BACK_INTENT_EVENT}.
 */
export function dispatchBackIntent(): boolean {
  if (typeof window === "undefined") return false;
  const detail: BackIntentEventDetail = { handled: false };
  window.dispatchEvent(new CustomEvent(ELIZA_BACK_INTENT_EVENT, { detail }));
  return detail.handled;
}

// ── Event-name unions (shared base widened with the UI-only events) ───────

export type ElizaDocumentEventName =
  | SharedDocumentEventName
  | typeof FOCUS_CONNECTOR_EVENT
  | typeof CHAT_OVERLAY_OPEN_EVENT;

export type ElizaWindowEventName =
  | SharedWindowEventName
  | typeof VOICE_CONTROL_EVENT
  | typeof CHAT_PREFILL_EVENT
  | typeof CLOUD_HANDOFF_PHASE_EVENT
  | typeof CLOUD_HANDOFF_RETRY_EVENT
  | typeof ELIZA_BACK_INTENT_EVENT;

export type ElizaEventName = ElizaDocumentEventName | ElizaWindowEventName;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Dispatch a typed custom event on `document`. */
export function dispatchAppEvent(
  name: ElizaDocumentEventName,
  detail?: unknown,
): void {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

export interface ConnectRequestDetail {
  gatewayUrl: string;
  token?: string;
  completeFirstRun?: boolean;
  skipConfirm?: boolean;
}

type ConnectRequestListener = (
  detail: ConnectRequestDetail,
) => void | Promise<void>;

const connectRequestClaims = new WeakMap<object, () => boolean>();
let pendingConnectRequest: ConnectRequestDetail | null = null;

function emitConnectRequest(detail: ConnectRequestDetail): void {
  document.dispatchEvent(new CustomEvent(CONNECT_EVENT, { detail }));
}

/**
 * Dispatches a connection request without losing native deep links that arrive
 * while React is replacing the startup screen with the live shell. The latest
 * unclaimed request is replayed when a consumer mounts; a synchronous claim
 * guarantees that the startup and shell listeners cannot both adopt it.
 */
export function dispatchConnectRequest(detail: ConnectRequestDetail): void {
  let claimed = false;
  const request: ConnectRequestDetail = {
    ...detail,
  };
  connectRequestClaims.set(request, () => {
    if (claimed) return false;
    claimed = true;
    if (pendingConnectRequest === request) {
      pendingConnectRequest = null;
    }
    return true;
  });
  pendingConnectRequest = request;
  emitConnectRequest(request);
}

/**
 * Subscribes to connection requests and immediately replays one that arrived
 * before this listener mounted. Legacy CustomEvents outside this helper remain
 * supported for browser tests and third-party in-app producers.
 */
export function listenForConnectRequests(
  listener: ConnectRequestListener,
): () => void {
  const handle = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (
      !detail ||
      typeof detail !== "object" ||
      Array.isArray(detail) ||
      typeof (detail as { gatewayUrl?: unknown }).gatewayUrl !== "string"
    ) {
      return;
    }

    const request = detail as ConnectRequestDetail;
    const claim = connectRequestClaims.get(request);
    if (claim && !claim()) return;
    void listener(request);
  };

  document.addEventListener(CONNECT_EVENT, handle);
  queueMicrotask(() => {
    if (pendingConnectRequest) {
      emitConnectRequest(pendingConnectRequest);
    }
  });
  return () => document.removeEventListener(CONNECT_EVENT, handle);
}

// A listener reports whether it actually APPLIED the request by returning
// `true`/`void`; returning `false` (or throwing) means "not applied" so the
// intent stays eligible for a later-mounting or retried listener instead of
// being permanently consumed by whichever subscriber happened to mount first.
type NavigateViewRequestListener = (
  event: NavigateViewEvent,
) => boolean | undefined;

interface NavigateViewRequestClaim {
  claimed: boolean;
  /** Durably consumes the request: unqueues it and resolves its dispatch promise `true`. */
  commit: () => void;
}

const MAX_PENDING_NAVIGATE_VIEW_REQUESTS = 16;
const navigateViewRequestClaims = new WeakMap<
  object,
  NavigateViewRequestClaim
>();
const navigateViewRequestResolvers = new WeakMap<
  object,
  (applied: boolean) => void
>();
const pendingNavigateViewRequests: NavigateViewDetail[] = [];
let drainingNavigateViewRequests = false;

function emitNavigateViewRequest(detail: NavigateViewDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(createNavigateViewEvent(detail));
}

function drainNavigateViewRequests(): void {
  if (drainingNavigateViewRequests || typeof window === "undefined") return;
  drainingNavigateViewRequests = true;
  try {
    while (pendingNavigateViewRequests.length > 0) {
      const request = pendingNavigateViewRequests[0];
      emitNavigateViewRequest(request);
      // Every attached listener declined or threw. Preserve strict FIFO: a
      // later request cannot overtake this one while it is still unclaimed.
      if (pendingNavigateViewRequests[0] === request) break;
    }
  } finally {
    drainingNavigateViewRequests = false;
  }
}

function dropOldestPendingNavigateViewRequest(): void {
  const dropped = pendingNavigateViewRequests.shift();
  if (!dropped) return;
  // error-policy:J4 bounded FIFO — an OS can deliver intents faster than a
  // listener claims them (or none ever mounts); silently dropping one here
  // used to be indistinguishable from a healthy delivery. Surface it, and
  // resolve the dispatcher's promise `false` so a caller gating a native ack
  // on "applied" (mobile-lifecycle's Android intent buffer) never
  // acknowledges a request this store just discarded.
  logger.warn(
    { viewId: dropped.viewId, viewPath: dropped.viewPath },
    `[navigate-view-request] dropped oldest pending request past the ${MAX_PENDING_NAVIGATE_VIEW_REQUESTS}-item bound`,
  );
  navigateViewRequestResolvers.get(dropped)?.(false);
  navigateViewRequestResolvers.delete(dropped);
  navigateViewRequestClaims.delete(dropped);
}

/**
 * Dispatches a native navigation intent without losing it during cold boot,
 * and resolves only once some listener has actually APPLIED it — never
 * merely enqueued it. `mobile-lifecycle.ts` (via `main.tsx`'s `handleDeepLink`)
 * awaits this before acknowledging the Android deep-link buffer: acking on
 * enqueue would tell Android the intent was delivered even though the queue
 * below is in-memory only, so a renderer reload/crash between dispatch and
 * the App mount effect can still lose it. The bounded FIFO preserves ordering
 * when an OS delivers several intents before mount.
 */
export function dispatchNavigateViewRequest(
  detail: NavigateViewDetail,
): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  const request: NavigateViewDetail = { ...detail };
  const applied = new Promise<boolean>((resolve) => {
    navigateViewRequestResolvers.set(request, resolve);
  });
  const claim: NavigateViewRequestClaim = {
    claimed: false,
    commit: () => {
      claim.claimed = true;
      const pendingIndex = pendingNavigateViewRequests.indexOf(request);
      if (pendingIndex >= 0)
        pendingNavigateViewRequests.splice(pendingIndex, 1);
      navigateViewRequestResolvers.get(request)?.(true);
      navigateViewRequestResolvers.delete(request);
    },
  };
  navigateViewRequestClaims.set(request, claim);
  pendingNavigateViewRequests.push(request);
  if (pendingNavigateViewRequests.length > MAX_PENDING_NAVIGATE_VIEW_REQUESTS) {
    dropOldestPendingNavigateViewRequest();
  }
  drainNavigateViewRequests();
  return applied;
}

/**
 * Subscribes to navigation events and synchronously replays unclaimed native
 * intents. A request is claimed — durably removed from the replay queue, with
 * its `dispatchNavigateViewRequest` promise resolved `true` — only after the
 * listener call returns without throwing and without returning `false`.
 * `window.dispatchEvent` invokes every attached listener regardless of an
 * earlier one throwing, so a listener that throws, no-ops, or unmounts before
 * applying the intent leaves it unclaimed for the next attached listener (or
 * the next mount's replay) rather than permanently stealing it. Raw legacy
 * CustomEvents outside this helper (no registered claim) still pass through
 * without entering the replay queue.
 */
export function listenForNavigateViewRequests(
  listener: NavigateViewRequestListener,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return;
    const claim = navigateViewRequestClaims.get(detail);
    if (claim?.claimed) return;
    let applied: boolean;
    try {
      applied = listener(event as NavigateViewEvent) !== false;
    } catch (error) {
      // error-policy:J4 one subscriber's failure must not steal the intent
      // from the next attached listener or a later mount's replay.
      logger.warn(
        { error },
        "[navigate-view-request] listener threw while applying a navigation intent; leaving it unclaimed for retry",
      );
      return;
    }
    if (applied) claim?.commit();
  };

  window.addEventListener(NAVIGATE_VIEW_EVENT, handle);
  drainNavigateViewRequests();
  return () => window.removeEventListener(NAVIGATE_VIEW_EVENT, handle);
}

/** Dispatch a typed custom event on `window`. */
export function dispatchWindowEvent(
  name: ElizaWindowEventName,
  detail?: unknown,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

// Last dispatched handoff phase, kept so surfaces that MOUNT AFTER a phase
// fired (the home provisioning tile renders only once onboarding lands, i.e.
// after the runner's initial `migrating` dispatch) still see the in-flight
// state instead of nothing. Session-scoped by design — a reload's in-flight
// handoff is re-driven by resumePendingCloudHandoff, which re-dispatches.
let lastCloudHandoffPhaseDetail: CloudHandoffPhaseDetail | null = null;

/** The most recent handoff phase dispatched this session (null before any). */
export function getLastCloudHandoffPhaseDetail(): CloudHandoffPhaseDetail | null {
  return lastCloudHandoffPhaseDetail;
}

/** Test-only: forget the cached phase so specs start from a clean session. */
export function __resetLastCloudHandoffPhaseDetailForTests(): void {
  lastCloudHandoffPhaseDetail = null;
}

/**
 * Surface a shared→dedicated handoff phase. Replaces the silent
 * `startCloudAgentHandoff(...).catch(() => {})` discard so the typed
 * {@link ConversationHandoffResult} reaches the UI.
 */
export function dispatchCloudHandoffPhase(
  detail: CloudHandoffPhaseDetail,
): void {
  lastCloudHandoffPhaseDetail = detail;
  dispatchWindowEvent(CLOUD_HANDOFF_PHASE_EVENT, detail);
}

/** Ask the armed handoff runner to retry a failed shared→dedicated handoff. */
export function dispatchCloudHandoffRetry(
  detail: CloudHandoffRetryDetail,
): void {
  dispatchWindowEvent(CLOUD_HANDOFF_RETRY_EVENT, detail);
}

export function readPendingFocusConnector(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(FOCUS_CONNECTOR_STORAGE_KEY);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    // error-policy:J3 storage unavailable — no pending focus hint; the
    // connectors page opens without a pre-focused entry.
    return null;
  }
}

export function clearPendingFocusConnector(connectorId?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (connectorId) {
      const value = window.sessionStorage.getItem(FOCUS_CONNECTOR_STORAGE_KEY);
      if (value !== connectorId) return;
    }
    window.sessionStorage.removeItem(FOCUS_CONNECTOR_STORAGE_KEY);
  } catch {
    // Ignore storage failures; the event still drives the current page.
  }
}

export function dispatchFocusConnector(connectorId: string): void {
  const normalized = connectorId.trim();
  if (!normalized) return;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(FOCUS_CONNECTOR_STORAGE_KEY, normalized);
    } catch {
      // Ignore storage failures; the event still drives mounted listeners.
    }
  }
  dispatchAppEvent(FOCUS_CONNECTOR_EVENT, { connectorId: normalized });
}

// ── Generic app aliases (preferred) ──────────────────────────────────────
export type AppDocumentEventName = ElizaDocumentEventName;
export type AppWindowEventName = ElizaWindowEventName;
export type AppEventName = ElizaEventName;
