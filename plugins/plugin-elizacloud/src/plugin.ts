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
import { loadElizaConfig, type ElizaConfig } from "@elizaos/agent/config";
import { ensureRouteAuthorized } from "@elizaos/app-core/api/auth";
import type { CompatRuntimeState } from "@elizaos/app-core/api/compat-route-shared";
import { sendJson } from "@elizaos/app-core/api/response";
import type { Plugin, Route } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  isElizaSettingsDebugEnabled,
  sanitizeForSettingsDebug,
} from "@elizaos/shared";
import {
  type CloudRouteState,
  handleCloudRoute,
} from "./routes/cloud-routes";
import { handleCloudStatusRoutes } from "./routes/cloud-status-routes";

type AnyRuntime = Parameters<typeof handleCloudStatusRoutes>[0]["runtime"];

interface CloudCompatState extends CompatRuntimeState {
  current: AnyRuntime;
}

function buildState(runtime: unknown): CloudCompatState {
  return { current: runtime as AnyRuntime } as CloudCompatState;
}

/**
 * Loopback PUT to the same API server's `/api/config` endpoint. Used to
 * sync cloud login / disconnect state into the upstream's in-memory
 * config. Loopback origin is derived from the request's local port, which
 * always resolves to the actual listener — never trusts the incoming
 * Host header.
 */
async function compatLoopbackConfigPut(
  req: http.IncomingMessage,
  body: Record<string, unknown>,
): Promise<void> {
  const localPort = req.socket?.localPort;
  if (!Number.isFinite(localPort)) {
    return;
  }
  const base = `http://127.0.0.1:${localPort}`;
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  // Forward the inbound request's auth so the loopback PUT passes through the
  // same compat auth gate.
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.length > 0) {
    headers.set("Authorization", authHeader);
  }
  const csrfHeader = req.headers["x-eliza-csrf"];
  if (typeof csrfHeader === "string" && csrfHeader.length > 0) {
    headers.set("X-Eliza-CSRF", csrfHeader);
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === "string" && cookie.length > 0) {
    headers.set("Cookie", cookie);
  }
  const response = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: /api/config`,
    );
  }
}

/**
 * Status-only handler — `/api/cloud/status` and `/api/cloud/credits`.
 * The cloud-provisioned exemption for `/api/cloud/status` lives in app-core
 * (server.ts) before this plugin route fires; if we get here, auth is
 * required.
 */
function isCloudProvisioned(): boolean {
  return process.env.ELIZA_CLOUD_PROVISIONED === "1";
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
    const state = buildState(runtime);

    // Cloud-provisioned containers exempt /api/cloud/status from auth so the
    // SPA can discover cloud connection state without a token.
    const isCloudStatusExempt =
      isCloudProvisioned() &&
      method === "GET" &&
      url.pathname === "/api/cloud/status";
    if (
      !isCloudStatusExempt &&
      !(await ensureRouteAuthorized(httpReq, httpRes, state))
    ) {
      return;
    }

    const config = loadElizaConfig();

    await handleCloudStatusRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      config,
      runtime: state.current,
      json: (_res, body, status = 200) => {
        sendJson(httpRes, status, body);
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
    const state = buildState(runtime);

    if (!(await ensureRouteAuthorized(httpReq, httpRes, state))) return;

    const config = loadElizaConfig() as ElizaConfig;
    const cloudState: CloudRouteState = {
      config,
      runtime: state.current as CloudRouteState["runtime"],
      cloudManager: null,
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

    // Login/persist + login/status: sync the freshly persisted apiKey into the
    // upstream's in-memory config via loopback PUT /api/config. Skipped silently
    // if disk has no apiKey (e.g. login still pending or rejected).
    if (
      (method === "POST" && url.pathname === "/api/cloud/login/persist") ||
      (method === "GET" && url.pathname.startsWith("/api/cloud/login/status"))
    ) {
      const refreshed = loadElizaConfig() as ElizaConfig;
      const cloud =
        refreshed.cloud && typeof refreshed.cloud === "object"
          ? (refreshed.cloud as Record<string, unknown>)
          : undefined;
      const apiKey =
        typeof cloud?.apiKey === "string" ? cloud.apiKey.trim() : "";
      if (apiKey.length > 0) {
        const nextCloud: Record<string, unknown> = { apiKey };
        const baseUrl =
          typeof cloud?.baseUrl === "string" ? cloud.baseUrl.trim() : "";
        if (baseUrl) {
          nextCloud.baseUrl = baseUrl;
        }
        const patch: Record<string, unknown> = {
          cloud: nextCloud,
          linkedAccounts: {
            elizacloud: { status: "linked", source: "api-key" },
          },
        };
        if (isElizaSettingsDebugEnabled()) {
          logger.debug(
            `[eliza][settings][compat] cloud login → loopback PUT /api/config patch=${JSON.stringify(sanitizeForSettingsDebug(patch))}`,
          );
        }
        try {
          await compatLoopbackConfigPut(httpReq, patch);
          if (isElizaSettingsDebugEnabled()) {
            logger.debug(
              "[eliza][settings][compat] cloud login loopback sync OK",
            );
          }
        } catch (err) {
          logger.warn(
            `[eliza][cloud/login] Failed to sync cloud login to upstream state: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    // Disconnect: clear cloud + serviceRouting + linkedAccounts in upstream
    // state so the next saveElizaConfig doesn't reintroduce the just-cleared
    // key. See full rationale in the original server.ts inline comment.
    if (method === "POST" && url.pathname === "/api/cloud/disconnect") {
      const disconnectPatch = {
        cloud: { enabled: false, apiKey: null },
        serviceRouting: {
          llmText: null,
          tts: null,
          media: null,
          embeddings: null,
          rpc: null,
        },
        linkedAccounts: {
          elizacloud: { status: "unlinked", source: "api-key" },
        },
      };
      if (isElizaSettingsDebugEnabled()) {
        logger.debug(
          `[eliza][settings][compat] POST /api/cloud/disconnect → loopback PUT /api/config patch=${JSON.stringify(sanitizeForSettingsDebug(disconnectPatch))}`,
        );
      }
      try {
        await compatLoopbackConfigPut(httpReq, disconnectPatch);
        if (isElizaSettingsDebugEnabled()) {
          logger.debug(
            "[eliza][settings][compat] POST /api/cloud/disconnect loopback sync OK",
          );
        }
      } catch (err) {
        logger.warn(
          `[eliza][cloud/disconnect] Failed to sync cloud disable to upstream state: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };
}

const cloudStatusHandler = makeStatusHandler();
const cloudRouteHandler = makeCloudRouteHandler();

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
    path: "/api/cloud/disconnect",
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
];

export const elizaCloudRoutePlugin: Plugin = {
  name: "@elizaos/plugin-elizacloud:routes",
  description:
    "Eliza Cloud connection, login, status, credit, and relay routes (extracted from app-core/server.ts)",
  routes: cloudRoutes,
};

export default elizaCloudRoutePlugin;
