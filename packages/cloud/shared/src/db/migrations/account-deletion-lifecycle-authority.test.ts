/** Applies the account lifecycle authority migrations to isolated PostgreSQL. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationNames = [
  "0276_account_deletion_requests.sql",
  "0312_account_deletion_lifecycle_authority.sql",
  "0313_account_deletion_phase_receipts.sql",
  "0314_account_deletion_exports.sql",
  "0315_account_deletion_canceling_state.sql",
  "0316_account_deletion_admission_recovery.sql",
] as const;
const migrations = await Promise.all(
  migrationNames.map(async (name) => await readFile(new URL(`./${name}`, import.meta.url), "utf8")),
);
const databases: PGlite[] = [];

async function createDatabase(): Promise<PGlite> {
  const database = new PGlite();
  databases.push(database);
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
  `);
  await database.exec(migrations[0]);
  await database.exec(`
    INSERT INTO organizations (id) VALUES ('10000000-0000-4000-8000-000000000001');
    INSERT INTO users (id) VALUES ('20000000-0000-4000-8000-000000000001');
    INSERT INTO account_deletion_requests
      (user_id, organization_id, steward_user_id, execute_after)
    VALUES
      ('20000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001', 'steward-test', now());
  `);
  for (const migration of migrations.slice(1)) await database.exec(migration);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => await database.close()));
});

describe("account deletion lifecycle authority migrations", () => {
  test("backfills active authority and preserves a legacy open receipt", async () => {
    const database = await createDatabase();
    const organizations = await database.query<{
      account_lifecycle_state: string;
      account_lifecycle_revision: number;
    }>("SELECT account_lifecycle_state, account_lifecycle_revision FROM organizations");
    const requests = await database.query<{
      status: string;
      operation_kind: string;
      lifecycle_revision: number;
    }>("SELECT status, operation_kind, lifecycle_revision FROM account_deletion_requests");

    expect(organizations.rows).toEqual([
      { account_lifecycle_state: "active", account_lifecycle_revision: 0 },
    ]);
    expect(requests.rows).toEqual([
      {
        status: "requested",
        operation_kind: "personal_account_deletion",
        lifecycle_revision: 1,
      },
    ]);
  });

  test("enforces one phase receipt per request and generation constraints", async () => {
    const database = await createDatabase();
    const request = await database.query<{ id: string }>(
      "SELECT id FROM account_deletion_requests LIMIT 1",
    );
    const requestId = request.rows[0]?.id;
    expect(requestId).toBeDefined();

    await database.query(
      `INSERT INTO account_deletion_phase_receipts
        (request_id, phase, phase_order, idempotency_key_digest)
       VALUES ($1::uuid, 'steward', 2, 'digest')`,
      [requestId],
    );
    await expect(
      database.query(
        `INSERT INTO account_deletion_phase_receipts
          (request_id, phase, phase_order, idempotency_key_digest)
         VALUES ($1::uuid, 'steward', 2, 'other')`,
        [requestId],
      ),
    ).rejects.toThrow(/account_deletion_phase_receipts_request_phase_unique/);
    await expect(
      database.query(
        `INSERT INTO account_deletion_phase_receipts
          (request_id, phase, phase_order, idempotency_key_digest, lease_generation)
         VALUES ($1::uuid, 'stripe', 3, 'digest', -1)`,
        [requestId],
      ),
    ).rejects.toThrow(/account_deletion_phase_receipts_attempt_check/);
  });

  test("keeps export receipts singular and permits a new request after cancellation", async () => {
    const database = await createDatabase();
    const request = await database.query<{ id: string }>(
      "SELECT id FROM account_deletion_requests LIMIT 1",
    );
    const requestId = request.rows[0]?.id;

    await database.query(
      `INSERT INTO account_deletion_exports (request_id, expires_at)
       VALUES ($1::uuid, now() + interval '7 days')`,
      [requestId],
    );
    await expect(
      database.query(
        `INSERT INTO account_deletion_exports (request_id, expires_at)
         VALUES ($1::uuid, now() + interval '7 days')`,
        [requestId],
      ),
    ).rejects.toThrow(/account_deletion_exports_request_unique/);

    await database.exec(`
      UPDATE account_deletion_requests SET status = 'canceled', canceled_at = now();
      INSERT INTO account_deletion_requests
        (user_id, organization_id, steward_user_id, execute_after)
      VALUES
        ('20000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000001', 'steward-test', now());
    `);
    const count = await database.query<{ count: number }>(
      "SELECT count(*)::bigint AS count FROM account_deletion_requests",
    );
    expect(count.rows[0]?.count).toBe(2);
  });

  test("keeps canceling nonterminal until cleanup can restore access", async () => {
    const database = await createDatabase();
    await database.exec("UPDATE account_deletion_requests SET status = 'canceling'");
    await expect(
      database.exec(`
        INSERT INTO account_deletion_requests
          (user_id, organization_id, steward_user_id, execute_after)
        VALUES
          ('20000000-0000-4000-8000-000000000001',
           '10000000-0000-4000-8000-000000000001', 'steward-test', now());
      `),
    ).rejects.toThrow(/account_deletion_requests_one_open_user_idx/);
  });

  test("binds response-loss admission authority as an all-or-nothing hash pair", async () => {
    const database = await createDatabase();
    await expect(
      database.exec("UPDATE account_deletion_requests SET admission_token_hash = 'digest-only'"),
    ).rejects.toThrow(/account_deletion_requests_admission_pair_check/);
    await database.exec(`
      UPDATE account_deletion_requests
      SET admission_token_hash = 'digest', admission_token_expires_at = now() + interval '1 day'
    `);
    await expect(
      database.exec(`
        INSERT INTO account_deletion_requests
          (user_id, organization_id, steward_user_id, execute_after,
           admission_token_hash, admission_token_expires_at)
        VALUES
          (NULL, NULL, NULL, now(), 'digest', now() + interval '1 day')
      `),
    ).rejects.toThrow(/account_deletion_requests_admission_token_idx/);
  });
});
