/**
 * Security mount guard for W11-CLOUD-01 (app-core variant).
 *
 * Mirrors the agent and cloud-api mount guards: mount capability is a
 * capability reference (object identity), not a URL string. Both bootstrap
 * and thin shells must enforce it.
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

export function mountGuardMiddleware(capabilityRef: unknown) {
  return async (c: any, next: any) => {
    const verdict = checkMountGuard(capabilityRef);
    if (!verdict.ok) {
      return c.json({ error: "Forbidden", code: verdict.code }, 403);
    }
    await next();
  };
}
