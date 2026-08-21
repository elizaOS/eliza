/**
 * Applies the real mobile App Auth migrations to PGlite and proves their
 * constraints, indexes, idempotence, and credential-revocation foreign key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const migrationUrl = new URL("./migrations/0277_mobile_app_auth_pkce_grants.sql", import.meta.url);
const deviceNameMigrationUrl = new URL(
  "./migrations/0279_mobile_app_auth_device_name.sql",
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

async function insertPendingGrant(input: {
  challengeMethod?: string;
  codeHash: string;
  environment?: string;
  status?: string;
}): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO mobile_app_auth_grants
     (code_hash, app_id, client_id, user_id, organization_id, environment,
      redirect_uri, state_hash, code_challenge, code_challenge_method,
      scopes, status, expires_at)
     VALUES
     ('${input.codeHash}', '${APP_ID}', 'ai.elizaos.app', '${USER_ID}',
      '${ORGANIZATION_ID}', '${input.environment ?? "staging"}',
      'https://eliza.app/auth/callback', '${"b".repeat(64)}',
      '${"c".repeat(43)}', '${input.challengeMethod ?? "S256"}',
      '["cloud:user"]', '${input.status ?? "pending"}',
      now() + interval '5 minutes')`,
  );
}

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
  await applyMigration(migrationUrl);
  await applyMigration(deviceNameMigrationUrl);
  await dbWrite.execute(`INSERT INTO organizations (id) VALUES ('${ORGANIZATION_ID}')`);
  await dbWrite.execute(`INSERT INTO users (id) VALUES ('${USER_ID}')`);
  await dbWrite.execute(`INSERT INTO apps (id) VALUES ('${APP_ID}')`);
  await dbWrite.execute(`INSERT INTO api_keys (id) VALUES ('${CREDENTIAL_ID}')`);
}, 60_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("0277 mobile App Auth PKCE grants migration", () => {
  test("is journaled and re-applies idempotently", async () => {
    const journal = JSON.parse(readFileSync(journalUrl, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    expect(journal.entries.map((entry) => entry.tag)).toEqual(
      expect.arrayContaining([
        "0277_mobile_app_auth_pkce_grants",
        "0279_mobile_app_auth_device_name",
      ]),
    );
    await applyMigration(migrationUrl);
    await applyMigration(deviceNameMigrationUrl);
    const table = await dbWrite.execute(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = 'mobile_app_auth_grants'",
    );
    expect(Number(table.rows[0]?.count)).toBe(1);
  });

  test("creates every lookup index used by exchange and cleanup", async () => {
    const indexes = await dbWrite.execute(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'mobile_app_auth_grants' ORDER BY indexname",
    );
    const definitions = new Map<string, string>(
      indexes.rows.map((row) => [String(row.indexname), String(row.indexdef)] as const),
    );
    expect([...definitions.keys()]).toEqual(
      expect.arrayContaining([
        "idx_mobile_app_auth_grants_code_hash",
        "idx_mobile_app_auth_grants_credential",
        "idx_mobile_app_auth_grants_expires_status",
      ]),
    );
    expect(definitions.get("idx_mobile_app_auth_grants_code_hash")).toContain(
      "CREATE UNIQUE INDEX",
    );
    expect(definitions.get("idx_mobile_app_auth_grants_code_hash")).toContain("(code_hash)");
    expect(definitions.get("idx_mobile_app_auth_grants_expires_status")).toContain(
      "(expires_at, status)",
    );
    expect(definitions.get("idx_mobile_app_auth_grants_credential")).toContain("(credential_id)");
    expect(definitions.get("idx_mobile_app_auth_grants_credential")).toContain(
      "WHERE (credential_id IS NOT NULL)",
    );
  });

  test("declares the intended deletion semantics for every foreign key", async () => {
    const constraints = await dbWrite.execute(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'mobile_app_auth_grants'::regclass
         AND contype = 'f'`,
    );
    const definitions = constraints.rows.map((row) => String(row.definition).replace(/\s+/g, " "));
    expect(definitions).toEqual(
      expect.arrayContaining([
        "FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE",
        "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
        "FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE",
        "FOREIGN KEY (credential_id) REFERENCES api_keys(id) ON DELETE SET NULL",
      ]),
    );
    expect(definitions).toHaveLength(4);
  });

  test("enforces every protocol binding check and unique authorization-code hash", async () => {
    await expect(
      insertPendingGrant({ codeHash: "d".repeat(64), environment: "local" }),
    ).rejects.toThrow();
    await expect(
      insertPendingGrant({ codeHash: "e".repeat(64), challengeMethod: "plain" }),
    ).rejects.toThrow();
    await expect(
      insertPendingGrant({ codeHash: "f".repeat(64), status: "revoked" }),
    ).rejects.toThrow();

    const codeHash = "1".repeat(64);
    await insertPendingGrant({ codeHash });
    await expect(insertPendingGrant({ codeHash })).rejects.toThrow();
  });

  test("stores a bounded recovery label and rejects invalid database writes", async () => {
    const codeHash = "2".repeat(64);
    await insertPendingGrant({ codeHash });
    await dbWrite.execute(
      `UPDATE mobile_app_auth_grants SET device_name = 'Simulator iPhone'
       WHERE code_hash = '${codeHash}'`,
    );
    const row = await dbWrite.execute(
      `SELECT device_name FROM mobile_app_auth_grants WHERE code_hash = '${codeHash}'`,
    );
    expect(row.rows[0]?.device_name).toBe("Simulator iPhone");
    await expect(
      Promise.resolve(
        dbWrite.execute(
          `UPDATE mobile_app_auth_grants SET device_name = '' WHERE code_hash = '${codeHash}'`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        dbWrite.execute(
          `UPDATE mobile_app_auth_grants SET device_name = '${"x".repeat(81)}'
           WHERE code_hash = '${codeHash}'`,
        ),
      ),
    ).rejects.toThrow();
  });

  test("clears the grant reference on exact key revocation", async () => {
    await dbWrite.execute(
      `INSERT INTO mobile_app_auth_grants
       (code_hash, app_id, client_id, user_id, organization_id, environment,
        redirect_uri, state_hash, code_challenge, code_challenge_method,
        scopes, status, credential_id, expires_at)
       VALUES
       ('${"a".repeat(64)}', '${APP_ID}', 'ai.elizaos.app', '${USER_ID}',
        '${ORGANIZATION_ID}', 'staging', 'https://eliza.app/auth/callback',
        '${"b".repeat(64)}', '${"c".repeat(43)}', 'S256', '["cloud:user"]',
        'exchanged', '${CREDENTIAL_ID}', now() + interval '5 minutes');`,
    );

    await dbWrite.execute(`DELETE FROM api_keys WHERE id = '${CREDENTIAL_ID}'`);
    const grant = await dbWrite.execute(
      `SELECT credential_id FROM mobile_app_auth_grants WHERE code_hash = '${"a".repeat(64)}'`,
    );
    expect(grant.rows[0]?.credential_id).toBeNull();
  });
});
