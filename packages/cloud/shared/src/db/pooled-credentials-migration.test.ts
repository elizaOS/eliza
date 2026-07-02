/**
 * #11332 — migration UP for the team credential pool, executed for real.
 *
 * Applies the actual `0164_pooled_credentials.sql` file (statement by
 * statement, exactly how the migrator splits on `--> statement-breakpoint`)
 * against an in-process PGlite that carries the prerequisite tables
 * (organizations / users / secrets), then proves the resulting schema
 * behaves: inserts succeed, the FKs reject orphans, the rollup unique index
 * upserts, and re-running the migration is a no-op (IF NOT EXISTS
 * idempotency). Also pins journal registration so the migration actually
 * runs in prod.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const migrationsDir = join(import.meta.dirname, "migrations");
const sqlPath = join(migrationsDir, "0164_pooled_credentials.sql");

let pgliteReady = true;
let dbWrite: typeof import("./client").dbWrite;
let closeDb: (() => Promise<void>) | undefined;

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-1111-4111-8111-111111111111";
const SECRET_A = "cccccccc-1111-4111-8111-111111111111";
const SECRET_B = "cccccccc-2222-4222-8222-222222222222";

function migrationStatements(): string[] {
  return readFileSync(sqlPath, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyMigration(): Promise<void> {
  for (const statement of migrationStatements()) {
    await dbWrite.execute(statement);
  }
}

beforeAll(async () => {
  try {
    ({ dbWrite, closeDatabaseConnectionsForTests: closeDb } = await import("./client"));
    const { organizations } = await import("./schemas/organizations");
    const { users } = await import("./schemas/users");
    const {
      secretActorTypeEnum,
      secretAuditActionEnum,
      secretEnvironmentEnum,
      secretProjectTypeEnum,
      secretProviderEnum,
      secretScopeEnum,
      secrets,
    } = await import("./schemas/secrets");
    const { pushSchema } = await import("./push-schema-for-tests");
    // Prerequisites only — the tables under test come from the SQL file.
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        secrets,
        secretScopeEnum,
        secretEnvironmentEnum,
        secretAuditActionEnum,
        secretActorTypeEnum,
        secretProviderEnum,
        secretProjectTypeEnum,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite.insert(organizations).values([{ id: ORG, name: "Org", slug: "org-mig" }]);
    await dbWrite.insert(users).values([
      {
        id: USER,
        email: "mig@test.test",
        organization_id: ORG,
        role: "owner",
        steward_user_id: `steward-${USER}`,
      },
    ]);
    for (const id of [SECRET_A, SECRET_B]) {
      await dbWrite.execute(
        `INSERT INTO secrets (id, organization_id, name, encrypted_value, encryption_key_id, encrypted_dek, nonce, auth_tag, created_by)
         VALUES ('${id}', '${ORG}', 'pooled/mig/${id}', 'ct', 'k1', 'dek', 'n', 't', '${USER}');`,
      );
    }
  } catch (error) {
    pgliteReady = false;
    console.error("[pooled-credentials-migration.test] setup failed — failing.", error);
  }
}, 120_000);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("0164_pooled_credentials migration up (#11332)", () => {
  test("is registered in the drizzle journal", () => {
    expect(existsSync(sqlPath)).toBe(true);
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.at(-1)?.tag).toBe("0164_pooled_credentials");
  });

  test("applies cleanly and creates both tables + the unique indexes", async () => {
    expect(pgliteReady).toBe(true);
    await applyMigration();
    const tables = await dbWrite.execute(
      `SELECT tablename FROM pg_tables WHERE tablename IN ('pooled_credentials','pooled_credential_usage');`,
    );
    expect(tables.rows).toHaveLength(2);
    const indexes = await dbWrite.execute(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('pooled_credentials_secret_id_idx','pooled_credential_usage_cred_user_day_idx');`,
    );
    expect(indexes.rows).toHaveLength(2);
  });

  test("re-running the migration is a no-op (IF NOT EXISTS idempotency)", async () => {
    await applyMigration();
    const tables = await dbWrite.execute(
      `SELECT tablename FROM pg_tables WHERE tablename IN ('pooled_credentials','pooled_credential_usage');`,
    );
    expect(tables.rows).toHaveLength(2);
  });

  test("schema behaves: inserts land, FKs reject orphans, rollup unique upserts", async () => {
    await dbWrite.execute(
      `INSERT INTO pooled_credentials (id, organization_id, provider, secret_id, label, key_last4, contributed_by)
       VALUES ('dddddddd-1111-4111-8111-111111111111', '${ORG}', 'anthropic-api', '${SECRET_A}', 'mig key', '1234', '${USER}');`,
    );
    // FK: unknown secret is rejected. (async wrapper: execute() is a lazy
    // thenable, .rejects needs a real promise)
    await expect(
      (async () =>
        await dbWrite.execute(
          `INSERT INTO pooled_credentials (organization_id, provider, secret_id, label, key_last4)
           VALUES ('${ORG}', 'anthropic-api', '99999999-9999-4999-8999-999999999999', 'orphan', '0000');`,
        ))(),
    ).rejects.toThrow();
    // Rollup unique (credential, user, day): second insert must conflict.
    await dbWrite.execute(
      `INSERT INTO pooled_credential_usage (organization_id, credential_id, user_id, day, calls)
       VALUES ('${ORG}', 'dddddddd-1111-4111-8111-111111111111', '${USER}', '2026-07-02', 1);`,
    );
    await expect(
      (async () =>
        await dbWrite.execute(
          `INSERT INTO pooled_credential_usage (organization_id, credential_id, user_id, day, calls)
           VALUES ('${ORG}', 'dddddddd-1111-4111-8111-111111111111', '${USER}', '2026-07-02', 1);`,
        ))(),
    ).rejects.toThrow();
    // ON CONFLICT path (what recordDailyUsage uses) increments instead.
    await dbWrite.execute(
      `INSERT INTO pooled_credential_usage (organization_id, credential_id, user_id, day, calls)
       VALUES ('${ORG}', 'dddddddd-1111-4111-8111-111111111111', '${USER}', '2026-07-02', 1)
       ON CONFLICT (credential_id, user_id, day) DO UPDATE SET calls = pooled_credential_usage.calls + 1;`,
    );
    const rollup = await dbWrite.execute(
      `SELECT calls FROM pooled_credential_usage WHERE user_id = '${USER}';`,
    );
    expect((rollup.rows[0] as { calls: number }).calls).toBe(2);
    // Cascade: deleting the credential clears its rollups.
    await dbWrite.execute(
      `DELETE FROM pooled_credentials WHERE id = 'dddddddd-1111-4111-8111-111111111111';`,
    );
    const left = await dbWrite.execute(`SELECT id FROM pooled_credential_usage;`);
    expect(left.rows).toHaveLength(0);
  });
});
