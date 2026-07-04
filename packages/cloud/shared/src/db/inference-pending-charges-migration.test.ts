// Exercises cloud DB inference pending charges migration behavior with deterministic repository fixtures.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

/**
 * #9899 — the migration that creates the `inference_pending_charges` DB ledger
 * (the durable, exactly-once optimistic-billing backstop) must (a) exist and be
 * registered in the Drizzle journal so it actually runs in prod, (b) be additive
 * + idempotent (CREATE ... IF NOT EXISTS, guarded FKs) so re-running is safe, and
 * (c) carry the partial indexes the admission gate + sweep rely on. The schema
 * source-of-truth must be exported from the barrel so the Drizzle client and
 * future generations see it. These checks need no live DB.
 */
const migrationsDir = join(import.meta.dirname, "migrations");
const schemasDir = join(import.meta.dirname, "schemas");

describe("inference_pending_charges migration (#9899)", () => {
  const sqlPath = join(migrationsDir, "0153_inference_pending_charges.sql");

  it("migration file exists and is registered in the journal", () => {
    expect(existsSync(sqlPath)).toBe(true);
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((e) => e.tag === "0153_inference_pending_charges")).toBe(true);
  });

  it("creates the table additively + idempotently with the exactly-once PK", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "inference_pending_charges"/i);
    // request_id PK is the exactly-once idempotency key.
    expect(sql).toMatch(/"request_id" text PRIMARY KEY/i);
    // Guarded, idempotent FK adds (re-run safe).
    expect(sql).toMatch(/WHEN duplicate_object THEN null/i);
    expect(sql).toMatch(/REFERENCES "public"\."organizations"/i);
  });

  it("carries the partial indexes the admission gate + sweep depend on", () => {
    const sql = readFileSync(sqlPath, "utf8");
    // Age-ordered sweep cursor.
    expect(sql).toMatch(
      /inference_pending_charges_pending_age_idx[\s\S]*\("enqueued_at"\)\s*WHERE status = 'pending'/i,
    );
    // Per-org in-flight SUM for the atomic admission gate.
    expect(sql).toMatch(
      /inference_pending_charges_org_pending_idx[\s\S]*\("organization_id"\)\s*WHERE status = 'pending'/i,
    );
  });

  it("the schema source is exported from the barrel (Drizzle client + future gen)", () => {
    expect(existsSync(join(schemasDir, "inference-pending-charges.ts"))).toBe(true);
    const barrel = readFileSync(join(schemasDir, "index.ts"), "utf8");
    expect(barrel).toContain("./inference-pending-charges");
  });
});

/**
 * Apply the REAL migration-file bytes against in-process PGlite (real Postgres in
 * WASM) and prove the resulting table + partial indexes exist and that re-running
 * the file is idempotent — so the SQL is valid DDL, not just regex-matched text.
 * Self-skips if PGlite is unavailable.
 */
describe("inference_pending_charges migration applies to a real DB (#9899)", () => {
  const sqlPath = join(migrationsDir, "0153_inference_pending_charges.sql");
  let dbWrite: typeof import("./client").dbWrite;
  let closeDb: typeof import("./client").closeDatabaseConnectionsForTests | undefined;
  let pgliteReady = true;

  async function applyMigration(): Promise<void> {
    const file = readFileSync(sqlPath, "utf8");
    for (const stmt of file.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) await dbWrite.execute(trimmed);
    }
  }

  beforeAll(async () => {
    try {
      ({ dbWrite, closeDatabaseConnectionsForTests: closeDb } = await import("./client"));
      // FK targets the migration references must pre-exist.
      await dbWrite.execute(`CREATE TABLE IF NOT EXISTS organizations (id uuid PRIMARY KEY)`);
      await dbWrite.execute(`CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY)`);
      await dbWrite.execute(`DROP TABLE IF EXISTS inference_pending_charges`);
    } catch (error) {
      pgliteReady = false;
      console.warn("[migration] PGlite unavailable, skipping DB apply:", error);
    }
  }, 60000);

  afterAll(async () => {
    if (closeDb) await closeDb();
  });

  it("applies cleanly and creates the table, PK, and both partial indexes", async () => {
    if (!pgliteReady) return;
    await applyMigration();

    const cols = await dbWrite.execute(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'inference_pending_charges' ORDER BY column_name`,
    );
    const names = (cols.rows as { column_name: string }[]).map((r) => r.column_name);
    expect(names).toEqual(
      [
        "actual_cost_usd",
        "api_key_id",
        "billing_source",
        "enqueued_at",
        "estimated_cost_usd",
        "model",
        "organization_id",
        "provider",
        "request_id",
        "settled_at",
        "status",
        "user_id",
      ].sort(),
    );

    const idx = await dbWrite.execute(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'inference_pending_charges' ORDER BY indexname`,
    );
    const idxNames = (idx.rows as { indexname: string }[]).map((r) => r.indexname);
    expect(idxNames).toContain("inference_pending_charges_pending_age_idx");
    expect(idxNames).toContain("inference_pending_charges_org_pending_idx");
  }, 60000);

  it("is idempotent — re-applying the same file is a no-op (no duplicate-object error)", async () => {
    if (!pgliteReady) return;
    await applyMigration(); // second time
    const t = await dbWrite.execute(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'inference_pending_charges'`,
    );
    expect(Number((t.rows[0] as { n: number }).n)).toBe(1);
  }, 60000);
});
