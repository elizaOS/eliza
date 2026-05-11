/**
 * POST /api/auth/logout
 * Logs out the current user by ending all sessions and clearing auth cookies.
 * Also invalidates Redis caches to ensure immediate token invalidation.
 */

import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { invalidateSessionCaches } from "@/lib/auth";
import { cookieDomainForHost } from "@/lib/auth/cookie-domain";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { userSessionsService } from "@/lib/services/user-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const stewardToken = getCookie(c, "steward-token");

    const user = await getCurrentUser(c);

    if (stewardToken) {
      await invalidateSessionCaches(stewardToken);
      logger.debug("[Logout] Invalidated session caches for token");
    }

    if (user) {
      await userSessionsService.endAllUserSessions(user.id);
    }

    const domain = cookieDomainForHost(c.req.header("host"));
    const opts = domain ? { path: "/", domain } : { path: "/" };
    deleteCookie(c, "steward-token", opts);
    deleteCookie(c, "steward-refresh-token", opts);
    deleteCookie(c, "steward-authed", opts);
    deleteCookie(c, "eliza-anon-session", opts);

    return c.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    logger.error("Error during logout:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to logout",
      },
      500,
    );
  }
});

export default app;
