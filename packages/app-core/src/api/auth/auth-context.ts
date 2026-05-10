/**
 * Canonical request guard for the auth model.
 *
 * Order of resolution:
 *   1. session cookie (`eliza_session`) — modern path, what the SPA uses.
 *   2. session-id bearer header (machine sessions and SPA fallback).
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
import { getProvidedApiToken } from "../auth.ts";
import { findActiveSession, parseSessionCookie } from "./sessions";

export type AuthContextSource =
  | "cookie"
  | "bearer-session"
  | "bearer-bootstrap";

export interface ResolvedAuthContext {
  session: AuthSessionRow | null;
  identity: AuthIdentityRow | null;
  source: AuthContextSource;
}

export interface EnsureSessionOptions {
  store: AuthStore;
  env?: RuntimeEnvRecord;
  now?: number;
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
  _res: http.ServerResponse,
  options: EnsureSessionOptions,
): Promise<ResolvedAuthContext | null> {
  const { store } = options;
  const now = options.now ?? Date.now();
  const allowBootstrap = options.allowBootstrapBearer ?? true;

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
        return { session, identity, source: "cookie" };
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
    // 2a. session-id bearer (machine sessions and SPA fallback).
    const session = await findActiveSession(store, bearer, now).catch(
      () => null,
    );
    if (session) {
      const identity = await store
        .findIdentity(session.identityId)
        .catch(() => null);
      if (identity) {
        return { session, identity, source: "bearer-session" };
      }
      return null;
    }

    // 2b. bootstrap bearer — caller exchanges via dedicated route. We do
    // not verify here (verification consumes the jti), only signal that a
    // bearer is present so the route handler can decide.
    if (allowBootstrap) {
      return {
        session: null,
        identity: null,
        source: "bearer-bootstrap",
      };
    }
  }

  return null;
}
