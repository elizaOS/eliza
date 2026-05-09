import type http from "node:http";
import { sendJson as httpSendJson, sendJsonError as httpSendJsonError } from "@elizaos/core";
import { TLSSocket } from "node:tls";
import { handleConnectorAccountRoutes } from "@elizaos/agent";
import {
  readJsonBody as httpReadJsonBody } from "@elizaos/shared";
import type {
  AgentRuntime,
  Plugin,
  RoleName,
  RolesWorldMetadata,
  Route,
  UUID,
} from "@elizaos/core";
import {
  ROLE_RANK,
  resolveCanonicalOwnerId,
  resolveEntityRole,
  stringToUuid,
} from "@elizaos/core";
import { createRuntimeScheduledTaskRunner } from "../lifeops/scheduled-task/runtime-wiring.js";
import { handleEntityRoutes } from "./entities.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";
import { handleLifeOpsRoutes } from "./lifeops-routes.js";
import { handleRelationshipRoutes } from "./relationships.js";
import {
  makeScheduledTasksRouteHandler,
  SCHEDULED_TASKS_ROUTE_PATHS,
} from "./scheduled-tasks.js";
import { handleSleepRoutes } from "./sleep-routes.js";
import type { WebsiteBlockerRouteContext } from "./website-blocker-routes.js";
import { handleWebsiteBlockerRoutes } from "./website-blocker-routes.js";

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
  if (typeof ownerId === "string" && ownerId.trim()) {
    return ownerId as UUID;
  }
  if (
    runtime &&
    typeof runtime.agentId === "string" &&
    runtime.agentId.trim()
  ) {
    return stringToUuid(`${runtime.agentId}-admin-entity`) as UUID;
  }
  return null;
}

function routeActorEntityId(
  req: http.IncomingMessage,
  runtime: AgentRuntime | null,
): UUID | null {
  const headerActor =
    firstHeaderValue(req.headers["x-eliza-entity-id"]) ??
    firstHeaderValue(req.headers["x-eliza-actor-entity-id"]);
  if (headerActor) {
    return headerActor as UUID;
  }
  return routeOwnerEntityId(runtime);
}

async function resolveRouteActorRole(
  runtime: AgentRuntime,
  actorEntityId: UUID,
): Promise<RoleName> {
  const ownerEntityId = routeOwnerEntityId(runtime);
  if (ownerEntityId && actorEntityId === ownerEntityId) {
    return "OWNER";
  }

  const worlds =
    typeof runtime.getAllWorlds === "function"
      ? await runtime.getAllWorlds()
      : [];
  let bestRole: RoleName = "GUEST";
  for (const world of worlds ?? []) {
    const metadata = (world?.metadata ?? {}) as RolesWorldMetadata;
    const role = await resolveEntityRole(
      runtime,
      world,
      metadata,
      actorEntityId,
    );
    if (ROLE_RANK[role] > ROLE_RANK[bestRole]) {
      bestRole = role;
    }
    if (ROLE_RANK[bestRole] >= ROLE_RANK.ADMIN) {
      return bestRole;
    }
  }
  return bestRole;
}

export async function requireLifeOpsRouteOwnerAdminAccess(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  runtime: AgentRuntime | null;
}): Promise<boolean> {
  const { req, res, runtime } = args;
  if (!runtime) {
    error(res, "Agent runtime is not available", 503);
    return false;
  }

  const actorEntityId = routeActorEntityId(req, runtime);
  if (!actorEntityId) {
    error(res, "LifeOps routes require OWNER or ADMIN access", 403);
    return false;
  }

  try {
    const role = await resolveRouteActorRole(runtime, actorEntityId);
    if (ROLE_RANK[role] >= ROLE_RANK.ADMIN) {
      return true;
    }
  } catch {
    error(res, "LifeOps route access could not be verified", 403);
    return false;
  }

  error(res, "LifeOps routes require OWNER or ADMIN access", 403);
  return false;
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
      adminEntityId: routeOwnerEntityId(runtime),
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

function runtimeSetting(
  runtime: AgentRuntime | null,
  key: string,
): string | undefined {
  const value = runtime?.getSetting?.(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildCloudProxyConfig(
  runtime: AgentRuntime | null,
): CloudProxyConfigLike {
  return {
    cloud: {
      apiKey:
        runtimeSetting(runtime, "ELIZAOS_CLOUD_API_KEY") ??
        process.env.ELIZAOS_CLOUD_API_KEY,
      baseUrl:
        runtimeSetting(runtime, "ELIZAOS_CLOUD_BASE_URL") ??
        process.env.ELIZAOS_CLOUD_BASE_URL,
      serviceKey:
        runtimeSetting(runtime, "ELIZAOS_CLOUD_SERVICE_KEY") ??
        process.env.ELIZAOS_CLOUD_SERVICE_KEY,
    },
  };
}

type HttpRouteType = Exclude<Route["type"], "STATIC">;

interface PrivateRouteSpec {
  type: HttpRouteType;
  path: string;
  public?: false;
}

interface PublicRouteSpec {
  type: HttpRouteType;
  path: string;
  public: true;
  name: string;
}

type RouteSpec = PrivateRouteSpec | PublicRouteSpec;

const LIFEOPS_STATIC_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/lifeops/app-state" },
  { type: "PUT", path: "/api/lifeops/app-state" },
  { type: "GET", path: "/api/lifeops/capabilities" },
  { type: "GET", path: "/api/lifeops/calendar/feed" },
  { type: "GET", path: "/api/lifeops/calendar/calendars" },
  { type: "PUT", path: "/api/lifeops/calendar/calendars/:id/include" },
  { type: "GET", path: "/api/lifeops/calendar/next-context" },
  { type: "GET", path: "/api/lifeops/gmail/triage" },
  { type: "GET", path: "/api/lifeops/gmail/search" },
  { type: "GET", path: "/api/lifeops/gmail/needs-response" },
  { type: "GET", path: "/api/lifeops/gmail/recommendations" },
  { type: "GET", path: "/api/lifeops/gmail/spam-review" },
  { type: "GET", path: "/api/lifeops/gmail/unresponded" },
  { type: "POST", path: "/api/lifeops/calendar/events" },
  { type: "GET", path: "/api/lifeops/inbox" },
  { type: "POST", path: "/api/lifeops/gmail/reply-drafts" },
  { type: "POST", path: "/api/lifeops/gmail/batch-reply-drafts" },
  { type: "POST", path: "/api/lifeops/gmail/reply-send" },
  { type: "POST", path: "/api/lifeops/gmail/message-send" },
  { type: "POST", path: "/api/lifeops/gmail/batch-reply-send" },
  { type: "POST", path: "/api/lifeops/gmail/manage" },
  { type: "POST", path: "/api/lifeops/gmail/events/ingest" },
  { type: "GET", path: "/api/lifeops/connectors/x/status" },
  { type: "POST", path: "/api/lifeops/connectors/x/start" },
  {
    type: "GET",
    path: "/api/lifeops/connectors/x/success",
    public: true,
    name: "lifeops.x.success",
  },
  { type: "POST", path: "/api/lifeops/connectors/x/disconnect" },
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
  { type: "GET", path: "/api/lifeops/connectors/signal/messages" },
  { type: "POST", path: "/api/lifeops/connectors/signal/send" },
  // Discord
  { type: "GET", path: "/api/lifeops/connectors/discord/status" },
  { type: "POST", path: "/api/lifeops/connectors/discord/connect" },
  { type: "POST", path: "/api/lifeops/connectors/discord/disconnect" },
  { type: "POST", path: "/api/lifeops/connectors/discord/send" },
  { type: "POST", path: "/api/lifeops/connectors/discord/verify" },
  // WhatsApp
  { type: "GET", path: "/api/lifeops/connectors/whatsapp/status" },
  { type: "POST", path: "/api/lifeops/connectors/whatsapp/send" },
  { type: "GET", path: "/api/lifeops/connectors/whatsapp/messages" },
  { type: "GET", path: "/api/lifeops/channel-policies" },
  { type: "POST", path: "/api/lifeops/channel-policies" },
  { type: "POST", path: "/api/lifeops/channels/phone-consent" },
  { type: "GET", path: "/api/lifeops/activity-signals" },
  { type: "POST", path: "/api/lifeops/activity-signals" },
  { type: "POST", path: "/api/lifeops/manual-override" },
  { type: "POST", path: "/api/lifeops/reminders/process" },
  { type: "GET", path: "/api/lifeops/reminder-preferences" },
  { type: "POST", path: "/api/lifeops/reminder-preferences" },
  { type: "POST", path: "/api/lifeops/reminders/acknowledge" },
  { type: "POST", path: "/api/lifeops/website-access/relock" },
  { type: "GET", path: "/api/lifeops/reminders/inspection" },
  { type: "GET", path: "/api/lifeops/workflows" },
  { type: "POST", path: "/api/lifeops/workflows" },
  // Browser companion + package routes moved to
  // `@elizaos/plugin-browser/plugin` (under `/api/browser-bridge/*`).
  { type: "POST", path: "/api/lifeops/schedule/observations" },
  { type: "GET", path: "/api/lifeops/schedule/merged-state" },
  { type: "GET", path: "/api/lifeops/schedule/inspection" },
  { type: "GET", path: "/api/lifeops/schedule/summary" },
  { type: "GET", path: "/api/lifeops/permissions/full-disk-access" },
  { type: "GET", path: "/api/lifeops/screen-time/summary" },
  { type: "GET", path: "/api/lifeops/screen-time/breakdown" },
  { type: "GET", path: "/api/lifeops/screen-time/history" },
  { type: "GET", path: "/api/lifeops/social/summary" },
  { type: "GET", path: "/api/lifeops/overview" },
  { type: "GET", path: "/api/lifeops/connectors/health/status" },
  { type: "POST", path: "/api/lifeops/health/sync" },
  { type: "GET", path: "/api/lifeops/health/summary" },
  { type: "GET", path: "/api/lifeops/money/dashboard" },
  { type: "GET", path: "/api/lifeops/money/sources" },
  { type: "POST", path: "/api/lifeops/money/sources" },
  { type: "POST", path: "/api/lifeops/money/import-csv" },
  { type: "GET", path: "/api/lifeops/money/transactions" },
  { type: "GET", path: "/api/lifeops/money/recurring" },
  { type: "POST", path: "/api/lifeops/money/plaid/link-token" },
  { type: "POST", path: "/api/lifeops/money/plaid/complete" },
  { type: "POST", path: "/api/lifeops/money/plaid/sync" },
  { type: "POST", path: "/api/lifeops/money/paypal/authorize-url" },
  { type: "POST", path: "/api/lifeops/money/paypal/complete" },
  { type: "POST", path: "/api/lifeops/money/paypal/sync" },
  { type: "GET", path: "/api/lifeops/money/bills" },
  { type: "POST", path: "/api/lifeops/money/bills/mark-paid" },
  { type: "POST", path: "/api/lifeops/money/bills/snooze" },
  { type: "GET", path: "/api/lifeops/smart-features/settings" },
  { type: "POST", path: "/api/lifeops/smart-features/settings" },
  { type: "GET", path: "/api/lifeops/subscriptions/playbook-lookup" },
  { type: "GET", path: "/api/lifeops/subscriptions/playbooks" },
  { type: "POST", path: "/api/lifeops/subscriptions/cancel" },
  { type: "POST", path: "/api/lifeops/email-unsubscribe/scan" },
  { type: "POST", path: "/api/lifeops/email-unsubscribe/unsubscribe" },
  { type: "GET", path: "/api/lifeops/seed-templates" },
  { type: "POST", path: "/api/lifeops/seed" },
  { type: "GET", path: "/api/lifeops/definitions" },
  { type: "POST", path: "/api/lifeops/definitions" },
  { type: "GET", path: "/api/lifeops/goals" },
  { type: "POST", path: "/api/lifeops/goals" },
  { type: "POST", path: "/api/lifeops/features/toggle" },
  // Browser extension self-registration.
  { type: "POST", path: "/api/lifeops/browser/register" },
  // W1-E knowledge-graph: entities + relationships.
  { type: "GET", path: "/api/lifeops/entities" },
  { type: "POST", path: "/api/lifeops/entities" },
  { type: "GET", path: "/api/lifeops/entities/resolve" },
  { type: "POST", path: "/api/lifeops/entities/merge" },
  { type: "GET", path: "/api/lifeops/relationships" },
  { type: "POST", path: "/api/lifeops/relationships" },
  { type: "POST", path: "/api/lifeops/relationships/observe" },
];

const LIFEOPS_DYNAMIC_ROUTES: RouteSpec[] = [
  {
    type: "GET",
    path: "/api/lifeops/connectors/health/:provider/status",
  },
  {
    type: "POST",
    path: "/api/lifeops/connectors/health/:provider/start",
  },
  {
    type: "GET",
    path: "/api/lifeops/connectors/health/:provider/callback",
    public: true,
    name: "lifeops.health.callback",
  },
  {
    type: "GET",
    path: "/api/lifeops/connectors/health/:provider/success",
    public: true,
    name: "lifeops.health.success",
  },
  {
    type: "POST",
    path: "/api/lifeops/connectors/health/:provider/disconnect",
  },
  // /api/lifeops/money/sources/:sourceId
  { type: "DELETE", path: "/api/lifeops/money/sources/:sourceId" },
  // /api/lifeops/calendar/events/:eventId
  { type: "PATCH", path: "/api/lifeops/calendar/events/:eventId" },
  { type: "DELETE", path: "/api/lifeops/calendar/events/:eventId" },
  // /api/lifeops/gmail/spam-review/:itemId
  { type: "PATCH", path: "/api/lifeops/gmail/spam-review/:itemId" },
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
  // Browser session + package dynamic routes moved to
  // `@elizaos/plugin-browser/plugin` (under `/api/browser-bridge/*`).
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
  // W1-E knowledge graph dynamic routes.
  { type: "GET", path: "/api/lifeops/entities/:id" },
  { type: "PATCH", path: "/api/lifeops/entities/:id" },
  { type: "POST", path: "/api/lifeops/entities/:id/identities" },
  { type: "GET", path: "/api/lifeops/relationships/:id" },
  { type: "PATCH", path: "/api/lifeops/relationships/:id" },
  { type: "POST", path: "/api/lifeops/relationships/:id/retire" },
];

// ---------------------------------------------------------------------------
// Sleep routes (history / regularity / baseline)
// ---------------------------------------------------------------------------

const LIFEOPS_SLEEP_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/lifeops/sleep/history" },
  { type: "GET", path: "/api/lifeops/sleep/regularity" },
  { type: "GET", path: "/api/lifeops/sleep/baseline" },
];

// ---------------------------------------------------------------------------
// Website-blocker routes
// ---------------------------------------------------------------------------

const WEBSITE_BLOCKER_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/website-blocker" },
  { type: "GET", path: "/api/website-blocker/status" },
  { type: "POST", path: "/api/website-blocker" },
  { type: "PUT", path: "/api/website-blocker" },
  { type: "DELETE", path: "/api/website-blocker" },
];

const CLOUD_FEATURE_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/cloud/features" },
  { type: "POST", path: "/api/cloud/features/sync" },
];

const TRAVEL_PROVIDER_RELAY_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/cloud/travel-providers/:provider/:providerPath*" },
  {
    type: "POST",
    path: "/api/cloud/travel-providers/:provider/:providerPath*",
  },
];

const GOOGLE_CONNECTOR_ACCOUNT_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/connectors/google/accounts" },
  { type: "POST", path: "/api/connectors/google/accounts" },
  { type: "GET", path: "/api/connectors/google/accounts/:accountId" },
  { type: "PATCH", path: "/api/connectors/google/accounts/:accountId" },
  { type: "DELETE", path: "/api/connectors/google/accounts/:accountId" },
  { type: "POST", path: "/api/connectors/google/accounts/:accountId/test" },
  { type: "POST", path: "/api/connectors/google/accounts/:accountId/refresh" },
  { type: "POST", path: "/api/connectors/google/accounts/:accountId/default" },
  { type: "POST", path: "/api/connectors/google/oauth/start" },
  { type: "GET", path: "/api/connectors/google/oauth/status" },
  {
    type: "GET",
    path: "/api/connectors/google/oauth/callback",
    public: true,
    name: "connectors.google.oauth.callback",
  },
  {
    type: "POST",
    path: "/api/connectors/google/oauth/callback",
    public: true,
    name: "connectors.google.oauth.callback.post",
  },
  { type: "GET", path: "/api/connectors/google/audit/events" },
];

// ---------------------------------------------------------------------------
// Build Plugin Route arrays
// ---------------------------------------------------------------------------

type PluginRouteHandler = NonNullable<Route["handler"]>;

interface CloudProxyConfigLike {
  cloud?: {
    apiKey?: string;
    baseUrl?: string;
    serviceKey?: string;
  };
}

function withOwnerAdminGate(handler: PluginRouteHandler): PluginRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: httpReq,
      res: httpRes,
      runtime: agentRuntime,
    });
    if (!allowed) {
      return;
    }
    await handler(req as never, res as never, runtime as never);
  };
}

function buildRawRoutes(
  specs: readonly RouteSpec[],
  handler: PluginRouteHandler,
): Route[] {
  return specs.map((spec): Route => {
    if (spec.public) {
      return {
        type: spec.type,
        path: spec.path,
        rawPath: true,
        public: true,
        name: spec.name,
        handler,
      };
    }
    return {
      type: spec.type,
      path: spec.path,
      rawPath: true,
      handler: withOwnerAdminGate(handler),
    };
  });
}

function lifeOpsRouteHandler(): PluginRouteHandler {
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
    if (await handleEntityRoutes(ctx)) return;
    if (await handleRelationshipRoutes(ctx)) return;
    await handleLifeOpsRoutes(ctx);
  };
}

function scheduledTasksRouteHandler(): PluginRouteHandler {
  // The runner is created per-request because it depends on the
  // runtime which is only available inside the route call. The runtime
  // wiring registers the built-in gates / completion-checks / ladders
  // and uses the LifeOpsRepository for storage.
  const handle = makeScheduledTasksRouteHandler({
    async resolveRunner(ctx) {
      const runtime = ctx.state.runtime;
      if (!runtime) {
        ctx.error(ctx.res, "Agent runtime is not available", 503);
        return null;
      }
      return createRuntimeScheduledTaskRunner({
        runtime,
        agentId: runtime.agentId,
      });
    },
  });
  return async (req, res, runtime): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const ctx = buildLifeOpsContext(
      httpReq,
      httpRes,
      (runtime as AgentRuntime) ?? null,
    );
    const handled = await handle(ctx);
    if (!handled) {
      error(httpRes, "Scheduled-tasks route not found", 404);
    }
  };
}

function sleepRouteHandler(): PluginRouteHandler {
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
    await handleSleepRoutes(ctx);
  };
}

function websiteBlockerRouteHandler(): PluginRouteHandler {
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

function cloudFeaturesRouteHandler(): PluginRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    const { handleCloudFeaturesRoute } = await import(
      "./cloud-features-routes.js"
    );
    await handleCloudFeaturesRoute(httpReq, httpRes, url.pathname, method, {
      config: buildCloudProxyConfig(agentRuntime),
      runtime: agentRuntime,
    });
  };
}

function travelProviderRelayRouteHandler(): PluginRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    const { handleTravelProviderRelayRoute } = await import(
      "./travel-provider-relay-routes.js"
    );
    await handleTravelProviderRelayRoute(
      httpReq,
      httpRes,
      url.pathname,
      method,
      {
        config: buildCloudProxyConfig(agentRuntime),
        runtime: agentRuntime,
      },
    );
  };
}

function googleConnectorAccountRouteHandler(): PluginRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    const handled = await handleConnectorAccountRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      state: {
        runtime: (runtime as AgentRuntime) ?? null,
      },
      json,
      error,
      readJsonBody: httpReadJsonBody,
    });
    if (!handled) {
      error(httpRes, "Connector account route not found", 404);
    }
  };
}

const lifeOpsPluginRoutes: Route[] = [
  ...buildRawRoutes(CLOUD_FEATURE_ROUTES, cloudFeaturesRouteHandler()),
  ...buildRawRoutes(
    TRAVEL_PROVIDER_RELAY_ROUTES,
    travelProviderRelayRouteHandler(),
  ),
  ...buildRawRoutes(
    GOOGLE_CONNECTOR_ACCOUNT_ROUTES,
    googleConnectorAccountRouteHandler(),
  ),
  ...buildRawRoutes(LIFEOPS_STATIC_ROUTES, lifeOpsRouteHandler()),
  ...buildRawRoutes(LIFEOPS_DYNAMIC_ROUTES, lifeOpsRouteHandler()),
  // W1-A — ScheduledTask spine REST surface (`docs/audit/wave1-interfaces.md` §1.6).
  ...buildRawRoutes(
    SCHEDULED_TASKS_ROUTE_PATHS,
    scheduledTasksRouteHandler(),
  ),
  ...buildRawRoutes(LIFEOPS_SLEEP_ROUTES, sleepRouteHandler()),
  ...buildRawRoutes(WEBSITE_BLOCKER_ROUTES, websiteBlockerRouteHandler()),
];

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const lifeopsPlugin: Plugin = {
  name: "@elizaos/app-lifeops-routes",
  description:
    "LifeOps dashboard, Google Workspace, website blocker, and scheduling routes",
  dependencies: ["@elizaos/plugin-google"],
  routes: lifeOpsPluginRoutes,
};
