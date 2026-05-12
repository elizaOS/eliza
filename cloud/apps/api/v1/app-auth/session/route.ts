/**
 * GET /api/v1/app-auth/session
 *
 * Returns the current user (id, email, name, avatar, created_at) for an
 * authenticated request. Accepts a Steward JWT or an API key. If X-App-Id is
 * supplied, the referenced app is also returned.
 *
 * CORS is handled globally in src/index.ts.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/client";
import { apps } from "@/db/schemas/apps";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { usersService } from "@/lib/services/users";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const authed = await requireUserOrApiKey(c);

    // The Workers AuthedUser doesn't carry name/avatar/created_at — fetch the
    // full user row to match the Next response shape.
    const fullUser = await usersService.getById(authed.id);

    const appId = c.req.header("X-App-Id") || c.req.header("x-app-id");
    let appInfo: { id: string; name: string } | null = null;
    if (appId) {
      const [row] = await dbRead
        .select({ id: apps.id, name: apps.name })
        .from(apps)
        .where(eq(apps.id, appId))
        .limit(1);
      if (row) appInfo = row;
    }

    logger.info("App auth session verified", { userId: authed.id, appId });

    return c.json({
      success: true,
      user: {
        id: authed.id,
        email: fullUser?.email ?? authed.email ?? null,
        name: fullUser?.name ?? null,
        avatar: fullUser?.avatar ?? null,
        createdAt: fullUser?.created_at ?? null,
      },
      app: appInfo,
    });
  } catch (error) {
    logger.error("App auth session error:", error);
    return failureResponse(c, error);
  }
});

export default app;
