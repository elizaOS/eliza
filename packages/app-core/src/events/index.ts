/**
 * Typed constants for milady:* custom events dispatched across the app.
 *
 * Using these constants instead of raw strings prevents typo-driven drift
 * between producers (main.tsx, bridge, components) and consumers (AppContext,
 * EmotePicker, ChatView, etc.).
 */

// ── App lifecycle ────────────────────────────────────────────────────────
export const COMMAND_PALETTE_EVENT = "milady:command-palette" as const;
export const EMOTE_PICKER_EVENT = "milady:emote-picker" as const;
export const STOP_EMOTE_EVENT = "milady:stop-emote" as const;

// ── Agent / bridge ───────────────────────────────────────────────────────
export const AGENT_READY_EVENT = "milady:agent-ready" as const;
export const BRIDGE_READY_EVENT = "milady:bridge-ready" as const;
export const SHARE_TARGET_EVENT = "milady:share-target" as const;
export const TRAY_ACTION_EVENT = "milady:tray-action" as const;

// ── App state ────────────────────────────────────────────────────────────
export const APP_RESUME_EVENT = "milady:app-resume" as const;
export const APP_PAUSE_EVENT = "milady:app-pause" as const;
export const CONNECT_EVENT = "milady:connect" as const;

// ── Voice / config ───────────────────────────────────────────────────────
export const VOICE_CONFIG_UPDATED_EVENT =
  "milady:voice-config-updated" as const;
export const CHAT_AVATAR_VOICE_EVENT = "milady:chat-avatar-voice" as const;
export const APP_EMOTE_EVENT = "milady:app-emote" as const;

// ── Sidebar sync ─────────────────────────────────────────────────────────
export const SELF_STATUS_SYNC_EVENT = "milady:self-status-refresh" as const;

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

export type MiladyDocumentEventName =
  | typeof COMMAND_PALETTE_EVENT
  | typeof EMOTE_PICKER_EVENT
  | typeof STOP_EMOTE_EVENT
  | typeof AGENT_READY_EVENT
  | typeof BRIDGE_READY_EVENT
  | typeof SHARE_TARGET_EVENT
  | typeof TRAY_ACTION_EVENT
  | typeof APP_RESUME_EVENT
  | typeof APP_PAUSE_EVENT
  | typeof CONNECT_EVENT;

export type MiladyWindowEventName =
  | typeof VOICE_CONFIG_UPDATED_EVENT
  | typeof CHAT_AVATAR_VOICE_EVENT
  | typeof APP_EMOTE_EVENT
  | typeof SELF_STATUS_SYNC_EVENT;

export type MiladyEventName = MiladyDocumentEventName | MiladyWindowEventName;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Dispatch a typed custom event on `document`. */
export function dispatchMiladyEvent(
  name: MiladyDocumentEventName,
  detail?: unknown,
): void {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Dispatch a typed custom event on `window`. */
export function dispatchWindowEvent(
  name: MiladyWindowEventName,
  detail?: unknown,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Dispatch a normalized app-wide emote event on `window`. */
export function dispatchAppEmoteEvent(detail: AppEmoteEventDetail): void {
  dispatchWindowEvent(APP_EMOTE_EVENT, detail);
}
