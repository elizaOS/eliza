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
  // Shared dispatch helpers
  dispatchAppEmoteEvent,
  dispatchElizaCloudStatusUpdated,
  ELIZA_CLOUD_STATUS_UPDATED_EVENT,
  type ElizaCloudStatusUpdatedDetail,
  EMOTE_PICKER_EVENT,
  FIRST_RUN_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT,
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
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

/**
 * In-chat onboarding (Phase 1): the first-run conductor asks the floating chat
 * (ContinuousChatOverlay) to open so the seeded greeting + runtime choice are
 * visible. UI-only, no payload — the overlay listens and opens its sheet.
 */
export const OPEN_IN_CHAT_ONBOARDING_EVENT =
  "eliza:open-in-chat-onboarding" as const;

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
/** Open the keyword message-search panel (fired by the chat search affordance). */
export const CHAT_MESSAGE_SEARCH_EVENT = "eliza:chat:message-search" as const;

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
  | typeof CLOUD_HANDOFF_RETRY_EVENT;

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
