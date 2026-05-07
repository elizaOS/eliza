/**
 * Bootstrap-token exchange route.
 *
 * The cloud control plane mints a single-use RS256 JWT and injects it as
 * `ELIZA_CLOUD_BOOTSTRAP_TOKEN`. The dashboard pastes the same value into
 * this endpoint exactly once; on success we mint a long-lived browser
 * session row and return its id. The UI uses the id as a bearer until P1
 * lands the cookie + CSRF infrastructure.
 *
 * This is the only place that flips bootstrap → session. The token's `jti`
 * is consumed atomically by the verifier so a replay (even after a crash
 * mid-mint) is rejected.
 */

import crypto from "node:crypto";
import type http from "node:http";
import type { DrizzleDatabase } from "@elizaos/plugin-sql/types";
import { AuthStore } from "../services/auth-store";
import { extractHeaderValue } from "./auth";
import {
  appendAuditEvent,
  bootstrapExchangeLimiter,
  serializeCsrfCookie,
  serializeSessionCookie,
  verifyBootstrapToken,
} from "./auth/index";
import {
  type CompatRuntimeState,
  isLoopbackRemoteAddress,
  readCompatJsonBody,
} from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

/** 12h sliding TTL for browser sessions per plan §1.3. */
export const BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface AdapterWithDb {
  db?: unknown;
}

function getDrizzleDb(state: CompatRuntimeState): DrizzleDatabase | null {
  const runtime = state.current;
  if (!runtime) return null;
  const adapter = runtime.adapter as AdapterWithDb | undefined;
  if (!adapter?.db) return null;
  return adapter.db as DrizzleDatabase;
}

function deriveIdentityIdFromCloudUser(cloudUserId: string): string {
  // Stable per-cloud-user id so repeated exchanges by the same user reuse the
  // same identity row. SHA-256 of the cloud sub keeps it opaque while still
  // deterministic. We slice to 32 hex chars and shape as a uuid-ish string
  // because the column is plain `text` and downstream consumers expect that
  // shape.
  const hash = crypto
    .createHash("sha256")
    .update(cloudUserId, "utf8")
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

/**
 * POST /api/auth/bootstrap/exchange
 *
 * Body: `{ token: string }`
 *
 * Success: 200 with `{ sessionId, identityId, expiresAt }`. The caller stores
 * the session id and presents it as a bearer (`Authorization: Bearer …`)
 * on subsequent requests until P1 ships cookie auth.
 *
 * Failure: 401 / 403 / 429 with `{ error, reason }`. Reason is one of the
 * `VerifyBootstrapFailureReason` values plus `rate_limited` and
 * `db_unavailable`.
 */
export async function handleAuthBootstrapRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method !== "POST" || url.pathname !== "/api/auth/bootstrap/exchange") {
    return false;
  }

  const ip = req.socket?.remoteAddress ?? null;
  if (!bootstrapExchangeLimiter.consume(ip)) {
    sendJsonResponse(res, 429, {
      error: "rate_limited",
      reason: "rate_limited",
    });
    return true;
  }

  const db = getDrizzleDb(state);
  if (!db) {
    sendJsonResponse(res, 503, {
      error: "db_unavailable",
      reason: "db_unavailable",
    });
    return true;
  }
  const store = new AuthStore(db);

  const body = await readCompatJsonBody(req, res);
  if (body == null) return true;

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    sendJsonErrorResponse(res, 400, "missing_token");
    return true;
  }

  const userAgent = extractHeaderValue(req.headers["user-agent"]);
  const result = await verifyBootstrapToken(token, { authStore: store });

  if (!result.ok) {
    // Failure path is audited so the operator can see replay / mismatch
    // attempts. The token itself is never written — just the failure
    // reason.
    await appendAuditEvent(
      {
        actorIdentityId: null,
        ip,
        userAgent,
        action: "auth.bootstrap.exchange",
        outcome: "failure",
        metadata: { reason: result.reason },
      },
      { store },
    ).catch((err: unknown) => {
      // Audit failure must not change auth outcome — but it must surface.
      // Log to stderr; the route still returns the original auth failure.
      console.error("[auth] audit append failed:", err);
    });
    const status =
      result.reason === "missing_token"
        ? 400
        : result.reason === "missing_issuer_env" ||
            result.reason === "missing_container_env"
          ? 503
          : 401;
    sendJsonResponse(res, status, {
      error: "auth_required",
      reason: result.reason,
    });
    return true;
  }

  const claims = result.claims;
  const now = Date.now();
  const identityId = deriveIdentityIdFromCloudUser(claims.sub);
  const existing = await store.findIdentity(identityId);
  if (!existing) {
    await store.createIdentity({
      id: identityId,
      kind: "owner",
      displayName: `Cloud user ${claims.sub.slice(0, 8)}`,
      createdAt: now,
      passwordHash: null,
      cloudUserId: claims.sub,
    });
  }

  const sessionId = crypto.randomBytes(32).toString("hex");
  const csrfSecret = crypto.randomBytes(32).toString("hex");
  const expiresAt = now + BROWSER_SESSION_TTL_MS;
  const session = await store.createSession({
    id: sessionId,
    identityId,
    kind: "browser",
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    rememberDevice: false,
    csrfSecret,
    ip,
    userAgent,
    scopes: [],
  });

  // P1: bootstrap exchange now also sets the cookie pair. The response body
  // continues to include `sessionId` for P0 SPA compat (sessionStorage-based
  // bearer fallback) but the canonical credential is the cookie.
  res.setHeader("set-cookie", [
    serializeSessionCookie(session),
    serializeCsrfCookie(session),
  ]);

  await appendAuditEvent(
    {
      actorIdentityId: identityId,
      ip,
      userAgent,
      action: "auth.bootstrap.exchange",
      outcome: "success",
      metadata: { containerId: claims.containerId, jti: claims.jti },
    },
    { store },
  ).catch((err: unknown) => {
    console.error("[auth] audit append failed:", err);
  });

  sendJsonResponse(res, 200, {
    sessionId,
    identityId,
    expiresAt,
  });
  // We deliberately mark loopback so dev runs over `localhost` don't miss
  // the response (no functional effect — just documents intent).
  void isLoopbackRemoteAddress(ip);
  return true;
}
