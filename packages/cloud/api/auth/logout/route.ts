/**
 * POST /api/auth/logout
 * Logs out the current user by ending all sessions and clearing auth cookies.
 * Also invalidates Redis caches to ensure immediate token invalidation.
 */

import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
import { invalidateSessionCaches } from "@/lib/auth";
import { checkElizaMutatingRequestOrigin } from "@/lib/auth/browser-origin-policy";
import { cookieDomainForHost } from "@/lib/auth/cookie-domain";
import { verifyStewardTokenCached } from "@/lib/auth/steward-client";
import { stewardCookieNames } from "@/lib/auth/steward-cookies";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import {
  getRequestIp,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  isInferenceStrongRevocationEnabled,
  revokeInferenceSessionsThrough,
} from "@/lib/services/inference-credential-revocation";
import { markSsoBridgeLogout } from "@/lib/services/sso-bridge-codes";
import { userSessionsService } from "@/lib/services/user-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  const originCheck = checkElizaMutatingRequestOrigin(
    c.req,
    c.env.NODE_ENV === "production",
  );
  if (!originCheck.ok) {
    logger.warn("[Logout] Rejected cross-origin POST", {
      detail: originCheck.reason,
    });
    return c.json(
      { error: "Forbidden", code: "forbidden_origin" as const },
      403,
    );
  }

  const cookieNames = stewardCookieNames(c.env.ENVIRONMENT);
  // Each environment reads only its own scoped cookie. The bounded read-only
  // migration window that let non-production fall back to the historical
  // unsuffixed cookie closed on 2026-08-04 (#14130); in production the scoped
  // names already ARE the unsuffixed names, so `cookieNames.token` covers both
  // eras and no separate legacy read is needed.
  const stewardToken = getCookie(c, cookieNames.token);

  // Clear cookies FIRST. Clearing them is what actually logs the user out, and
  // it must happen even if the server-side teardown below fails (a transient DB
  // error during logout must not leave the session cookies in place — that was
  // the prior behavior, which left users "still logged in" after a failed
  // logout). The session-record teardown + cache invalidation are best-effort
  // hygiene (caches expire on their own TTL).
  const domain = cookieDomainForHost(c.req.header("host"));
  const stewardOpts = domain ? { path: "/", domain } : { path: "/" };
  // Non-production clears only its suffixed pair. The unsuffixed legacy names
  // are production's live cookies on the shared parent domain; deleting them
  // from staging/dev signs the user out of production.
  // In production the scoped names already ARE the historical unsuffixed names,
  // so a single set of deleteCookie calls covers both eras. The separate legacy
  // clear block was redundant (#14130).
  deleteCookie(c, cookieNames.token, stewardOpts);
  deleteCookie(c, cookieNames.refreshToken, stewardOpts);
  deleteCookie(c, cookieNames.authed, stewardOpts);
  deleteCookie(c, "eliza-anon-session", { path: "/" });

  let strongRevocationFailed = false;
  if (stewardToken && isInferenceStrongRevocationEnabled(c.env)) {
    try {
      const [claims, user] = await Promise.all([
        verifyStewardTokenCached(c.env, stewardToken),
        getCurrentUser(c),
      ]);
      if (!claims || !user?.organization_id) {
        throw new Error("logout credential identity could not be resolved");
      }
      await revokeInferenceSessionsThrough(
        user.organization_id,
        user.id,
        claims.issuedAt,
      );
    } catch (error) {
      // error-policy:J1 cookies are already cleared, but the server must not
      // claim a globally complete logout until the strong inference boundary
      // confirms that the presented session generation is denied.
      logger.error("[Logout] Strong inference-session revocation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      strongRevocationFailed = true;
    }
  }

  // Stamp the cross-host SSO logout marker FIRST and in its own guarded block:
  // the sso-bridge legs and the cookie-planting session-sync endpoint refuse
  // tokens issued before this moment, so an explicit logout cannot be silently
  // undone by the paired host bridging or re-syncing the other origin's
  // still-unexpired session back in. The marker lives in Postgres (same store
  // the bridge reads), so a store outage that loses this stamp also disables
  // the bridge itself — but a TRANSIENT stamp failure would leave a bridgeable
  // window once the store recovers, hence one retry and an error-level log
  // (never a silent downgrade to debug) when the stamp is unconfirmed.
  if (stewardToken) {
    try {
      const claims = await verifyStewardTokenCached(c.env, stewardToken);
      if (claims) {
        try {
          await markSsoBridgeLogout(claims.userId);
        } catch {
          // error-policy:J6 single bounded retry of best-effort teardown; the
          // definitive failure is handled (loudly) by the outer catch.
          await markSsoBridgeLogout(claims.userId);
        }
        logger.debug("[Logout] Stamped SSO bridge logout marker");
      }
    } catch (error) {
      // error-policy:J6 best-effort teardown — cookies are already cleared, so
      // THIS origin is logged out; but the cross-host logout barrier did not
      // land, which is a security-relevant condition worth an alert, not a
      // debug line. The bridge's own store reads fail closed while the store
      // is down, narrowing the exposure to a post-recovery window bounded by
      // the access-token TTL.
      logger.error(
        "[Logout] FAILED to stamp SSO bridge logout marker — cross-host logout barrier not persisted",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  try {
    // Only tear down caches/sessions when this environment owned the token that
    // was actually presented. The non-production legacy read fallback closed on
    // 2026-08-04 (#14130), so stewardToken here is always this environment's own
    // scoped cookie.
    if (stewardToken) {
      await invalidateSessionCaches(stewardToken);
      logger.debug("[Logout] Invalidated session caches for token");
    }

    if (stewardToken) {
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
            ip: getRequestIp(c),
            user_agent: c.req.header("user-agent") ?? undefined,
            request_id: c.get("requestId"),
            metadata: { method: "steward_cookie" },
          })
          // error-policy:J7 audit write is diagnostic; logout already succeeded via
          // the cookie clear above, so a dropped audit event is logged, not fatal.
          .catch((err: unknown) => {
            logger.warn("[Logout] audit emit failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
    }
  } catch (error) {
    // error-policy:J6 best-effort teardown — cookies are already cleared, so the
    // user is logged out client-side; a failed server-side session teardown must
    // not turn logout into a 500 that strands stale cookies. Caches expire on TTL.
    logger.warn(
      "[Logout] server-side teardown failed (cookies already cleared)",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  if (strongRevocationFailed) {
    return c.json(
      {
        error: "Logout revocation is temporarily unavailable",
        code: "logout_revocation_unavailable" as const,
      },
      503,
    );
  }

  return c.json({ success: true, message: "Logged out successfully" });
});

export default app;
