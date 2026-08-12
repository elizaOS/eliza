/**
 * Applies migration 0197 against real PGlite rows and proves Cloud identity
 * approval relocates onto distinct tables without touching the plugin-sql
 * owner-approval queue (#18074).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_PATH = join(
  import.meta.dir,
  "migrations/0197_cloud_approval_requests_distinct_tables.sql",
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
const USER_ID = "00000000-0000-4000-8000-0000000000bb";
const CLOUD_ID = "00000000-0000-4000-8000-0000000000c1";
const PLUGIN_ID = "00000000-0000-4000-8000-0000000000a1";
const CLOUD_EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const PLUGIN_EVENT_ID = "00000000-0000-4000-8000-0000000000e2";

let client: PGlite | null = null;

afterEach(async () => {
  if (client) {
    await client.close();
    client = null;
  }
});

async function applyMigration(db: PGlite): Promise<void> {
  await db.exec(MIGRATION_SQL);
}

async function seedPrereqs(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE organizations (
      id UUID PRIMARY KEY
    );
    CREATE TABLE users (
      id UUID PRIMARY KEY
    );
    INSERT INTO organizations (id) VALUES ('${ORG_ID}');
    INSERT INTO users (id) VALUES ('${USER_ID}');
  `);
}

describe("0197 cloud approval requests distinct tables (#18074)", () => {
  test("copies Cloud-shaped rows, leaves plugin-sql rows, and is idempotent", async () => {
    client = new PGlite();
    await seedPrereqs(client);
    // Hybrid legacy table: Cloud columns plus a plugin-sql `state` column so
    // both owners can coexist in one PGlite fixture (production has one shape
    // or the other; the copy gate is organization_id IS NOT NULL).
    await client.exec(`
      CREATE TABLE approval_requests (
        id UUID PRIMARY KEY,
        organization_id UUID REFERENCES organizations(id),
        agent_id UUID,
        user_id UUID REFERENCES users(id),
        challenge_kind TEXT,
        challenge_payload JSONB DEFAULT '{}'::jsonb,
        expected_signer_identity_id TEXT,
        status TEXT,
        signature_text TEXT,
        signed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        metadata JSONB DEFAULT '{}'::jsonb,
        state TEXT
      );
      CREATE TABLE approval_request_events (
        id UUID PRIMARY KEY,
        approval_request_id UUID NOT NULL,
        event_name TEXT NOT NULL,
        redacted_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO approval_requests (
        id, organization_id, user_id, challenge_kind, challenge_payload,
        status, expires_at, metadata
      ) VALUES (
        '${CLOUD_ID}', '${ORG_ID}', '${USER_ID}', 'login', '{"message":"sign-in"}'::jsonb,
        'pending', now() + interval '1 hour', '{}'::jsonb
      );
      INSERT INTO approval_requests (id, state, expires_at)
      VALUES ('${PLUGIN_ID}', 'pending', now() + interval '1 hour');
      INSERT INTO approval_request_events (id, approval_request_id, event_name)
      VALUES
        ('${CLOUD_EVENT_ID}', '${CLOUD_ID}', 'approval.created'),
        ('${PLUGIN_EVENT_ID}', '${PLUGIN_ID}', 'approval.created');
    `);

    await applyMigration(client);
    await applyMigration(client);

    const cloudRows = await client.query<{ id: string }>(
      "SELECT id FROM cloud_approval_requests ORDER BY id",
    );
    expect(cloudRows.rows.map((row) => row.id)).toEqual([CLOUD_ID]);

    const pluginRows = await client.query<{ id: string; state: string | null }>(
      "SELECT id, state FROM approval_requests WHERE id = $1",
      [PLUGIN_ID],
    );
    expect(pluginRows.rows).toEqual([{ id: PLUGIN_ID, state: "pending" }]);

    const events = await client.query<{ id: string }>(
      "SELECT id FROM cloud_approval_request_events ORDER BY id",
    );
    expect(events.rows.map((row) => row.id)).toEqual([CLOUD_EVENT_ID]);

    const legacyEventCount = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM approval_request_events",
    );
    expect(legacyEventCount.rows[0]?.count).toBe("2");
  });

  test("creates empty Cloud tables when only the plugin-sql queue exists", async () => {
    client = new PGlite();
    await seedPrereqs(client);
    await client.exec(`
      CREATE TABLE approval_requests (
        id UUID PRIMARY KEY,
        state TEXT NOT NULL,
        requested_by TEXT,
        subject_user_id TEXT,
        action TEXT,
        payload JSONB,
        expires_at TIMESTAMPTZ
      );
      INSERT INTO approval_requests (id, state, action)
      VALUES ('${PLUGIN_ID}', 'pending', 'transfer');
    `);

    await applyMigration(client);

    const cloudCount = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cloud_approval_requests",
    );
    expect(cloudCount.rows[0]?.count).toBe("0");

    const plugin = await client.query<{ id: string; state: string }>(
      "SELECT id, state FROM approval_requests",
    );
    expect(plugin.rows).toEqual([{ id: PLUGIN_ID, state: "pending" }]);
  });

  test("preflight raises 55000 when a required Cloud column is missing", async () => {
    client = new PGlite();
    await seedPrereqs(client);
    await applyMigration(client);

    await client.exec("ALTER TABLE cloud_approval_requests DROP COLUMN signature_text");

    const preflight = MIGRATION_SQL.slice(
      MIGRATION_SQL.indexOf(
        "-- Fail closed unless the Cloud-owned relation has the required catalog shape.",
      ),
    );
    expect(preflight.length).toBeGreaterThan(100);

    let raised: unknown;
    try {
      await client.exec(preflight);
    } catch (error) {
      // error-policy:J3 untrusted-input sanitizing — capture the raised catalog
      // failure for assertion; the migration itself fails closed.
      raised = error;
    }
    expect(raised).toBeTruthy();
    const message = raised instanceof Error ? raised.message : String(raised);
    expect(message).toContain("cloud_approval_requests catalog mismatch");
  });

  test("never drops or alters plugin-sql approval_requests in SQL text", () => {
    expect(MIGRATION_SQL).not.toMatch(/DROP\s+TABLE\s+.*approval_requests/i);
    expect(MIGRATION_SQL).not.toMatch(/ALTER\s+TABLE\s+approval_requests/i);
    expect(MIGRATION_SQL).toContain("WHERE organization_id IS NOT NULL");
  });
});
