// Exercises tenant db placement claimer behavior with deterministic cloud-shared lib fixtures.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { dbWrite as DbWrite } from "../../../db/client";
import type { AppDatabasesRepository } from "../../../db/repositories/app-databases";
import type { TenantDbClustersRepository } from "../../../db/repositories/tenant-db-clusters";
import { SqlTenantDbProvisioning, type TenantDbProvisioner } from "./tenant-db-provisioning";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const PROVISIONED_DSN = "postgresql://app_x:pw@apps-cluster-1:5432/db_app_x?sslmode=require";

let dataDir = "";
let dbWrite: typeof DbWrite;
let closeDatabaseConnectionsForTests: () => Promise<void>;
let appDatabasesRepository: AppDatabasesRepository;
let tenantDbClustersRepository: TenantDbClustersRepository;

async function applySqlStatements(sqlText: string): Promise<void> {
  for (const stmt of sqlText.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) {
      await dbWrite.execute(trimmed);
    }
  }
}

async function clusterDatabaseCount(clusterId: string): Promise<number> {
  const result = await dbWrite.execute(
    `SELECT database_count FROM tenant_db_clusters WHERE id = '${clusterId}'`,
  );
  const row = result.rows?.[0] as { database_count?: number | string } | undefined;
  return Number(row?.database_count ?? -1);
}

describe("tenant DB durable placement claimer", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "tenant-db-placement-"));
    process.env.DATABASE_URL = `pglite://${dataDir}`;
    process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;

    const client = await import("../../../db/client");
    const appDbs = await import("../../../db/repositories/app-databases");
    const tenantClusters = await import("../../../db/repositories/tenant-db-clusters");
    dbWrite = client.dbWrite;
    closeDatabaseConnectionsForTests = client.closeDatabaseConnectionsForTests;
    appDatabasesRepository = appDbs.appDatabasesRepository;
    tenantDbClustersRepository = tenantClusters.tenantDbClustersRepository;

    await dbWrite.execute(`
      DO $$ BEGIN
        CREATE TYPE user_database_status AS ENUM ('none', 'provisioning', 'ready', 'error');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await dbWrite.execute(`
      CREATE TABLE IF NOT EXISTS apps (
        id uuid PRIMARY KEY
      );
    `);
    await dbWrite.execute(`
      CREATE TABLE IF NOT EXISTS app_databases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL UNIQUE REFERENCES apps(id) ON DELETE cascade,
        user_database_uri text,
        user_database_region text DEFAULT 'aws-us-east-1',
        user_database_status user_database_status NOT NULL DEFAULT 'none',
        user_database_error text,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL
      );
    `);

    await applySqlStatements(
      readFileSync(
        path.join(import.meta.dir, "../../../db/migrations/0140_tenant_db_clusters.sql"),
        "utf8",
      ),
    );
    await applySqlStatements(
      readFileSync(
        path.join(
          import.meta.dir,
          "../../../db/migrations/0151_app_database_tenant_cluster_placement.sql",
        ),
        "utf8",
      ),
    );
  });

  beforeEach(async () => {
    await dbWrite.execute(`DELETE FROM app_databases`);
    await dbWrite.execute(`DELETE FROM apps`);
    await dbWrite.execute(`DELETE FROM tenant_db_clusters`);
    await dbWrite.execute(`INSERT INTO apps (id) VALUES ('${APP_ID}')`);
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests?.().catch(() => {});
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("provisionForApp retry reuses the same real placement without claiming a second slot", async () => {
    const cluster = await tenantDbClustersRepository.create({
      provider: "direct_pg",
      host: "apps-cluster-1:5432",
      admin_dsn_encrypted: "enc:v1:admin-dsn",
      max_databases: 10,
      database_count: 0,
      is_active: true,
    });

    const provisionedApps: string[] = [];
    const provisioning = new SqlTenantDbProvisioning({
      pool: {
        async allocate() {
          throw new Error("pool allocation should not be used when claimPlacement is wired");
        },
      },
      claimPlacement: (appId) => appDatabasesRepository.claimTenantDbPlacementForApp(appId),
      decrypt: async (value) => value,
      makeProvisioner(): TenantDbProvisioner {
        return {
          async provision(appId) {
            provisionedApps.push(appId);
            return {
              dbName: "db_app_x",
              roleName: "app_x",
              dsn: PROVISIONED_DSN,
            };
          },
          async deprovision() {
            return { existed: true };
          },
        };
      },
    });

    const first = await provisioning.provisionForApp(APP_ID);
    const afterFirst = await clusterDatabaseCount(cluster.id);
    const second = await provisioning.provisionForApp(APP_ID);
    const afterSecond = await clusterDatabaseCount(cluster.id);
    const placement = await appDatabasesRepository.findTenantDbPlacementByAppId(APP_ID);

    expect(first.clusterId).toBe(cluster.id);
    expect(second.clusterId).toBe(cluster.id);
    expect(placement?.id).toBe(cluster.id);
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
    expect(provisionedApps).toEqual([APP_ID, APP_ID]);
  });
});
