/**
 * Public account-pool status route.
 *
 * The route is intentionally read-only and unauthenticated, but all response
 * fields come from the account-pool status service's allowlisted serializer so
 * private pool metadata, consumer labels, keys, and exact reset timestamps stay
 * server-side.
 */
import type http from "node:http";
import {
  getPublicAccountPoolStatus,
  type PublicPoolStatus,
} from "../services/account-pool-status.js";
import { sendJson, sendJsonError } from "./response.js";

const STATUS_PATH = "/api/pool/status";
const RETRY_AFTER_SECONDS = 60;

export async function handleAccountPoolStatusRoute(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  pathname: string,
): Promise<boolean> {
  if (pathname !== STATUS_PATH) return false;
  if (method !== "GET") {
    res.setHeader("allow", "GET");
    sendJsonError(res, 405, "method not allowed");
    return true;
  }
  try {
    const status: PublicPoolStatus = await getPublicAccountPoolStatus();
    res.setHeader("cache-control", "public, max-age=60");
    sendJson(res, 200, status);
  } catch {
    res.setHeader("retry-after", String(RETRY_AFTER_SECONDS));
    sendJsonError(res, 503, "pool status temporarily unavailable");
  }
  return true;
}
