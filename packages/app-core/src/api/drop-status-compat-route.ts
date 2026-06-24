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
