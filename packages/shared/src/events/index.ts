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
export const NETWORK_STATUS_CHANGE_EVENT =
  "eliza:network-status-change" as const;
export const MOBILE_RUNTIME_MODE_CHANGED_EVENT =
  "eliza:mobile-runtime-mode-changed" as const;

/** Detail payload for {@link NETWORK_STATUS_CHANGE_EVENT}. */
export interface NetworkStatusChangeDetail {
  /** `true` when the device reports a usable network interface. */
  connected: boolean;
}

// ── Voice / config ───────────────────────────────────────────────────────
export const VOICE_CONFIG_UPDATED_EVENT = "eliza:voice-config-updated" as const;
export const CHAT_AVATAR_VOICE_EVENT = "eliza:chat-avatar-voice" as const;
export const APP_EMOTE_EVENT = "eliza:app-emote" as const;
/**
 * Fused on-device wake (#9953 / #10351). The battery-efficient native
 * openWakeWord runtime (`libwakeword` via `wake-word-ggml.ts`) runs in the
 * agent/native process; each detected stage is forwarded to the renderer as
 * this window event, where `useWakeController` activates the bottom bar and
 * starts a turn. This is the single contract shared by the producer
 * (`@elizaos/plugin-local-inference`) and the consumer (`@elizaos/ui`
 * fused-wake-bridge) so the two halves never drift.
 */
export const FUSED_WAKE_EVENT = "eliza:fused-wake" as const;

/** Which fused wake stage fired. */
export type FusedWakeStage =
  /** A trained openWakeWord head crossed threshold — terminal, no ASR confirm. */
  | "head-fired"
  /** The generic detector raised a candidate; an ASR confirm window opens. */
  | "stage-a-candidate"
  /** The short-window ASR transcript for two-stage confirmation. */
  | "stage-b-transcript";

/** Detail payload for {@link FUSED_WAKE_EVENT} — one fused-wake stage. */
export interface FusedWakeEventDetail {
  stage: FusedWakeStage;
  /** ASR transcript for `stage-b-transcript`. */
  transcript?: string;
  /** Detector confidence in [0, 1], when known. */
  confidence?: number;
}
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

// ── Navigation ──────────────────────────────────────────────────────────
export const NAVIGATE_VIEW_EVENT = "eliza:navigate:view" as const;

export type NavigateViewType = "gui" | "tui" | "xr";

export interface NavigateViewDetail {
  viewId?: string;
  viewPath?: string | null;
  viewLabel?: string;
  viewType?: NavigateViewType;
  action?: string;
  /** Sub-section to deep-link within the target view (e.g. a Settings section id). */
  subview?: string;
  views?: string[];
  layout?: string;
  placement?: string;
  alwaysOnTop?: boolean;
  /** Opaque payload handed to the target view on navigation (deep-link state). */
  payload?: unknown;
}

export type NavigateViewEvent = CustomEvent<NavigateViewDetail>;

export function createNavigateViewEvent(
  detail: NavigateViewDetail,
): NavigateViewEvent {
  return new CustomEvent(NAVIGATE_VIEW_EVENT, { detail });
}

export function dispatchNavigateViewEvent(detail: NavigateViewDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(createNavigateViewEvent(detail));
}

// ── View event bus ──────────────────────────────────────────────────────
export const BACKGROUND_APPLY_EVENT = "background:apply" as const;

/** Operation carried by a {@link BACKGROUND_APPLY_EVENT} payload. */
export type BackgroundApplyOp = "set" | "undo" | "redo" | "reset";

/** Tunable GLSL uniform patch the BACKGROUND action can send to the renderer. */
export interface BackgroundShaderUniformPatch {
  u_speed?: number;
  u_scale?: number;
  u_intensity?: number;
  u_seed?: number;
}

/** Payload broadcast on {@link BACKGROUND_APPLY_EVENT}. */
export interface BackgroundApplyPayload extends Record<string, unknown> {
  op: BackgroundApplyOp;
  /** "shader" (color field), "image" (cover image), or "glsl" (programmable shader). */
  mode?: "shader" | "image" | "glsl";
  /** 6-digit hex for shader/glsl mode. */
  color?: string;
  /** Same-origin image URL (`/api/media/...`) for image mode. */
  imageUrl?: string;
  /** Named GLSL preset id; the renderer resolves this to source. */
  presetId?: string;
  /** Uniform patch for glsl mode. */
  uniforms?: BackgroundShaderUniformPatch;
}

// ── Avatar / VRM ─────────────────────────────────────────────────────────
export const VRM_TELEPORT_COMPLETE_EVENT =
  "eliza:vrm-teleport-complete" as const;
/** FirstRunShell dispatches this after queuing a post-teleport voice preview; FirstRunWizard echoes {@link VRM_TELEPORT_COMPLETE_EVENT} when VRM is off. */
export const FIRST_RUN_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT =
  "eliza:first-run-voice-preview-await-teleport" as const;

// ── Sidebar sync ─────────────────────────────────────────────────────────
export const SELF_STATUS_SYNC_EVENT = "eliza:self-status-refresh" as const;

// ── Agent WebSocket shell events ─────────────────────────────────────────
export const SHELL_NAVIGATE_VIEW_WS_EVENT = "shell:navigate:view" as const;

export type ShellNavigateViewType = "gui" | "tui" | "xr";

export interface ShellNavigateViewPayload {
  viewId?: string;
  viewPath?: string | null;
  viewLabel?: string;
  viewType?: ShellNavigateViewType;
  action?: string;
  subview?: string;
  views?: string[];
  layout?: string;
  placement?: string;
  alwaysOnTop?: boolean;
}

export type ShellNavigateViewWsFrame = ShellNavigateViewPayload & {
  type: typeof SHELL_NAVIGATE_VIEW_WS_EVENT;
};

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readViewType(value: unknown): ShellNavigateViewType | undefined {
  return value === "gui" || value === "tui" || value === "xr"
    ? value
    : undefined;
}

export function normalizeShellNavigateViewPayload(
  data: Record<string, unknown>,
): ShellNavigateViewPayload {
  const views = Array.isArray(data.views)
    ? data.views.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : undefined;

  return {
    viewId: typeof data.viewId === "string" ? data.viewId : undefined,
    viewPath: typeof data.viewPath === "string" ? data.viewPath : undefined,
    viewLabel: typeof data.viewLabel === "string" ? data.viewLabel : undefined,
    viewType: readViewType(data.viewType),
    action: typeof data.action === "string" ? data.action : undefined,
    subview: readNonEmptyString(data.subview),
    views: views && views.length > 0 ? views : undefined,
    layout: readNonEmptyString(data.layout),
    placement: readNonEmptyString(data.placement),
    alwaysOnTop: data.alwaysOnTop === true,
  };
}

export function createShellNavigateViewWsFrame(
  payload: ShellNavigateViewPayload,
): ShellNavigateViewWsFrame {
  return {
    type: SHELL_NAVIGATE_VIEW_WS_EVENT,
    ...payload,
  };
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
  | typeof NETWORK_STATUS_CHANGE_EVENT
  | typeof MOBILE_RUNTIME_MODE_CHANGED_EVENT;

export type ElizaWindowEventName =
  | typeof VOICE_CONFIG_UPDATED_EVENT
  | typeof CHAT_AVATAR_VOICE_EVENT
  | typeof FUSED_WAKE_EVENT
  | typeof APP_EMOTE_EVENT
  | typeof ELIZA_CLOUD_STATUS_UPDATED_EVENT
  | typeof NAVIGATE_VIEW_EVENT
  | typeof VRM_TELEPORT_COMPLETE_EVENT
  | typeof FIRST_RUN_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT
  | typeof SELF_STATUS_SYNC_EVENT;

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

// ── Generic app aliases (preferred) ──────────────────────────────────────
export type AppDocumentEventName = ElizaDocumentEventName;
export type AppWindowEventName = ElizaWindowEventName;
export type AppEventName = ElizaEventName;
