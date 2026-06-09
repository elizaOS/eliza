import { describe, expect, test } from "bun:test";
import type { AllocatedCluster } from "../cluster-pool";
import {
  SqlTenantDbProvisioning,
  type SqlTenantDbProvisioningDeps,
  type TenantDbProvisioner,
} from "../tenant-db-provisioning";

const ALLOCATED: AllocatedCluster = {
  id: "cluster-1",
  host: "apps-cluster-1:5432",
  adminDsnEncrypted: "enc:v1:admin-dsn",
};

const PROVISIONED_DSN = "postgresql://app_x:pw@apps-cluster-1:5432/db_app_x?sslmode=require";

function deps(
  over: Partial<SqlTenantDbProvisioningDeps> = {},
): SqlTenantDbProvisioningDeps & { seen: Record<string, unknown> } {
  const seen: Record<string, unknown> = {};
  const base: SqlTenantDbProvisioningDeps = {
    pool: {
      async allocate() {
        return ALLOCATED;
      },
      async release() {
        seen.releasedCluster = true;
        return true;
      },
      async findById(clusterId) {
        seen.foundCluster = clusterId;
        return ALLOCATED;
      },
    },
    async decrypt(enc) {
      seen.decryptedArg = enc;
      return "postgresql://admin:pw@apps-cluster-1:5432/postgres";
    },
    makeProvisioner(cluster, adminDsn): TenantDbProvisioner {
      seen.providerCluster = cluster;
      seen.providerAdminDsn = adminDsn;
      return {
        async provision(appId) {
          seen.provisionedApp = appId;
          return { dbName: "db_app_x", roleName: "app_x", dsn: PROVISIONED_DSN };
        },
        async deprovision(appId) {
          seen.deprovisionedApp = appId;
        },
      };
    },
  };
  return { ...base, ...over, seen };
}

describe("SqlTenantDbProvisioning", () => {
  test("provisions on the allocated cluster and returns the real isolated DSN", async () => {
    const d = deps();
    const result = await new SqlTenantDbProvisioning(d).provisionForApp("app-1");

    expect(result).toEqual({ dsn: PROVISIONED_DSN, clusterId: "cluster-1" });
    // it decrypted THIS cluster's admin dsn and handed it to the provisioner
    expect(d.seen.decryptedArg).toBe("enc:v1:admin-dsn");
    expect(d.seen.providerAdminDsn).toBe("postgresql://admin:pw@apps-cluster-1:5432/postgres");
    expect(d.seen.providerCluster).toEqual({ host: "apps-cluster-1:5432" });
    expect(d.seen.provisionedApp).toBe("app-1");
  });

  test("the returned DSN is the per-tenant one, never the shared env DATABASE_URL", async () => {
    process.env.DATABASE_URL = "postgresql://SHARED@shared/agentdb";
    const result = await new SqlTenantDbProvisioning(deps()).provisionForApp("app-1");
    expect(result.dsn).toBe(PROVISIONED_DSN);
    expect(result.dsn).not.toContain("SHARED");
  });

  test("propagates a NoClusterCapacity failure from the pool", async () => {
    const d = deps({
      pool: {
        async allocate() {
          throw new Error("No tenant DB cluster has capacity");
        },
        async release() {
          return true;
        },
        async findById() {
          return null;
        },
      },
    });
    await expect(new SqlTenantDbProvisioning(d).provisionForApp("app-1")).rejects.toThrow(
      "capacity",
    );
  });

  test("deprovisionForApp resolves the cluster by host, DROPs the DB, releases the slot", async () => {
    const released: string[] = [];
    const d = deps({
      async resolveClusterByHost(host) {
        d.seen.resolvedHost = host;
        return { id: "cluster-1", adminDsnEncrypted: "enc:v1:admin-dsn" };
      },
      async releaseSlot(clusterId) {
        released.push(clusterId);
      },
    });
    const result = await new SqlTenantDbProvisioning(d).deprovisionForApp("app-1", PROVISIONED_DSN);

    expect(result).toEqual({ deprovisioned: true });
    expect(d.seen.resolvedHost).toBe("apps-cluster-1"); // host parsed from the stored DSN
    expect(d.seen.deprovisionedApp).toBe("app-1"); // the DROP ran on that cluster
    expect(released).toEqual(["cluster-1"]); // the slot was released
  });

  test("deprovisionForApp throws a clear error when the teardown deps aren't wired", async () => {
    // base deps() has no resolveClusterByHost / releaseSlot
    await expect(
      new SqlTenantDbProvisioning(deps()).deprovisionForApp("app-1", PROVISIONED_DSN),
    ).rejects.toThrow("not configured");
  });
});
