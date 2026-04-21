/**
 * LifeOps plugin — registers LifeOps and website-blocker routes with the
 * elizaOS runtime plugin route system.
 *
 * Unlike Vincent/Shopify/Steward (which have a handful of routes each),
 * LifeOps has 60+ routes with many dynamic segments. Rather than
 * duplicating every path pattern, we register a small set of catch-all
 * entries per HTTP method and delegate to the existing monolithic
 * `handleLifeOpsRoutes` / `handleWebsiteBlockerRoutes` handlers.
 *
 * The plugin route bridge in runtime-plugin-routes.ts matches exact path
 * segments, so we register one route per (method × prefix) combination.
 * Each handler builds the LifeOpsRouteContext or WebsiteBlockerRouteContext
 * that the underlying handlers expect, then delegates.
 */

import type http from "node:http";
import type { AgentRuntime, Plugin, Route } from "@elizaos/core";
import {
  sendJson as httpSendJson,
  sendJsonError as httpSendJsonError,
  readJsonBody as httpReadJsonBody,
} from "@elizaos/agent/api/http-helpers";
import { decodePathComponent as httpDecodePathComponent } from "@elizaos/agent/api/server-helpers";
import { handleLifeOpsRoutes } from "./lifeops-routes.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";
import { handleWebsiteBlockerRoutes } from "./website-blocker-routes.js";
import type { WebsiteBlockerRouteContext } from "./website-blocker-routes.js";

// ---------------------------------------------------------------------------
// Context builders — bridge plugin route (req, res, runtime) to the context
// objects the LifeOps handlers expect.
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  httpSendJson(res, data, status);
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  httpSendJsonError(res, message, status);
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
    (((req.socket as { encrypted?: boolean } | undefined)?.encrypted ?? false)
      ? "https"
      : "http");
  const host =
    firstHeaderValue(headers["x-forwarded-host"]) ??
    firstHeaderValue(headers.host) ??
    "localhost";
  return `${protocol}://${host}`;
}

function buildLifeOpsContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime | null,
): LifeOpsRouteContext {
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
      adminEntityId: null,
    },
    json,
    error,
    readJsonBody: httpReadJsonBody,
    decodePathComponent: httpDecodePathComponent,
  };
}

function buildWebsiteBlockerContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime | null,
): WebsiteBlockerRouteContext {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", requestBaseUrl(req));
  return {
    req,
    res,
    method,
    pathname: url.pathname,
    runtime: runtime ?? undefined,
    readJsonBody: httpReadJsonBody,
    json,
    error,
  };
}

// ---------------------------------------------------------------------------
// All static LifeOps routes (exact-path matches)
// ---------------------------------------------------------------------------

const LIFEOPS_STATIC_ROUTES: Array<{
  type: string;
  path: string;
  public?: boolean;
}> = [
  { type: "GET", path: "/api/lifeops/app-state" },
  { type: "PUT", path: "/api/lifeops/app-state" },
  { type: "GET", path: "/api/lifeops/calendar/feed" },
  { type: "GET", path: "/api/lifeops/calendar/next-context" },
  { type: "GET", path: "/api/lifeops/gmail/triage" },
  { type: "GET", path: "/api/lifeops/gmail/search" },
  { type: "GET", path: "/api/lifeops/gmail/needs-response" },
  { type: "POST", path: "/api/lifeops/calendar/events" },
  { type: "POST", path: "/api/lifeops/gmail/reply-drafts" },
  { type: "POST", path: "/api/lifeops/gmail/batch-reply-drafts" },
  { type: "POST", path: "/api/lifeops/gmail/reply-send" },
  { type: "POST", path: "/api/lifeops/gmail/message-send" },
  { type: "POST", path: "/api/lifeops/gmail/batch-reply-send" },
  { type: "GET", path: "/api/lifeops/connectors/google/status" },
  { type: "POST", path: "/api/lifeops/connectors/google/start" },
  { type: "POST", path: "/api/lifeops/connectors/google/preference" },
  {
    type: "GET",
    path: "/api/lifeops/connectors/google/callback",
    public: true,
  },
  { type: "GET", path: "/api/lifeops/connectors/google/success", public: true },
  { type: "GET", path: "/api/lifeops/connectors/google/accounts" },
  { type: "POST", path: "/api/lifeops/connectors/google/disconnect" },
  { type: "GET", path: "/api/lifeops/connectors/x/status" },
  { type: "POST", path: "/api/lifeops/connectors/x" },
  { type: "POST", path: "/api/lifeops/x/posts" },
  { type: "GET", path: "/api/lifeops/x/dms/digest" },
  { type: "POST", path: "/api/lifeops/x/dms/curate" },
  { type: "POST", path: "/api/lifeops/x/dms/send" },
  // iMessage
  { type: "GET", path: "/api/lifeops/connectors/imessage/status" },
  { type: "GET", path: "/api/lifeops/connectors/imessage/chats" },
  { type: "GET", path: "/api/lifeops/connectors/imessage/messages" },
  { type: "POST", path: "/api/lifeops/connectors/imessage/send" },
  // Telegram
  { type: "GET", path: "/api/lifeops/connectors/telegram/status" },
  { type: "POST", path: "/api/lifeops/connectors/telegram/start" },
  { type: "POST", path: "/api/lifeops/connectors/telegram/submit" },
  { type: "POST", path: "/api/lifeops/connectors/telegram/cancel" },
  { type: "POST", path: "/api/lifeops/connectors/telegram/disconnect" },
  { type: "POST", path: "/api/lifeops/connectors/telegram/verify" },
  // Signal
  { type: "GET", path: "/api/lifeops/connectors/signal/status" },
  { type: "POST", path: "/api/lifeops/connectors/signal/pair" },
  { type: "GET", path: "/api/lifeops/connectors/signal/pairing-status" },
  { type: "POST", path: "/api/lifeops/connectors/signal/stop" },
  { type: "POST", path: "/api/lifeops/connectors/signal/disconnect" },
  // Discord
  { type: "GET", path: "/api/lifeops/connectors/discord/status" },
  { type: "POST", path: "/api/lifeops/connectors/discord/connect" },
  { type: "POST", path: "/api/lifeops/connectors/discord/disconnect" },
  { type: "GET", path: "/api/lifeops/channel-policies" },
  { type: "POST", path: "/api/lifeops/channel-policies" },
  { type: "POST", path: "/api/lifeops/channels/phone-consent" },
  { type: "GET", path: "/api/lifeops/activity-signals" },
  { type: "POST", path: "/api/lifeops/activity-signals" },
  { type: "POST", path: "/api/lifeops/reminders/process" },
  { type: "GET", path: "/api/lifeops/reminder-preferences" },
  { type: "POST", path: "/api/lifeops/reminder-preferences" },
  { type: "POST", path: "/api/lifeops/reminders/acknowledge" },
  { type: "POST", path: "/api/lifeops/website-access/relock" },
  { type: "GET", path: "/api/lifeops/reminders/inspection" },
  { type: "GET", path: "/api/lifeops/workflows" },
  { type: "POST", path: "/api/lifeops/workflows" },
  { type: "GET", path: "/api/lifeops/browser/sessions" },
  { type: "GET", path: "/api/lifeops/browser/settings" },
  { type: "POST", path: "/api/lifeops/browser/settings" },
  { type: "POST", path: "/api/lifeops/browser/companions/pair" },
  { type: "POST", path: "/api/lifeops/browser/companions/auto-pair" },
  { type: "GET", path: "/api/lifeops/browser/companions" },
  { type: "GET", path: "/api/lifeops/browser/packages" },
  { type: "POST", path: "/api/lifeops/browser/packages/open-path" },
  { type: "POST", path: "/api/lifeops/browser/companions/sync" },
  { type: "GET", path: "/api/lifeops/browser/tabs" },
  { type: "GET", path: "/api/lifeops/browser/current-page" },
  { type: "POST", path: "/api/lifeops/browser/sync" },
  { type: "POST", path: "/api/lifeops/browser/sessions" },
  { type: "POST", path: "/api/lifeops/schedule/observations" },
  { type: "GET", path: "/api/lifeops/schedule/merged-state" },
  { type: "GET", path: "/api/lifeops/overview" },
  { type: "GET", path: "/api/lifeops/seed-templates" },
  { type: "POST", path: "/api/lifeops/seed" },
  { type: "GET", path: "/api/lifeops/definitions" },
  { type: "POST", path: "/api/lifeops/definitions" },
  { type: "GET", path: "/api/lifeops/goals" },
  { type: "POST", path: "/api/lifeops/goals" },
];

// ---------------------------------------------------------------------------
// Dynamic LifeOps routes (param-based matches)
// ---------------------------------------------------------------------------

const LIFEOPS_DYNAMIC_ROUTES: Array<{ type: string; path: string }> = [
  // /api/lifeops/definitions/:id
  { type: "GET", path: "/api/lifeops/definitions/:id" },
  { type: "PUT", path: "/api/lifeops/definitions/:id" },
  { type: "DELETE", path: "/api/lifeops/definitions/:id" },
  // /api/lifeops/goals/:id
  { type: "GET", path: "/api/lifeops/goals/:id" },
  { type: "PUT", path: "/api/lifeops/goals/:id" },
  { type: "DELETE", path: "/api/lifeops/goals/:id" },
  // /api/lifeops/goals/:id/review
  { type: "GET", path: "/api/lifeops/goals/:id/review" },
  // /api/lifeops/workflows/:id
  { type: "GET", path: "/api/lifeops/workflows/:id" },
  { type: "PUT", path: "/api/lifeops/workflows/:id" },
  // /api/lifeops/workflows/:id/run
  { type: "POST", path: "/api/lifeops/workflows/:id/run" },
  // /api/lifeops/browser/sessions/:id
  { type: "GET", path: "/api/lifeops/browser/sessions/:id" },
  // /api/lifeops/browser/sessions/:id/confirm
  { type: "POST", path: "/api/lifeops/browser/sessions/:id/confirm" },
  // /api/lifeops/browser/sessions/:id/progress
  { type: "POST", path: "/api/lifeops/browser/sessions/:id/progress" },
  // /api/lifeops/browser/sessions/:id/complete
  { type: "POST", path: "/api/lifeops/browser/sessions/:id/complete" },
  // /api/lifeops/browser/companions/sessions/:id/progress
  {
    type: "POST",
    path: "/api/lifeops/browser/companions/sessions/:id/progress",
  },
  // /api/lifeops/browser/companions/sessions/:id/complete
  {
    type: "POST",
    path: "/api/lifeops/browser/companions/sessions/:id/complete",
  },
  // /api/lifeops/browser/packages/:browser/build
  { type: "POST", path: "/api/lifeops/browser/packages/:browser/build" },
  // /api/lifeops/browser/packages/:browser/open-manager
  { type: "POST", path: "/api/lifeops/browser/packages/:browser/open-manager" },
  // /api/lifeops/browser/packages/:browser/download
  { type: "GET", path: "/api/lifeops/browser/packages/:browser/download" },
  // /api/lifeops/occurrences/:id/explanation
  { type: "GET", path: "/api/lifeops/occurrences/:id/explanation" },
  // /api/lifeops/occurrences/:id/complete
  { type: "POST", path: "/api/lifeops/occurrences/:id/complete" },
  // /api/lifeops/occurrences/:id/skip
  { type: "POST", path: "/api/lifeops/occurrences/:id/skip" },
  // /api/lifeops/occurrences/:id/snooze
  { type: "POST", path: "/api/lifeops/occurrences/:id/snooze" },
  // /api/lifeops/website-access/callbacks/:key/resolve
  { type: "POST", path: "/api/lifeops/website-access/callbacks/:key/resolve" },
];

// ---------------------------------------------------------------------------
// Website-blocker routes
// ---------------------------------------------------------------------------

const WEBSITE_BLOCKER_ROUTES: Array<{ type: string; path: string }> = [
  { type: "GET", path: "/api/website-blocker" },
  { type: "GET", path: "/api/website-blocker/status" },
  { type: "POST", path: "/api/website-blocker" },
  { type: "PUT", path: "/api/website-blocker" },
  { type: "DELETE", path: "/api/website-blocker" },
];

// ---------------------------------------------------------------------------
// Build Plugin Route arrays
// ---------------------------------------------------------------------------

function lifeOpsRouteHandler(): Route["handler"] {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const ctx = buildLifeOpsContext(
      httpReq,
      httpRes,
      (runtime as AgentRuntime) ?? null,
    );
    await handleLifeOpsRoutes(ctx);
  };
}

function websiteBlockerRouteHandler(): Route["handler"] {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const ctx = buildWebsiteBlockerContext(
      httpReq,
      httpRes,
      (runtime as AgentRuntime) ?? null,
    );
    await handleWebsiteBlockerRoutes(ctx);
  };
}

const lifeOpsPluginRoutes: Route[] = [
  // Static LifeOps routes
  ...LIFEOPS_STATIC_ROUTES.map(
    (r) =>
      ({
        type: r.type as Route["type"],
        path: r.path,
        rawPath: true as const,
        ...(r.public ? ({ public: true } as const) : {}),
        handler: lifeOpsRouteHandler()!,
      }) as Route,
  ),
  // Dynamic LifeOps routes
  ...LIFEOPS_DYNAMIC_ROUTES.map(
    (r) =>
      ({
        type: r.type as Route["type"],
        path: r.path,
        rawPath: true as const,
        handler: lifeOpsRouteHandler()!,
      }) as Route,
  ),
  // Website blocker routes
  ...WEBSITE_BLOCKER_ROUTES.map(
    (r) =>
      ({
        type: r.type as Route["type"],
        path: r.path,
        rawPath: true as const,
        handler: websiteBlockerRouteHandler()!,
      }) as Route,
  ),
];

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const lifeopsPlugin: Plugin = {
  name: "@elizaos/app-lifeops-routes",
  description:
    "LifeOps dashboard, Google Workspace, browser companion, website blocker, and scheduling routes",
  routes: lifeOpsPluginRoutes,
};
