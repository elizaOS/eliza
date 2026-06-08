/**
 * GET /api/v1/me/audit-events
 *
 * Returns recent audit events for the authenticated user from the
 * `auth_events` table. Events are filtered by the user's actor_id
 * and org_id and returned in reverse-chronological order.
 */

import { desc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/client";
import { authEvents } from "@/db/schemas/auth-events";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

    const events = await dbRead
      .select()
      .from(authEvents)
      .where(
        or(
          eq(authEvents.actor_id, user.id),
          eq(authEvents.org_id, user.organization_id),
        ),
      )
      .orderBy(desc(authEvents.ts))
      .limit(limit);

    return c.json({
      events: events.map((e) => ({
        id: e.event_id,
        action: e.action,
        result: e.result,
        resource: e.resource_type
          ? { type: e.resource_type, id: e.resource_id }
          : null,
        ip: e.ip,
        userAgent: e.ua,
        createdAt: e.ts.toISOString(),
        metadata: e.metadata,
      })),
      total: events.length,
      limit,
    });
  } catch (error) {
    logger.error("[AuditEvents] Error fetching audit events:", error);
    return failureResponse(c, error);
  }
});

export default app;
