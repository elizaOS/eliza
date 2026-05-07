/**
 * Shared admin authentication helper.
 */

import { AuthenticationError, ForbiddenError } from "@/lib/api/errors";
import { type AdminAuthResult, requireAdmin } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";

/**
 * Wrapper for requireAdmin that returns a Response on auth failure
 * instead of throwing, making it easier to use in route handlers.
 */
export async function requireAdminWithResponse(
  request: Request,
  logPrefix: string = "[Admin]",
): Promise<AdminAuthResult | Response> {
  try {
    return await requireAdmin(request);
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
