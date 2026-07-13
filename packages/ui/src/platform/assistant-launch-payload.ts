/**
 * Keys and parsing for the assistant-launch deep-link payload (which query keys
 * carry the launch text).
 */
export const ASSISTANT_LAUNCH_TEXT_KEYS = [
  "text",
  "q",
  "query",
  "body",
] as const;

export const ASSISTANT_LAUNCH_PARAM_KEYS = [
  ...ASSISTANT_LAUNCH_TEXT_KEYS,
  "action",
  "assistant.launchId",
  "source",
  "voice",
  "transcribe",
] as const;

// Every OS-native launch surface that mints `#chat?…` hash routes. Sources here
// gate CLAIMING only (which entry points may open chat / start capture) — text
// is still prefilled, never auto-sent, because the URL spine is forgeable by any
// app or website regardless of what `source` it claims to be.
export const ASSISTANT_LAUNCH_SOURCES = new Set([
  "android-app-actions",
  "android-assist",
  "android-assistant-session",
  "android-ime",
  "android-qs-tile",
  "android-recognition-service",
  "android-share-sheet",
  "android-share-sheet-multiple",
  "android-static-shortcut",
  "android-widget",
  "assistant-entry",
  "desktop-hotkey",
  "desktop-tray",
  "ios-app-intents",
  "ios-app-shortcuts",
  "ios-control",
  "ios-keyboard",
  "ios-live-activity",
  "ios-widget",
  "macos-shortcuts",
  "macos-siri",
  "siri",
]);

export interface AssistantLaunchPayload {
  action: string | null;
  launchId: string;
  route: string;
  source: string;
  text: string;
  /** `voice=1` launch — start hands-free conversation capture. */
  voice: boolean;
  /** `transcribe=1` launch — start transcription-mode capture. */
  transcribe: boolean;
}

export interface AssistantLaunchPayloadClaimOptions {
  allowedRoutes?: readonly string[];
}

export interface AssistantLaunchPayloadSendOptions {
  metadata: Record<string, unknown>;
}

export interface AssistantLaunchPayloadConsumeOptions
  extends AssistantLaunchPayloadClaimOptions {
  onSendFailure?: (payload: AssistantLaunchPayload, error: unknown) => void;
  sendText: (
    text: string,
    options: AssistantLaunchPayloadSendOptions,
  ) => Promise<unknown> | unknown;
}

const claimedAssistantLaunchIds = new Set<string>();

function trimParam(params: URLSearchParams, key: string): string {
  return params.get(key)?.trim() ?? "";
}

function readLaunchText(params: URLSearchParams): string {
  for (const key of ASSISTANT_LAUNCH_TEXT_KEYS) {
    const value = trimParam(params, key);
    if (value) return value;
  }
  return "";
}

export function readAssistantLaunchPayloadFromHash(
  hash: string,
): AssistantLaunchPayload | null {
  const normalizedHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const [routePart, query = ""] = normalizedHash.split("?");
  if (!query) return null;

  const params = new URLSearchParams(query);
  const source = trimParam(params, "source");
  if (!ASSISTANT_LAUNCH_SOURCES.has(source)) return null;

  const text = readLaunchText(params);
  // Voice/transcribe launches are capture-control intents and legitimately
  // carry no text (`elizaos://voice` → `#chat?voice=1&source=…`); a payload
  // with neither text nor a capture flag has nothing to do.
  const voice = trimParam(params, "voice") === "1";
  const transcribe = trimParam(params, "transcribe") === "1";
  if (!text && !voice && !transcribe) return null;

  const action = trimParam(params, "action") || null;
  // Fallback id (deep-link routing normally mints a per-launch UUID). Keep the
  // historical text-launch shape; capture-only launches get their own suffix so
  // a voice launch never collides with a same-source text launch.
  const launchId =
    trimParam(params, "assistant.launchId") ||
    `${source}:${action ?? ""}:${text}${voice ? ":voice" : ""}${transcribe ? ":transcribe" : ""}`;

  return {
    action,
    launchId,
    route: routePart.replace(/^\/+|\/+$/g, ""),
    source,
    text,
    voice,
    transcribe,
  };
}

export function buildAssistantLaunchMetadata(
  payload: AssistantLaunchPayload,
): Record<string, unknown> {
  return {
    assistantLaunch: true,
    assistantLaunchAction: payload.action,
    assistantLaunchId: payload.launchId,
    assistantLaunchRoute: payload.route,
    assistantLaunchSource: payload.source,
  };
}

export function claimAssistantLaunchPayloadFromHash(
  hash: string,
  options: AssistantLaunchPayloadClaimOptions = {},
): AssistantLaunchPayload | null {
  const payload = readAssistantLaunchPayloadFromHash(hash);
  if (!payload) return null;

  if (options.allowedRoutes && !options.allowedRoutes.includes(payload.route)) {
    return null;
  }

  if (claimedAssistantLaunchIds.has(payload.launchId)) return null;
  claimedAssistantLaunchIds.add(payload.launchId);
  clearAssistantLaunchPayloadFromHash();
  return payload;
}

export async function consumeAssistantLaunchPayloadFromHash(
  hash: string,
  options: AssistantLaunchPayloadConsumeOptions,
): Promise<AssistantLaunchPayload | null> {
  const payload = claimAssistantLaunchPayloadFromHash(hash, options);
  if (!payload) return null;

  // Capture-control launches (voice/transcribe with no text) have nothing to
  // send; the caller reads the flags off the returned payload.
  if (payload.text) {
    try {
      await options.sendText(payload.text, {
        metadata: buildAssistantLaunchMetadata(payload),
      });
    } catch (error) {
      options.onSendFailure?.(payload, error);
    }
  }

  return payload;
}

export function clearAssistantLaunchPayloadFromHash(): void {
  if (typeof window === "undefined") return;

  const [routePart, query = ""] = window.location.hash.split("?");
  if (!query) return;

  const params = new URLSearchParams(query);
  for (const key of ASSISTANT_LAUNCH_PARAM_KEYS) {
    params.delete(key);
  }

  const nextHash = params.toString() ? `${routePart}?${params}` : routePart;
  if (nextHash === window.location.hash) return;

  window.history.replaceState(
    null,
    "",
    `${window.location.href.split("#")[0]}${nextHash}`,
  );
}

export function __resetAssistantLaunchPayloadClaimsForTests(): void {
  claimedAssistantLaunchIds.clear();
}
