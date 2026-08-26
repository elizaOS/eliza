/** Applies the split billing-cancellation migrations to PGlite and proves their invariants. */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migration = (
  await Promise.all(
    [
      "0330_billing_cancel_intent_authority.sql",
      "0331_billing_cancel_commands.sql",
      "0332_billing_cancel_command_keys.sql",
      "0333_billing_cancel_guard_functions.sql",
      "0334_billing_cancel_guards.sql",
    ].map((name) => Bun.file(new URL(`./${name}`, import.meta.url)).text()),
  )
).join("\n--> statement-breakpoint\n");
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

describe("split billing resource cancellation receipts", () => {
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

  test("retains actor audit identity when a requester moves organizations", async () => {
    const db = await database();
    await db.exec(migration);
    const commandId = "50000000-0000-4000-8000-000000000001";
    await db.exec(`
      INSERT INTO billing_cancel_commands (
        id, organization_id, requested_by_user_id, resource_type, resource_id,
        expected_lifecycle_revision, job_id
      ) VALUES (
        '${commandId}', '${ORG_A}', '${USER_A}', 'container', '${RESOURCE}', 4, '${JOB_A}'
      );
      INSERT INTO billing_cancel_command_keys (
        organization_id, idempotency_key_hash, request_digest, command_id,
        requested_by_user_id
      ) VALUES (
        '${ORG_A}', '${"a".repeat(64)}', '${"c".repeat(64)}', '${commandId}', '${USER_A}'
      );
      UPDATE users SET organization_id = '${ORG_B}' WHERE id = '${USER_A}';
    `);

    const audit = await db.query<{
      command_actor: string;
      command_org: string;
      key_actor: string;
      key_org: string;
      current_user_org: string;
    }>(`
      SELECT
        command.requested_by_user_id::text AS command_actor,
        command.organization_id::text AS command_org,
        key.requested_by_user_id::text AS key_actor,
        key.organization_id::text AS key_org,
        actor.organization_id::text AS current_user_org
      FROM billing_cancel_commands command
      JOIN billing_cancel_command_keys key ON key.command_id = command.id
      JOIN users actor ON actor.id = command.requested_by_user_id
      WHERE command.id = '${commandId}'
    `);
    expect(audit.rows).toEqual([
      {
        command_actor: USER_A,
        command_org: ORG_A,
        key_actor: USER_A,
        key_org: ORG_A,
        current_user_org: ORG_B,
      },
    ]);

    await expect(
      db.exec(`INSERT INTO billing_cancel_command_keys (
        organization_id, idempotency_key_hash, request_digest, command_id,
        requested_by_user_id
      ) VALUES (
        '${ORG_A}', '${"b".repeat(64)}', '${"c".repeat(64)}', '${commandId}', '${USER_A}'
      )`),
    ).rejects.toThrow(/requesting_user_tenant_guard/i);
    await expect(
      db.exec(`UPDATE billing_cancel_commands
        SET requested_by_user_id = '${USER_B}' WHERE id = '${commandId}'`),
    ).rejects.toThrow(/authority_immutable/i);
    await expect(
      db.exec(`UPDATE billing_cancel_command_keys
        SET request_digest = '${"d".repeat(64)}' WHERE command_id = '${commandId}'`),
    ).rejects.toThrow(/authority_immutable/i);
    await expect(
      db.exec(`DELETE FROM billing_cancel_command_keys WHERE command_id = '${commandId}'`),
    ).rejects.toThrow(/authority_immutable/i);
    await expect(
      db.exec(`DELETE FROM billing_cancel_commands WHERE id = '${commandId}'`),
    ).rejects.toThrow(/authority_immutable/i);
    await expect(db.exec(`TRUNCATE billing_cancel_command_keys`)).rejects.toThrow(
      /truncate_guard/i,
    );
    await expect(db.exec(`TRUNCATE billing_cancel_commands CASCADE`)).rejects.toThrow(
      /truncate_guard/i,
    );

    const largeTableConstraints = await db.query<{ constraint_name: string }>(`
      SELECT conname AS constraint_name
      FROM pg_constraint
      WHERE conname IN ('jobs_id_org_unique', 'users_id_org_unique')
    `);
    expect(largeTableConstraints.rows).toEqual([]);
  });
});
