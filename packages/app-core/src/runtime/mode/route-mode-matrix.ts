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

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "*";

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
export const ROUTE_MODE_MATRIX: ReadonlyArray<RouteModeRule> = [
  // ── /api/local-inference/* — local model management ───────────────────
  // Local hardware probes, catalog browse, HF search, downloads, active
  // model switch, routing policy. All hidden in cloud mode (no local
  // models at all). Hidden in remote mode — the controller forwards local
  // settings to the target's own `/api/local-inference/*`, it does NOT
  // run a second local-inference service.
  {
    path: "/api/local-inference/",
    method: "*",
    modes: ["local", "local-only"],
    reason: "local model management — hidden in cloud + remote",
  },

  // ── /api/cloud/* — Eliza Cloud connection management ──────────────────
  // Cloud-routed providers, billing, login. Hidden in local-only (the
  // user opted out of cloud entirely). Visible in remote because the
  // controller forwards the request to the target's cloud settings.
  {
    path: "/api/cloud/compat/",
    method: "*",
    modes: ["local", "cloud", "remote"],
    reason: "Eliza Cloud thin-client proxy",
  },
  {
    path: "/api/cloud/v1/",
    method: "*",
    modes: ["local", "cloud", "remote"],
    reason: "Eliza Cloud thin-client proxy",
  },
  {
    path: "/api/cloud/billing/",
    method: "*",
    modes: ["local", "cloud", "remote"],
    reason: "Eliza Cloud billing — hidden in local-only",
  },
  {
    path: "/api/cloud/",
    method: "*",
    modes: ["local", "cloud", "remote"],
    reason:
      "Eliza Cloud connection state (status/login/disconnect) — hidden in local-only",
  },

  // ── /api/tts/cloud — cloud-routed TTS preview ─────────────────────────
  {
    path: "/api/tts/cloud",
    method: "POST",
    modes: ["local", "cloud", "remote"],
    reason: "cloud TTS preview — hidden in local-only",
  },

  // ── /api/dev/* — dev observability (always-on for local dev) ──────────
  // Cloud-provisioned containers can disable separately via env, but the
  // matrix entry is "all modes" so the dispatcher does not synthesise a
  // 404 for a dev surface the operator deliberately wired up.
  {
    path: "/api/dev/",
    method: "*",
    modes: ["local", "local-only", "cloud", "remote"],
    reason: "dev observability (loopback-only auth gates this further)",
  },
] as const;

function matchesPath(rulePath: string, requestPath: string): boolean {
  if (rulePath.endsWith("/")) {
    return requestPath.startsWith(rulePath);
  }
  return rulePath === requestPath;
}

function matchesMethod(ruleMethod: HttpMethod, requestMethod: string): boolean {
  if (ruleMethod === "*") return true;
  return ruleMethod === requestMethod.toUpperCase();
}

/**
 * Look up the matrix entry that governs this request, if any. Returns
 * `null` when no entry applies — callers should default-allow in that
 * case (the matrix is an explicit gate list, not a wholesale ACL).
 */
export function findRouteModeRule(
  pathname: string,
  method: string,
): RouteModeRule | null {
  for (const rule of ROUTE_MODE_MATRIX) {
    if (matchesPath(rule.path, pathname) && matchesMethod(rule.method, method)) {
      return rule;
    }
  }
  return null;
}

/**
 * Returns true when the route is visible in the active runtime mode, or
 * when no matrix entry applies. Returns false when an entry exists and
 * excludes the active mode — caller MUST respond with 404 (hidden) and
 * MUST NOT leak any information about why.
 */
export function isRouteVisible(args: {
  pathname: string;
  method: string;
  mode: RuntimeMode;
}): boolean {
  const rule = findRouteModeRule(args.pathname, args.method);
  if (!rule) return true;
  return rule.modes.includes(args.mode);
}
