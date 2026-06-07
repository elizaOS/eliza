/**
 * High-level per-tenant DB provisioning seam (Apps / Product 2).
 *
 * Composes the cluster pool (where) + the per-tenant provisioner (what) into a
 * single `provisionForApp(appId)` that `UserDatabaseService` calls instead of
 * handing apps the shared agent DATABASE_URL. Every dependency is injected, so
 * the orchestration is unit-testable with no DB; the concrete cluster store +
 * the real Postgres executor (the IO backends) plug in behind these seams.
 */

import type { AllocatedCluster } from "./cluster-pool";
import type { ProvisionedTenantDb, TenantDbCluster } from "./tenant-db-provisioner";

/** What `UserDatabaseService` depends on: provision an isolated DB for an app. */
export interface TenantDbProvisioning {
  /** Returns the app's own isolated DSN + the cluster it was placed on. */
  provisionForApp(appId: string): Promise<{ dsn: string; clusterId: string }>;
}

/** A per-cluster provisioner (the U2 `SqlTenantDbProvisioner` shape). */
export interface TenantDbProvisioner {
  provision(appId: string): Promise<ProvisionedTenantDb>;
}

export interface SqlTenantDbProvisioningDeps {
  /** Allocates the least-loaded cluster with capacity. */
  pool: { allocate(): Promise<AllocatedCluster> };
  /** Decrypts a cluster's stored admin DSN. */
  decrypt: (encrypted: string) => Promise<string>;
  /** Builds a provisioner bound to a cluster's admin connection. */
  makeProvisioner: (cluster: TenantDbCluster, adminDsn: string) => TenantDbProvisioner;
}

export class SqlTenantDbProvisioning implements TenantDbProvisioning {
  private readonly deps: SqlTenantDbProvisioningDeps;

  constructor(deps: SqlTenantDbProvisioningDeps) {
    this.deps = deps;
  }

  async provisionForApp(appId: string): Promise<{ dsn: string; clusterId: string }> {
    const allocated = await this.deps.pool.allocate();
    const adminDsn = await this.deps.decrypt(allocated.adminDsnEncrypted);
    const provisioner = this.deps.makeProvisioner({ host: allocated.host }, adminDsn);
    const result = await provisioner.provision(appId);
    return { dsn: result.dsn, clusterId: allocated.id };
  }
}
