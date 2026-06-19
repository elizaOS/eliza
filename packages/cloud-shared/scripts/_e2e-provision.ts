/**
 * E2E provisioning helper (Apps / Product 2) — host-side half of the real
 * container↔isolated-DB verification (see verify-e2e-container-db.sh).
 *
 * Drives the REAL composed stack (makeTenantDbProvisioning -> ClusterPool ->
 * tenantDbClustersRepository -> SqlTenantDbProvisioner -> DirectPgExecutor)
 * against a throwaway tenant Postgres, then prints the two tenants' DSNs as JSON
 * so the bash orchestrator can run real app containers that connect with them.
 *
 * Env:
 *   ADMIN_DSN     superuser admin DSN the host-side provisioner connects with
 *                 (host-published, e.g. postgresql://postgres:pw@localhost:55444/postgres?sslmode=disable)
 *   CLUSTER_HOST  the in-docker-network address the APP CONTAINER uses to reach
 *                 the same PG (e.g. apps-tenant-pg:5432) — becomes the DSN host
 *   DATABASE_URL  must equal ADMIN_DSN so the repository's dbWrite hits this PG
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { tenantDbClustersRepository } from "../src/db/repositories/tenant-db-clusters";
import { makeTenantDbProvisioning } from "../src/lib/services/tenant-db/make-tenant-db-provisioning";
import { deriveTenantIdent } from "../src/lib/services/tenant-db/tenant-db-provisioner";

const ADMIN_DSN = process.env.ADMIN_DSN!;
const CLUSTER_HOST = process.env.CLUSTER_HOST!;
const APP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function adminExec(sql: string): Promise<void> {
  const c = new Client({ connectionString: ADMIN_DSN });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

// 1. Apply migration 0140 to the throwaway tenant PG (idempotent).
const migration = readFileSync("./src/db/migrations/0140_tenant_db_clusters.sql", "utf8");
for (const stmt of migration.split("--> statement-breakpoint")) {
  if (stmt.trim()) await adminExec(stmt.trim());
}
await adminExec("DELETE FROM tenant_db_clusters");

// 2. Seed a cluster whose host is the CONTAINER-reachable address; the admin DSN
//    (host-published) is what DirectPgExecutor connects with to run the DDL.
await tenantDbClustersRepository.create({
  provider: "direct_pg",
  host: CLUSTER_HOST,
  admin_dsn_encrypted: ADMIN_DSN, // passthrough decrypt below
  max_databases: 100,
  database_count: 0,
  is_active: true,
});

// 3. Provision two tenants through the real composer.
const provisioning = makeTenantDbProvisioning({
  decrypt: async (x) => x,
  genPassword: () => randomBytes(18).toString("base64url"),
});
const a = await provisioning.provisionForApp(APP_A);
const b = await provisioning.provisionForApp(APP_B);

const identA = deriveTenantIdent(APP_A);
const identB = deriveTenantIdent(APP_B);

process.stdout.write(
  `${JSON.stringify({
    a: { dsn: a.dsn, role: identA.roleName, db: identA.dbName },
    b: { dsn: b.dsn, role: identB.roleName, db: identB.dbName },
  })}\n`,
);
process.exit(0);
