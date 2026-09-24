/**
 * Compat guard for GET /api/drop/status. When the sensitive-route auth gate
 * rejects, it logs and claims the request (returns true) so the caller stops;
 * for authorized or non-matching requests it returns false to fall through to
 * the real handler. It never serves drop status itself — only the auth gate.
 */
import type http from "node:http";
import { logger } from "@elizaos/core";
import { ensureCompatSensitiveRouteAuthorized } from "./auth.ts";

export function handleDropStatusCompatRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  pathname: string,
): boolean {
  if (method !== "GET" || pathname !== "/api/drop/status") {
    return false;
  }

  if (!ensureCompatSensitiveRouteAuthorized(req, res)) {
    logger.warn(
      "[eliza][drop] GET /api/drop/status rejected (sensitive route not authorized)",
    );
    return true;
  }

  return false;
}
