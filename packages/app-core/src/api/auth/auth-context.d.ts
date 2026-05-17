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
import type { AuthIdentityRow, AuthSessionRow, AuthStore } from "../../services/auth-store";
export type AuthContextSource = "cookie" | "bearer-session" | "bearer-bootstrap";
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
export declare function ensureSessionForRequest(req: Pick<http.IncomingMessage, "headers" | "socket">, _res: http.ServerResponse, options: EnsureSessionOptions): Promise<ResolvedAuthContext | null>;
//# sourceMappingURL=auth-context.d.ts.map