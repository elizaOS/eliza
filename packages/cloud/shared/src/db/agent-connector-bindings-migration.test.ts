/**
 * Applies the real agent connector binding migration to isolated PGlite and
 * proves its authorization-bearing foreign keys and uniqueness constraints.
 * The fixture creates only prerequisite tables; the binding table itself must
 * come entirely from the production migration bytes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const migrationsDir = join(import.meta.dirname, "migrations");
const sqlPath = join(migrationsDir, "0195_agent_connector_bindings.sql");

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL_A = "44444444-4444-4444-8444-444444444444";
const CREDENTIAL_B = "55555555-5555-4555-8555-555555555555";
const LEGACY_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEGACY_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEGACY_AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEGACY_CREDENTIAL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MULTI_ORG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MULTI_USER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MULTI_CREDENTIAL = "12121212-1212-4212-8212-121212121212";

const database = new PGlite();

function migrationStatements(): string[] {
  return readFileSync(sqlPath, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE user_characters (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL
    );
    CREATE TABLE platform_credentials (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      user_id uuid,
      platform text NOT NULL,
      platform_user_id text NOT NULL,
      status text NOT NULL,
      scopes jsonb,
      linked_at timestamp with time zone
    );
    INSERT INTO organizations VALUES ('${ORG}'), ('${LEGACY_ORG}'), ('${MULTI_ORG}');
    INSERT INTO users VALUES ('${USER}'), ('${LEGACY_USER}'), ('${MULTI_USER}');
    INSERT INTO user_characters VALUES
      ('${AGENT}', '${ORG}'),
      ('${LEGACY_AGENT}', '${LEGACY_ORG}'),
      ('13131313-1313-4313-8313-131313131313', '${MULTI_ORG}'),
      ('14141414-1414-4414-8414-141414141414', '${MULTI_ORG}');
    INSERT INTO platform_credentials VALUES
      ('${CREDENTIAL_A}', '${ORG}', '${USER}', 'slack', 'slack-a', 'active', '[]', now()),
      ('${CREDENTIAL_B}', '${ORG}', '${USER}', 'slack', 'slack-b', 'active', '[]', now()),
      ('${LEGACY_CREDENTIAL}', '${LEGACY_ORG}', '${LEGACY_USER}', 'google',
       'google-user', 'active',
       '["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.events"]',
       now()),
      ('${MULTI_CREDENTIAL}', '${MULTI_ORG}', '${MULTI_USER}', 'google',
       'multi-google-user', 'active',
       '["https://www.googleapis.com/auth/gmail.readonly"]', now());
  `);
  for (const statement of migrationStatements()) await database.exec(statement);
});

afterAll(async () => {
  await database.close();
});

function insertBinding(args: {
  id: string;
  credentialId: string;
  role?: "OWNER" | "AGENT";
  isDefault?: boolean;
}): Promise<unknown> {
  return database.exec(`
    INSERT INTO agent_connector_bindings
      (id, organization_id, agent_id, platform_credential_id, provider, role,
       authorized_by_user_id, is_default)
    VALUES
      ('${args.id}', '${ORG}', '${AGENT}', '${args.credentialId}', 'google',
       '${args.role ?? "OWNER"}', '${USER}', ${args.isDefault ?? false});
  `);
}

describe("0195 agent connector bindings migration", () => {
  test("is present and registered in the migration journal", () => {
    expect(existsSync(sqlPath)).toBe(true);
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((entry) => entry.tag === "0195_agent_connector_bindings")).toBe(
      true,
    );
  });

  test("applies the table, checks, and binding indexes", async () => {
    const tables = await database.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE tablename = 'agent_connector_bindings';",
    );
    expect(tables.rows).toEqual([{ tablename: "agent_connector_bindings" }]);
    const indexes = await database.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'uq_agent_connector_bindings_active_credential',
        'uq_agent_connector_bindings_default_role'
      ) ORDER BY indexname;
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "uq_agent_connector_bindings_active_credential",
      "uq_agent_connector_bindings_default_role",
    ]);
  });

  test("backfills a legacy Google credential only for a sole-agent organization", async () => {
    const result = await database.query<{
      agent_id: string;
      selected_products: string[];
      allowed_capabilities: string[];
      is_default: boolean;
    }>(`
      SELECT agent_id, selected_products, allowed_capabilities, is_default
      FROM agent_connector_bindings
      WHERE platform_credential_id = '${LEGACY_CREDENTIAL}';
    `);

    expect(result.rows).toEqual([
      {
        agent_id: LEGACY_AGENT,
        selected_products: ["gmail", "calendar"],
        allowed_capabilities: ["gmail.read", "calendar.read"],
        is_default: true,
      },
    ]);
  });

  test("does not guess an agent for a multi-agent organization's personal credential", async () => {
    const result = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM agent_connector_bindings
      WHERE platform_credential_id = '${MULTI_CREDENTIAL}';
    `);

    expect(result.rows).toEqual([{ count: 0 }]);
  });

  test("enforces one active binding per agent, provider, and credential", async () => {
    const bindingId = "66666666-6666-4666-8666-666666666666";
    await insertBinding({ id: bindingId, credentialId: CREDENTIAL_A, isDefault: true });
    await expect(
      insertBinding({
        id: "77777777-7777-4777-8777-777777777777",
        credentialId: CREDENTIAL_A,
      }),
    ).rejects.toThrow();
  });

  test("enforces one active default per agent, provider, and role", async () => {
    await expect(
      insertBinding({
        id: "88888888-8888-4888-8888-888888888888",
        credentialId: CREDENTIAL_B,
        isDefault: true,
      }),
    ).rejects.toThrow();
    await insertBinding({
      id: "99999999-9999-4999-8999-999999999999",
      credentialId: CREDENTIAL_B,
      role: "AGENT",
      isDefault: true,
    });
  });

  test("rejects invalid roles and restricts deletion of a referenced credential", async () => {
    await expect(
      database.exec(`
        INSERT INTO agent_connector_bindings
          (organization_id, agent_id, platform_credential_id, provider, role,
           authorized_by_user_id)
        VALUES ('${ORG}', '${AGENT}', '${CREDENTIAL_B}', 'slack', 'ROOT', '${USER}');
      `),
    ).rejects.toThrow();
    await expect(
      database.exec(`DELETE FROM platform_credentials WHERE id = '${CREDENTIAL_A}';`),
    ).rejects.toThrow();
  });
});
