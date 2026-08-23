/**
 * Security mount guard for W11-CLOUD-01.
 *
 * The mount capability is a trusted object reference (WeakSet identity), never
 * a URL string. Official inference route modules are registered by the thin
 * entry loader *after* dynamic import and *before* createInferenceApp — the
 * factory itself does not register the caller-supplied route. An attacker Hono
 * instance passed to createInferenceApp is therefore 403.
 *
 * Bootstrap uses a module-level capability registered here, not a fresh object
 * allocated at the mount site.
 */

import type { MiddlewareHandler } from "hono";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

export const MOUNT_GUARD_REJECT_CODE = "mount_guard_rejected" as const;

/** Known mount capability refs — the only Hono route objects the shells may mount. */
const KNOWN_MOUNT_REFS = new WeakSet<object>();

/** Bootstrap shell identity. Registered at this module's load, not in createApp. */
export const BOOTSTRAP_MOUNT_CAPABILITY: object = {
  id: "eliza-cloud-bootstrap",
};
KNOWN_MOUNT_REFS.add(BOOTSTRAP_MOUNT_CAPABILITY);

/**
 * Register a mount's capability ref (the imported route Hono instance). Call
 * this from the trusted loader after importing the official module — never
 * from createInferenceApp itself.
 */
export function registerMountCapability(ref: object): void {
  KNOWN_MOUNT_REFS.add(ref);
}

/** Check a mount capability ref by identity (not URL). */
export function checkMountGuard(
  capabilityRef: unknown,
): { ok: true } | { ok: false; code: typeof MOUNT_GUARD_REJECT_CODE } {
  if (
    typeof capabilityRef === "object" &&
    capabilityRef !== null &&
    KNOWN_MOUNT_REFS.has(capabilityRef)
  ) {
    return { ok: true };
  }
  return { ok: false, code: MOUNT_GUARD_REJECT_CODE };
}

/** Hono middleware that validates the bound mount capability ref before routing. */
export function mountGuardMiddleware(
  capabilityRef: unknown,
): MiddlewareHandler<AppEnv> {
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
