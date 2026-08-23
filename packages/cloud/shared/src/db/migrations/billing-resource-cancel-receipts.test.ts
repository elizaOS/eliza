/** Applies migration 0312 to real PGlite and proves its receipt and intent invariants. */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await Bun.file(
  new URL("./0312_billing_resource_cancel_receipts.sql", import.meta.url),
).text();
const databases: PGlite[] = [];

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const USER_A = "20000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const JOB_A = "30000000-0000-4000-8000-000000000001";
const JOB_B = "30000000-0000-4000-8000-000000000002";
const RESOURCE = "40000000-0000-4000-8000-000000000001";

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id)
    );
    CREATE TABLE jobs (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id)
    );
    CREATE TABLE container_compute_stop_intents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      container_id uuid NOT NULL,
      lifecycle_revision bigint NOT NULL,
      status text NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE agent_compute_stop_intents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      agent_id uuid NOT NULL,
      lifecycle_revision bigint NOT NULL,
      status text NOT NULL DEFAULT 'pending'
    );
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO users (id, organization_id) VALUES
      ('${USER_A}', '${ORG_A}'), ('${USER_B}', '${ORG_B}');
    INSERT INTO jobs (id, organization_id) VALUES
      ('${JOB_A}', '${ORG_A}'), ('${JOB_B}', '${ORG_B}');
    INSERT INTO container_compute_stop_intents
      (organization_id, container_id, lifecycle_revision, status)
      VALUES ('${ORG_A}', '${RESOURCE}', 4, 'provider_confirmed');
    INSERT INTO agent_compute_stop_intents
      (organization_id, agent_id, lifecycle_revision, status)
      VALUES ('${ORG_A}', '${RESOURCE}', 4, 'provider_confirmed');
  `);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0312 billing resource cancellation receipts", () => {
  test("backfills billing authority and enforces one explicit user intent per generation", async () => {
    const db = await database();
    await db.exec(migration);

    const existing = await db.query<{ source: string; authorization: string }>(`
      SELECT 'agent' AS source, "authorization" FROM agent_compute_stop_intents
      UNION ALL
      SELECT 'container' AS source, "authorization" FROM container_compute_stop_intents
      ORDER BY source
    `);
    expect(existing.rows).toEqual([
      { source: "agent", authorization: "billing_request" },
      { source: "container", authorization: "billing_request" },
    ]);

    await db.exec(`
      INSERT INTO container_compute_stop_intents
        (organization_id, container_id, lifecycle_revision, status, "authorization")
        VALUES ('${ORG_A}', '${RESOURCE}', 5, 'provider_confirmed', 'user_request');
      INSERT INTO agent_compute_stop_intents
        (organization_id, agent_id, lifecycle_revision, status, "authorization")
        VALUES ('${ORG_A}', '${RESOURCE}', 5, 'provider_confirmed', 'user_request');
    `);
    await expect(
      db.exec(`INSERT INTO container_compute_stop_intents
        (organization_id, container_id, lifecycle_revision, status, "authorization")
        VALUES ('${ORG_A}', '${RESOURCE}', 5, 'superseded', 'user_request')`),
    ).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO agent_compute_stop_intents
        (organization_id, agent_id, lifecycle_revision, status, "authorization")
        VALUES ('${ORG_A}', '${RESOURCE}', 5, 'superseded', 'user_request')`),
    ).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO agent_compute_stop_intents
        (organization_id, agent_id, lifecycle_revision, status, "authorization")
        VALUES ('${ORG_A}', '${RESOURCE}', 6, 'pending', 'caller_claim')`),
    ).rejects.toThrow(/authorization_check/i);
  });

  test("retains multiple client aliases for one tenant-bound logical command", async () => {
    const db = await database();
    await db.exec(migration);
    await db.exec(`
      INSERT INTO billing_cancel_commands (
        id, organization_id, requested_by_user_id, resource_type, resource_id,
        expected_lifecycle_revision, job_id
      ) VALUES (
        '50000000-0000-4000-8000-000000000001', '${ORG_A}', '${USER_A}',
        'container', '${RESOURCE}', 4, '${JOB_A}'
      );
      INSERT INTO billing_cancel_command_keys (
        organization_id, idempotency_key_hash, request_digest, command_id, requested_by_user_id
      ) VALUES
        ('${ORG_A}', '${"a".repeat(64)}', '${"c".repeat(64)}',
          '50000000-0000-4000-8000-000000000001', '${USER_A}'),
        ('${ORG_A}', '${"b".repeat(64)}', '${"c".repeat(64)}',
          '50000000-0000-4000-8000-000000000001', '${USER_A}');
    `);

    const counts = await db.query<{ commands: number; keys: number }>(`
      SELECT
        (SELECT count(*)::int FROM billing_cancel_commands) AS commands,
        (SELECT count(*)::int FROM billing_cancel_command_keys) AS keys
    `);
    expect(counts.rows).toEqual([{ commands: 1, keys: 2 }]);

    await expect(
      db.exec(`INSERT INTO billing_cancel_command_keys (
        organization_id, idempotency_key_hash, request_digest, command_id, requested_by_user_id
      ) VALUES ('${ORG_A}', '${"a".repeat(64)}', '${"d".repeat(64)}',
        '50000000-0000-4000-8000-000000000001', '${USER_A}')`),
    ).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO billing_cancel_command_keys (
        organization_id, idempotency_key_hash, request_digest, command_id, requested_by_user_id
      ) VALUES ('${ORG_B}', '${"a".repeat(64)}', '${"c".repeat(64)}',
        '50000000-0000-4000-8000-000000000001', '${USER_B}')`),
    ).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO billing_cancel_command_keys (
        organization_id, idempotency_key_hash, request_digest, command_id, requested_by_user_id
      ) VALUES ('${ORG_A}', 'raw-key', '${"c".repeat(64)}',
        '50000000-0000-4000-8000-000000000001', '${USER_A}')`),
    ).rejects.toThrow(/digest_shape_check/i);
  });

  test("rejects duplicate jobs, duplicate logical generations, and invalid command shapes", async () => {
    const db = await database();
    await db.exec(migration);
    const insert = `INSERT INTO billing_cancel_commands (
      organization_id, requested_by_user_id, resource_type, resource_id,
      expected_lifecycle_revision, job_id
    ) VALUES ('${ORG_A}', '${USER_A}', 'container', '${RESOURCE}', 4, '${JOB_A}')`;
    await db.exec(insert);

    await expect(db.exec(insert)).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO billing_cancel_commands (
        organization_id, requested_by_user_id, resource_type, resource_id,
        expected_lifecycle_revision, job_id
      ) VALUES ('${ORG_A}', '${USER_A}', 'container',
        '40000000-0000-4000-8000-000000000002', 8, '${JOB_A}')`),
    ).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO billing_cancel_commands (
        organization_id, requested_by_user_id, resource_type, resource_id,
        expected_lifecycle_revision, job_id
      ) VALUES ('${ORG_B}', '${USER_B}', 'database', '${RESOURCE}', -1, '${JOB_B}')`),
    ).rejects.toThrow(/shape_check/i);
  });

  test("rejects cross-tenant jobs and requesting users on commands and keys", async () => {
    const db = await database();
    await db.exec(migration);

    await expect(
      db.exec(`INSERT INTO billing_cancel_commands (
        organization_id, requested_by_user_id, resource_type, resource_id,
        expected_lifecycle_revision, job_id
      ) VALUES ('${ORG_A}', '${USER_A}', 'container', '${RESOURCE}', 4, '${JOB_B}')`),
    ).rejects.toThrow(/job_tenant/i);
    await expect(
      db.exec(`INSERT INTO billing_cancel_commands (
        organization_id, requested_by_user_id, resource_type, resource_id,
        expected_lifecycle_revision, job_id
      ) VALUES ('${ORG_A}', '${USER_B}', 'container', '${RESOURCE}', 4, '${JOB_A}')`),
    ).rejects.toThrow(/requesting_user_tenant/i);

    await db.exec(`INSERT INTO billing_cancel_commands (
      id, organization_id, requested_by_user_id, resource_type, resource_id,
      expected_lifecycle_revision, job_id
    ) VALUES (
      '50000000-0000-4000-8000-000000000001', '${ORG_A}', '${USER_A}',
      'container', '${RESOURCE}', 4, '${JOB_A}'
    )`);
    await expect(
      db.exec(`INSERT INTO billing_cancel_command_keys (
        organization_id, idempotency_key_hash, request_digest, command_id,
        requested_by_user_id
      ) VALUES (
        '${ORG_A}', '${"a".repeat(64)}', '${"c".repeat(64)}',
        '50000000-0000-4000-8000-000000000001', '${USER_B}'
      )`),
    ).rejects.toThrow(/requesting_user_tenant/i);
  });
});
