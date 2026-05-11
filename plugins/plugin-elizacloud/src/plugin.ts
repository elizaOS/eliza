/**
 * Eliza Cloud route plugin — registers `/api/cloud/*` route handlers with the
 * elizaOS runtime plugin route system.
 *
 * All routes use `rawPath: true` to preserve the legacy `/api/cloud/*` paths
 * without a plugin-name prefix. This module is node-only — the main plugin
 * (services, actions, providers, model handlers) lives in `index.node.ts`
 * and is browser-safe; this `plugin.ts` is loaded only on the server via
 * `register-routes.ts`.
 *
 * Migrated from packages/app-core/src/api/cloud-routes.ts and
 * cloud-status-routes.ts. The login/persist, login/status and disconnect
 * paths each carry a small loopback-PUT that previously lived inline in
 * server.ts; that orchestration moved here so server.ts no longer needs
 * to import the cloud handlers directly.
 */

import type http from "node:http";
import { logger } from "@elizaos/core";
import type { Plugin, Route } from "@elizaos/core";
import { getRuntimeRouteHostContext } from "@elizaos/core";
import type { ElizaConfig } from "./lib/config-like";
import { sendJson } from "./lib/http";
import {
  type CloudBillingRouteState,
  handleCloudBillingRoute,
} from "./routes/cloud-billing-routes";
import {
  type CloudRouteState,
  handleCloudRoute,
} from "./routes/cloud-routes";
import { handleCloudStatusRoutes } from "./routes/cloud-status-routes";

type AnyRuntime = Parameters<typeof handleCloudStatusRoutes>[0]["runtime"];

function getHostContext(runtime: unknown) {
  return getRuntimeRouteHostContext<Record<string, unknown>>(
    runtime && typeof runtime === "object" ? runtime : null,
  );
}

function getRuntimeConfig(runtime: unknown): ElizaConfig {
  return (getHostContext(runtime)?.config ?? {}) as ElizaConfig;
}

function makeStatusHandler() {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const url = new URL(httpReq.url ?? "/", "http://localhost");
    const method = (httpReq.method ?? "GET").toUpperCase();
    const runtimeRef = runtime as AnyRuntime;
    const config = getRuntimeConfig(runtime);

    await handleCloudStatusRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      config,
      runtime: runtimeRef,
      json: (_res, body, status = 200) => {
        sendJson(httpRes, body, status);
      },
    });
  };
}

/**
 * Generic handler for the rest of `/api/cloud/*` (login, disconnect,
 * relay-status, …).  Carries the post-dispatch loopback sync that
 * previously lived inline in server.ts.
 */
function makeCloudRouteHandler() {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const url = new URL(httpReq.url ?? "/", "http://localhost");
    const method = (httpReq.method ?? "GET").toUpperCase();
    const hostContext = getHostContext(runtime);

    if (!hostContext?.config) {
      logger.warn("[eliza-cloud-routes] host config unavailable");
    }
    const config = (hostContext?.config ?? {}) as ElizaConfig;
    const cloudState: CloudRouteState = {
      config,
      runtime: runtime as CloudRouteState["runtime"],
      cloudManager: null,
      restartRuntime: hostContext?.restartRuntime,
      services: {
        createIntegrationTelemetrySpan: hostContext?.createTelemetrySpan,
        saveElizaConfig: (nextConfig) => {
          hostContext?.saveConfig?.(
            nextConfig as Record<string, unknown>,
          );
        },
      },
    };

    const handled = await handleCloudRoute(
      httpReq,
      httpRes,
      url.pathname,
      method,
      cloudState,
    );

    if (!handled) {
      return;
    }
  };
}

function makeBillingRouteHandler() {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const url = new URL(httpReq.url ?? "/", "http://localhost");
    const method = (httpReq.method ?? "GET").toUpperCase();
    const hostContext = getHostContext(runtime);
    const state: CloudBillingRouteState = {
      config: (hostContext?.config ?? {}) as ElizaConfig,
      runtime: runtime as CloudBillingRouteState["runtime"],
    };

    await handleCloudBillingRoute(
      httpReq,
      httpRes,
      url.pathname,
      method,
      state,
    );
  };
}

const cloudStatusHandler = makeStatusHandler();
const cloudRouteHandler = makeCloudRouteHandler();
const cloudBillingRouteHandler = makeBillingRouteHandler();

const cloudRoutes: Route[] = [
  // Status surface (read-only). Note: server.ts may exempt this from auth on
  // cloud-provisioned containers BEFORE the plugin route system fires.
  {
    type: "GET",
    path: "/api/cloud/status",
    rawPath: true,
    handler: cloudStatusHandler,
  },
  {
    type: "GET",
    path: "/api/cloud/credits",
    rawPath: true,
    handler: cloudStatusHandler,
  },
  {
    type: "GET",
    path: "/api/cloud/relay-status",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "POST",
    path: "/api/cloud/coding-containers/promotions",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "POST",
    path: "/api/cloud/coding-containers",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "POST",
    path: "/api/cloud/coding-containers/:containerId/sync",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  ...(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((type) => ({
    type,
    path: "/api/cloud/billing/:path*",
    rawPath: true,
    handler: cloudBillingRouteHandler,
  })),
  {
    type: "POST",
    path: "/api/cloud/disconnect",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "POST",
    path: "/api/cloud/login",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "POST",
    path: "/api/cloud/login/persist",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "GET",
    path: "/api/cloud/login/status",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "GET",
    path: "/api/cloud/agents",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "POST",
    path: "/api/cloud/agents",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "POST",
    path: "/api/cloud/agents/:agentId/provision",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "POST",
    path: "/api/cloud/agents/:agentId/connect",
    rawPath: true,
    handler: cloudRouteHandler,
  },
  {
    type: "POST",
    path: "/api/cloud/agents/:agentId/shutdown",
    rawPath: true,
    handler: cloudRouteHandler,
  },
];

export const elizaCloudRoutePlugin: Plugin = {
  name: "@elizaos/plugin-elizacloud:routes",
  description:
    "Eliza Cloud connection, login, status, credit, and relay routes (extracted from app-core/server.ts)",
  routes: cloudRoutes,
};

export default elizaCloudRoutePlugin;
