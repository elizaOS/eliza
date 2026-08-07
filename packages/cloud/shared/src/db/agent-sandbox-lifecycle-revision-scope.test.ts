/**
 * Applies the lifecycle-revision trigger to a real PGlite table and proves what
 * the counter means: it advances for a lifecycle write, stays put for a
 * billing-only write, and cannot be forged by a writer that supplies its own
 * value. The last suite is a drift guard over the migration text itself.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const SANDBOX_ID = "00000000-0000-4000-8000-000000017694";
const migrationUrl = new URL(
  "./migrations/0189_agent_sandbox_lifecycle_revision_scope.sql",
  import.meta.url,
);
const migrationSql = readFileSync(fileURLToPath(migrationUrl), "utf8");

let dbWrite: typeof import("./client").dbWrite;
let closeDb: typeof import("./client").closeDatabaseConnectionsForTests | undefined;
let databaseReady = true;

async function revision(): Promise<number> {
  const rows = await dbWrite.execute(
    `SELECT lifecycle_revision FROM agent_sandboxes WHERE id = '${SANDBOX_ID}'`,
  );
  return Number(
    (rows as unknown as { rows: Array<{ lifecycle_revision: string }> }).rows[0].lifecycle_revision,
  );
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("./client"));
    // The WHEN clause is `to_jsonb(OLD) - ARRAY[...]`, so it ranges over
    // whatever columns the table actually has. A hand-rolled subset would be the
    // one shape where the trigger under test sees a different row than
    // production does, and `jsonb - text[]` ignores absent keys silently.
    const { PROVISIONING_JOB_TEST_TABLES } = await import(
      "../lib/services/__tests__/tier-upgrade-pglite-schema"
    );
    for (const ddl of PROVISIONING_JOB_TEST_TABLES) {
      // The table only — the migration under test installs the function and the
      // trigger, and the shared block still carries the 0187 pair.
      if (ddl.includes('CREATE TABLE IF NOT EXISTS "agent_sandboxes"')) {
        await dbWrite.execute(ddl);
      }
    }
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      if (statement.trim()) await dbWrite.execute(statement);
    }
  } catch (error) {
    databaseReady = false;
    console.warn("[lifecycle-revision-scope] PGlite setup failed", error);
  }
}, TIMEOUT);

afterAll(async () => {
  await closeDb?.();
});

describe("agent_sandboxes lifecycle-revision trigger", () => {
  beforeAll(async () => {
    if (!databaseReady) return;
    await dbWrite.execute(`
      INSERT INTO agent_sandboxes (id, organization_id, user_id, status, billing_status)
      VALUES ('${SANDBOX_ID}', '00000000-0000-4000-8000-000000000001',
              '00000000-0000-4000-8000-000000000002', 'provisioning', 'active')
      ON CONFLICT (id) DO NOTHING;
    `);
  }, TIMEOUT);

  test(
    "a billing-cycle write leaves the revision alone",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      const before = await revision();

      // Exactly what active-billing.ts writes on suspension.
      await dbWrite.execute(`
        UPDATE agent_sandboxes
        SET billing_status = 'suspended',
            scheduled_shutdown_at = NULL,
            shutdown_warning_sent_at = NULL,
            updated_at = now()
        WHERE id = '${SANDBOX_ID}';
      `);

      expect(await revision()).toBe(before);
    },
    TIMEOUT,
  );

  test(
    "the hourly billing write leaves the revision alone",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      const before = await revision();

      await dbWrite.execute(`
        UPDATE agent_sandboxes
        SET last_billed_at = now(),
            billing_status = 'active',
            hourly_rate = '0.25',
            total_billed = COALESCE(total_billed, 0) + 0.25,
            scheduled_shutdown_at = NULL,
            shutdown_warning_sent_at = NULL,
            updated_at = now()
        WHERE id = '${SANDBOX_ID}';
      `);

      expect(await revision()).toBe(before);
    },
    TIMEOUT,
  );

  test(
    "a lifecycle write still advances the revision",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      const before = await revision();

      await dbWrite.execute(`
        UPDATE agent_sandboxes SET status = 'running', updated_at = now()
        WHERE id = '${SANDBOX_ID}';
      `);
      expect(await revision()).toBe(before + 1);

      await dbWrite.execute(`
        UPDATE agent_sandboxes SET environment_revision = environment_revision + 1
        WHERE id = '${SANDBOX_ID}';
      `);
      expect(await revision()).toBe(before + 2);

      await dbWrite.execute(`
        UPDATE agent_sandboxes SET warm_claim_credential_state = 'revoking'
        WHERE id = '${SANDBOX_ID}';
      `);
      expect(await revision()).toBe(before + 3);
    },
    TIMEOUT,
  );

  test(
    "a billing write that also sets the revision by hand cannot forge it",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      const before = await revision();

      // The revision is not in the excluded set precisely so this fires.
      await dbWrite.execute(`
        UPDATE agent_sandboxes
        SET billing_status = 'suspended', lifecycle_revision = -100
        WHERE id = '${SANDBOX_ID}';
      `);

      expect(await revision()).toBe(before + 1);
    },
    TIMEOUT,
  );

  test(
    "an update that changes nothing at all leaves the revision alone",
    async () => {
      if (!databaseReady) throw new Error("PGlite unavailable");
      const before = await revision();

      await dbWrite.execute(`
        UPDATE agent_sandboxes SET status = status WHERE id = '${SANDBOX_ID}';
      `);

      expect(await revision()).toBe(before);
    },
    TIMEOUT,
  );
});

describe("lifecycle-revision exclusion list drift guard", () => {
  // The trigger's blind spot is whatever the migration excludes. If a fence is
  // ever added on one of those columns, the fence silently stops working: the
  // write it wants to detect no longer advances the counter. This reads both
  // sides from source rather than asking anyone to remember.
  const excluded = new Set(
    Array.from(migrationSql.matchAll(/^\s*'([a-z_]+)',?$/gm), (match) => match[1]),
  );

  test("the migration really does exclude the billing columns and nothing else", () => {
    expect([...excluded].sort()).toEqual([
      "billing_status",
      "hourly_rate",
      "last_billed_at",
      "scheduled_shutdown_at",
      "shutdown_warning_sent_at",
      "total_billed",
      "updated_at",
    ]);
  });

  test("the counter itself is compared, so a supplied value cannot survive", () => {
    expect(excluded.has("lifecycle_revision")).toBe(false);
  });

  // Every fence, from both files and both spellings: raw SQL predicates and the
  // Drizzle builder. Scanning one file or one form fails open — which is the
  // failure mode this guard exists to prevent.
  function scanFences(): Set<string> {
    const columns = new Set(
      Array.from(
        readFileSync(
          fileURLToPath(new URL("./schemas/agent-sandboxes.ts", import.meta.url)),
          "utf8",
        ).matchAll(/^\s{4}([a-z_]+):/gm),
        (match) => match[1],
      ),
    );

    const fenced = new Set<string>();
    for (const source of [
      "../lib/services/eliza-sandbox.ts",
      "./repositories/agent-sandboxes.ts",
    ]) {
      const text = readFileSync(fileURLToPath(new URL(source, import.meta.url)), "utf8");
      // Look both ways: the revision is not always last in its predicate, and
      // assuming it is made an earlier version of this window silently wrong.
      for (const at of text.matchAll(/lifecycle_revision|lifecycleRevision/g)) {
        const index = at.index ?? 0;
        const window = text.slice(Math.max(0, index - 1500), index + 1500);
        for (const [, column] of window.matchAll(/AND\s+([a-z_]+)\s+(?:=|IS)/g)) {
          if (columns.has(column)) fenced.add(column);
        }
        for (const [, column] of window.matchAll(/eq\(\s*agentSandboxes\.([a-z_]+)/g)) {
          if (columns.has(column)) fenced.add(column);
        }
      }
    }
    fenced.delete("lifecycle_revision");
    return fenced;
  }

  test("no column a lifecycle fence compares on is excluded", () => {
    expect([...scanFences()].filter((column) => excluded.has(column))).toEqual([]);
  });

  test("the scan reaches both fence files and both fence spellings", () => {
    // Structural pins rather than a count floor: a count only fails once the
    // number happens to drop below it, so it can lose a whole source silently.
    // Each of these dies with exactly one gap: `execution_tier` is fenced only
    // in the repository file, `id` only through the Drizzle builder, and
    // `warm_claim_attested_at` only ahead of its predicate's revision clause.
    const fenced = scanFences();
    expect(fenced.has("execution_tier")).toBe(true);
    expect(fenced.has("id")).toBe(true);
    expect(fenced.has("warm_claim_attested_at")).toBe(true);
  });
});
