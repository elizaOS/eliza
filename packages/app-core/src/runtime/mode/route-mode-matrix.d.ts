/**
 * Mode-visibility matrix for HTTP API routes.
 *
 * Every route declares which runtime mode(s) it is reachable in. The route
 * dispatcher consults this matrix BEFORE the handler logic runs. A request
 * to a route that does not include the active mode returns 404 (hidden,
 * not forbidden).
 *
 * Rules:
 *   - Modes are matched against `getRuntimeMode()` (see runtime-mode.ts).
 *   - "local" implicitly does NOT include "local-only" — list both
 *     explicitly when a route is allowed in both. This keeps the table
 *     skim-readable.
 *   - A route accessible in zero modes is dead code: delete it.
 *   - The matcher prefers an exact pathname match, falls back to
 *     longest-prefix match. Method may be "*" to apply to all verbs.
 *
 * AGENTS.md §1 contract:
 *   - cloud mode hides every local-model surface and every
 *     `/api/local-inference/*` endpoint.
 *   - local-only hides every cloud-routed surface (`/api/cloud/*`,
 *     `/api/tts/cloud`).
 *   - remote mode runs no model surface itself — every model setting maps
 *     to the target. Local-inference and cloud are NOT exposed by the
 *     controller; the controller proxies to the target instead.
 */
import type { RuntimeMode } from "./runtime-mode";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "*";
export interface RouteModeRule {
    /**
     * Pathname or pathname prefix this rule applies to. Prefix matches end
     * with `/` or `*` (the `*` is stripped during matching).
     */
    path: string;
    /** HTTP method, or `*` for any. */
    method: HttpMethod;
    /** Modes the route is visible in. Empty = always hidden = delete. */
    modes: ReadonlyArray<RuntimeMode>;
    /** Free-form one-liner so this table doubles as documentation. */
    reason: string;
}
/**
 * Ordered list — first match wins. Put more-specific paths above their
 * prefixes. Prefix entries end with a trailing `/`.
 */
export declare const ROUTE_MODE_MATRIX: ReadonlyArray<RouteModeRule>;
/**
 * Look up the matrix entry that governs this request, if any. Returns
 * `null` when no entry applies — callers should default-allow in that
 * case (the matrix is an explicit gate list, not a wholesale ACL).
 */
export declare function findRouteModeRule(pathname: string, method: string): RouteModeRule | null;
/**
 * Returns true when the route is visible in the active runtime mode, or
 * when no matrix entry applies. Returns false when an entry exists and
 * excludes the active mode — caller MUST respond with 404 (hidden) and
 * MUST NOT leak any information about why.
 */
export declare function isRouteVisible(args: {
    pathname: string;
    method: string;
    mode: RuntimeMode;
}): boolean;
//# sourceMappingURL=route-mode-matrix.d.ts.map