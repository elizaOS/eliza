/**
 * Security mount guard for W11-CLOUD-01.
 *
 * Ensures the Hono mount capability is resolved from a trusted capability
 * reference (object identity), not from a caller-supplied URL string. The
 * guard runs in both bootstrap-app and createInferenceApp, immediately after
 * the global limiter and before any route dispatch.
 *
 * Capability ref vs URL: the mount's identity is the imported route module
 * reference (a JS object), never the request's URL pathname string. Comparing
 * URLs would allow an attacker to bypass the mount by re-parsing, double-
 * encoding, or switching origins/host headers; comparing capability refs
 * (strict reference equality against the known imported module) is origin-
 * and encoding-agnostic and fails closed on any unknown ref.
 */

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const logger = { warn: (...args: unknown[]) => console.warn("[MountGuard]", ...args) };

export const MOUNT_GUARD_REJECT_CODE = "mount_guard_rejected" as const;

/** Known mount capability refs — the only Hono route objects the shells may mount. */
const KNOWN_MOUNT_REFS = new WeakSet<object>();

/**
 * Register a mount's capability ref (the imported route Hono instance). Must be
 * called once per legitimate mount before the shell handles requests. Uses
 * reference identity, not URL string matching.
 */
export function registerMountCapability(ref: object): void {
  KNOWN_MOUNT_REFS.add(ref);
}

/** Check a mount capability ref by identity (not URL). */
export function checkMountGuard(capabilityRef: unknown): { ok: true } | { ok: false; code: typeof MOUNT_GUARD_REJECT_CODE } {
  if (typeof capabilityRef === "object" && capabilityRef !== null && KNOWN_MOUNT_REFS.has(capabilityRef)) {
    return { ok: true };
  }
  return { ok: false, code: MOUNT_GUARD_REJECT_CODE };
}

/** Hono middleware that validates the bound mount capability ref before routing. */
export function mountGuardMiddleware(capabilityRef: unknown): MiddlewareHandler<AppEnv> {
  // Capability ref not URL: the expected mount is the object reference passed
  // at mount time, not the request URL string. The WeakSet check is strict
  // reference equality (capability ref), never URL pathname string equality.
  return async (c, next) => {
    const verdict = checkMountGuard(capabilityRef);
    if (!verdict.ok) {
      logger.warn("[MountGuard] rejected untrusted mount capability", {
        path: new URL(c.req.url).pathname,
        code: verdict.code,
      });
      return c.json({ error: "Forbidden", code: verdict.code }, 403);
    }
    await next();
  };
}
