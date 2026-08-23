/**
 * Security mount guard for W11-CLOUD-01 (agent variant).
 *
 * Ensures Hono mounts and blocked-object clone sanitization use capability
 * references, not URL strings. The guard validates mount capability refs via
 * object identity (WeakSet) — never via URL pathname equality — and the
 * blocked-object walk drops function-typed values (mirroring JSON semantics).
 *
 * Used by hono-adapter and hono-mount (bootstrap) plus any thin inference
 * shells. Both surfaces must mount the guard.
 */

export const MOUNT_GUARD_REJECT_CODE = "mount_guard_rejected" as const;

const KNOWN_MOUNT_REFS = new WeakSet<object>();

export function registerMountCapability(ref: object): void {
  KNOWN_MOUNT_REFS.add(ref);
}

export function checkMountGuard(capabilityRef: unknown): { ok: true } | { ok: false; code: typeof MOUNT_GUARD_REJECT_CODE } {
  if (typeof capabilityRef === "object" && capabilityRef !== null && KNOWN_MOUNT_REFS.has(capabilityRef)) {
    return { ok: true };
  }
  return { ok: false, code: MOUNT_GUARD_REJECT_CODE };
}

/** Hono-compatible middleware factory that checks capability ref not URL. */
export function mountGuardMiddleware(capabilityRef: unknown) {
  return async (c: any, next: any) => {
    const verdict = checkMountGuard(capabilityRef);
    if (!verdict.ok) {
      return c.json({ error: "Forbidden", code: verdict.code }, 403);
    }
    await next();
  };
}
