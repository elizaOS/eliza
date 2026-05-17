/**
 * Typed constants for eliza:* custom events dispatched across the app.
 *
 * Using these constants instead of raw strings prevents typo-driven drift
 * between producers (main.tsx, bridge, components) and consumers (AppContext,
 * EmotePicker, ChatView, etc.).
 */
export declare const COMMAND_PALETTE_EVENT: "eliza:command-palette";
export declare const EMOTE_PICKER_EVENT: "eliza:emote-picker";
export declare const STOP_EMOTE_EVENT: "eliza:stop-emote";
export declare const AGENT_READY_EVENT: "eliza:agent-ready";
export declare const BRIDGE_READY_EVENT: "eliza:bridge-ready";
export declare const SHARE_TARGET_EVENT: "eliza:share-target";
export declare const TRAY_ACTION_EVENT: "eliza:tray-action";
export declare const APP_RESUME_EVENT: "eliza:app-resume";
export declare const APP_PAUSE_EVENT: "eliza:app-pause";
export declare const CONNECT_EVENT: "eliza:connect";
export declare const FOCUS_CONNECTOR_EVENT: "eliza:focus-connector";
export declare const NETWORK_STATUS_CHANGE_EVENT: "eliza:network-status-change";
export declare const MOBILE_RUNTIME_MODE_CHANGED_EVENT: "eliza:mobile-runtime-mode-changed";
/** Detail payload for {@link NETWORK_STATUS_CHANGE_EVENT}. */
export interface NetworkStatusChangeDetail {
  /** `true` when the device reports a usable network interface. */
  connected: boolean;
}
export declare const VOICE_CONFIG_UPDATED_EVENT: "eliza:voice-config-updated";
export declare const CHAT_AVATAR_VOICE_EVENT: "eliza:chat-avatar-voice";
export declare const APP_EMOTE_EVENT: "eliza:app-emote";
/** After `/api/cloud/status` — chat voice reloads config so cloud-backed TTS mode matches the server snapshot. */
export declare const ELIZA_CLOUD_STATUS_UPDATED_EVENT: "eliza:cloud-status-updated";
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
export declare const VRM_TELEPORT_COMPLETE_EVENT: "eliza:vrm-teleport-complete";
/** IdentityStep dispatches this after queuing a post-teleport voice preview; OnboardingWizard echoes {@link VRM_TELEPORT_COMPLETE_EVENT} when VRM is off. */
export declare const ONBOARDING_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT: "eliza:onboarding-voice-preview-await-teleport";
export declare const SELF_STATUS_SYNC_EVENT: "eliza:self-status-refresh";
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
  | typeof ONBOARDING_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT
  | typeof SELF_STATUS_SYNC_EVENT;
export type ElizaEventName = ElizaDocumentEventName | ElizaWindowEventName;
/** Dispatch a typed custom event on `document`. */
export declare function dispatchAppEvent(
  name: ElizaDocumentEventName,
  detail?: unknown,
): void;
/** Dispatch a typed custom event on `window`. */
export declare function dispatchWindowEvent(
  name: ElizaWindowEventName,
  detail?: unknown,
): void;
/** Dispatch a normalized app-wide emote event on `window`. */
export declare function dispatchAppEmoteEvent(
  detail: AppEmoteEventDetail,
): void;
export declare function dispatchElizaCloudStatusUpdated(
  detail: ElizaCloudStatusUpdatedDetail,
): void;
export declare function readPendingFocusConnector(): string | null;
export declare function clearPendingFocusConnector(connectorId?: string): void;
export declare function dispatchFocusConnector(connectorId: string): void;
export type AppDocumentEventName = ElizaDocumentEventName;
export type AppWindowEventName = ElizaWindowEventName;
export type AppEventName = ElizaEventName;
//# sourceMappingURL=index.d.ts.map
