import type http from "node:http";
import { handleSandboxRoute } from "@elizaos/plugin-computeruse";
import {
  type CloudRouteState,
  handleCloudBillingRoute,
  handleCloudCompatRoute,
  handleCloudRelayRoute,
  handleCloudRoute,
} from "@elizaos/plugin-elizacloud";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.js";
import { handleChatRoutes } from "./chat-routes.js";
import { handleConversationRoutes } from "./conversation-routes.js";
import { handleDatabaseRoute } from "./database.js";
import { handleInboxRoute } from "./inbox-routes.js";
import { tryHandleRuntimePluginRoute } from "./runtime-plugin-routes.js";
import type { ServerState } from "./server-types.js";
import { handleXRelayRoute } from "./x-relay-routes.js";

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
  if (pathname.startsWith("/api/inbox")) {
    return await handleInboxRoute(
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

  return await handleCloudRelayRoute(
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

  const xRelayHandled = await handleXRelayRoute(req, res, pathname, method, {
    config: state.config,
    runtime: state.runtime,
  });
  if (xRelayHandled) return true;

  const billingHandled = await handleCloudBillingRoute(
    req,
    res,
    pathname,
    method,
    { config: state.config, runtime: state.runtime },
  );
  if (billingHandled) return true;

  const compatHandled = await handleCloudCompatRoute(
    req,
    res,
    pathname,
    method,
    { config: state.config, runtime: state.runtime },
  );
  if (compatHandled) return true;

  const cloudState: CloudRouteState = {
    config: state.config,
    cloudManager: state.cloudManager,
    runtime: state.runtime,
    saveConfig,
    createTelemetrySpan: createIntegrationTelemetrySpan,
    restartRuntime,
  };
  return await handleCloudRoute(req, res, pathname, method, cloudState);
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

  return await handleSandboxRoute(req, res, pathname, method, {
    sandboxManager: state.sandboxManager,
  });
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

  return await handleDatabaseRoute(req, res, state.runtime, pathname);
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
    return await handleConversationRoutes({
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

  if (!pathname.startsWith("/v1/")) {
    return false;
  }

  return await handleChatRoutes({
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
  return await tryHandleRuntimePluginRoute({
    req,
    res,
    method,
    pathname,
    url,
    runtime: state.runtime,
    isAuthorized: () => isAuthorizedRequest(req),
  });
}
