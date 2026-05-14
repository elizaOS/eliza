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
] as const;

export const ASSISTANT_LAUNCH_SOURCES = new Set([
  "android-app-actions",
  "android-assist",
  "assistant-entry",
  "ios-app-shortcuts",
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
}

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
  if (!text) return null;

  const action = trimParam(params, "action") || null;
  const launchId =
    trimParam(params, "assistant.launchId") ||
    `${source}:${action ?? ""}:${text}`;

  return {
    action,
    launchId,
    route: routePart.replace(/^\/+|\/+$/g, ""),
    source,
    text,
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
    `${window.location.pathname}${window.location.search}${nextHash}`,
  );
}
