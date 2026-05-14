const ASSISTANT_ENTRY_SOURCE = "assistant-entry";
const ASSISTANT_LAUNCH_TEXT_KEYS = ["text", "q", "query", "body"] as const;

export interface AssistantLaunchHashRouteOptions {
  generateLaunchId?: () => string;
}

function withDefaultSearchParam(
  params: URLSearchParams,
  key: string,
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (!next.has(key)) {
    next.set(key, value);
  }
  return next;
}

function defaultLaunchId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function ensureAssistantLaunchId(
  params: URLSearchParams,
  generateLaunchId: () => string,
): void {
  if (params.has("assistant.launchId")) return;
  const hasAssistantPayload =
    hasAssistantLaunchText(params) ||
    params.has("action") ||
    params.has("source");
  if (!hasAssistantPayload) return;
  params.set("assistant.launchId", generateLaunchId());
}

function hasAssistantLaunchText(params: URLSearchParams): boolean {
  return ASSISTANT_LAUNCH_TEXT_KEYS.some((key) =>
    Boolean(params.get(key)?.trim()),
  );
}

function formatHashRoute(route: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `#${route}?${query}` : `#${route}`;
}

export function buildAssistantLaunchHashRoute(
  path: string,
  searchParams: URLSearchParams,
  options: AssistantLaunchHashRouteOptions = {},
): string | null {
  const generateLaunchId = options.generateLaunchId ?? defaultLaunchId;

  switch (path) {
    case "ask":
    case "assistant":
    case "chat/ask": {
      const params = withDefaultSearchParam(
        searchParams,
        "source",
        ASSISTANT_ENTRY_SOURCE,
      );
      params.set("action", params.get("action") ?? "ask");
      ensureAssistantLaunchId(params, generateLaunchId);
      return formatHashRoute("chat", params);
    }
    case "chat": {
      const params = withDefaultSearchParam(
        searchParams,
        "source",
        ASSISTANT_ENTRY_SOURCE,
      );
      params.set("action", params.get("action") ?? "chat");
      ensureAssistantLaunchId(params, generateLaunchId);
      return formatHashRoute("chat", params);
    }
    case "voice":
    case "chat/voice": {
      const params = withDefaultSearchParam(
        searchParams,
        "source",
        ASSISTANT_ENTRY_SOURCE,
      );
      ensureAssistantLaunchId(params, generateLaunchId);
      params.set("voice", "1");
      return formatHashRoute("chat", params);
    }
    case "daily-brief":
    case "lifeops/daily-brief": {
      const params = withDefaultSearchParam(
        searchParams,
        "source",
        ASSISTANT_ENTRY_SOURCE,
      );
      params.set("action", params.get("action") ?? "lifeops.daily-brief");
      ensureAssistantLaunchId(params, generateLaunchId);
      params.set("lifeops.section", "overview");
      return formatHashRoute("lifeops", params);
    }
    case "lifeops/create":
    case "lifeops/task":
    case "lifeops/reminder": {
      const params = withDefaultSearchParam(
        searchParams,
        "source",
        ASSISTANT_ENTRY_SOURCE,
      );
      params.set("action", params.get("action") ?? "lifeops.create");
      ensureAssistantLaunchId(params, generateLaunchId);
      params.set("lifeops.section", "reminders");
      return formatHashRoute(
        hasAssistantLaunchText(params) ? "chat" : "lifeops",
        params,
      );
    }
    default:
      return null;
  }
}
