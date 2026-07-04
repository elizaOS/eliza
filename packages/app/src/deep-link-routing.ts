/**
 * Deep-link routing table for the app shell: maps custom-URL-scheme
 * (`eliza://…`) and universal-link paths onto the two in-app navigation
 * primitives.
 *
 * `resolveDeepLinkNavigationIntent()` handles top-level surfaces (Settings,
 * Wallet/Inventory, Browser, Cloud Apps, Settings → Connectors), returning a
 * `DeepLinkNavigationIntent` the caller dispatches on the `eliza:navigate:view`
 * event bus. `buildAssistantLaunchHashRoute()` handles chat-launch entries
 * (ask / chat / voice / smart-reply / LifeOps briefs and tasks, plus Android
 * feature-open aliases), folding them into a single `#chat?…` hash route that
 * carries the trusted `assistant-entry` source and a stable launch id the
 * always-mounted ContinuousChatOverlay claims. Both return `null` for
 * unrecognized paths, so an unknown deep link is non-routable rather than
 * silently opening chat.
 */
const ASSISTANT_ENTRY_SOURCE = "assistant-entry";
const ASSISTANT_LAUNCH_TEXT_KEYS = ["text", "q", "query", "body"] as const;

export interface AssistantLaunchHashRouteOptions {
  generateLaunchId?: () => string;
}

/**
 * In-app navigation intent for a deep link that targets a top-level surface
 * (Settings, Wallet, Browser, Connectors) instead of the chat-launch flow.
 *
 * Structurally a subset of the app's `NavigateViewDetail` (packages/ui
 * app-navigate-view.ts): `viewPath` drives `tabFromPath` → `setTab`, and
 * `subview` deep-links a Settings section. The caller dispatches this on the
 * `eliza:navigate:view` event bus.
 */
export interface DeepLinkNavigationIntent {
  viewId: string;
  viewPath: string;
  subview?: string;
}

/**
 * Resolve a deep-link path to an in-app tab/section navigation intent, or
 * `null` when the path is not a top-level-surface deep link (chat-launch and
 * share/connect paths are handled elsewhere).
 *
 * These links previously set `window.location.hash` directly. On the
 * mobile/Capacitor entrypoint the app is not served over `file:` and is not an
 * app-window, so `getWindowNavigationPath()` reads `location.pathname` (never
 * the hash) — the target tab never opened. Returning a navigation intent lets
 * the caller dispatch the same `eliza:navigate:view` event the rest of the app
 * uses, which opens the surface on every platform. (Chat-launch deep links stay
 * on the hash: the always-mounted ContinuousChatOverlay claims the launch
 * payload from the hash directly.)
 */
export function resolveDeepLinkNavigationIntent(
  path: string,
): DeepLinkNavigationIntent | null {
  // eliza://connectors and eliza://settings/connectors/<provider> → open
  // Settings focused on the Connectors section (a Settings section, not a
  // top-level tab).
  if (
    path === "connectors" ||
    /^settings\/connectors\/[a-z0-9-]+$/i.test(path)
  ) {
    return { viewId: "settings", viewPath: "/settings", subview: "connectors" };
  }

  switch (path) {
    case "apps/deploy":
    case "cloud-apps":
      // eliza://apps/deploy (and https://eliza.app/apps/deploy) → the Eliza
      // Cloud Applications studio, the registered `cloud-apps` app-shell page
      // (NativeAppsStudio → ApplicationsPage → detail → Deploy/Redeploy). The
      // in-app entry point for the Apps Deploy UI (#10823).
      return { viewId: "cloud-apps", viewPath: "/cloud-apps" };
    case "settings":
      return { viewId: "settings", viewPath: "/settings" };
    case "wallet":
    case "inventory":
      // `/wallet` resolves to the `inventory` tab via `tabFromPath`.
      return { viewId: "inventory", viewPath: "/wallet" };
    case "browser":
      return { viewId: "browser", viewPath: "/browser" };
    default:
      return null;
  }
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
    case "smart-reply":
    case "chat/smart-reply": {
      const params = withDefaultSearchParam(
        searchParams,
        "source",
        ASSISTANT_ENTRY_SOURCE,
      );
      params.set("action", params.get("action") ?? "smart-reply");
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
    // Personal-assistant deep links no longer target a top-level "lifeops"
    // aggregate view (it was decomposed into independent plugins). They route
    // into chat with the assistant-entry source + a planner action hint so the
    // agent handles the briefing / task intent inline.
    case "daily-brief":
    case "lifeops/daily-brief": {
      const params = withDefaultSearchParam(
        searchParams,
        "source",
        ASSISTANT_ENTRY_SOURCE,
      );
      params.set("action", params.get("action") ?? "lifeops.daily-brief");
      ensureAssistantLaunchId(params, generateLaunchId);
      return formatHashRoute("chat", params);
    }
    case "lifeops/tasks": {
      const params = withDefaultSearchParam(
        searchParams,
        "source",
        ASSISTANT_ENTRY_SOURCE,
      );
      params.set("action", params.get("action") ?? "lifeops.tasks");
      ensureAssistantLaunchId(params, generateLaunchId);
      return formatHashRoute("chat", params);
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
      return formatHashRoute("chat", params);
    }
    default:
      return null;
  }
}
