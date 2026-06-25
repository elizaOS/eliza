/**
 * NODE-ONLY composer for the apps tenant-DB provisioning seam (Apps / Product 2).
 *
 * Wires the persistent cluster pool (`tenantDbClustersRepository`, over the
 * `tenant_db_clusters` table) + the real Postgres DDL executor (`DirectPgExecutor`,
 * node-`pg`) into a single {@link SqlTenantDbProvisioning} that
 * `UserDatabaseService` consumes. This is the REAL isolated path:
 * `provisionForApp` allocates the least-loaded cluster with capacity, decrypts
 * its admin DSN, and runs CREATE ROLE / CREATE DATABASE / REVOKE CONNECT FROM
 * PUBLIC against that cluster — handing the app its OWN least-privilege DSN and
 * never the shared agent `DATABASE_URL`.
 *
 * NODE-ONLY: `DirectPgExecutor` imports `pg`, which does not load on Cloudflare
 * Workers (workerd). Construct this only on the provisioning-worker daemon (or a
 * node host of the deploy path), never in cloud-api. The Worker deploy path uses
 * the shared-DB fallback (a `UserDatabaseService` with no provisioning backend).
 *
 * The cluster admin DSN is decrypted with the one-arg `fieldEncryption.decrypt`
 * (the ciphertext self-describes its `orgKeyId`, so the platform org it was
 * sealed under is resolved from the blob — no org id needed at this layer).
 */

import { randomBytes } from "node:crypto";
import { appDatabasesRepository } from "../../../db/repositories/app-databases";
import { tenantDbClustersRepository } from "../../../db/repositories/tenant-db-clusters";
import { fieldEncryption } from "../field-encryption";
import { type AllocatedCluster, ClusterPool, type ClusterPoolStore } from "./cluster-pool";
import { DirectPgExecutor } from "./direct-pg-executor";
import { SqlTenantDbProvisioner } from "./tenant-db-provisioner";
import { SqlTenantDbProvisioning } from "./tenant-db-provisioning";

/**
 * Strong random role password, URL-safe so it never breaks the generated DSN
 * (`base64url` has no `+` `/` `=` — the chars that would need DSN-escaping).
 * 36 bytes → 48 chars → ~288 bits.
 */
function genRolePassword(): string {
  return randomBytes(36).toString("base64url");
}

export interface MakeTenantDbProvisioningOpts {
  /** Override the cluster store (tests). Defaults to the real repository. */
  store?: ClusterPoolStore;
  /** Override the admin-DSN decryptor (tests). Defaults to `fieldEncryption.decrypt`. */
  decrypt?: (encrypted: string) => Promise<string>;
  /** Override the role-password generator (deterministic tests). */
  genPassword?: () => string;
  /** Override durable app->cluster placement claiming (tests). Defaults to app_databases. */
  claimPlacement?: (appId: string) => Promise<AllocatedCluster>;
  /** Override durable placement clearing on teardown (tests). Defaults to app_databases. */
  clearPlacement?: (appId: string, clusterId: string) => Promise<void>;
  /** Override the host->cluster resolver (teardown). Defaults to the repository. */
  resolveClusterByHost?: (
    host: string,
  ) => Promise<{ id: string; adminDsnEncrypted: string } | null>;
  /** Override the slot-release (teardown). Defaults to the repository. */
  releaseSlot?: (clusterId: string) => Promise<void>;
}

/**
 * Build the real node-side tenant-DB provisioning backend over the persistent
 * cluster pool + node-`pg`. Inject into `new UserDatabaseService(provisioning)`
 * (or the node deploy runner) so apps get isolated databases.
 */
export function makeTenantDbProvisioning(
  opts: MakeTenantDbProvisioningOpts = {},
): SqlTenantDbProvisioning {
  const store = opts.store ?? tenantDbClustersRepository;
  const pool = new ClusterPool(store);
  const decrypt = opts.decrypt ?? ((encrypted: string) => fieldEncryption.decrypt(encrypted));
  const genPassword = opts.genPassword ?? genRolePassword;

  const resolveClusterByHost =
    opts.resolveClusterByHost ?? ((host: string) => tenantDbClustersRepository.findByHost(host));
  const releaseSlot =
    opts.releaseSlot ?? ((clusterId: string) => tenantDbClustersRepository.releaseSlot(clusterId));
  const claimPlacement =
    opts.claimPlacement ??
    ((appId: string) => appDatabasesRepository.claimTenantDbPlacementForApp(appId));
  const clearPlacement =
    opts.clearPlacement ??
    ((appId: string, clusterId: string) =>
      appDatabasesRepository.clearTenantDbPlacementForApp(appId, clusterId));

  return new SqlTenantDbProvisioning({
    pool,
    decrypt,
    claimPlacement,
    clearPlacement,
    makeProvisioner: (cluster, adminDsn) =>
      new SqlTenantDbProvisioner({
        cluster,
        executor: new DirectPgExecutor(adminDsn),
        genPassword,
      }),
    resolveClusterByHost,
    releaseSlot,
  });
}
