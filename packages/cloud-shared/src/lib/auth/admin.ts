/**
 * Shared admin authentication helper.
 */

import { AuthenticationError, ForbiddenError } from "../api/errors";
import { logger } from "../utils/logger";
import { requireAdmin } from "./workers-hono-auth";

type AdminAuthResult = Awaited<ReturnType<typeof requireAdmin>>;

/**
 * Wrapper for requireAdmin that returns a Response on auth failure
 * instead of throwing, making it easier to use in route handlers.
 */
export async function requireAdminWithResponse(
  request: Request,
  logPrefix: string = "[Admin]",
): Promise<AdminAuthResult | Response> {
  try {
    return await requireAdmin(request as never);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      logger.warn(`${logPrefix} Authentication failed`, {
        error: error.message,
      });
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      logger.warn(`${logPrefix} Access forbidden`, { error: error.message });
      return Response.json({ error: error.message }, { status: 403 });
    }
    logger.error(`${logPrefix} Unexpected auth error`, { error });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
