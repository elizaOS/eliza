/** Verifies the real source-app migration backfill and deletion-resistant attribution. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const grantsMigrationUrl = new URL(
  "./migrations/0277_mobile_app_auth_pkce_grants.sql",
  import.meta.url,
);
const attributionMigrationUrl = new URL(
  "./migrations/0278_mobile_auth_source_app.sql",
  import.meta.url,
);
const journalUrl = new URL("./migrations/meta/_journal.json", import.meta.url);
const APP_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";

let dbWrite: typeof import("./client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("./client").closeDatabaseConnectionsForTests
  | undefined;

async function applyMigration(url: URL): Promise<void> {
  for (const statement of readFileSync(url, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(statement);
  }
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("./client"));
  await dbWrite.execute("CREATE TABLE organizations (id uuid PRIMARY KEY)");
  await dbWrite.execute("CREATE TABLE users (id uuid PRIMARY KEY)");
  await dbWrite.execute("CREATE TABLE apps (id uuid PRIMARY KEY)");
  await dbWrite.execute("CREATE TABLE api_keys (id uuid PRIMARY KEY)");
  await applyMigration(grantsMigrationUrl);
  await dbWrite.execute(`INSERT INTO organizations (id) VALUES ('${ORGANIZATION_ID}')`);
  await dbWrite.execute(`INSERT INTO users (id) VALUES ('${USER_ID}')`);
  await dbWrite.execute(`INSERT INTO apps (id) VALUES ('${APP_ID}')`);
  await dbWrite.execute(`INSERT INTO api_keys (id) VALUES ('${CREDENTIAL_ID}')`);
  await dbWrite.execute(
    `INSERT INTO mobile_app_auth_grants
     (code_hash, app_id, client_id, user_id, organization_id, environment,
      redirect_uri, state_hash, code_challenge, code_challenge_method,
      scopes, status, credential_id, expires_at)
     VALUES
     ('${"a".repeat(64)}', '${APP_ID}', 'ai.elizaos.app', '${USER_ID}',
      '${ORGANIZATION_ID}', 'staging', 'https://eliza.app/auth/callback',
      '${"b".repeat(64)}', '${"c".repeat(43)}', 'S256', '["cloud:user"]',
      'acknowledged', '${CREDENTIAL_ID}', now() + interval '30 days')`,
  );
  await applyMigration(attributionMigrationUrl);
}, 60_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("0278 mobile credential source-app attribution migration", () => {
  test("is journaled, indexed, backfilled, and idempotent", async () => {
    const journal = JSON.parse(readFileSync(journalUrl, "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const grantsIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0277_mobile_app_auth_pkce_grants",
    );
    const attributionIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0278_mobile_auth_source_app",
    );
    expect(grantsIndex).toBeGreaterThanOrEqual(0);
    expect(attributionIndex).toBe(grantsIndex + 1);
    expect(journal.entries[attributionIndex]?.idx).toBe(
      (journal.entries[grantsIndex]?.idx ?? -1) + 1,
    );
    const source = await dbWrite.execute(
      `SELECT source_app_id FROM api_keys WHERE id = '${CREDENTIAL_ID}'`,
    );
    expect(source.rows[0]?.source_app_id).toBe(APP_ID);
    const indexes = await dbWrite.execute(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'api_keys'",
    );
    const sourceIndex = indexes.rows.find((row) => row.indexname === "api_keys_source_app_id_idx");
    expect(String(sourceIndex?.indexdef)).toContain("(source_app_id)");
    expect(String(sourceIndex?.indexdef)).toContain("WHERE (source_app_id IS NOT NULL)");

    const foreignKeys = await dbWrite.execute(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'api_keys'::regclass
         AND contype = 'f'`,
    );
    expect(foreignKeys.rows.some((row) => String(row.definition).includes("(source_app_id)"))).toBe(
      false,
    );
    await applyMigration(attributionMigrationUrl);
  });

  test("app deletion cascades the grant but preserves its source on the credential", async () => {
    await dbWrite.execute(`DELETE FROM apps WHERE id = '${APP_ID}'`);
    const grants = await dbWrite.execute(
      `SELECT count(*)::int AS count FROM mobile_app_auth_grants WHERE app_id = '${APP_ID}'`,
    );
    expect(Number(grants.rows[0]?.count)).toBe(0);
    const credential = await dbWrite.execute(
      `SELECT source_app_id FROM api_keys WHERE id = '${CREDENTIAL_ID}'`,
    );
    expect(credential.rows[0]?.source_app_id).toBe(APP_ID);
  });
});
