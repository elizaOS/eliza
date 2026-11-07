/**
 * GET /api/users/me
 *
 * Returns the canonical, DB-resolved current user record. The SPA uses this
 * to populate the user/org/role surface after a Steward session is verified.
 *
 * Returns 401 when no session is present.
 */

import { requireUser } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUser(c);
    return c.json({
      user: {
        id: user.id,
        email: user.email ?? null,
        organization_id: user.organization_id ?? null,
        organization: user.organization ?? null,
        is_active: user.is_active ?? true,
        role: user.role ?? null,
        steward_id: user.steward_id ?? null,
        wallet_address: user.wallet_address ?? null,
        is_anonymous: user.is_anonymous ?? false,
      },
    });
  } catch (error) {
    // error-policy:J1 route boundary for the users/ dir — the outermost handler
    // catch translates exceptions into a structured HTTP failure
    // (failureResponse → 5xx / typed status), never a fabricated success.
    logger.error("[users/me] error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
