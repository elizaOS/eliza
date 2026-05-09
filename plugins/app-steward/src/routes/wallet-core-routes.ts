/**
 * Core wallet routes — wraps handleWalletRoutes from the local api/ copy
 * for registration as plugin routes.
 *
 * Handles:
 *   GET  /api/wallet/addresses
 *   GET  /api/wallet/balances
 *   POST /api/wallet/import
 *   POST /api/wallet/generate
 *   GET  /api/wallet/config
 *   PUT  /api/wallet/config
 *   POST /api/wallet/export
 */
import type http from "node:http";
import {
  type ElizaConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "@elizaos/agent";
import { readCompatJsonBody } from "@elizaos/app-core";
import { sendJson, sendJsonError } from "@elizaos/app-core";
import type { AgentRuntime } from "@elizaos/core";
import { resolveWalletExportRejection } from "@elizaos/plugin-wallet/lib/server-wallet-trade";
import {
  DEFAULT_WALLET_ROUTE_DEPENDENCIES,
  handleWalletRoutes,
} from "../api/wallet-routes";

function ensureWalletKeysInEnvAndConfig(_config: ElizaConfig): boolean {
  // Stub — auto-provisioning is disabled by default; the wallet generate
  // route handles this explicitly.
  return false;
}

export async function handleWalletCoreRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: unknown,
): Promise<boolean> {
  const method = req.method?.toUpperCase() ?? "GET";
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const pathname = url.pathname;

  // Only handle /api/wallet/* paths (not trade/steward sub-paths handled elsewhere)
  if (!pathname.startsWith("/api/wallet/")) return false;
  // Skip paths handled by other compat handlers
  if (
    pathname.startsWith("/api/wallet/trade/") ||
    pathname.startsWith("/api/wallet/transfer/") ||
    pathname.startsWith("/api/wallet/steward") ||
    pathname.startsWith("/api/wallet/browser-") ||
    pathname === "/api/wallet/os-store" ||
    pathname === "/api/wallet/keys" ||
    pathname === "/api/wallet/nfts" ||
    pathname === "/api/wallet/production-defaults" ||
    pathname === "/api/wallet/trading/profile"
  ) {
    return false;
  }

  const config = loadElizaConfig();
  const routeState =
    state && typeof state === "object"
      ? (state as {
          runtime?: unknown;
          restartRuntime?: unknown;
          scheduleRuntimeRestart?: unknown;
        })
      : null;
  const restartRuntime =
    typeof routeState?.restartRuntime === "function"
      ? (routeState.restartRuntime as (reason: string) => Promise<boolean>)
      : undefined;
  const scheduleRuntimeRestart =
    typeof routeState?.scheduleRuntimeRestart === "function"
      ? (routeState.scheduleRuntimeRestart as (reason: string) => void)
      : undefined;

  return handleWalletRoutes({
    req,
    res,
    method,
    pathname,
    config,
    saveConfig: saveElizaConfig,
    ensureWalletKeysInEnvAndConfig,
    resolveWalletExportRejection: (r, body) =>
      resolveWalletExportRejection(r, body as never) as never,
    readJsonBody: readCompatJsonBody as never,
    json: (r, data, status) => sendJson(r, status ?? 200, data),
    error: (r, message, status) => sendJsonError(r, status ?? 500, message),
    deps: DEFAULT_WALLET_ROUTE_DEPENDENCIES,
    restartRuntime,
    scheduleRuntimeRestart,
    runtime: (routeState?.runtime as AgentRuntime | null | undefined) ?? null,
  });
}
