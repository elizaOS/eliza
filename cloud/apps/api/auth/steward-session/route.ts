/**
 * POST /api/auth/steward-session — set steward-token cookie from a steward JWT.
 * DELETE /api/auth/steward-session — clear steward cookies (logout).
 */

import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { cookieDomainForHost } from "@/lib/auth/cookie-domain";
import {
  type StewardVerifyEnv,
  verifyStewardTokenCached,
} from "@/lib/auth/steward-client";
import { syncUserFromSteward } from "@/lib/steward-sync";
import type { AppEnv } from "@/types/cloud-worker-env";

function stewardSecretConfigured(env: StewardVerifyEnv): boolean {
  return Boolean(env.STEWARD_SESSION_SECRET || env.STEWARD_JWT_SECRET);
}

const STEWARD_REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

let stewardAuthMetricCounter = 0;
function logStewardAuth(outcome: string, ttl: number | null) {
  stewardAuthMetricCounter += 1;
  console.log("[steward-auth]", {
    timestamp: new Date().toISOString(),
    ttl,
    outcome,
    metric: stewardAuthMetricCounter,
  });
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      token?: string;
      refreshToken?: string;
    };
    const token = body.token;
    const refreshToken = body.refreshToken;

    if (!token || typeof token !== "string") {
      logStewardAuth("missing-token", null);
      return c.json({ error: "Token required", code: "missing_token" }, 400);
    }

    if (!stewardSecretConfigured(c.env)) {
      // Worker can't verify any token — the deployment is missing
      // STEWARD_SESSION_SECRET / STEWARD_JWT_SECRET. Surface this distinctly
      // so the client doesn't treat it as a revocation and wipe localStorage.
      logStewardAuth("server-secret-missing", null);
      return c.json(
        {
          error: "Steward verification not configured on server",
          code: "server_secret_missing",
        },
        503,
      );
    }

    const claims = await verifyStewardTokenCached(c.env, token);
    if (!claims) {
      logStewardAuth("invalid-token", null);
      return c.json({ error: "Invalid token", code: "invalid_token" }, 401);
    }

    let cloudUser: Awaited<ReturnType<typeof syncUserFromSteward>>;
    try {
      cloudUser = await syncUserFromSteward({
        stewardUserId: claims.userId,
        email: claims.email,
        walletAddress: claims.walletAddress ?? claims.address,
        walletChainType: claims.walletChain,
      });
    } catch (error) {
      logStewardAuth("sync-failed", null);
      console.error(
        "[steward-auth] Failed to sync Steward user before setting cookie",
        {
          stewardUserId: claims.userId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return c.json(
        {
          error: "Could not sync Steward user",
          code: "steward_user_sync_failed",
        },
        500,
      );
    }

    const ttl = claims.expiration
      ? Math.max(0, claims.expiration - Math.floor(Date.now() / 1000))
      : null;

    const secure = c.env.NODE_ENV === "production";
    const domain = cookieDomainForHost(c.req.header("host"));

    setCookie(c, "steward-token", token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      ...(domain ? { domain } : {}),
      ...(typeof ttl === "number" ? { maxAge: ttl } : {}),
    });

    if (typeof refreshToken === "string" && refreshToken.length > 0) {
      setCookie(c, "steward-refresh-token", refreshToken, {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/",
        ...(domain ? { domain } : {}),
        maxAge: STEWARD_REFRESH_COOKIE_MAX_AGE,
      });
    }

    setCookie(c, "steward-authed", "1", {
      httpOnly: false,
      secure,
      sameSite: "Lax",
      path: "/",
      ...(domain ? { domain } : {}),
      maxAge: 60 * 60 * 24 * 7,
    });

    logStewardAuth("ok", ttl);
    return c.json({
      ok: true,
      userId: cloudUser.id,
      stewardUserId: claims.userId,
    });
  } catch {
    logStewardAuth("error", null);
    return c.json({ error: "Internal error" }, 500);
  }
});

app.delete("/", (c) => {
  const domain = cookieDomainForHost(c.req.header("host"));
  const opts = domain ? { path: "/", domain } : { path: "/" };
  deleteCookie(c, "steward-token", opts);
  deleteCookie(c, "steward-refresh-token", opts);
  deleteCookie(c, "steward-authed", opts);
  logStewardAuth("deleted", null);
  return c.json({ ok: true });
});

export default app;
