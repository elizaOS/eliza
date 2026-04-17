import fs from "node:fs";
import type http from "node:http";
import { type AgentRuntime, logger, type UUID } from "@elizaos/core";
import type {
  AcknowledgeLifeOpsReminderRequest,
  CaptureLifeOpsActivitySignalRequest,
  CaptureLifeOpsPhoneConsentRequest,
  CompleteLifeOpsBrowserSessionRequest,
  CompleteLifeOpsOccurrenceRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserCompanionPairingRequest,
  CreateLifeOpsBrowserSessionRequest,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGmailBatchReplyDraftsRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  CreateLifeOpsGoalRequest,
  CreateLifeOpsWorkflowRequest,
  CreateLifeOpsXPostRequest,
  DisconnectLifeOpsGoogleConnectorRequest,
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsGmailSearchRequest,
  GetLifeOpsGmailTriageRequest,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  ProcessLifeOpsRemindersRequest,
  RelockLifeOpsWebsiteAccessRequest,
  ResolveLifeOpsWebsiteAccessCallbackRequest,
  RunLifeOpsWorkflowRequest,
  SelectLifeOpsGoogleConnectorPreferenceRequest,
  SendLifeOpsGmailBatchReplyRequest,
  SendLifeOpsGmailMessageRequest,
  SendLifeOpsGmailReplyRequest,
  SetLifeOpsReminderPreferenceRequest,
  SnoozeLifeOpsOccurrenceRequest,
  StartLifeOpsGoogleConnectorRequest,
  SyncLifeOpsBrowserStateRequest,
  UpdateLifeOpsBrowserSessionProgressRequest,
  UpdateLifeOpsBrowserSettingsRequest,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGoalRequest,
  UpdateLifeOpsWorkflowRequest,
  UpsertLifeOpsChannelPolicyRequest,
  UpsertLifeOpsXConnectorRequest,
  StartLifeOpsTelegramAuthRequest,
  SubmitLifeOpsTelegramAuthRequest,
} from "@elizaos/shared/contracts/lifeops";
import { LIFEOPS_ACTIVITY_SIGNAL_STATES } from "@elizaos/shared/contracts/lifeops";
import { createIntegrationTelemetrySpan } from "@elizaos/agent/diagnostics/integration-observability";
import {
  loadLifeOpsAppState,
  saveLifeOpsAppState,
} from "../lifeops/app-state.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";

import type { ReadJsonBodyOptions } from "@elizaos/agent/api/http-helpers";
import {
  buildLifeOpsBrowserCompanionPackage,
  getLifeOpsBrowserCompanionDownloadFile,
  getLifeOpsBrowserCompanionPackageStatus,
} from "./lifeops-browser-packaging.js";
import { checkRateLimit, type RateLimitConfig } from "@elizaos/agent/api/rate-limiter";

export interface LifeOpsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: {
    runtime: AgentRuntime | null;
    adminEntityId: UUID | null;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  decodePathComponent: (
    raw: string,
    res: http.ServerResponse,
    label: string,
  ) => string | null;
}

function getService(ctx: LifeOpsRouteContext): LifeOpsService | null {
  if (!ctx.state.runtime) {
    ctx.error(ctx.res, "Agent runtime is not available", 503);
    return null;
  }
  return new LifeOpsService(ctx.state.runtime, {
    ownerEntityId: ctx.state.adminEntityId,
  });
}

function getBrowserCompanionAuth(
  ctx: LifeOpsRouteContext,
): { companionId: string; pairingToken: string } | null {
  const companionHeader = ctx.req.headers["x-eliza-browser-companion-id"];
  const companionId =
    typeof companionHeader === "string" ? companionHeader.trim() : "";
  if (!companionId) {
    ctx.error(ctx.res, "Missing X-Eliza-Browser-Companion-Id header", 401);
    return null;
  }
  const authHeader =
    typeof ctx.req.headers.authorization === "string"
      ? ctx.req.headers.authorization.trim()
      : "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const pairingToken = match?.[1]?.trim() ?? "";
  if (!pairingToken) {
    ctx.error(ctx.res, "Missing browser companion bearer token", 401);
    return null;
  }
  return {
    companionId,
    pairingToken,
  };
}

// ---------------------------------------------------------------------------
// Rate limit configuration per operation.
// Keys are logical operation names; the "default" entry applies to any
// operation not explicitly listed.
// ---------------------------------------------------------------------------
const LIFEOPS_RATE_LIMITS: Record<string, RateLimitConfig> = {
  google_api_read: { maxRequests: 120, windowMs: 60_000 },
  google_api_write: { maxRequests: 30, windowMs: 60_000 },
  reminders_process: { maxRequests: 10, windowMs: 60_000 },
  task_create: { maxRequests: 30, windowMs: 60_000 },
  task_update: { maxRequests: 30, windowMs: 60_000 },
  gmail_draft: { maxRequests: 20, windowMs: 60_000 },
  gmail_send: { maxRequests: 5, windowMs: 60_000 },
  calendar_create: { maxRequests: 20, windowMs: 60_000 },
  default: { maxRequests: 60, windowMs: 60_000 },
};

/**
 * Check rate limit for a LifeOps operation. If the limit is exceeded,
 * sends a 429 response with Retry-After header and returns `true`.
 * Returns `false` when the request is allowed to proceed.
 */
function rateLimitRequest(
  ctx: LifeOpsRouteContext,
  operation: string,
): boolean {
  const agentId = String(ctx.state.runtime?.agentId ?? "unknown");
  const limitKey = `${agentId}:${operation}`;
  const config = LIFEOPS_RATE_LIMITS[operation] ?? LIFEOPS_RATE_LIMITS.default;
  const { allowed, retryAfterMs } = checkRateLimit(limitKey, config);
  if (!allowed) {
    ctx.res.writeHead(429, {
      "Retry-After": String(Math.ceil(retryAfterMs / 1_000)),
    });
    ctx.res.end(JSON.stringify({ error: "Rate limit exceeded", retryAfterMs }));
    return true;
  }
  return false;
}

function routeOperation(ctx: LifeOpsRouteContext): string {
  return `${ctx.method.toUpperCase()} ${ctx.pathname}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveIntegerQuery(
  value: string | null,
  field: string,
): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new LifeOpsServiceError(400, `${field} must be a positive integer`);
  }
  return parsed;
}

function parseActivitySignalStates(
  url: URL,
): Array<(typeof LIFEOPS_ACTIVITY_SIGNAL_STATES)[number]> | null {
  const rawValues = [
    ...url.searchParams.getAll("state"),
    ...url.searchParams.getAll("states").flatMap((value) => value.split(",")),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (rawValues.length === 0) {
    return null;
  }
  const invalid = rawValues.find(
    (value) =>
      !LIFEOPS_ACTIVITY_SIGNAL_STATES.includes(
        value as (typeof LIFEOPS_ACTIVITY_SIGNAL_STATES)[number],
      ),
  );
  if (invalid) {
    throw new LifeOpsServiceError(
      400,
      `state must be one of: ${LIFEOPS_ACTIVITY_SIGNAL_STATES.join(", ")}`,
    );
  }
  return rawValues as Array<(typeof LIFEOPS_ACTIVITY_SIGNAL_STATES)[number]>;
}

async function runRoute(
  ctx: LifeOpsRouteContext,
  fn: (service: LifeOpsService) => Promise<void>,
): Promise<boolean> {
  const operation = routeOperation(ctx);
  const span = createIntegrationTelemetrySpan({
    boundary: "lifeops",
    operation,
  });
  const service = getService(ctx);
  if (!service) {
    logger.info(
      {
        boundary: "lifeops",
        operation,
        statusCode: 503,
      },
      "[lifeops] Route rejected because agent runtime is unavailable",
    );
    span.failure({
      statusCode: 503,
      errorKind: "runtime_unavailable",
    });
    return true;
  }
  try {
    await fn(service);
    span.success({
      statusCode: ctx.res.statusCode >= 400 ? ctx.res.statusCode : 200,
    });
    return true;
  } catch (error) {
    if (error instanceof LifeOpsServiceError) {
      const logFn =
        error.status === 401
          ? logger.debug.bind(logger)
          : logger.warn.bind(logger);
      logFn(
        {
          boundary: "lifeops",
          operation,
          statusCode: error.status,
        },
        `[lifeops] Route failed: ${error.message}`,
      );
      span.failure({
        statusCode: error.status,
        error,
        errorKind:
          error.status === 401
            ? "lifeops_auth_invalid"
            : "lifeops_service_error",
      });
      ctx.error(ctx.res, error.message, error.status);
      return true;
    }
    logger.error(
      {
        boundary: "lifeops",
        operation,
      },
      `[lifeops] Route crashed: ${errorMessage(error)}`,
    );
    span.failure({
      error,
      errorKind: "unhandled_error",
    });
    throw error;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function serializeInlineScriptValue(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function writeHtml(
  res: http.ServerResponse,
  status: number,
  title: string,
  message: string,
  refreshDetail?: {
    side?: LifeOpsConnectorSide;
    mode?: LifeOpsConnectorMode;
  },
): void {
  const refreshScript = refreshDetail
    ? `
    <script>
      (() => {
        const payload = ${serializeInlineScriptValue({
          type: "lifeops-google-connector-refresh",
          detail: {
            ...refreshDetail,
            source: "callback",
          },
        })};
        if (window.opener && typeof window.opener.postMessage === "function") {
          window.opener.postMessage(payload, "*");
        }
        if (typeof BroadcastChannel === "function") {
          const channel = new BroadcastChannel("eliza:lifeops:google-connector");
          channel.postMessage(payload);
          channel.close();
        }
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(
            "eliza:lifeops:google-connector-refresh",
            JSON.stringify({
              ...payload,
              at: Date.now(),
            }),
          );
          localStorage.removeItem("eliza:lifeops:google-connector-refresh");
        }
      })();
    </script>`
    : "";
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f5f1e8;
        color: #18120d;
        font-family: "IBM Plex Sans", "Helvetica Neue", sans-serif;
      }
      main {
        width: min(32rem, calc(100vw - 2rem));
        padding: 2rem;
        border: 1px solid rgba(24, 18, 13, 0.12);
        border-radius: 1.25rem;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 24px 80px rgba(24, 18, 13, 0.08);
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.25rem;
      }
      p {
        margin: 0;
        line-height: 1.5;
        color: rgba(24, 18, 13, 0.78);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
    ${refreshScript}
    <script>
      window.setTimeout(() => {
        try {
          window.close();
        } catch {}
      }, 250);
    </script>
  </body>
</html>`);
}

export async function handleLifeOpsRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    url,
    json,
    readJsonBody,
    decodePathComponent,
  } = ctx;

  if (method === "GET" && pathname === "/api/lifeops/app-state") {
    if (!ctx.state.runtime) {
      ctx.error(res, "Agent runtime is not available", 503);
      return true;
    }
    json(res, await loadLifeOpsAppState(ctx.state.runtime));
    return true;
  }

  if (method === "PUT" && pathname === "/api/lifeops/app-state") {
    if (!ctx.state.runtime) {
      ctx.error(res, "Agent runtime is not available", 503);
      return true;
    }
    const body = await readJsonBody<{ enabled?: unknown }>(req, res);
    if (!body) {
      return true;
    }
    if (typeof body.enabled !== "boolean") {
      ctx.error(res, "enabled must be a boolean", 400);
      return true;
    }
    json(
      res,
      await saveLifeOpsAppState(ctx.state.runtime, {
        enabled: body.enabled,
      }),
    );
    return true;
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/google/status"
  ) {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const rawMode = url.searchParams.get("mode");
      const rawSide = url.searchParams.get("side");
      if (
        rawMode !== null &&
        rawMode !== "local" &&
        rawMode !== "remote" &&
        rawMode !== "cloud_managed"
      ) {
        throw new LifeOpsServiceError(
          400,
          "mode must be one of: local, remote, cloud_managed",
        );
      }
      if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
        throw new LifeOpsServiceError(400, "side must be one of: owner, agent");
      }
      const rawGrantId = url.searchParams.get("grantId");
      json(
        res,
        await service.getGoogleConnectorStatus(
          url,
          (rawMode ?? undefined) as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          (rawSide ?? undefined) as "owner" | "agent" | undefined,
          rawGrantId ?? undefined,
        ),
      );
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/google/accounts"
  ) {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const rawSide = url.searchParams.get("side");
      if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
        throw new LifeOpsServiceError(400, "side must be one of: owner, agent");
      }
      json(
        res,
        await service.getGoogleConnectorAccounts(
          url,
          (rawSide ?? undefined) as "owner" | "agent" | undefined,
        ),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/calendar/feed") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const rawMode = url.searchParams.get("mode");
      const rawSide = url.searchParams.get("side");
      const rawForceSync = url.searchParams.get("forceSync");
      if (
        rawMode !== null &&
        rawMode !== "local" &&
        rawMode !== "remote" &&
        rawMode !== "cloud_managed"
      ) {
        throw new LifeOpsServiceError(
          400,
          "mode must be one of: local, remote, cloud_managed",
        );
      }
      if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
        throw new LifeOpsServiceError(400, "side must be one of: owner, agent");
      }
      if (
        rawForceSync !== null &&
        rawForceSync !== "true" &&
        rawForceSync !== "false" &&
        rawForceSync !== "1" &&
        rawForceSync !== "0"
      ) {
        throw new LifeOpsServiceError(400, "forceSync must be a boolean");
      }
      const request: GetLifeOpsCalendarFeedRequest = {
        mode: (rawMode ?? undefined) as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined,
        side: (rawSide ?? undefined) as "owner" | "agent" | undefined,
        calendarId: url.searchParams.get("calendarId") ?? undefined,
        timeMin: url.searchParams.get("timeMin") ?? undefined,
        timeMax: url.searchParams.get("timeMax") ?? undefined,
        timeZone: url.searchParams.get("timeZone") ?? undefined,
        forceSync:
          rawForceSync === null
            ? undefined
            : rawForceSync === "true" || rawForceSync === "1",
        grantId: url.searchParams.get("grantId") ?? undefined,
      };
      json(res, await service.getCalendarFeed(url, request));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/calendar/next-context") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const rawMode = url.searchParams.get("mode");
      const rawSide = url.searchParams.get("side");
      if (
        rawMode !== null &&
        rawMode !== "local" &&
        rawMode !== "remote" &&
        rawMode !== "cloud_managed"
      ) {
        throw new LifeOpsServiceError(
          400,
          "mode must be one of: local, remote, cloud_managed",
        );
      }
      if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
        throw new LifeOpsServiceError(400, "side must be one of: owner, agent");
      }
      const request: GetLifeOpsCalendarFeedRequest = {
        mode: (rawMode ?? undefined) as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined,
        side: (rawSide ?? undefined) as "owner" | "agent" | undefined,
        calendarId: url.searchParams.get("calendarId") ?? undefined,
        timeMin: url.searchParams.get("timeMin") ?? undefined,
        timeMax: url.searchParams.get("timeMax") ?? undefined,
        timeZone: url.searchParams.get("timeZone") ?? undefined,
      };
      json(res, await service.getNextCalendarEventContext(url, request));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/gmail/triage") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const rawMode = url.searchParams.get("mode");
      const rawSide = url.searchParams.get("side");
      const rawForceSync = url.searchParams.get("forceSync");
      if (
        rawMode !== null &&
        rawMode !== "local" &&
        rawMode !== "remote" &&
        rawMode !== "cloud_managed"
      ) {
        throw new LifeOpsServiceError(
          400,
          "mode must be one of: local, remote, cloud_managed",
        );
      }
      if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
        throw new LifeOpsServiceError(400, "side must be one of: owner, agent");
      }
      if (
        rawForceSync !== null &&
        rawForceSync !== "true" &&
        rawForceSync !== "false" &&
        rawForceSync !== "1" &&
        rawForceSync !== "0"
      ) {
        throw new LifeOpsServiceError(400, "forceSync must be a boolean");
      }
      const request: GetLifeOpsGmailTriageRequest = {
        mode: (rawMode ?? undefined) as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined,
        side: (rawSide ?? undefined) as "owner" | "agent" | undefined,
        forceSync:
          rawForceSync === null
            ? undefined
            : rawForceSync === "true" || rawForceSync === "1",
        maxResults:
          url.searchParams.get("maxResults") === null
            ? undefined
            : Number(url.searchParams.get("maxResults")),
        grantId: url.searchParams.get("grantId") ?? undefined,
      };
      json(res, await service.getGmailTriage(url, request));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/gmail/search") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const rawMode = url.searchParams.get("mode");
      const rawSide = url.searchParams.get("side");
      const rawForceSync = url.searchParams.get("forceSync");
      const query = url.searchParams.get("query");
      const rawReplyNeededOnly = url.searchParams.get("replyNeededOnly");
      if (
        rawMode !== null &&
        rawMode !== "local" &&
        rawMode !== "remote" &&
        rawMode !== "cloud_managed"
      ) {
        throw new LifeOpsServiceError(
          400,
          "mode must be one of: local, remote, cloud_managed",
        );
      }
      if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
        throw new LifeOpsServiceError(400, "side must be one of: owner, agent");
      }
      if (
        rawForceSync !== null &&
        rawForceSync !== "true" &&
        rawForceSync !== "false" &&
        rawForceSync !== "1" &&
        rawForceSync !== "0"
      ) {
        throw new LifeOpsServiceError(400, "forceSync must be a boolean");
      }
      if (
        rawReplyNeededOnly !== null &&
        rawReplyNeededOnly !== "true" &&
        rawReplyNeededOnly !== "false" &&
        rawReplyNeededOnly !== "1" &&
        rawReplyNeededOnly !== "0"
      ) {
        throw new LifeOpsServiceError(400, "replyNeededOnly must be a boolean");
      }
      const request: GetLifeOpsGmailSearchRequest = {
        mode: (rawMode ?? undefined) as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined,
        side: (rawSide ?? undefined) as "owner" | "agent" | undefined,
        forceSync:
          rawForceSync === null
            ? undefined
            : rawForceSync === "true" || rawForceSync === "1",
        maxResults:
          url.searchParams.get("maxResults") === null
            ? undefined
            : Number(url.searchParams.get("maxResults")),
        query: query ?? "",
        replyNeededOnly:
          rawReplyNeededOnly === null
            ? undefined
            : rawReplyNeededOnly === "true" || rawReplyNeededOnly === "1",
        grantId: url.searchParams.get("grantId") ?? undefined,
      };
      json(res, await service.getGmailSearch(url, request));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/gmail/needs-response") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const rawMode = url.searchParams.get("mode");
      const rawSide = url.searchParams.get("side");
      const rawForceSync = url.searchParams.get("forceSync");
      if (
        rawMode !== null &&
        rawMode !== "local" &&
        rawMode !== "remote" &&
        rawMode !== "cloud_managed"
      ) {
        throw new LifeOpsServiceError(
          400,
          "mode must be one of: local, remote, cloud_managed",
        );
      }
      if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
        throw new LifeOpsServiceError(400, "side must be one of: owner, agent");
      }
      if (
        rawForceSync !== null &&
        rawForceSync !== "true" &&
        rawForceSync !== "false" &&
        rawForceSync !== "1" &&
        rawForceSync !== "0"
      ) {
        throw new LifeOpsServiceError(400, "forceSync must be a boolean");
      }
      const request: GetLifeOpsGmailTriageRequest = {
        mode: (rawMode ?? undefined) as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined,
        side: (rawSide ?? undefined) as "owner" | "agent" | undefined,
        forceSync:
          rawForceSync === null
            ? undefined
            : rawForceSync === "true" || rawForceSync === "1",
        maxResults:
          url.searchParams.get("maxResults") === null
            ? undefined
            : Number(url.searchParams.get("maxResults")),
        grantId: url.searchParams.get("grantId") ?? undefined,
      };
      json(res, await service.getGmailNeedsResponse(url, request));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/calendar/events") {
    if (rateLimitRequest(ctx, "calendar_create")) return true;
    const body = await readJsonBody<CreateLifeOpsCalendarEventRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, { event: await service.createCalendarEvent(url, body) }, 201);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/reply-drafts") {
    if (rateLimitRequest(ctx, "gmail_draft")) return true;
    const body = await readJsonBody<CreateLifeOpsGmailReplyDraftRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, { draft: await service.createGmailReplyDraft(url, body) }, 201);
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/gmail/batch-reply-drafts"
  ) {
    if (rateLimitRequest(ctx, "gmail_draft")) return true;
    const body = await readJsonBody<CreateLifeOpsGmailBatchReplyDraftsRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        { batch: await service.createGmailBatchReplyDrafts(url, body) },
        201,
      );
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/reply-send") {
    if (rateLimitRequest(ctx, "gmail_send")) return true;
    const body = await readJsonBody<SendLifeOpsGmailReplyRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.sendGmailReply(url, body));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/message-send") {
    if (rateLimitRequest(ctx, "gmail_send")) return true;
    const body = await readJsonBody<SendLifeOpsGmailMessageRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.sendGmailMessage(url, body));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/batch-reply-send") {
    if (rateLimitRequest(ctx, "gmail_send")) return true;
    const body = await readJsonBody<SendLifeOpsGmailBatchReplyRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.sendGmailReplies(url, body));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/google/start"
  ) {
    if (rateLimitRequest(ctx, "google_api_write")) return true;
    const body = await readJsonBody<StartLifeOpsGoogleConnectorRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.startGoogleConnector(body, url));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/google/preference"
  ) {
    if (rateLimitRequest(ctx, "google_api_write")) return true;
    const body =
      await readJsonBody<SelectLifeOpsGoogleConnectorPreferenceRequest>(
        req,
        res,
      );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.selectGoogleConnectorMode(url, body.mode, body.side),
      );
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/google/callback"
  ) {
    const service = getService(ctx);
    if (!service) return true;
    try {
      const connectorStatus =
        await service.completeGoogleConnectorCallback(url);
      writeHtml(
        res,
        200,
        "Google Connected",
        "Google access is now available in Eliza. You can close this window.",
        {
          side: connectorStatus.side,
          mode: connectorStatus.mode,
        },
      );
      return true;
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        writeHtml(res, error.status, "Google Connection Failed", error.message);
        return true;
      }
      throw error;
    }
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/google/success"
  ) {
    const rawSide = url.searchParams.get("side");
    const rawMode = url.searchParams.get("mode");
    if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
      ctx.error(res, "side must be one of: owner, agent", 400);
      return true;
    }
    if (
      rawMode !== null &&
      rawMode !== "local" &&
      rawMode !== "remote" &&
      rawMode !== "cloud_managed"
    ) {
      ctx.error(res, "mode must be one of: local, remote, cloud_managed", 400);
      return true;
    }
    writeHtml(
      res,
      200,
      "Google Connected",
      "Google access is now available in Eliza. You can close this window.",
      {
        side: (rawSide ?? "owner") as LifeOpsConnectorSide,
        mode: (rawMode ?? "cloud_managed") as LifeOpsConnectorMode,
      },
    );
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/google/disconnect"
  ) {
    if (rateLimitRequest(ctx, "google_api_write")) return true;
    const body = await readJsonBody<
      DisconnectLifeOpsGoogleConnectorRequest & { grantId?: string }
    >(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.disconnectGoogleConnector(body, url),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/connectors/x/status") {
    return runRoute(ctx, async (service) => {
      const rawMode = url.searchParams.get("mode");
      if (rawMode !== null && rawMode !== "local" && rawMode !== "remote") {
        throw new LifeOpsServiceError(
          400,
          "mode must be one of: local, remote",
        );
      }
      json(
        res,
        await service.getXConnectorStatus(
          (rawMode ?? undefined) as "local" | "remote" | undefined,
        ),
      );
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/connectors/x") {
    const body = await readJsonBody<UpsertLifeOpsXConnectorRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.upsertXConnector(body), 201);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/x/posts") {
    const body = await readJsonBody<CreateLifeOpsXPostRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.createXPost(body), 201);
    });
  }

  // -----------------------------------------------------------------------
  // Telegram connector
  // -----------------------------------------------------------------------

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/telegram/status"
  ) {
    const rawSide = url.searchParams.get("side") as LifeOpsConnectorSide | null;
    return runRoute(ctx, async (service) => {
      json(res, await service.getTelegramConnectorStatus(rawSide ?? undefined));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/telegram/start"
  ) {
    const body = await readJsonBody<StartLifeOpsTelegramAuthRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.startTelegramAuth(body), 201);
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/telegram/submit"
  ) {
    const body = await readJsonBody<SubmitLifeOpsTelegramAuthRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.submitTelegramAuth(body));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/telegram/cancel"
  ) {
    const rawSide = url.searchParams.get("side") as LifeOpsConnectorSide | null;
    return runRoute(ctx, async (service) => {
      const side = rawSide ?? "owner";
      const pending = await service.getTelegramConnectorStatus(side);
      if (pending.authState !== "idle" && pending.authState !== "connected") {
        json(res, await service.disconnectTelegram(side));
      } else {
        json(res, pending);
      }
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/telegram/disconnect"
  ) {
    const rawSide = url.searchParams.get("side") as LifeOpsConnectorSide | null;
    return runRoute(ctx, async (service) => {
      json(res, await service.disconnectTelegram(rawSide ?? undefined));
    });
  }

  // -----------------------------------------------------------------------
  // Signal connector
  // -----------------------------------------------------------------------

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/signal/status"
  ) {
    const rawSide = url.searchParams.get("side") as LifeOpsConnectorSide | null;
    return runRoute(ctx, async (service) => {
      json(res, await service.getSignalConnectorStatus(rawSide ?? undefined));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/signal/pair"
  ) {
    const rawSide = url.searchParams.get("side") as LifeOpsConnectorSide | null;
    return runRoute(ctx, async (service) => {
      json(res, await service.startSignalPairing(rawSide ?? undefined), 201);
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/signal/pairing-status"
  ) {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      throw new LifeOpsServiceError(400, "sessionId is required");
    }
    return runRoute(ctx, async (service) => {
      json(res, await service.getSignalPairingStatus(sessionId));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/signal/stop"
  ) {
    const rawSide = url.searchParams.get("side") as LifeOpsConnectorSide | null;
    return runRoute(ctx, async (service) => {
      json(res, service.stopSignalPairing(rawSide ?? undefined));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/signal/disconnect"
  ) {
    const rawSide = url.searchParams.get("side") as LifeOpsConnectorSide | null;
    return runRoute(ctx, async (service) => {
      json(res, await service.disconnectSignal(rawSide ?? undefined));
    });
  }

  // -----------------------------------------------------------------------
  // Discord connector
  // -----------------------------------------------------------------------

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/discord/status"
  ) {
    const rawSide = url.searchParams.get("side") as LifeOpsConnectorSide | null;
    return runRoute(ctx, async (service) => {
      json(res, await service.getDiscordConnectorStatus(rawSide ?? undefined));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/discord/connect"
  ) {
    const rawSide = url.searchParams.get("side") as LifeOpsConnectorSide | null;
    return runRoute(ctx, async (service) => {
      json(res, await service.authorizeDiscordConnector(rawSide ?? undefined));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/discord/disconnect"
  ) {
    const rawSide = url.searchParams.get("side") as LifeOpsConnectorSide | null;
    return runRoute(ctx, async (service) => {
      json(res, await service.disconnectDiscord(rawSide ?? undefined));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/channel-policies") {
    return runRoute(ctx, async (service) => {
      json(res, { policies: await service.listChannelPolicies() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/channel-policies") {
    const body = await readJsonBody<UpsertLifeOpsChannelPolicyRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, { policy: await service.upsertChannelPolicy(body) }, 201);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/channels/phone-consent") {
    const body = await readJsonBody<CaptureLifeOpsPhoneConsentRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.capturePhoneConsent(body), 201);
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/activity-signals") {
    return runRoute(ctx, async (service) => {
      json(res, {
        signals: await service.listActivitySignals({
          sinceAt: url.searchParams.get("sinceAt"),
          limit: parsePositiveIntegerQuery(
            url.searchParams.get("limit"),
            "limit",
          ),
          states: parseActivitySignalStates(url),
        }),
      });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/activity-signals") {
    const body = await readJsonBody<CaptureLifeOpsActivitySignalRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, { signal: await service.captureActivitySignal(body) }, 201);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/reminders/process") {
    if (rateLimitRequest(ctx, "reminders_process")) return true;
    const body = await readJsonBody<ProcessLifeOpsRemindersRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.processReminders(body));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/reminder-preferences") {
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.getReminderPreference(
          url.searchParams.get("definitionId") ?? undefined,
        ),
      );
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/reminder-preferences") {
    const body = await readJsonBody<SetLifeOpsReminderPreferenceRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.setReminderPreference(body), 201);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/reminders/acknowledge") {
    const body = await readJsonBody<AcknowledgeLifeOpsReminderRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.acknowledgeReminder(body));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/website-access/relock") {
    const body = await readJsonBody<RelockLifeOpsWebsiteAccessRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.relockWebsiteAccessGroup(body.groupKey));
    });
  }

  const websiteAccessCallbackMatch = pathname.match(
    /^\/api\/lifeops\/website-access\/callbacks\/([^/]+)\/resolve$/,
  );
  if (method === "POST" && websiteAccessCallbackMatch) {
    const callbackKey = decodePathComponent(
      websiteAccessCallbackMatch[1],
      res,
      "website access callback key",
    );
    if (!callbackKey) return true;
    const body = await readJsonBody<ResolveLifeOpsWebsiteAccessCallbackRequest>(
      req,
      res,
    );
    if (body === null) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.resolveWebsiteAccessCallback(
          body.callbackKey || callbackKey,
        ),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/reminders/inspection") {
    return runRoute(ctx, async (service) => {
      const ownerType = url.searchParams.get("ownerType");
      const ownerId = url.searchParams.get("ownerId");
      if (ownerType !== "occurrence" && ownerType !== "calendar_event") {
        throw new LifeOpsServiceError(
          400,
          "ownerType must be occurrence or calendar_event",
        );
      }
      if (!ownerId) {
        throw new LifeOpsServiceError(400, "ownerId is required");
      }
      json(res, await service.inspectReminder(ownerType, ownerId));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/workflows") {
    return runRoute(ctx, async (service) => {
      json(res, { workflows: await service.listWorkflows() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/workflows") {
    const body = await readJsonBody<CreateLifeOpsWorkflowRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.createWorkflow(body), 201);
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/browser/sessions") {
    return runRoute(ctx, async (service) => {
      json(res, { sessions: await service.listBrowserSessions() });
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/browser/settings") {
    return runRoute(ctx, async (service) => {
      json(res, { settings: await service.getBrowserSettings() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/browser/settings") {
    const body = await readJsonBody<UpdateLifeOpsBrowserSettingsRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, { settings: await service.updateBrowserSettings(body) });
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/browser/companions/pair"
  ) {
    const body =
      await readJsonBody<CreateLifeOpsBrowserCompanionPairingRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.createBrowserCompanionPairing(body), 201);
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/browser/companions") {
    return runRoute(ctx, async (service) => {
      json(res, { companions: await service.listBrowserCompanions() });
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/browser/packages") {
    return runRoute(ctx, async () => {
      json(res, { status: getLifeOpsBrowserCompanionPackageStatus() });
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/browser/companions/sync"
  ) {
    const body = await readJsonBody<SyncLifeOpsBrowserStateRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      const auth = getBrowserCompanionAuth(ctx);
      if (!auth) {
        return;
      }
      json(
        res,
        await service.syncBrowserCompanion(
          auth.companionId,
          auth.pairingToken,
          body,
        ),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/browser/tabs") {
    return runRoute(ctx, async (service) => {
      json(res, { tabs: await service.listBrowserTabs() });
    });
  }

  const browserPackageBuildMatch = pathname.match(
    /^\/api\/lifeops\/browser\/packages\/([^/]+)\/build$/,
  );
  if (method === "POST" && browserPackageBuildMatch) {
    const browser = decodePathComponent(
      browserPackageBuildMatch[1],
      res,
      "browser package target",
    );
    if (!browser) return true;
    if (browser !== "chrome" && browser !== "safari") {
      ctx.error(res, "browser must be chrome or safari", 400);
      return true;
    }
    return runRoute(ctx, async () => {
      json(res, {
        status: await buildLifeOpsBrowserCompanionPackage(browser),
      });
    });
  }

  const browserPackageDownloadMatch = pathname.match(
    /^\/api\/lifeops\/browser\/packages\/([^/]+)\/download$/,
  );
  if (method === "GET" && browserPackageDownloadMatch) {
    const browser = decodePathComponent(
      browserPackageDownloadMatch[1],
      res,
      "browser package target",
    );
    if (!browser) return true;
    if (browser !== "chrome" && browser !== "safari") {
      ctx.error(res, "browser must be chrome or safari", 400);
      return true;
    }
    return runRoute(ctx, async () => {
      const artifact = getLifeOpsBrowserCompanionDownloadFile(browser);
      res.statusCode = 200;
      res.setHeader("Content-Type", artifact.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${artifact.filename}"`,
      );
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(artifact.path);
        stream.on("error", reject);
        res.on("error", reject);
        stream.on("end", resolve);
        stream.pipe(res);
      });
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/browser/current-page") {
    return runRoute(ctx, async (service) => {
      json(res, { page: await service.getCurrentBrowserPage() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/browser/sync") {
    const body = await readJsonBody<SyncLifeOpsBrowserStateRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.syncBrowserState(body));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/browser/sessions") {
    const body = await readJsonBody<CreateLifeOpsBrowserSessionRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, { session: await service.createBrowserSession(body) }, 201);
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/overview") {
    return runRoute(ctx, async (service) => {
      json(res, await service.getOverview());
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/seed-templates") {
    return runRoute(ctx, async (service) => {
      json(res, await service.checkAndOfferSeeding());
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/seed") {
    const body = await readJsonBody<{ keys: string[]; timezone?: string }>(
      req,
      res,
    );
    if (!body) return true;
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      ctx.error(
        res,
        "keys must be a non-empty array of seed template keys",
        400,
      );
      return true;
    }
    return runRoute(ctx, async (service) => {
      const ids = await service.applySeedRoutines(body.keys, body.timezone);
      json(res, { createdIds: ids }, 201);
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/definitions") {
    return runRoute(ctx, async (service) => {
      json(res, { definitions: await service.listDefinitions() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/definitions") {
    if (rateLimitRequest(ctx, "task_create")) return true;
    const body = await readJsonBody<CreateLifeOpsDefinitionRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.createDefinition(body), 201);
    });
  }

  const definitionMatch = pathname.match(
    /^\/api\/lifeops\/definitions\/([^/]+)$/,
  );
  if (definitionMatch) {
    const definitionId = decodePathComponent(
      definitionMatch[1],
      res,
      "definition id",
    );
    if (!definitionId) return true;
    if (method === "GET") {
      return runRoute(ctx, async (service) => {
        json(res, await service.getDefinition(definitionId));
      });
    }
    if (method === "PUT") {
      if (rateLimitRequest(ctx, "task_update")) return true;
      const body = await readJsonBody<UpdateLifeOpsDefinitionRequest>(req, res);
      if (!body) return true;
      return runRoute(ctx, async (service) => {
        json(res, await service.updateDefinition(definitionId, body));
      });
    }
    if (method === "DELETE") {
      return runRoute(ctx, async (service) => {
        await service.deleteDefinition(definitionId);
        json(res, { deleted: true });
      });
    }
  }

  if (method === "GET" && pathname === "/api/lifeops/goals") {
    return runRoute(ctx, async (service) => {
      json(res, { goals: await service.listGoals() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/goals") {
    if (rateLimitRequest(ctx, "task_create")) return true;
    const body = await readJsonBody<CreateLifeOpsGoalRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.createGoal(body), 201);
    });
  }

  const goalMatch = pathname.match(/^\/api\/lifeops\/goals\/([^/]+)$/);
  if (goalMatch) {
    const goalId = decodePathComponent(goalMatch[1], res, "goal id");
    if (!goalId) return true;
    if (method === "GET") {
      return runRoute(ctx, async (service) => {
        json(res, await service.getGoal(goalId));
      });
    }
    if (method === "PUT") {
      if (rateLimitRequest(ctx, "task_update")) return true;
      const body = await readJsonBody<UpdateLifeOpsGoalRequest>(req, res);
      if (!body) return true;
      return runRoute(ctx, async (service) => {
        json(res, await service.updateGoal(goalId, body));
      });
    }
    if (method === "DELETE") {
      return runRoute(ctx, async (service) => {
        await service.deleteGoal(goalId);
        json(res, { deleted: true });
      });
    }
  }

  const goalReviewMatch = pathname.match(
    /^\/api\/lifeops\/goals\/([^/]+)\/review$/,
  );
  if (goalReviewMatch && method === "GET") {
    const goalId = decodePathComponent(goalReviewMatch[1], res, "goal id");
    if (!goalId) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.reviewGoal(goalId));
    });
  }

  const workflowMatch = pathname.match(/^\/api\/lifeops\/workflows\/([^/]+)$/);
  if (workflowMatch) {
    const workflowId = decodePathComponent(
      workflowMatch[1],
      res,
      "workflow id",
    );
    if (!workflowId) return true;
    if (method === "GET") {
      return runRoute(ctx, async (service) => {
        json(res, await service.getWorkflow(workflowId));
      });
    }
    if (method === "PUT") {
      const body = await readJsonBody<UpdateLifeOpsWorkflowRequest>(req, res);
      if (!body) return true;
      return runRoute(ctx, async (service) => {
        json(res, await service.updateWorkflow(workflowId, body));
      });
    }
  }

  const workflowRunMatch = pathname.match(
    /^\/api\/lifeops\/workflows\/([^/]+)\/run$/,
  );
  if (method === "POST" && workflowRunMatch) {
    const workflowId = decodePathComponent(
      workflowRunMatch[1],
      res,
      "workflow id",
    );
    if (!workflowId) return true;
    const body = await readJsonBody<RunLifeOpsWorkflowRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, { run: await service.runWorkflow(workflowId, body) }, 201);
    });
  }

  const browserSessionMatch = pathname.match(
    /^\/api\/lifeops\/browser\/sessions\/([^/]+)$/,
  );
  if (browserSessionMatch) {
    const sessionId = decodePathComponent(
      browserSessionMatch[1],
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    if (method === "GET") {
      return runRoute(ctx, async (service) => {
        json(res, { session: await service.getBrowserSession(sessionId) });
      });
    }
  }

  const browserConfirmMatch = pathname.match(
    /^\/api\/lifeops\/browser\/sessions\/([^/]+)\/confirm$/,
  );
  if (method === "POST" && browserConfirmMatch) {
    const sessionId = decodePathComponent(
      browserConfirmMatch[1],
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    const body = await readJsonBody<ConfirmLifeOpsBrowserSessionRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        session: await service.confirmBrowserSession(sessionId, body),
      });
    });
  }

  const browserCompleteMatch = pathname.match(
    /^\/api\/lifeops\/browser\/sessions\/([^/]+)\/complete$/,
  );
  if (method === "POST" && browserCompleteMatch) {
    const sessionId = decodePathComponent(
      browserCompleteMatch[1],
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    const body = await readJsonBody<CompleteLifeOpsBrowserSessionRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        session: await service.completeBrowserSession(sessionId, body),
      });
    });
  }

  const browserCompanionProgressMatch = pathname.match(
    /^\/api\/lifeops\/browser\/companions\/sessions\/([^/]+)\/progress$/,
  );
  if (method === "POST" && browserCompanionProgressMatch) {
    const sessionId = decodePathComponent(
      browserCompanionProgressMatch[1],
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    const body = await readJsonBody<UpdateLifeOpsBrowserSessionProgressRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      const auth = getBrowserCompanionAuth(ctx);
      if (!auth) {
        return;
      }
      json(res, {
        session: await service.updateBrowserSessionProgressFromCompanion(
          auth.companionId,
          auth.pairingToken,
          sessionId,
          body,
        ),
      });
    });
  }

  const browserCompanionCompleteMatch = pathname.match(
    /^\/api\/lifeops\/browser\/companions\/sessions\/([^/]+)\/complete$/,
  );
  if (method === "POST" && browserCompanionCompleteMatch) {
    const sessionId = decodePathComponent(
      browserCompanionCompleteMatch[1],
      res,
      "browser session id",
    );
    if (!sessionId) return true;
    const body = await readJsonBody<CompleteLifeOpsBrowserSessionRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      const auth = getBrowserCompanionAuth(ctx);
      if (!auth) {
        return;
      }
      json(res, {
        session: await service.completeBrowserSessionFromCompanion(
          auth.companionId,
          auth.pairingToken,
          sessionId,
          body,
        ),
      });
    });
  }

  const occurrenceExplanationMatch = pathname.match(
    /^\/api\/lifeops\/occurrences\/([^/]+)\/explanation$/,
  );
  if (occurrenceExplanationMatch && method === "GET") {
    const occurrenceId = decodePathComponent(
      occurrenceExplanationMatch[1],
      res,
      "occurrence id",
    );
    if (!occurrenceId) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.explainOccurrence(occurrenceId));
    });
  }

  const completeMatch = pathname.match(
    /^\/api\/lifeops\/occurrences\/([^/]+)\/complete$/,
  );
  if (method === "POST" && completeMatch) {
    const occurrenceId = decodePathComponent(
      completeMatch[1],
      res,
      "occurrence id",
    );
    if (!occurrenceId) return true;
    const body = await readJsonBody<CompleteLifeOpsOccurrenceRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        occurrence: await service.completeOccurrence(occurrenceId, body),
      });
    });
  }

  const skipMatch = pathname.match(
    /^\/api\/lifeops\/occurrences\/([^/]+)\/skip$/,
  );
  if (method === "POST" && skipMatch) {
    const occurrenceId = decodePathComponent(
      skipMatch[1],
      res,
      "occurrence id",
    );
    if (!occurrenceId) return true;
    const body = await readJsonBody<Record<string, never>>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        occurrence: await service.skipOccurrence(occurrenceId),
      });
    });
  }

  const snoozeMatch = pathname.match(
    /^\/api\/lifeops\/occurrences\/([^/]+)\/snooze$/,
  );
  if (method === "POST" && snoozeMatch) {
    const occurrenceId = decodePathComponent(
      snoozeMatch[1],
      res,
      "occurrence id",
    );
    if (!occurrenceId) return true;
    const body = await readJsonBody<SnoozeLifeOpsOccurrenceRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        occurrence: await service.snoozeOccurrence(occurrenceId, body),
      });
    });
  }

  return false;
}
