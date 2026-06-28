/**
 * GET /api/users/me
 *
 * Returns the canonical, DB-resolved current user record. The SPA uses this
 * to populate the user/org/role surface after a Steward session is verified.
 *
 * Returns 401 when no session is present.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUser } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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
    logger.error("[users/me] error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
