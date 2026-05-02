/**
 * Privy wallet provisioning HTTP routes for the app-steward plugin.
 *
 * Three endpoints (GET /api/privy/status, POST /api/privy/login, POST
 * /api/privy/logout) used to live in
 * `packages/agent/src/api/agent-status-routes.ts` with the privy
 * provisioning helpers wired in via AgentStatusRouteDeps. They now live
 * in app-steward and call the privy-wallets helpers directly, so server.ts
 * no longer needs to thread privy provisioning through dependency
 * injection.
 */

import type http from "node:http";
import { logger, type Plugin, type Route } from "@elizaos/core";
import {
  readJsonBody,
  sendJson,
  sendJsonError,
} from "@elizaos/agent/api/http-helpers";
import {
  ensurePrivyWalletsForCustomUser,
  isPrivyWalletProvisioningEnabled,
} from "./services/privy-wallets.js";

type PluginRouteHandler = NonNullable<Route["handler"]>;

async function handlePrivyStatus(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const enabled = isPrivyWalletProvisioningEnabled();
  sendJson(res, { enabled, configured: enabled });
}

async function handlePrivyLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!isPrivyWalletProvisioningEnabled()) {
    sendJsonError(res, "Privy wallet provisioning is not configured.", 503);
    return;
  }
  const body = await readJsonBody<{ userId?: string }>(req, res);
  if (!body) return;

  const userId = (body.userId ?? "").trim();
  if (!userId) {
    sendJsonError(res, "userId is required", 400);
    return;
  }

  try {
    const result = await ensurePrivyWalletsForCustomUser(userId);
    sendJson(res, { ok: true, ...result });
  } catch (err) {
    logger.error(
      `[api] Privy login failed: ${err instanceof Error ? err.message : err}`,
    );
    sendJsonError(
      res,
      `Privy login failed: ${err instanceof Error ? err.message : "unknown error"}`,
      500,
    );
  }
}

async function handlePrivyLogout(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  sendJson(res, { ok: true });
}

function privyHandler(
  fn: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
): PluginRouteHandler {
  return async (req: unknown, res: unknown): Promise<void> => {
    await fn(req as http.IncomingMessage, res as http.ServerResponse);
  };
}

export const privyRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/privy/status",
    rawPath: true,
    handler: privyHandler(handlePrivyStatus),
  },
  {
    type: "POST",
    path: "/api/privy/login",
    rawPath: true,
    handler: privyHandler(handlePrivyLogin),
  },
  {
    type: "POST",
    path: "/api/privy/logout",
    rawPath: true,
    handler: privyHandler(handlePrivyLogout),
  },
];

export const privyPlugin: Plugin = {
  name: "@elizaos/app-steward-privy-routes",
  description: "Privy wallet provisioning routes (status / login / logout)",
  routes: privyRoutes,
};
