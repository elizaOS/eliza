/**
 * Shared admin authentication helper.
 */

import type { AppContext } from "../../types/cloud-worker-env";
import { ApiError } from "../api/cloud-worker-errors";
import { logger } from "../utils/logger";
import { requireAdmin } from "./workers-hono-auth";

type AdminAuthResult = Awaited<ReturnType<typeof requireAdmin>>;

/**
 * Wrapper for requireAdmin that returns a Response on auth failure
 * instead of throwing, making it easier to use in route handlers.
 */
export async function requireAdminWithResponse(
  c: AppContext,
  logPrefix: string = "[Admin]",
): Promise<AdminAuthResult | Response> {
  try {
    return await requireAdmin(c);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      logger.warn(`${logPrefix} Authentication failed`, {
        error: error.message,
      });
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ApiError && error.status === 403) {
      logger.warn(`${logPrefix} Access forbidden`, { error: error.message });
      return Response.json({ error: error.message }, { status: 403 });
    }
    logger.error(`${logPrefix} Unexpected auth error`, { error });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
