import type http from "node:http";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";
import { handleApprovalRoute } from "./approval-routes.ts";
import { handleChatRoutes } from "./chat-routes.ts";
import { handleConversationRoutes } from "./conversation-routes.ts";
import { handleDatabaseRoute } from "./database.ts";
import { handleInboxRoute } from "./inbox-routes.ts";
import { handleNotificationRoute } from "./notification-routes.ts";
import { handlePushTokenRoute } from "./push-token-routes.ts";
import { tryHandleRuntimePluginRoute } from "./runtime-plugin-routes.ts";
import type { ServerState } from "./server-types.ts";

// Lazy memoized loaders: each plugin loads only when its route group is first
// hit. A module-scope `await import` would pull @elizaos/plugin-computeruse and
// @elizaos/plugin-elizacloud into the static graph, loading them on every agent
// boot even when their routes are never touched.
type ComputeUsePluginModule = {
  handleSandboxRoute: (...args: unknown[]) => Promise<boolean>;
};

let computeUsePromise: Promise<ComputeUsePluginModule> | null = null;
function getComputeUsePlugin(): Promise<ComputeUsePluginModule> {
  computeUsePromise ??= import(
    "@elizaos/plugin-computeruse"
  ) as Promise<unknown> as Promise<ComputeUsePluginModule>;
  return computeUsePromise;
}

// plugin-elizacloud owns these host-side cloud routes and exports them as a
// typed contract (`@elizaos/plugin-elizacloud/host-routes`). Typing the lazy
// import against the real exports means a handler signature change here is a
// compile error, not a silent runtime break.
type CloudHostRoutesModule =
  typeof import("@elizaos/plugin-elizacloud/host-routes");

let cloudRoutesPromise: Promise<CloudHostRoutesModule> | null = null;
function getCloudRoutesPlugin(): Promise<CloudHostRoutesModule> {
  cloudRoutesPromise ??= import("@elizaos/plugin-elizacloud/host-routes");
  return cloudRoutesPromise;
}

type ChatRouteArg = Parameters<typeof handleChatRoutes>[0];
type ConversationRouteArg = Parameters<typeof handleConversationRoutes>[0];

const coerce = <T>(value: unknown): T => value as T;

interface DispatchRouteHelpers {
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: ChatRouteArg["readJsonBody"];
}

interface DispatchRouteContext extends DispatchRouteHelpers {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: ServerState;
}

interface CloudAndCoreRouteContext extends DispatchRouteContext {
  restartRuntime: (reason: string) => Promise<boolean>;
  saveConfig: (config: ServerState["config"]) => void;
  isAuthorizedRequest: (req: http.IncomingMessage) => boolean;
}

export async function handleInboxAndCloudRelayRouteGroup({
  req,
  res,
  method,
  pathname,
  state,
  json,
  error,
  readJsonBody,
}: DispatchRouteContext): Promise<boolean> {
  // Push-token routes share the /api/notifications namespace but are owned by
  // the push delivery service, so they must be checked BEFORE the notification
  // catch-all (otherwise notification-routes' `:id` matchers would swallow
  // `/api/notifications/push-tokens/<token>`).
  if (pathname.startsWith("/api/notifications/push-tokens")) {
    return handlePushTokenRoute(
      req,
      res,
      pathname,
      method,
      { runtime: state.runtime ?? null },
      { json, error, readJsonBody },
    );
  }

  if (pathname.startsWith("/api/notifications")) {
    return handleNotificationRoute(
      req,
      res,
      pathname,
      method,
      { runtime: state.runtime ?? null },
      { json, error, readJsonBody },
    );
  }

  if (pathname.startsWith("/api/approvals")) {
    return handleApprovalRoute(
      req,
      res,
      pathname,
      method,
      { runtime: state.runtime ?? null },
      { json, error, readJsonBody },
    );
  }

  if (pathname.startsWith("/api/inbox")) {
    return handleInboxRoute(
      req,
      res,
      pathname,
      method,
      { runtime: state.runtime ?? null },
      { json, error, readJsonBody },
    );
  }

  if (pathname === "/api/approvals") {
    return handleApprovalRoute(
      req,
      res,
      pathname,
      method,
      { runtime: state.runtime ?? null },
      { json, error, readJsonBody },
    );
  }

  if (pathname !== "/api/cloud/relay-status") {
    return false;
  }

  return (await getCloudRoutesPlugin()).handleCloudRelayRoute(
    req,
    res,
    pathname,
    method,
    {
      runtime: state.runtime
        ? {
            getService: (type: string) =>
              (
                state.runtime as {
                  getService: (serviceType: string) => unknown;
                }
              ).getService(type),
          }
        : undefined,
    },
    { json, error, readJsonBody },
  );
}

export async function handleCloudAndCoreRouteGroup({
  req,
  res,
  method,
  pathname,
  state,
  restartRuntime,
  saveConfig,
}: Pick<
  CloudAndCoreRouteContext,
  | "req"
  | "res"
  | "method"
  | "pathname"
  | "state"
  | "restartRuntime"
  | "saveConfig"
>): Promise<boolean> {
  if (!pathname.startsWith("/api/cloud/")) {
    return false;
  }

  // Note: `/api/cloud/x/*` (X relay) is served by @elizaos/plugin-elizacloud's
  // route surface (elizaCloudRoutePlugin) via the runtime plugin route system,
  // not here. None of the handlers below match `/api/cloud/x/*`, so it falls
  // through to `tryHandleRuntimePluginRoute`.

  const cloudRoutes = await getCloudRoutesPlugin();
  const billingHandled = await cloudRoutes.handleCloudBillingRoute(
    req,
    res,
    pathname,
    method,
    { config: state.config, runtime: state.runtime },
  );
  if (billingHandled) return true;

  const compatHandled = await cloudRoutes.handleCloudCompatRoute(
    req,
    res,
    pathname,
    method,
    { config: state.config, runtime: state.runtime },
  );
  if (compatHandled) return true;

  const cloudState = {
    config: state.config,
    cloudManager: state.cloudManager,
    runtime: state.runtime,
    saveConfig,
    createTelemetrySpan: createIntegrationTelemetrySpan,
    restartRuntime,
  };
  return cloudRoutes.handleCloudRoute(req, res, pathname, method, cloudState);
}

export async function handleSandboxRouteGroup({
  req,
  res,
  method,
  pathname,
  state,
}: Pick<
  DispatchRouteContext,
  "req" | "res" | "method" | "pathname" | "state"
>): Promise<boolean> {
  if (!pathname.startsWith("/api/sandbox")) {
    return false;
  }

  return (await getComputeUsePlugin()).handleSandboxRoute(
    req,
    res,
    pathname,
    method,
    { sandboxManager: state.sandboxManager },
  );
}

export async function handleDatabaseRouteGroup({
  req,
  res,
  pathname,
  state,
}: Pick<
  DispatchRouteContext,
  "req" | "res" | "pathname" | "state"
>): Promise<boolean> {
  if (!pathname.startsWith("/api/database/")) {
    return false;
  }

  return handleDatabaseRoute(req, res, state.runtime, pathname);
}

export async function handleConversationRouteGroup({
  req,
  res,
  method,
  pathname,
  state,
  json,
  error,
  readJsonBody,
}: DispatchRouteContext): Promise<boolean> {
  if (pathname.startsWith("/api/conversations")) {
    return handleConversationRoutes({
      req,
      res,
      method,
      pathname,
      readJsonBody,
      json,
      error,
      state: coerce<ConversationRouteArg["state"]>(state),
    });
  }

  // Per-agent message endpoint mirrors the cloud agent-server contract
  // (`POST /agents/:id/message`) and shares chat-routes' generateChatResponse
  // path — same model routing as `/v1/chat/completions`, including
  // local-inference TEXT_LARGE handlers. Issue #7680.
  const isAgentMessageRoute =
    method === "POST" && /^\/api\/agents\/[^/]+\/message$/.test(pathname);

  if (!pathname.startsWith("/v1/") && !isAgentMessageRoute) {
    return false;
  }

  return handleChatRoutes({
    req,
    res,
    method,
    pathname,
    readJsonBody,
    json,
    error,
    state: coerce<ChatRouteArg["state"]>(state),
  });
}

export async function handleLifeOpsRuntimePluginRoute({
  req,
  res,
  method,
  pathname,
  url,
  state,
  isAuthorizedRequest,
}: Pick<
  CloudAndCoreRouteContext,
  | "req"
  | "res"
  | "method"
  | "pathname"
  | "url"
  | "state"
  | "isAuthorizedRequest"
>): Promise<boolean> {
  return tryHandleRuntimePluginRoute({
    req,
    res,
    method,
    pathname,
    url,
    runtime: state.runtime,
    isAuthorized: () => isAuthorizedRequest(req),
  });
}
