/**
 * Tenant-DB teardown (Apps / Product 2) — the deprovision counterpart to the
 * provision path. When an isolated-DB app is deleted, its per-tenant Postgres
 * DATABASE + ROLE must be DROPped and its cluster slot released, or we leak a
 * live DB we keep paying for AND burn one of the cluster's finite slots forever
 * (the billing leak tracked in #8342).
 *
 * Pure orchestration over injected seams (cluster resolution, the admin
 * executor/provisioner, the slot release) so it's fully unit-testable without a
 * live Postgres. The real DROP runs on the DAEMON (it needs `pg`), composed at
 * the integration boundary; the app-delete route enqueues it.
 *
 * Idempotent + fail-safe: a missing DSN host / unknown cluster is a no-op
 * (nothing to drop — never throws on "already gone"), and `releaseSlot` is
 * floored at 0, so a retry or a double-delete can't corrupt the slot accounting.
 */

/** Provisioner bound to one cluster's admin connection (the deprovision half). */
export interface TenantDbDeprovisioner {
  /**
   * DROP the app's DB + role. Returns `{ existed }` — whether the database was
   * actually present before the DROP — so the caller can release the cluster
   * slot exactly once (a re-run finds `existed: false` and skips the release).
   */
  deprovision(appId: string): Promise<{ existed: boolean }>;
}

export interface TenantDbDeprovisionDeps {
  /**
   * Resolve the cluster that owns a host (the host embedded in the app's stored
   * DSN) to its id + DECRYPTED admin DSN. Returns null when no cluster matches
   * (e.g. a shared-mode/Neon app, or an already-removed cluster).
   */
  resolveClusterByHost: (host: string) => Promise<{ id: string; adminDsn: string } | null>;
  /** Build a provisioner bound to a cluster's admin DSN (for the DROP). */
  makeDeprovisioner: (adminDsn: string, host: string) => TenantDbDeprovisioner;
  /** Decrement the cluster's `database_count` (floored at 0). */
  releaseSlot: (clusterId: string) => Promise<void>;
}

export interface TenantDbDeprovisionResult {
  deprovisioned: boolean;
  reason?: "no-host" | "unknown-cluster";
}

/**
 * Parse the host from a Postgres DSN (`postgres[ql]://user:pw@HOST:port/db…`).
 * Returns the lower-cased host without port, or null if it can't be parsed.
 */
export function parseDsnHost(dsn: string): string | null {
  try {
    // The URL parser handles credentials + ports + query strings cleanly; it
    // requires a parseable scheme, which a Postgres DSN provides.
    const u = new URL(dsn);
    const host = u.hostname.trim().toLowerCase();
    return host || null;
  } catch {
    // Fallback for odd DSNs: grab between the last '@' and the next ':' or '/'.
    const at = dsn.lastIndexOf("@");
    if (at < 0) return null;
    const rest = dsn.slice(at + 1);
    const host = rest.split(/[:/?]/)[0]?.trim().toLowerCase();
    return host || null;
  }
}

/**
 * Drop an app's isolated tenant DB + role and release its cluster slot.
 * Order matters: DROP first, then release the slot — so a failed DROP (which
 * throws) leaves the slot counted (the DB still exists) rather than freeing a
 * slot for a DB that's still live.
 */
export async function deprovisionTenantDbForApp(
  appId: string,
  dsn: string,
  deps: TenantDbDeprovisionDeps,
): Promise<TenantDbDeprovisionResult> {
  const host = parseDsnHost(dsn);
  if (!host) return { deprovisioned: false, reason: "no-host" };

  const cluster = await deps.resolveClusterByHost(host);
  if (!cluster) return { deprovisioned: false, reason: "unknown-cluster" };

  const { existed } = await deps.makeDeprovisioner(cluster.adminDsn, host).deprovision(appId);
  // Release the cluster slot ONLY when this call actually dropped a live DB.
  // The DROP runs on the tenant cluster while `database_count` lives in the
  // control-plane DB, so the two can't share a transaction — gating on existence
  // is what makes a re-run idempotent (DB already gone → no second decrement →
  // no freed phantom capacity). Residual window: a crash AFTER the DROP but
  // BEFORE releaseSlot leaves the slot counted, which fails SAFE (under-counts
  // free capacity rather than over-committing a multi-tenant cluster); a periodic
  // reconcile of database_count against the actual db_app_* databases is the
  // complete fix. (#8342)
  if (existed) await deps.releaseSlot(cluster.id);
  return { deprovisioned: true };
}
