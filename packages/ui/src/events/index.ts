/**
 * Typed constants for eliza:* custom events dispatched across the app.
 *
 * Using these constants instead of raw strings prevents typo-driven drift
 * between producers (main.tsx, bridge, components) and consumers (AppContext,
 * EmotePicker, ChatView, etc.).
 */

// ── App lifecycle ────────────────────────────────────────────────────────
export const COMMAND_PALETTE_EVENT = "eliza:command-palette" as const;
export const EMOTE_PICKER_EVENT = "eliza:emote-picker" as const;
export const STOP_EMOTE_EVENT = "eliza:stop-emote" as const;

// ── Agent / bridge ───────────────────────────────────────────────────────
export const AGENT_READY_EVENT = "eliza:agent-ready" as const;
export const BRIDGE_READY_EVENT = "eliza:bridge-ready" as const;
export const SHARE_TARGET_EVENT = "eliza:share-target" as const;
export const TRAY_ACTION_EVENT = "eliza:tray-action" as const;

// ── App state ────────────────────────────────────────────────────────────
export const APP_RESUME_EVENT = "eliza:app-resume" as const;
export const APP_PAUSE_EVENT = "eliza:app-pause" as const;
export const CONNECT_EVENT = "eliza:connect" as const;
export const FOCUS_CONNECTOR_EVENT = "eliza:focus-connector" as const;
export const NETWORK_STATUS_CHANGE_EVENT =
  "eliza:network-status-change" as const;
export const MOBILE_RUNTIME_MODE_CHANGED_EVENT =
  "eliza:mobile-runtime-mode-changed" as const;
const FOCUS_CONNECTOR_STORAGE_KEY = "elizaos:focus-connector";

/** Detail payload for {@link NETWORK_STATUS_CHANGE_EVENT}. */
export interface NetworkStatusChangeDetail {
  /** `true` when the device reports a usable network interface. */
  connected: boolean;
}

// ── Voice / config ───────────────────────────────────────────────────────
export const VOICE_CONFIG_UPDATED_EVENT = "eliza:voice-config-updated" as const;
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

export const CHAT_AVATAR_VOICE_EVENT = "eliza:chat-avatar-voice" as const;
export const APP_EMOTE_EVENT = "eliza:app-emote" as const;
/** After `/api/cloud/status` — chat voice reloads config so cloud-backed TTS mode matches the server snapshot. */
export const ELIZA_CLOUD_STATUS_UPDATED_EVENT =
  "eliza:cloud-status-updated" as const;
export interface ElizaCloudStatusUpdatedDetail {
  /** Same as cloud status `connected` (auth or API key on server). */
  connected: boolean;
  /** True only when Eliza Cloud inference is the active connection. */
  enabled: boolean;
  /** Server reports a persisted Eliza Cloud API key. */
  hasPersistedApiKey: boolean;
  /** True only when cloud voice/chat routing should actively use the proxy. */
  cloudVoiceProxyAvailable: boolean;
}

export interface FocusConnectorEventDetail {
  connectorId: string;
}

// ── Avatar / VRM ─────────────────────────────────────────────────────────
export const VRM_TELEPORT_COMPLETE_EVENT =
  "eliza:vrm-teleport-complete" as const;
/** FirstRunShell dispatches this after queuing a post-teleport voice preview; FirstRunWizard echoes {@link VRM_TELEPORT_COMPLETE_EVENT} when VRM is off. */
export const FIRST_RUN_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT =
  "eliza:first-run-voice-preview-await-teleport" as const;

// ── Sidebar sync ─────────────────────────────────────────────────────────
export const SELF_STATUS_SYNC_EVENT = "eliza:self-status-refresh" as const;

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

/** Dispatch a tutorial chat-control instruction to the overlay. */
export function dispatchTutorialChatControl(
  detail: TutorialChatControlDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TUTORIAL_CHAT_CONTROL_EVENT, { detail }),
  );
}

export interface AppEmoteEventDetail {
  emoteId: string;
  path: string;
  duration: number;
  loop: boolean;
  showOverlay?: boolean;
}

export interface ChatAvatarVoiceEventDetail {
  mouthOpen: number;
  isSpeaking: boolean;
}

export type ElizaDocumentEventName =
  | typeof COMMAND_PALETTE_EVENT
  | typeof EMOTE_PICKER_EVENT
  | typeof STOP_EMOTE_EVENT
  | typeof AGENT_READY_EVENT
  | typeof BRIDGE_READY_EVENT
  | typeof SHARE_TARGET_EVENT
  | typeof TRAY_ACTION_EVENT
  | typeof APP_RESUME_EVENT
  | typeof APP_PAUSE_EVENT
  | typeof CONNECT_EVENT
  | typeof FOCUS_CONNECTOR_EVENT
  | typeof NETWORK_STATUS_CHANGE_EVENT
  | typeof MOBILE_RUNTIME_MODE_CHANGED_EVENT;

export type ElizaWindowEventName =
  | typeof VOICE_CONFIG_UPDATED_EVENT
  | typeof CHAT_AVATAR_VOICE_EVENT
  | typeof APP_EMOTE_EVENT
  | typeof ELIZA_CLOUD_STATUS_UPDATED_EVENT
  | typeof VRM_TELEPORT_COMPLETE_EVENT
  | typeof FIRST_RUN_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT
  | typeof SELF_STATUS_SYNC_EVENT
  | typeof TUTORIAL_CHAT_CONTROL_EVENT
  | typeof CLOUD_HANDOFF_PHASE_EVENT;

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

/** Dispatch a normalized app-wide emote event on `window`. */
export function dispatchAppEmoteEvent(detail: AppEmoteEventDetail): void {
  dispatchWindowEvent(APP_EMOTE_EVENT, detail);
}

export function dispatchElizaCloudStatusUpdated(
  detail: ElizaCloudStatusUpdatedDetail,
): void {
  dispatchWindowEvent(ELIZA_CLOUD_STATUS_UPDATED_EVENT, detail);
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
