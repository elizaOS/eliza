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
  return globalThis.crypto.randomUUID();
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

function normalizeFeatureName(value: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function resolveAndroidFeatureOpenPath(params: URLSearchParams): string {
  const feature = normalizeFeatureName(params.get("feature"));
  if (
    ["voice", "voice chat", "talk", "eliza app action voice"].includes(feature)
  ) {
    return "voice";
  }
  if (
    [
      "daily brief",
      "daily briefing",
      "lifeops daily brief",
      "briefing",
      "recap",
      "eliza app action daily brief",
    ].includes(feature)
  ) {
    return "lifeops/daily-brief";
  }
  if (
    [
      "new task",
      "create task",
      "add task",
      "lifeops task",
      "reminder",
      "eliza app action new task",
    ].includes(feature)
  ) {
    return "lifeops/task/new";
  }
  if (
    [
      "task",
      "tasks",
      "lifeops tasks",
      "reminders",
      "to do",
      "eliza app action tasks",
    ].includes(feature)
  ) {
    return "lifeops/tasks";
  }
  if (feature === "ask") {
    return "ask";
  }
  return "chat";
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
    case "feature/open":
      return buildAssistantLaunchHashRoute(
        resolveAndroidFeatureOpenPath(searchParams),
        searchParams,
        options,
      );
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
    case "lifeops/tasks": {
      const params = withDefaultSearchParam(
        searchParams,
        "source",
        ASSISTANT_ENTRY_SOURCE,
      );
      params.set("action", params.get("action") ?? "lifeops.tasks");
      ensureAssistantLaunchId(params, generateLaunchId);
      params.set("lifeops.section", "reminders");
      return formatHashRoute("lifeops", params);
    }
    case "lifeops/create":
    case "lifeops/task":
    case "lifeops/task/new":
    case "lifeops/reminder": {
      const params = withDefaultSearchParam(
        searchParams,
        "source",
        ASSISTANT_ENTRY_SOURCE,
      );
      params.set("action", params.get("action") ?? "lifeops.create");
      ensureAssistantLaunchId(params, generateLaunchId);
      if (hasAssistantLaunchText(params)) {
        return formatHashRoute("chat", params);
      }
      params.set("lifeops.section", "reminders");
      return formatHashRoute("lifeops", params);
    }
    default:
      return null;
  }
}
