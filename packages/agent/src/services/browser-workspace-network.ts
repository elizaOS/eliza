import {
  browserWorkspacePageFetch,
  DEFAULT_TIMEOUT_MS,
} from "./browser-workspace-helpers.js";
import { getBrowserWorkspaceTimestamp } from "./browser-workspace-state.js";
import type {
  BrowserWorkspaceNetworkRequestRecord,
  BrowserWorkspaceNetworkRoute,
  BrowserWorkspaceRuntimeState,
} from "./browser-workspace-types.js";

export function browserWorkspacePatternMatches(
  pattern: string,
  value: string,
): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.includes("*")) {
    return value.includes(trimmed);
  }
  let wildcardPattern = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? "";
    if (char === "*") {
      const next = trimmed[index + 1];
      if (next === "*") {
        wildcardPattern += ".*";
        index += 1;
      } else {
        wildcardPattern += ".*";
      }
      continue;
    }
    wildcardPattern += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${wildcardPattern}$`, "i").test(value);
}

export function normalizeBrowserWorkspaceHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" &&
        entry[0].trim().length > 0 &&
        typeof entry[1] === "string",
    ),
  );
}

export function findBrowserWorkspaceNetworkRoute(
  state: BrowserWorkspaceRuntimeState,
  url: string,
): BrowserWorkspaceNetworkRoute | null {
  return (
    [...state.networkRoutes]
      .reverse()
      .find((route) => browserWorkspacePatternMatches(route.pattern, url)) ??
    null
  );
}

export function recordBrowserWorkspaceNetworkRequest(
  state: BrowserWorkspaceRuntimeState,
  request: Omit<BrowserWorkspaceNetworkRequestRecord, "id" | "timestamp">,
): BrowserWorkspaceNetworkRequestRecord {
  const entry: BrowserWorkspaceNetworkRequestRecord = {
    ...request,
    id: `req_${state.networkNextRequestId++}`,
    timestamp: getBrowserWorkspaceTimestamp(),
  };
  state.networkRequests.push(entry);
  if (state.networkHar.active) {
    state.networkHar.entries.push(entry);
  }
  return entry;
}

export async function fetchBrowserWorkspaceTrackedResponse(
  state: BrowserWorkspaceRuntimeState,
  url: string,
  init: RequestInit = {},
  resourceType: string,
): Promise<Response> {
  if (state.settings.offline) {
    recordBrowserWorkspaceNetworkRequest(state, {
      matchedRoute: null,
      method: String(init.method ?? "GET").toUpperCase(),
      resourceType,
      responseBody: null,
      responseHeaders: {},
      status: 0,
      url,
    });
    throw new Error("Browser workspace is offline.");
  }

  const route = findBrowserWorkspaceNetworkRoute(state, url);
  if (route?.abort) {
    recordBrowserWorkspaceNetworkRequest(state, {
      matchedRoute: route.pattern,
      method: String(init.method ?? "GET").toUpperCase(),
      resourceType,
      responseBody: null,
      responseHeaders: route.headers,
      status: 0,
      url,
    });
    throw new Error(`Browser workspace network route aborted request: ${url}`);
  }

  if (
    route &&
    (route.body !== null ||
      route.status !== null ||
      Object.keys(route.headers).length > 0)
  ) {
    const response = new Response(route?.body ?? "", {
      headers: route?.headers,
      status: route?.status ?? 200,
    });
    recordBrowserWorkspaceNetworkRequest(state, {
      matchedRoute: route?.pattern ?? null,
      method: String(init.method ?? "GET").toUpperCase(),
      resourceType,
      responseBody: route?.body ?? "",
      responseHeaders: route?.headers ?? {},
      status: route?.status ?? 200,
      url,
    });
    return response;
  }

  const headers = new Headers(init.headers ?? {});
  for (const [key, value] of Object.entries(state.settings.headers)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  if (
    state.settings.credentials &&
    !headers.has("Authorization") &&
    state.settings.credentials.username
  ) {
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(
        `${state.settings.credentials.username}:${state.settings.credentials.password}`,
      ).toString("base64")}`,
    );
  }

  const response = await browserWorkspacePageFetch(url, {
    ...init,
    headers,
    redirect: init.redirect ?? "follow",
    signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  let responseBody: string | null = null;
  if (resourceType !== "document") {
    const clone = response.clone();
    try {
      responseBody = await clone.text();
    } catch {
      responseBody = null;
    }
  }
  recordBrowserWorkspaceNetworkRequest(state, {
    matchedRoute: null,
    method: String(init.method ?? "GET").toUpperCase(),
    resourceType,
    responseBody,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    status: response.status,
    url: response.url || url,
  });
  return response;
}
