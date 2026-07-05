/**
 * Mode-visibility matrix for HTTP API routes.
 *
 * Every mode-gated route declares which runtime mode(s) it is reachable in.
 * The route dispatcher consults this matrix BEFORE the handler logic runs. A
 * request to a route that does not include the active mode returns 404
 * (hidden, not forbidden).
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
 * Runtime-mode contract (#13725):
 *   - cloud mode hides every local-model surface and every
 *     `/api/local-inference/*` endpoint.
 *   - local-only hides every cloud-routed surface (`/api/cloud/*`,
 *     `/api/tts/cloud`).
 *   - remote mode runs no model surface itself — every model setting maps
 *     to the target. Local-inference and cloud are NOT exposed by the
 *     controller; the controller proxies to the target instead.
 *
 * ── Fail-closed contract (arch-audit #12090 item 3 / #12633) ──────────────
 * The mode matrix used to key on anonymous path strings and default-allow any
 * path it did not recognise. That is fail-OPEN on drift: a new sub-route added
 * under a mode-sensitive namespace (e.g. `/api/local-inference/whatever-next`)
 * that a contributor forgets to enumerate would silently be served in EVERY
 * mode, including cloud, leaking a local-model surface.
 *
 * Fix: mode-sensitive namespaces are now *owner-declared* via
 * `PROTECTED_MODE_NAMESPACES`. Every declared rule names the namespace it
 * belongs to. Any request whose pathname falls under a protected namespace but
 * matches no explicit rule FAILS CLOSED (treated as visible in zero modes →
 * 404) instead of default-allowing. Non-protected paths (SPA assets, the wide
 * always-authed `/api/*` surface that is not mode-sensitive) keep
 * default-allow — the matrix is a targeted gate list for mode-sensitive
 * surfaces, not a wholesale ACL. `assertMatrixReconciled()` proves at
 * import/test time that every declared rule lives inside a declared namespace,
 * so the owner set and the rule set cannot drift apart.
 */

import type { RuntimeMode } from "./runtime-mode.ts";

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "*";

/**
 * A mode-sensitive namespace whose sub-routes MUST all be explicitly
 * declared. Any path under `prefix` that matches no rule fails closed.
 *
 * `owner` is the route module that declares and mounts these routes — it is
 * the single point of truth for what lives under the prefix, so a reviewer
 * can reconcile the matrix against the handler by owner name.
 */
export interface ProtectedModeNamespace {
  /** Pathname prefix owned by this namespace. Ends with `/`. */
  prefix: string;
  /** Route module that owns (declares + mounts) every route under `prefix`. */
  owner: string;
  /** Why this namespace is mode-sensitive. */
  reason: string;
}

/**
 * Owner-declared mode-sensitive namespaces. If a request lands under one of
 * these prefixes and no explicit rule in `ROUTE_MODE_MATRIX` matches, it fails
 * closed (404 in every mode) rather than defaulting to visible.
 *
 * Adding a route under one of these prefixes therefore REQUIRES adding a
 * matching rule below, or the route disappears in every mode — a loud,
 * test-covered failure instead of a silent fail-open.
 */
export const PROTECTED_MODE_NAMESPACES: ReadonlyArray<ProtectedModeNamespace> =
  [
    {
      prefix: "/api/local-inference/",
      owner: "plugin-local-inference (compat routes)",
      reason: "local model surface — must never be served in cloud/remote mode",
    },
    {
      prefix: "/api/cloud/",
      owner: "plugin-elizacloud (compat + billing routes)",
      reason: "cloud-routed surface — must never be served in local-only mode",
    },
  ] as const;

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
  /**
   * Owner-declared namespace this rule belongs to (prefix from
   * `PROTECTED_MODE_NAMESPACES`), or `null` for standalone mode-gated paths
   * that are not part of a fail-closed namespace (e.g. one-off TTS/ASR
   * previews). `assertMatrixReconciled()` verifies every non-null owner
   * exists in `PROTECTED_MODE_NAMESPACES`.
   */
  owner: string | null;
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
    owner: "/api/local-inference/",
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
    owner: "/api/cloud/",
    reason: "Eliza Cloud thin-client proxy",
  },
  {
    path: "/api/cloud/v1/",
    method: "*",
    modes: ["local", "cloud", "remote"],
    owner: "/api/cloud/",
    reason: "Eliza Cloud thin-client proxy",
  },
  {
    path: "/api/cloud/billing/",
    method: "*",
    modes: ["local", "cloud", "remote"],
    owner: "/api/cloud/",
    reason: "Eliza Cloud billing — hidden in local-only",
  },
  {
    path: "/api/cloud/",
    method: "*",
    modes: ["local", "cloud", "remote"],
    owner: "/api/cloud/",
    reason:
      "Eliza Cloud connection state (status/login/disconnect) — hidden in local-only",
  },

  // ── /api/tts/local-inference, /api/asr/local-inference ────────────────
  // Cloud-routed TTS (`/api/tts/cloud`) is intentionally NOT listed here —
  // its visibility is handler-declared via the plugin route's `modes`
  // (see findRegisteredRouteModeRule), which is the direction this audit
  // pushes toward. Only the local-inference audio previews remain in the
  // static matrix.
  {
    path: "/api/tts/local-inference",
    method: "POST",
    modes: ["local", "local-only"],
    owner: null,
    reason: "local TTS preview — hidden in cloud + remote",
  },
  {
    path: "/api/asr/local-inference",
    method: "POST",
    modes: ["local", "local-only"],
    owner: null,
    reason: "local ASR transcription — hidden in cloud + remote",
  },

  // ── /api/dev/* — dev observability (always-on for local dev) ──────────
  // Cloud-provisioned containers can disable separately via env, but the
  // matrix entry is "all modes" so the dispatcher does not synthesise a
  // 404 for a dev surface the operator deliberately wired up.
  {
    path: "/api/dev/",
    method: "*",
    modes: ["local", "local-only", "cloud", "remote"],
    owner: null,
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
 * The namespace that owns this pathname, if any. Used to decide whether an
 * un-matrixed path should fail closed (protected namespace) or default-allow
 * (everything else).
 */
export function findProtectedNamespace(
  pathname: string,
): ProtectedModeNamespace | null {
  for (const ns of PROTECTED_MODE_NAMESPACES) {
    // Match children (`/api/cloud/x`) AND the bare namespace root without a
    // trailing slash (`/api/cloud`). The bare root would otherwise slip past
    // both the prefix rule and this check and default-allow — a fail-open
    // seam. `ns.prefix` always ends in `/`, so the bare root is prefix minus
    // that slash.
    const bareRoot = ns.prefix.slice(0, -1);
    if (pathname === bareRoot || pathname.startsWith(ns.prefix)) return ns;
  }
  return null;
}

/**
 * Look up the matrix entry that governs this request, if any. Returns
 * `null` when no explicit entry applies. Callers must NOT treat a `null`
 * result as "visible" on its own — use {@link isRouteVisible}, which fails
 * closed for paths inside a protected namespace.
 */
export function findRouteModeRule(
  pathname: string,
  method: string,
): RouteModeRule | null {
  for (const rule of ROUTE_MODE_MATRIX) {
    if (
      matchesPath(rule.path, pathname) &&
      matchesMethod(rule.method, method)
    ) {
      return rule;
    }
  }
  return null;
}

/**
 * Returns true when the route is visible in the active runtime mode.
 *
 * Resolution order:
 *   1. Explicit matrix rule matches → visible iff the rule lists `mode`.
 *   2. No rule, but the path is inside a protected mode-sensitive namespace
 *      → FAIL CLOSED (not visible in any mode). This is the drift guard:
 *      a forgotten sub-route under a gated prefix is hidden, never leaked.
 *   3. No rule and not protected → default-allow (matrix is a targeted gate
 *      list, not a wholesale ACL; the wide `/api/*` surface is authed
 *      elsewhere).
 *
 * When false, the caller MUST respond with 404 (hidden) and MUST NOT leak
 * any information about why.
 */
export function isRouteVisible(args: {
  pathname: string;
  method: string;
  mode: RuntimeMode;
}): boolean {
  return isRouteVisibleWith(ROUTE_MODE_MATRIX, PROTECTED_MODE_NAMESPACES, args);
}

/**
 * Pure core of {@link isRouteVisible}, parameterised on the rule set and
 * protected-namespace set. Exported so the fail-closed drift branch can be
 * exercised in isolation against a synthetic namespace that (deliberately)
 * has no covering rule — the exact failure mode the shipped catch-all rules
 * mask but that this contract must still handle safely.
 */
export function isRouteVisibleWith(
  rules: ReadonlyArray<RouteModeRule>,
  namespaces: ReadonlyArray<ProtectedModeNamespace>,
  args: { pathname: string; method: string; mode: RuntimeMode },
): boolean {
  for (const rule of rules) {
    if (
      matchesPath(rule.path, args.pathname) &&
      matchesMethod(rule.method, args.method)
    ) {
      return rule.modes.includes(args.mode);
    }
  }

  // No explicit rule. Fail closed inside a protected namespace, default-allow
  // everywhere else. Match children AND the bare namespace root (prefix minus
  // its trailing slash) so `/api/cloud` does not slip through fail-open.
  for (const ns of namespaces) {
    const bareRoot = ns.prefix.slice(0, -1);
    if (args.pathname === bareRoot || args.pathname.startsWith(ns.prefix)) {
      return false;
    }
  }
  return true;
}

/**
 * Reconciliation guard (arch-audit #12633 "grep/lint/assertion" clause).
 *
 * Proves the owner set and the rule set have not drifted apart:
 *   - every rule's non-null `owner` is a declared namespace prefix;
 *   - every declared namespace has at least one rule (no orphan namespace
 *     that would silently fail-close a live surface);
 *   - every rule tagged with an owner actually sits under that prefix.
 *
 * Throws on any violation. Called at module import so a broken matrix cannot
 * ship, and asserted directly in the unit tests.
 */
export function assertMatrixReconciled(): void {
  const namespacePrefixes = new Set(
    PROTECTED_MODE_NAMESPACES.map((ns) => ns.prefix),
  );
  const rulesByOwner = new Map<string, number>();

  for (const rule of ROUTE_MODE_MATRIX) {
    if (rule.owner === null) continue;
    if (!namespacePrefixes.has(rule.owner)) {
      throw new Error(
        `[route-mode-matrix] rule for "${rule.path}" declares owner "${rule.owner}" ` +
          `which is not a declared PROTECTED_MODE_NAMESPACES prefix`,
      );
    }
    if (!rule.path.startsWith(rule.owner)) {
      throw new Error(
        `[route-mode-matrix] rule path "${rule.path}" is tagged with owner ` +
          `"${rule.owner}" but does not sit under that prefix`,
      );
    }
    rulesByOwner.set(rule.owner, (rulesByOwner.get(rule.owner) ?? 0) + 1);
  }

  for (const ns of PROTECTED_MODE_NAMESPACES) {
    if (!rulesByOwner.has(ns.prefix)) {
      throw new Error(
        `[route-mode-matrix] protected namespace "${ns.prefix}" (owner: ` +
          `${ns.owner}) has no matrix rule — every request under it would ` +
          `fail closed. Add a rule or drop the namespace.`,
      );
    }
  }
}

// Fail fast at import time: a matrix that cannot reconcile must not ship.
assertMatrixReconciled();
