/**
 * Canonical request guard for the auth model.
 *
 * Order of resolution:
 *   1. session cookie (`eliza_session`) — modern path, what the SPA uses.
 *   2. session-id bearer header (machine sessions and SPA fallback).
 *   3. bootstrap-token bearer (delegates to existing
 *      `ensureAuthSessionOrBootstrap` semantics in `../auth.ts`).
 *
 * Hard rule: this helper fails closed on every error. By default a DB lookup
 * throw, malformed cookie, or CSRF mismatch returns null. HTTP boundaries that
 * distinguish infrastructure outages from invalid credentials may opt into
 * propagating store failures so they can return a retryable 503 instead of a
 * credential-invalidating 401. No failure ever authenticates the request.
 */

import type http from "node:http";
import {
  isLoopbackBindHost,
  isLoopbackRemoteAddress,
  proxyClientHeaderBlocksLocalTrust,
  type RuntimeEnvRecord,
} from "@elizaos/shared";
import type {
  AuthIdentityRow,
  AuthSessionRow,
  AuthStore,
} from "../../services/auth-store";
import { findActiveSession, parseSessionCookie } from "./sessions.js";
import { getProvidedApiToken } from "./tokens.js";

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
  /**
   * `deny` preserves the general guard contract by translating store failures
   * to an unauthenticated result. `throw` lets an outer transport boundary
   * distinguish a temporary store outage from a genuine missing session.
   */
  storeFailureMode?: "deny" | "throw";
}

export const DESKTOP_LOOPBACK_SESSION_SCOPE = "desktop:loopback";

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

function sessionAllowedForRequest(
  session: AuthSessionRow,
  req: Pick<http.IncomingMessage, "headers" | "socket">,
): boolean {
  if (!session.scopes.includes(DESKTOP_LOOPBACK_SESSION_SCOPE)) return true;
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) return false;
  if (proxyClientHeaderBlocksLocalTrust(req.headers)) return false;
  const host = firstHeaderValue(req.headers.host);
  return host !== null && isLoopbackBindHost(host);
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
  const handleStoreFailure = (error: unknown): null => {
    if (options.storeFailureMode === "throw") throw error;
    return null;
  };

  // 1. cookie session
  const cookieSessionId = parseSessionCookie(req);
  if (cookieSessionId) {
    const session = await findActiveSession(store, cookieSessionId, now).catch(
      handleStoreFailure,
    );
    if (session && sessionAllowedForRequest(session, req)) {
      const identity = await store
        .findIdentity(session.identityId)
        .catch(handleStoreFailure);
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
      handleStoreFailure,
    );
    if (session && sessionAllowedForRequest(session, req)) {
      const identity = await store
        .findIdentity(session.identityId)
        .catch(handleStoreFailure);
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
