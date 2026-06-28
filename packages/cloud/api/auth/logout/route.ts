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
  const stewardToken = getCookie(c, "steward-token");

  // Clear cookies FIRST. Clearing them is what actually logs the user out, and
  // it must happen even if the server-side teardown below fails (a transient DB
  // error during logout must not leave the session cookies in place — that was
  // the prior behavior, which left users "still logged in" after a failed
  // logout). The session-record teardown + cache invalidation are best-effort
  // hygiene (caches expire on their own TTL).
  const domain = cookieDomainForHost(c.req.header("host"));
  const stewardOpts = domain ? { path: "/", domain } : { path: "/" };
  deleteCookie(c, "steward-token", stewardOpts);
  deleteCookie(c, "steward-refresh-token", stewardOpts);
  deleteCookie(c, "steward-authed", stewardOpts);
  deleteCookie(c, "eliza-anon-session", { path: "/" });

  try {
    if (stewardToken) {
      await invalidateSessionCaches(stewardToken);
      logger.debug("[Logout] Invalidated session caches for token");
    }

    const user = await getCurrentUser(c);
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
  } catch (error) {
    // Cookies are already cleared, so the user is logged out client-side; a
    // failed server-side teardown must not turn logout into a 500 that strands
    // stale cookies.
    logger.warn(
      "[Logout] server-side teardown failed (cookies already cleared)",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  return c.json({ success: true, message: "Logged out successfully" });
});

export default app;
