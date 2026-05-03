/**
 * POST /api/v1/app-auth/connect
 *
 * Record a user-app connection during authorization. Accepts either a Steward
 * JWT or API key via the Authorization header.
 *
 * CORS is handled globally in src/index.ts — the OPTIONS handler and per-route
 * CORS_HEADERS from the Next version are intentionally dropped.
 */

import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead, dbWrite } from "@/db/client";
import { apps, appUsers } from "@/db/schemas/apps";
import { failureResponse, NotFoundError, ValidationError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ConnectSchema = z.object({
  appId: z.string().uuid(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKey(c);

    const body = await c.req.json();
    const parsed = ConnectSchema.safeParse(body);

    if (!parsed.success) {
      throw ValidationError("Invalid request data", {
        details: parsed.error.format() as Record<string, unknown>,
      });
    }

    const { appId } = parsed.data;

    const [appRow] = await dbRead
      .select({ id: apps.id, name: apps.name })
      .from(apps)
      .where(and(eq(apps.id, appId), eq(apps.is_active, true), eq(apps.is_approved, true)))
      .limit(1);

    if (!appRow) {
      throw NotFoundError("App not found");
    }

    const [existingConnection] = await dbRead
      .select({ id: appUsers.id })
      .from(appUsers)
      .where(and(eq(appUsers.app_id, appId), eq(appUsers.user_id, user.id)))
      .limit(1);

    if (existingConnection) {
      await dbWrite
        .update(appUsers)
        .set({ last_seen_at: new Date() })
        .where(eq(appUsers.id, existingConnection.id));

      logger.info("Updated app user connection", { userId: user.id, appId });
    } else {
      await dbWrite.insert(appUsers).values({
        app_id: appId,
        user_id: user.id,
        signup_source: "oauth",
        ip_address: c.req.header("x-forwarded-for")?.split(",")[0] || null,
        user_agent: c.req.header("user-agent") || null,
      });

      await dbWrite
        .update(apps)
        .set({ total_users: sql`COALESCE(${apps.total_users}, 0) + 1` })
        .where(eq(apps.id, appId));

      logger.info("Created new app user connection", { userId: user.id, appId });
    }

    return c.json({ success: true, message: "Connected successfully" });
  } catch (error) {
    logger.error("App auth connect error:", error);
    return failureResponse(c, error);
  }
});

export default app;
