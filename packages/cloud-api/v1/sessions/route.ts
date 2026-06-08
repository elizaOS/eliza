/**
 * GET    /api/v1/sessions        — list active sessions for the authenticated user
 * DELETE /api/v1/sessions/:id    — revoke a specific session
 *
 * Backed by the real `userSessionsService` and `user_sessions` table.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { userSessionsService } from "@/lib/services/user-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessions = await userSessionsService.listActiveByUser(user.id);

    return c.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        device: s.device_info
          ? typeof s.device_info === "object"
            ? ((s.device_info as Record<string, unknown>).device_name ??
              (s.device_info as Record<string, unknown>).os ??
              null)
            : null
          : null,
        ip: s.ip_address,
        user_agent: s.user_agent,
        last_seen: s.last_activity_at?.toISOString() ?? null,
        current: false, // We can't reliably detect "current" without the raw JWT
      })),
    });
  } catch (error) {
    logger.error("[Sessions] Error listing sessions:", error);
    return failureResponse(c, error);
  }
});

app.delete("/:id", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("id");

    // Verify the session belongs to this user
    const session = await userSessionsService.getById(sessionId);
    if (!session || session.user_id !== user.id) {
      return c.json({ error: "Session not found" }, 404);
    }

    await userSessionsService.endSession(session.session_token);

    logger.info("[Sessions] Session revoked", {
      userId: user.id,
      sessionId,
    });

    return c.json({ ok: true });
  } catch (error) {
    logger.error("[Sessions] Error revoking session:", error);
    return failureResponse(c, error);
  }
});

export default app;
