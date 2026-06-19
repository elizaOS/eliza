/**
 * POST /api/auth/logout
 * Logs out the current user by ending all sessions and clearing auth cookies.
 * Also invalidates Redis caches to ensure immediate token invalidation.
 */

import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
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
      await getAuditDispatcher()
        .emit({
          actor: { type: "user", id: user.id },
          action: "auth.logout",
          result: "success",
          resource: null,
          org_id: user.organization_id ?? undefined,
          ip:
            c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
          user_agent: c.req.header("user-agent") ?? undefined,
          request_id: c.get("requestId"),
          metadata: { method: "steward_cookie" },
        })
        .catch((err: unknown) => {
          logger.warn("[Logout] audit emit failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    const domain = cookieDomainForHost(c.req.header("host"));
    const stewardOpts = domain ? { path: "/", domain } : { path: "/" };
    deleteCookie(c, "steward-token", stewardOpts);
    deleteCookie(c, "steward-refresh-token", stewardOpts);
    deleteCookie(c, "steward-authed", stewardOpts);
    deleteCookie(c, "eliza-anon-session", { path: "/" });

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
