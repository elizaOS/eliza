/**
 * Bootstrap-token exchange route.
 *
 * The cloud control plane mints a single-use RS256 JWT and injects it as
 * `ELIZA_CLOUD_BOOTSTRAP_TOKEN`. The dashboard submits it to this endpoint
 * exactly once; on success a long-lived browser session row is minted and
 * returned as a cookie pair. The token's `jti` is consumed atomically so
 * any replay is rejected.
 */
import type http from "node:http";
import { type CompatRuntimeState } from "./compat-route-shared";
/** 12h sliding TTL for browser sessions per plan §1.3. */
export declare const BROWSER_SESSION_TTL_MS: number;
/**
 * POST /api/auth/bootstrap/exchange
 *
 * Body: `{ token: string }`
 *
 * Success: 200 with `{ sessionId, identityId, expiresAt }` plus session/CSRF cookies.
 *
 * Failure: 401 / 403 / 429 with `{ error, reason }`. Reason is one of the
 * `VerifyBootstrapFailureReason` values plus `rate_limited` and `db_unavailable`.
 */
export declare function handleAuthBootstrapRoutes(req: http.IncomingMessage, res: http.ServerResponse, state: CompatRuntimeState): Promise<boolean>;
//# sourceMappingURL=auth-bootstrap-routes.d.ts.map