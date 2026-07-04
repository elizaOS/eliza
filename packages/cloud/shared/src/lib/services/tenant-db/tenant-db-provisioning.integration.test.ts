/**
 * Tenant-DB provisioning — REAL Postgres integration (Apps / Product 2).
 *
 * Drives the FULL composed stack end-to-end against a live Postgres:
 *   makeTenantDbProvisioning -> ClusterPool -> tenantDbClustersRepository (real
 *   dbRead/dbWrite) -> SqlTenantDbProvisioner -> DirectPgExecutor (node-`pg`).
 *
 * It proves the load-bearing properties that mocks cannot:
 *   1. RACE SAFETY — two concurrent slot claims on a one-slot cluster: exactly
 *      one wins (the atomic `UPDATE ... WHERE database_count < max RETURNING`).
 *   2. TENANT ISOLATION — a provisioned app's DB is created atomically and is
 *      reachable by its OWN role, but another app's role is rejected by `REVOKE
 *      CONNECT ON DATABASE ... FROM PUBLIC` ("permission denied for database") —
 *      the hard CONNECT-boundary that keeps tenant data isolated.
 *
 * RUNNABLE WITHOUT EXTERNAL SECRETS. The test resolves a superuser Postgres in
 * this order (see ./__tests__/ephemeral-postgres.ts):
 *   1. `APPS_TENANT_DB_TEST_DSN` set        → use it directly (external PG).
 *   2. docker + opt-in (`TEST_LANE=post-merge` or `APPS_TENANT_DB_EPHEMERAL=1`)
 *                                           → boot a throwaway `postgres:16-alpine`.
 *   3. neither                              → SKIP LOUDLY (console.warn naming
 *                                              exactly how to enable it).
 * The resolved DSN backs BOTH the admin connection AND `DATABASE_URL` (the
 * repository's dbRead/dbWrite), so the whole stack hits one ephemeral cluster.
 *
 * Enable the live lane locally with docker present:
 *   APPS_TENANT_DB_EPHEMERAL=1 \
 *   bun test src/lib/services/tenant-db/tenant-db-provisioning.integration.test.ts
 * …or against your own Postgres:
 *   DATABASE_URL='postgresql://postgres:pw@localhost:5432/postgres?sslmode=disable' \
 *   APPS_TENANT_DB_TEST_DSN="$DATABASE_URL" \
 *   bun test src/lib/services/tenant-db/tenant-db-provisioning.integration.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { closeDatabaseConnectionsForTests } from "../../../db/client";
import { tenantDbClustersRepository } from "../../../db/repositories/tenant-db-clusters";
import { acquireEphemeralPostgres, type EphemeralPostgres } from "./__tests__/ephemeral-postgres";
import { ClusterPool, NoClusterCapacityError } from "./cluster-pool";
import { DirectPgExecutor } from "./direct-pg-executor";
import { makeTenantDbProvisioning } from "./make-tenant-db-provisioning";
import { deriveTenantIdent, SqlTenantDbProvisioner } from "./tenant-db-provisioner";

/** Resolved at runtime in beforeAll; `null` ⇒ the describe self-skips loudly. */
let pg: EphemeralPostgres | null = null;
let ADMIN_DSN = "";
let HOST = "";

const SKIP_REASON =
  "[E6 tenant-db isolation] SKIPPED — no superuser Postgres available. " +
  "This proves per-tenant DB CREATE + the cross-tenant CONNECT rejection " +
  "(REVOKE CONNECT FROM PUBLIC), which need a REAL Postgres. Enable it with:\n" +
  "  • docker present:   APPS_TENANT_DB_EPHEMERAL=1 bun test " +
  "src/lib/services/tenant-db/tenant-db-provisioning.integration.test.ts\n" +
  "  • or your own PG:   DATABASE_URL=<dsn> APPS_TENANT_DB_TEST_DSN=<same dsn> bun test …\n" +
  "  • CI post-merge lane (TEST_LANE=post-merge) opts in automatically when docker exists.";

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
  // FK-safe order (app_databases.app_id → apps; app_databases.tenant_db_cluster_id
  // → tenant_db_clusters). app_databases/apps are created by beforeAll for the
  // placement-reuse test; harmless no-op rows for the cluster-only tests.
  await adminExec("DELETE FROM app_databases; DELETE FROM apps; DELETE FROM tenant_db_clusters;");
}

/** Read an app's persisted tenant-DB cluster placement (null if unplaced). */
async function appPlacementClusterId(appId: string): Promise<string | null> {
  const client = new Client({ connectionString: ADMIN_DSN });
  await client.connect();
  try {
    const res = await client.query<{ tenant_db_cluster_id: string | null }>(
      "SELECT tenant_db_cluster_id FROM app_databases WHERE app_id = $1",
      [appId],
    );
    return res.rows[0]?.tenant_db_cluster_id ?? null;
  } finally {
    await client.end();
  }
}

/** Read a cluster's recorded slot count by host (NaN-safe). */
async function clusterDatabaseCount(host: string): Promise<number> {
  const client = new Client({ connectionString: ADMIN_DSN });
  await client.connect();
  try {
    const res = await client.query<{ database_count: number }>(
      "SELECT database_count FROM tenant_db_clusters WHERE host = $1",
      [host],
    );
    return Number(res.rows[0]?.database_count ?? -1);
  } finally {
    await client.end();
  }
}

// Resolve the ephemeral/external Postgres up front so the whole describe can be
// statically skipped (with a LOUD reason) when none is available. Synchronous
// `describe`/`describe.skip` selection requires the decision before the suite is
// registered, so the container boot happens here and stops in afterAll.
pg = await acquireEphemeralPostgres();
const RUN = pg !== null;
if (RUN && pg) {
  ADMIN_DSN = pg.dsn;
  HOST = pg.hostPort;
  // The repository's dbRead/dbWrite read DATABASE_URL lazily (per access) and
  // cache the connection by URL — set both to the SAME ephemeral cluster so the
  // tenant_db_clusters row and the admin DDL hit one Postgres.
  process.env.DATABASE_URL = ADMIN_DSN;
  process.env.TEST_DATABASE_URL = ADMIN_DSN;
} else {
  console.warn(SKIP_REASON);
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
    // Minimal apps + app_databases schema so the REAL durable-placement claimer
    // (claimTenantDbPlacementForApp) can be exercised end-to-end. The production
    // apps table has a deep FK chain irrelevant to placement; app_databases only
    // needs its own columns (matching schemas/app-databases.ts, incl. migration
    // 0151's tenant_db_cluster_id) and a satisfiable app_id FK, so apps is a bare
    // id stub.
    await adminExec(
      "DO $$ BEGIN CREATE TYPE user_database_status AS ENUM ('none','provisioning','ready','error'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;",
    );
    await adminExec("CREATE TABLE IF NOT EXISTS apps (id uuid PRIMARY KEY)");
    await adminExec(
      `CREATE TABLE IF NOT EXISTS app_databases (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        app_id uuid NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
        user_database_uri text,
        user_database_region text DEFAULT 'aws-us-east-1',
        user_database_status user_database_status NOT NULL DEFAULT 'none',
        user_database_error text,
        tenant_db_cluster_id uuid REFERENCES tenant_db_clusters(id) ON DELETE SET NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
    );
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
    await closeDatabaseConnectionsForTests().catch(() => {});
    await pg?.stop().catch(() => {});
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
    // This integration creates only tenant_db_clusters (not the whole cloud
    // apps/app_databases schema), so keep it on the compatibility pool seam while unit
    // tests cover the production placement claimer.
    const provisioning = makeTenantDbProvisioning({
      decrypt: async (x) => x,
      claimPlacement: () => new ClusterPool(tenantDbClustersRepository).allocate(),
    });

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

  test("SqlTenantDbProvisioner.provision() is DDL-idempotent against REAL Postgres: a re-run on the SAME cluster does not throw, rotates the DSN, and consumes NO cluster slot", async () => {
    // The load-bearing retry case the mocks cannot prove: against a live PG, a
    // second provision() hits an EXISTING role + database, so it must rely on the
    // DO-block swallowing `duplicate_object` (CREATE ROLE) and the `databaseExists`
    // gate skipping CREATE DATABASE — re-running the real DDL with no IF NOT EXISTS
    // would otherwise throw 42710 / 42P04.
    //
    // It drives SqlTenantDbProvisioner DIRECTLY on one fixed cluster — NOT
    // provisionForApp — because provisionForApp now owns durable app->cluster
    // placement. This test pins only the lower DDL layer: provisioner DDL
    // idempotency, and that this layer never touches the slot count.
    const SEED_COUNT = 7;
    await tenantDbClustersRepository.create({
      provider: "direct_pg",
      host: HOST,
      admin_dsn_encrypted: ADMIN_DSN!,
      max_databases: 100,
      database_count: SEED_COUNT,
      is_active: true,
    });

    const app = randomUUID();
    const ident = deriveTenantIdent(app);
    created.push({ role: ident.roleName, db: ident.dbName });

    let pw = 0;
    const provisioner = new SqlTenantDbProvisioner({
      cluster: { host: HOST },
      executor: new DirectPgExecutor(ADMIN_DSN),
      genPassword: () => `pw-real-${++pw}`,
    });

    const first = await provisioner.provision(app);
    const second = await provisioner.provision(app); // the deploy RETRY — same app, DB already there

    // Stable identifiers both times (derivation is stable), but the password rotated.
    expect(second.dbName).toBe(first.dbName);
    expect(second.roleName).toBe(first.roleName);
    expect(parseDsn(second.dsn).pw).not.toBe(parseDsn(first.dsn).pw);

    // The credential the retry handed back is the live one: the ALTER ROLE on the
    // second pass rotated the password, so ONLY the second DSN connects.
    expect(await connectAndPing(localize(second.dsn))).toBe(1);
    await expect(connectAndPing(localize(first.dsn))).rejects.toThrow();

    // The provisioner layer claims NO slot — re-running it is slot-neutral. (Slot
    // accounting lives in ClusterPool/provisionForApp, intentionally bypassed here.)
    expect(await clusterDatabaseCount(HOST)).toBe(SEED_COUNT);
  });

  test("#9686: a deploy RETRY for the SAME app reuses its durable cluster placement — provisionForApp twice claims ONE slot, not two", async () => {
    // The load-bearing property the mocked unit tests cannot prove against a real
    // database: the FOR UPDATE lock + existing-placement branch in
    // claimTenantDbPlacementForApp makes a second provisionForApp for the SAME
    // appId re-enter the same physical cluster WITHOUT a second tryClaimSlot. This
    // drives the REAL production claimer (claimPlacement defaults to
    // appDatabasesRepository.claimTenantDbPlacementForApp) — not the compatibility pool
    // seam the sibling tests inject — so the durable app->cluster placement that
    // closes #9686 is exercised end to end.
    const { id: clusterId } = await tenantDbClustersRepository.create({
      provider: "direct_pg",
      host: HOST,
      admin_dsn_encrypted: ADMIN_DSN!, // passthrough decrypt below
      max_databases: 100,
      database_count: 0,
      is_active: true,
    });

    const app = randomUUID();
    // app_databases.app_id FKs apps(id); production has the app row before deploy.
    await adminExec(`INSERT INTO apps (id) VALUES ('${app}')`);

    const provisioning = makeTenantDbProvisioning({ decrypt: async (x) => x });

    const r1 = await provisioning.provisionForApp(app);
    const r2 = await provisioning.provisionForApp(app); // the deploy RETRY — same appId

    // deriveTenantIdent is deterministic, so both calls target the SAME db/role;
    // one entry suffices for afterAll teardown.
    const t1 = parseDsn(r1.dsn);
    created.push({ role: t1.role, db: t1.db });

    // 1) Both calls land on the SAME physical cluster (placement reuse).
    expect(r1.clusterId).toBe(clusterId);
    expect(r2.clusterId).toBe(clusterId);

    // 2) THE BUG GUARD: the slot count incremented by EXACTLY 1, not 2. Before the
    //    #9686 fix, the retry called tryClaimSlot again and this would be 2 — a
    //    silent capacity leak.
    expect(await clusterDatabaseCount(HOST)).toBe(1);

    // 3) The placement is persisted on the app row and stable across the retry,
    //    so any number of further retries also re-enter this same cluster.
    expect(await appPlacementClusterId(app)).toBe(clusterId);

    const r3 = await provisioning.provisionForApp(app); // a third retry
    expect(r3.clusterId).toBe(clusterId);
    expect(await clusterDatabaseCount(HOST)).toBe(1); // still ONE slot, never climbs
  });
});
