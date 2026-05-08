/**
 * @elizaos/plugin-browser plugin export.
 *
 * plugin-collector discovers `routes` and `schema` at runtime. Eliza loads
 * this as a core plugin so the Browser Workspace UI and browser companion
 * extension share one route surface.
 */

import type http from "node:http";
import { TLSSocket } from "node:tls";
import {
  readJsonBody as httpReadJsonBody,
  sendJson as httpSendJson,
  sendJsonError as httpSendJsonError,
} from "@elizaos/agent/api/http-helpers";
import type { AgentRuntime, Plugin, Route, UUID } from "@elizaos/core";
import { resolveCanonicalOwnerId } from "@elizaos/core";
import { browserBridgeActions } from "./actions/bridge.js";
import { browserAutofillLoginAction } from "./actions/browser-autofill-login.js";
import { browserSessionAction } from "./actions/browser-session.js";
import {
  type BrowserBridgeRouteContext,
  handleBrowserBridgeRoutes,
} from "./routes.js";
import { browserBridgeSchema } from "./schema.js";

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  httpSendJson(res, data, status);
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  httpSendJsonError(res, message, status);
}

function httpDecodePathComponent(
  raw: string,
  res: http.ServerResponse,
  fieldName: string,
): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    httpSendJsonError(res, `Invalid ${fieldName}: malformed URL encoding`, 400);
    return null;
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return firstHeaderValue(value[0]);
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.split(",")[0]?.trim();
  return normalized ? normalized : null;
}

function requestBaseUrl(req: http.IncomingMessage): string {
  const headers = req.headers ?? {};
  const protocol =
    firstHeaderValue(headers["x-forwarded-proto"]) ??
    (req.socket instanceof TLSSocket && req.socket.encrypted
      ? "https"
      : "http");
  const host =
    firstHeaderValue(headers["x-forwarded-host"]) ??
    firstHeaderValue(headers.host) ??
    "localhost";
  return `${protocol}://${host}`;
}

function routeOwnerEntityId(runtime: AgentRuntime | null): UUID | null {
  const ownerId = runtime ? resolveCanonicalOwnerId(runtime) : null;
  return typeof ownerId === "string" ? (ownerId as UUID) : null;
}

function buildRouteContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime | null,
): BrowserBridgeRouteContext {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", requestBaseUrl(req));
  return {
    req,
    res,
    method,
    pathname: url.pathname,
    url,
    state: {
      runtime,
      adminEntityId: routeOwnerEntityId(runtime),
    },
    json,
    error,
    readJsonBody: httpReadJsonBody,
    decodePathComponent: httpDecodePathComponent,
  };
}

const STATIC_ROUTES: Array<{ type: string; path: string; public?: boolean }> = [
  { type: "GET", path: "/api/browser-bridge/sessions" },
  { type: "GET", path: "/api/browser-bridge/settings" },
  { type: "POST", path: "/api/browser-bridge/settings" },
  { type: "POST", path: "/api/browser-bridge/companions/pair" },
  { type: "POST", path: "/api/browser-bridge/companions/auto-pair" },
  { type: "GET", path: "/api/browser-bridge/companions" },
  { type: "GET", path: "/api/browser-bridge/packages" },
  { type: "POST", path: "/api/browser-bridge/packages/open-path" },
  { type: "POST", path: "/api/browser-bridge/companions/sync", public: true },
  { type: "GET", path: "/api/browser-bridge/tabs" },
  { type: "GET", path: "/api/browser-bridge/current-page" },
  { type: "POST", path: "/api/browser-bridge/sync" },
  { type: "POST", path: "/api/browser-bridge/sessions" },
];

const DYNAMIC_ROUTES: Array<{ type: string; path: string; public?: boolean }> =
  [
    { type: "GET", path: "/api/browser-bridge/sessions/:id" },
    { type: "POST", path: "/api/browser-bridge/sessions/:id/confirm" },
    { type: "POST", path: "/api/browser-bridge/sessions/:id/progress" },
    { type: "POST", path: "/api/browser-bridge/sessions/:id/complete" },
    {
      type: "POST",
      path: "/api/browser-bridge/companions/sessions/:id/progress",
      public: true,
    },
    {
      type: "POST",
      path: "/api/browser-bridge/companions/sessions/:id/complete",
      public: true,
    },
    { type: "POST", path: "/api/browser-bridge/packages/:browser/build" },
    {
      type: "POST",
      path: "/api/browser-bridge/packages/:browser/open-manager",
    },
    { type: "GET", path: "/api/browser-bridge/packages/:browser/download" },
  ];

type PluginRouteHandler = NonNullable<Route["handler"]>;

function routeHandler(): PluginRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const ctx = buildRouteContext(
      httpReq,
      httpRes,
      (runtime as AgentRuntime) ?? null,
    );
    await handleBrowserBridgeRoutes(ctx);
  };
}

const browserBridgePluginRoutes: Route[] = [
  ...STATIC_ROUTES.map(
    (r) =>
      ({
        type: r.type as Route["type"],
        path: r.path,
        rawPath: true as const,
        ...(r.public ? ({ public: true } as const) : {}),
        handler: routeHandler(),
      }) as Route,
  ),
  ...DYNAMIC_ROUTES.map(
    (r) =>
      ({
        type: r.type as Route["type"],
        path: r.path,
        rawPath: true as const,
        ...(r.public ? ({ public: true } as const) : {}),
        handler: routeHandler(),
      }) as Route,
  ),
];

export const browserPlugin: Plugin = {
  name: "@elizaos/plugin-browser",
  description:
    "Browser plugin: BROWSER + MANAGE_BROWSER_BRIDGE actions. Owns the workspace browser (electrobun-embedded + jsdom fallback) and the Chrome/Safari companion bridge — settings, pairing, tab + page-context sync, and packaging artifacts.",
  schema: browserBridgeSchema,
  routes: browserBridgePluginRoutes,
  actions: [
    browserSessionAction,
    browserAutofillLoginAction,
    ...browserBridgeActions,
  ],
};
