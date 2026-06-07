/**
 * Tenant-DB provisioning — REAL Postgres integration (Apps / Product 2).
 *
 * Drives the FULL composed stack end-to-end against a live Postgres:
 *   makeTenantDbProvisioning -> ClusterPool -> tenantDbClustersRepository (real
 *   dbRead/dbWrite) -> SqlTenantDbProvisioner -> DirectPgExecutor (node-`pg`).
 *
 * It proves the two load-bearing properties that mocks cannot:
 *   1. RACE SAFETY — two concurrent slot claims on a one-slot cluster: exactly
 *      one wins (the atomic `UPDATE ... WHERE database_count < max RETURNING`).
 *   2. TENANT ISOLATION — a provisioned app reaches its OWN database but another
 *      app's role is rejected by `REVOKE CONNECT ON DATABASE ... FROM PUBLIC`
 *      ("permission denied for database") — the hard auth-layer boundary.
 *
 * GATED: runs only when `APPS_TENANT_DB_TEST_DSN` is set to a superuser admin
 * DSN (e.g. `postgresql://postgres:pw@localhost:55432/postgres?sslmode=disable`).
 * `DATABASE_URL` MUST point at the SAME database so the repository's dbRead/
 * dbWrite hit it. With no DSN the whole describe is skipped, so CI stays green
 * without infra. Local run:
 *
 *   DATABASE_URL='postgresql://postgres:adminpw@localhost:55432/postgres?sslmode=disable' \
 *   APPS_TENANT_DB_TEST_DSN="$DATABASE_URL" \
 *   bun test src/lib/services/tenant-db/tenant-db-provisioning.integration.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { tenantDbClustersRepository } from "../../../db/repositories/tenant-db-clusters";
import { ClusterPool, NoClusterCapacityError } from "./cluster-pool";
import { makeTenantDbProvisioning } from "./make-tenant-db-provisioning";

const ADMIN_DSN = process.env.APPS_TENANT_DB_TEST_DSN;
const HOST = process.env.APPS_TENANT_DB_TEST_HOST ?? "localhost:55432";
const RUN = Boolean(ADMIN_DSN);

/** Identities created during the run, dropped in afterAll. */
const created: Array<{ role: string; db: string }> = [];

async function adminExec(sql: string): Promise<void> {
  const client = new Client({ connectionString: ADMIN_DSN });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Connect with a tenant DSN and ping; resolves to 1 on success, rejects otherwise. */
async function connectAndPing(dsn: string): Promise<number> {
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    const res = await client.query<{ one: number }>("SELECT 1 AS one");
    return res.rows[0]?.one ?? -1;
  } finally {
    await client.end();
  }
}

/** Tenant DSNs carry `sslmode=require`; the local test PG has no TLS. */
function localize(dsn: string): string {
  return dsn.replace("sslmode=require", "sslmode=disable");
}

function parseDsn(dsn: string): { role: string; pw: string; db: string } {
  const u = new URL(dsn);
  return { role: u.username, pw: u.password, db: u.pathname.replace(/^\//, "") };
}

async function resetClusters(): Promise<void> {
  await adminExec("DELETE FROM tenant_db_clusters");
}

const d = RUN ? describe : describe.skip;

d("tenant-db provisioning over real Postgres", () => {
  beforeAll(async () => {
    // Apply migration 0140 idempotently (CREATE TABLE/INDEX IF NOT EXISTS).
    const sql = readFileSync(
      join(import.meta.dir, "../../../db/migrations/0140_tenant_db_clusters.sql"),
      "utf8",
    );
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await adminExec(trimmed);
    }
  });

  beforeEach(async () => {
    await resetClusters();
  });

  afterAll(async () => {
    for (const { role, db } of created) {
      await adminExec(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
      await adminExec(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    }
    await resetClusters().catch(() => {});
  });

  test("two concurrent claims on a one-slot cluster: exactly one wins", async () => {
    const { id } = await tenantDbClustersRepository.create({
      provider: "direct_pg",
      host: HOST,
      admin_dsn_encrypted: ADMIN_DSN!,
      max_databases: 5,
      database_count: 4, // exactly one slot left
      is_active: true,
    });

    const [a, b] = await Promise.all([
      tenantDbClustersRepository.tryClaimSlot(id),
      tenantDbClustersRepository.tryClaimSlot(id),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1); // never overfills
    expect(await tenantDbClustersRepository.tryClaimSlot(id)).toBe(false); // now full

    // Pool sees no allocatable capacity once the only cluster is full.
    await expect(new ClusterPool(tenantDbClustersRepository).allocate()).rejects.toBeInstanceOf(
      NoClusterCapacityError,
    );
  });

  test("provisionForApp gives an isolated DB reachable only by its own role", async () => {
    await tenantDbClustersRepository.create({
      provider: "direct_pg",
      host: HOST,
      admin_dsn_encrypted: ADMIN_DSN!, // passthrough decrypt below
      max_databases: 100,
      database_count: 0,
      is_active: true,
    });

    // decrypt passthrough: the column holds the plaintext admin DSN for the test.
    const provisioning = makeTenantDbProvisioning({ decrypt: async (x) => x });

    const app1 = randomUUID();
    const app2 = randomUUID();
    const r1 = await provisioning.provisionForApp(app1);
    const r2 = await provisioning.provisionForApp(app2);

    const t1 = parseDsn(r1.dsn);
    const t2 = parseDsn(r2.dsn);
    created.push({ role: t1.role, db: t1.db }, { role: t2.role, db: t2.db });

    // 1) Each app reaches its OWN database.
    expect(await connectAndPing(localize(r1.dsn))).toBe(1);
    expect(await connectAndPing(localize(r2.dsn))).toBe(1);

    // 2) Cross-tenant is rejected at the database CONNECT boundary: app2's role
    //    cannot open app1's database (REVOKE CONNECT ... FROM PUBLIC).
    const crossDsn = `postgresql://${encodeURIComponent(t2.role)}:${encodeURIComponent(
      t2.pw,
    )}@${HOST}/${t1.db}?sslmode=disable`;
    await expect(connectAndPing(crossDsn)).rejects.toThrow(/permission denied for database/i);

    // The allocator recorded both placements on the cluster.
    expect(r1.clusterId).toBe(r2.clusterId);
  });
});
