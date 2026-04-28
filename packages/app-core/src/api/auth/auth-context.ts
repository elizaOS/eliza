/**
 * Canonical request guard for the P1 auth model.
 *
 * Order of resolution per task brief:
 *   1. session cookie (`milady_session`) — modern path, what the SPA uses.
 *   2. bearer header — covers machine sessions AND the legacy static
 *      `ELIZA_API_TOKEN` during the 14-day grace window.
 *   3. bootstrap-token bearer (delegates to existing
 *      `ensureAuthSessionOrBootstrap` semantics in `../auth.ts`).
 *
 * Hard rule: this helper fails closed on every error. A DB lookup throw, a
 * malformed cookie, a CSRF mismatch — all return null. We do NOT swallow an
 * error and pretend the request was authenticated.
 */

import type http from "node:http";
import type { RuntimeEnvRecord } from "@elizaos/shared";
import type {
  AuthIdentityRow,
  AuthSessionRow,
  AuthStore,
} from "../../services/auth-store";
import {
  extractHeaderValue,
  getCompatApiToken,
  getProvidedApiToken,
  tokenMatches,
} from "../auth";
import {
  decideLegacyBearer,
  LEGACY_DEPRECATION_HEADER,
  recordLegacyBearerRejection,
  recordLegacyBearerUse,
} from "./legacy-bearer";
import { findActiveSession, parseSessionCookie } from "./sessions";

export type AuthContextSource =
  | "cookie"
  | "bearer-session"
  | "bearer-legacy"
  | "bearer-bootstrap";

export interface ResolvedAuthContext {
  session: AuthSessionRow | null;
  identity: AuthIdentityRow | null;
  source: AuthContextSource;
  /** True for the legacy static token path during the grace window. */
  legacy: boolean;
}

export interface EnsureSessionOptions {
  store: AuthStore;
  env?: RuntimeEnvRecord;
  now?: number;
  /**
   * When true (default), allow the legacy static API token through during
   * the 14-day grace window. Set false on routes that MUST require a real
   * session.
   */
  allowLegacyBearer?: boolean;
  /**
   * When true (default), accept a raw bootstrap-token bearer and let the
   * caller exchange it. Set false on routes that should NEVER accept a
   * bootstrap bearer (i.e. anything outside the dedicated exchange route).
   */
  allowBootstrapBearer?: boolean;
}

/**
 * Resolve the request to a session + identity if possible. Returns null on
 * any failure path; never throws on bad input. The caller is responsible
 * for sending the 401.
 */
export async function ensureSessionForRequest(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
  options: EnsureSessionOptions,
): Promise<ResolvedAuthContext | null> {
  const { store } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const allowLegacy = options.allowLegacyBearer ?? true;
  const allowBootstrap = options.allowBootstrapBearer ?? true;
  const ip = req.socket?.remoteAddress ?? null;
  const userAgent = extractHeaderValue(req.headers["user-agent"]);

  // 1. cookie session
  const cookieSessionId = parseSessionCookie(req);
  if (cookieSessionId) {
    const session = await findActiveSession(store, cookieSessionId, now).catch(
      () => null,
    );
    if (session) {
      const identity = await store
        .findIdentity(session.identityId)
        .catch(() => null);
      if (identity) {
        return { session, identity, source: "cookie", legacy: false };
      }
      return null;
    }
    // Cookie present but invalid — fall through to bearer paths to allow
    // CI tools that pin a bearer alongside a stale cookie. Failure to find
    // a bearer below ends the request.
  }

  // 2. bearer header
  const bearer = getProvidedApiToken(req);
  if (bearer) {
    // 2a. session-id bearer (machine sessions and SPA fallback during P0/P1
    // transition where the token is stashed in sessionStorage).
    const session = await findActiveSession(store, bearer, now).catch(
      () => null,
    );
    if (session) {
      const identity = await store
        .findIdentity(session.identityId)
        .catch(() => null);
      if (identity) {
        return { session, identity, source: "bearer-session", legacy: false };
      }
      return null;
    }

    // 2b. legacy static token grace window
    const legacyToken = getCompatApiToken();
    if (allowLegacy && legacyToken && tokenMatches(legacyToken, bearer)) {
      const decision = await decideLegacyBearer(store, env, now);
      if (decision.allowed) {
        // Surface the deprecation header so clients know to migrate.
        if (!res.headersSent) {
          res.setHeader(LEGACY_DEPRECATION_HEADER, "1");
        }
        await recordLegacyBearerUse(store, { ip, userAgent }).catch((err) => {
          console.error("[auth] legacy bearer audit failed:", err);
        });
        return {
          session: null,
          identity: null,
          source: "bearer-legacy",
          legacy: true,
        };
      }
      await recordLegacyBearerRejection(store, {
        ip,
        userAgent,
        reason: decision.reason ?? "post_grace",
      }).catch((err) => {
        console.error("[auth] legacy bearer rejection audit failed:", err);
      });
      return null;
    }

    // 2c. bootstrap bearer — caller exchanges via dedicated route. We do
    // not verify here (verification consumes the jti), only signal that a
    // bearer is present so the route handler can decide.
    if (allowBootstrap) {
      return {
        session: null,
        identity: null,
        source: "bearer-bootstrap",
        legacy: false,
      };
    }
  }

  return null;
}
