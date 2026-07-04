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

import type {
  ElizaDocumentEventName as SharedDocumentEventName,
  ElizaWindowEventName as SharedWindowEventName,
} from "@elizaos/shared/events";

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
const FOCUS_CONNECTOR_STORAGE_KEY = "elizaos:focus-connector";

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
 * threw); the user safely stays on the working shared adapter. Mirrors
 * `ConversationHandoffStatus` plus the `migrating` in-flight phase.
 */
export type CloudHandoffPhase =
  | "migrating"
  | "switched"
  | "switched-empty"
  | "timed-out"
  | "failed";

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

// ── Tutorial ─────────────────────────────────────────────────────────────
/**
 * The interactive tour drives the floating chat into a known state at the start
 * of each frame (and pre-fills the composer for the guided "ask to navigate"
 * demo) via this event; {@link ContinuousChatOverlay} applies it. Keeps the tour
 * decoupled from the overlay's internal detent state (same pattern as the slash
 * navigation events).
 */
export const TUTORIAL_CHAT_CONTROL_EVENT =
  "eliza:tutorial:chat-control" as const;
export const CHAT_PREFILL_EVENT = "eliza:chat:prefill" as const;
/**
 * Open (expand) the floating chat from anywhere — fired when the launcher's
 * "Messages" tile is tapped so landing on `/chat` lands the user IN an open
 * conversation, not on the wordless home with a collapsed pill. The always-
 * mounted {@link ContinuousChatOverlay} is the one listener.
 */
export const CHAT_OPEN_EVENT = "eliza:chat:open" as const;
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

export interface TutorialChatControlDetail {
  /**
   * `pill` collapses the chat to the floating pill; `rest` opens it to the peek
   * detent (grabber + composer visible, history hidden); `expand` opens it
   * full-screen; `prefill` opens to rest and sets the composer draft to `text`.
   * `reset` restores the chat to a normal interactive state when the tour ends
   * (un-pill so the composer is not `inert`, clear any prefilled draft, rest the
   * sheet) — without it, cancelling the tour while it had collapsed the chat to
   * the pill leaves the composer visible-but-inert and the user can't type.
   */
  action: "pill" | "rest" | "expand" | "prefill" | "reset";
  text?: string;
}

export interface ChatPrefillEventDetail {
  text: string;
  /** Select the inserted draft after focusing the composer. Defaults to false. */
  select?: boolean;
}

/** Dispatch a tutorial chat-control instruction to the overlay. */
export function dispatchTutorialChatControl(
  detail: TutorialChatControlDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TUTORIAL_CHAT_CONTROL_EVENT, { detail }),
  );
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

/** Request the notification center to open (surface-agnostic — see
 * {@link OPEN_NOTIFICATION_CENTER_EVENT}). */
export function dispatchOpenNotificationCenter(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATION_CENTER_EVENT));
}

// ── Android hardware back ─────────────────────────────────────────────────
/**
 * The Android hardware/gesture back press, surfaced to shell consumers BEFORE
 * the app's default back behavior runs (#9148). Native (`main.tsx`) dispatches
 * this on the Capacitor `backButton` event; a consumer with an open,
 * back-dismissable surface — today the {@link ContinuousChatOverlay} chat sheet
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
  | typeof FOCUS_CONNECTOR_EVENT;

export type ElizaWindowEventName =
  | SharedWindowEventName
  | typeof VOICE_CONTROL_EVENT
  | typeof TUTORIAL_CHAT_CONTROL_EVENT
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

/** Dispatch a typed custom event on `window`. */
export function dispatchWindowEvent(
  name: ElizaWindowEventName,
  detail?: unknown,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Surface a shared→dedicated handoff phase. Replaces the silent
 * `startCloudAgentHandoff(...).catch(() => {})` discard so the typed
 * {@link ConversationHandoffResult} reaches the UI.
 */
export function dispatchCloudHandoffPhase(
  detail: CloudHandoffPhaseDetail,
): void {
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
