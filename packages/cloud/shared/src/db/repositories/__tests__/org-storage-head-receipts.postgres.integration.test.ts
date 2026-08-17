/**
 * Proves native-storage HEAD receipt convergence with independent connections
 * and PostgreSQL's real row-lock and uniqueness semantics.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import type {
  OrgStorageHeadTerminalResponse,
  PreparedOrgStorageHeadReceiptIdentity,
  OrgStorageHeadReceiptRepository as ReceiptRepository,
} from "../org-storage-head-receipts";

const SKIP_REASON =
  "[org storage HEAD receipts] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  LOCAL_PG_POOL_MAX: process.env.LOCAL_PG_POOL_MAX,
  NODE_ENV: process.env.NODE_ENV,
};
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const GATE_KEY_ONE = 21_045;
const GATE_KEY_TWO = 23_940;
const TEST_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 10_000;

interface TestGate {
  readonly organizationId: string;
  readonly control: Client;
  released: boolean;
}

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let setupClient: Client | null = null;
let observerClient: Client | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let repository: ReceiptRepository | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const databaseName = `eliza_head_receipt_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return { databaseName, dsn: url.toString() };
}

async function dropIsolatedDatabase(baseDsn: string, databaseName: string): Promise<void> {
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
        "WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

function request(organizationId: string): {
  objectKey: string;
  ifMatch: null;
  ifNoneMatch: null;
  ifModifiedSince: null;
  ifUnmodifiedSince: null;
} {
  return {
    objectKey: `org/${organizationId}/concurrency/object.bin`,
    ifMatch: null,
    ifNoneMatch: null,
    ifModifiedSince: null,
    ifUnmodifiedSince: null,
  };
}

function okResponse(seed: number): Extract<OrgStorageHeadTerminalResponse, { kind: "ok" }> {
  return {
    kind: "ok",
    objectId: `20000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
    objectGeneration: 7n,
    contentLength: 123n,
    contentType: "application/octet-stream",
    etag: `postgres-etag-${seed}`,
    lastModified: new Date("2026-08-17T09:00:37.000Z"),
    forceAttachment: false,
  };
}

async function prepareIdentity(
  organizationId: string,
  rawIdempotencyKey: string,
): Promise<PreparedOrgStorageHeadReceiptIdentity> {
  if (!repository) throw new Error("real PostgreSQL harness was not initialized");
  const prepared = await repository.prepare({
    organizationId,
    rawIdempotencyKey,
    request: request(organizationId),
  });
  if (prepared.outcome !== "miss") throw new Error("Expected a receipt miss");
  return prepared.identity;
}

async function armGate(organizationId: string): Promise<TestGate> {
  if (!setupClient || !isolatedDsn) {
    throw new Error("real PostgreSQL harness was not initialized");
  }
  await setupClient.query(
    `INSERT INTO head_receipt_test_gates (organization_id, gate_key_one, gate_key_two)
     VALUES ($1, $2, $3)`,
    [organizationId, GATE_KEY_ONE, GATE_KEY_TWO],
  );
  const control = new Client({ connectionString: isolatedDsn });
  await control.connect();
  try {
    await control.query("BEGIN");
    await control.query("SELECT pg_advisory_xact_lock($1, $2)", [GATE_KEY_ONE, GATE_KEY_TWO]);
    return { organizationId, control, released: false };
  } catch (error) {
    await control.query("ROLLBACK").catch(() => {});
    await control.end().catch(() => {});
    await setupClient
      .query("DELETE FROM head_receipt_test_gates WHERE organization_id = $1", [organizationId])
      .catch(() => {});
    throw error;
  }
}

async function releaseGate(gate: TestGate): Promise<void> {
  if (gate.released) return;
  await gate.control.query("COMMIT");
  gate.released = true;
}

async function cleanupGate(gate: TestGate): Promise<void> {
  if (!gate.released) {
    await gate.control.query("ROLLBACK").catch(() => {});
    gate.released = true;
  }
  await gate.control.end().catch(() => {});
  await setupClient
    ?.query("DELETE FROM head_receipt_test_gates WHERE organization_id = $1", [gate.organizationId])
    .catch(() => {});
}

async function lockWaiterCount(): Promise<number> {
  if (!observerClient) throw new Error("real PostgreSQL harness was not initialized");
  const result = await observerClient.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function advisoryWaiterCount(): Promise<number> {
  if (!observerClient) throw new Error("real PostgreSQL harness was not initialized");
  const result = await observerClient.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND NOT granted`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function waitForLockWaiters(minimum: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await lockWaiterCount()) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} PostgreSQL lock waiter(s)`);
}

async function waitForAdvisoryWaiter(): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await advisoryWaiterCount()) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the PostgreSQL advisory-lock barrier");
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not complete while the other organization waited`)),
          WAIT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

if (!postgres) {
  console.warn(SKIP_REASON);
} else {
  const isolated = await createIsolatedDatabase(postgres.dsn);
  isolatedDatabaseName = isolated.databaseName;
  isolatedDsn = isolated.dsn;
  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.LOCAL_PG_POOL_MAX = "24";
  process.env.NODE_ENV = "test";

  const [clientModule, repositoryModule] = await Promise.all([
    import("../../client"),
    import("../org-storage-head-receipts"),
  ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  repository = new repositoryModule.OrgStorageHeadReceiptRepository();
}

afterAll(async () => {
  await setupClient?.end().catch(() => {});
  await observerClient?.end().catch(() => {});
  await closeDatabaseConnectionsForTests?.();
  if (postgres && isolatedDatabaseName) {
    await dropIsolatedDatabase(postgres.dsn, isolatedDatabaseName);
  }
  await postgres?.stop();
  postgres = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
}, TEST_TIMEOUT_MS);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("OrgStorageHeadReceiptRepository real PostgreSQL concurrency", () => {
  beforeAll(async () => {
    if (!isolatedDsn) throw new Error("real PostgreSQL harness was not initialized");
    setupClient = new Client({ connectionString: isolatedDsn });
    observerClient = new Client({ connectionString: isolatedDsn });
    await Promise.all([setupClient.connect(), observerClient.connect()]);

    await setupClient.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        credit_balance numeric(16, 6) NOT NULL DEFAULT '0.000000',
        balance_revision bigint NOT NULL DEFAULT 0,
        balance_decrease_revision bigint NOT NULL DEFAULT 0,
        updated_at timestamp NOT NULL DEFAULT NOW(),
        CONSTRAINT credit_balance_non_negative CHECK (credit_balance >= 0)
      );
      CREATE TABLE credit_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id uuid,
        amount numeric(16, 6) NOT NULL,
        type text NOT NULL,
        description text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        stripe_payment_intent_id text,
        created_at timestamp NOT NULL DEFAULT NOW(),
        settled_at timestamp
      );
      CREATE UNIQUE INDEX credit_transactions_stripe_payment_intent_idx
        ON credit_transactions(stripe_payment_intent_id);
    `);
    for (const migration of [
      "0239_org_storage_head_receipts.sql",
      "0240_org_storage_head_receipt_response_shapes.sql",
    ]) {
      await setupClient.query(
        await readFile(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
    await setupClient.query(`
      CREATE TABLE head_receipt_test_gates (
        organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        gate_key_one integer NOT NULL,
        gate_key_two integer NOT NULL
      );

      CREATE FUNCTION block_test_head_receipt_balance_update() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(gate_key_one, gate_key_two)
          FROM head_receipt_test_gates
         WHERE organization_id = NEW.id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE FUNCTION block_test_head_receipt_insert() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(gate_key_one, gate_key_two)
          FROM head_receipt_test_gates
         WHERE organization_id = NEW.organization_id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER block_test_head_receipt_balance_update_trigger
        BEFORE UPDATE OF credit_balance ON organizations
        FOR EACH ROW EXECUTE FUNCTION block_test_head_receipt_balance_update();
      CREATE TRIGGER block_test_head_receipt_insert_trigger
        BEFORE INSERT ON org_storage_head_receipts
        FOR EACH ROW EXECUTE FUNCTION block_test_head_receipt_insert();
    `);
  }, TEST_TIMEOUT_MS);

  beforeEach(async () => {
    if (!setupClient) throw new Error("real PostgreSQL harness was not initialized");
    await setupClient.query(`
      TRUNCATE TABLE org_storage_head_receipts, credit_transactions,
        head_receipt_test_gates, organizations CASCADE;
      INSERT INTO organizations (id, name, slug, credit_balance) VALUES
        ('${ORG_A}', 'Org A', 'postgres-org-a', '10.000000'),
        ('${ORG_B}', 'Org B', 'postgres-org-b', '10.000000');
    `);
  });

  test(
    "converges sixteen paid commits onto one receipt, one debit, and one balance mutation",
    async () => {
      if (!repository || !setupClient) {
        throw new Error("real PostgreSQL harness was not initialized");
      }
      const identity = await prepareIdentity(ORG_A, "postgres-sixteen-way-paid");
      const gate = await armGate(ORG_A);
      const commits = Array.from({ length: 16 }, () =>
        repository?.commitTerminal({
          identity,
          chargeAmountUsd: "0.000050",
          response: okResponse(1),
        }),
      ) as Array<ReturnType<ReceiptRepository["commitTerminal"]>>;

      try {
        await waitForLockWaiters(4);
        await releaseGate(gate);
        const results = await Promise.all(commits);

        expect(results.filter((result) => result.outcome === "committed")).toHaveLength(1);
        expect(results.filter((result) => result.outcome === "replayed")).toHaveLength(15);
        expect(new Set(results.map((result) => result.receipt.id)).size).toBe(1);

        const firstReceipt = results[0]?.receipt;
        if (!firstReceipt || firstReceipt.creditTransactionId === null) {
          throw new Error("Expected one positively charged receipt");
        }

        const persisted = await setupClient.query<{
          receipt_id: string;
          charge_amount_usd: string;
          ledger_id: string;
          ledger_amount: string;
          ledger_type: string;
          credit_balance: string;
        }>(`
          SELECT receipt.id AS receipt_id,
                 receipt.charge_amount_usd::text AS charge_amount_usd,
                 ledger.id AS ledger_id,
                 ledger.amount::text AS ledger_amount,
                 ledger.type AS ledger_type,
                 organization.credit_balance::text AS credit_balance
            FROM organizations AS organization
            JOIN org_storage_head_receipts AS receipt
              ON receipt.organization_id = organization.id
            JOIN credit_transactions AS ledger
              ON ledger.id = receipt.credit_transaction_id
           WHERE organization.id = '${ORG_A}'
        `);
        expect(persisted.rows).toEqual([
          {
            receipt_id: firstReceipt.id,
            charge_amount_usd: "0.000050",
            ledger_id: firstReceipt.creditTransactionId,
            ledger_amount: "-0.000050",
            ledger_type: "debit",
            credit_balance: "9.999950",
          },
        ]);
      } finally {
        await releaseGate(gate).catch(() => {});
        await Promise.allSettled(commits);
        await cleanupGate(gate);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "pins one durable winner when zero and paid prices race for the same key",
    async () => {
      if (!repository || !setupClient) {
        throw new Error("real PostgreSQL harness was not initialized");
      }
      const rawIdempotencyKey = "postgres-zero-versus-paid";
      const identity = await prepareIdentity(ORG_A, rawIdempotencyKey);
      const gate = await armGate(ORG_A);
      const zero = repository.commitTerminal({
        identity,
        chargeAmountUsd: "0.000000",
        response: okResponse(2),
      });
      const paid = repository.commitTerminal({
        identity,
        chargeAmountUsd: "0.000050",
        response: okResponse(2),
      });
      const commits = [zero, paid];

      try {
        await waitForAdvisoryWaiter();
        await releaseGate(gate);
        const results = await Promise.all(commits);

        expect(results.filter((result) => result.outcome === "committed")).toHaveLength(1);
        expect(results.filter((result) => result.outcome === "replayed")).toHaveLength(1);
        expect(new Set(results.map((result) => result.receipt.id)).size).toBe(1);
        expect(new Set(results.map((result) => result.receipt.chargeAmountUsd)).size).toBe(1);

        const replay = await repository.prepare({
          organizationId: ORG_A,
          rawIdempotencyKey,
          request: request(ORG_A),
        });
        expect(replay.outcome).toBe("replay");
        if (replay.outcome !== "replay") throw new Error("Expected a durable replay");
        expect(replay.receipt).toEqual(results[0]?.receipt);

        const state = await setupClient.query<{
          charge_amount_usd: string;
          ledger_count: string;
          credit_balance: string;
        }>(`
          SELECT receipt.charge_amount_usd::text AS charge_amount_usd,
                 count(ledger.id)::text AS ledger_count,
                 organization.credit_balance::text AS credit_balance
            FROM organizations AS organization
            JOIN org_storage_head_receipts AS receipt
              ON receipt.organization_id = organization.id
       LEFT JOIN credit_transactions AS ledger
              ON ledger.id = receipt.credit_transaction_id
           WHERE organization.id = '${ORG_A}'
        GROUP BY receipt.id, organization.id
        `);
        const winnerCharge = results[0]?.receipt.chargeAmountUsd;
        expect(state.rows).toEqual([
          {
            charge_amount_usd: winnerCharge,
            ledger_count: winnerCharge === "0.000050" ? "1" : "0",
            credit_balance: winnerCharge === "0.000050" ? "9.999950" : "10.000000",
          },
        ]);
      } finally {
        await releaseGate(gate).catch(() => {});
        await Promise.allSettled(commits);
        await cleanupGate(gate);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "does not serialize a second organization behind the first organization's row lock",
    async () => {
      if (!repository || !setupClient) {
        throw new Error("real PostgreSQL harness was not initialized");
      }
      const [identityA, identityB] = await Promise.all([
        prepareIdentity(ORG_A, "postgres-independent-org-a"),
        prepareIdentity(ORG_B, "postgres-independent-org-b"),
      ]);
      const gate = await armGate(ORG_A);
      const commitA = repository.commitTerminal({
        identity: identityA,
        chargeAmountUsd: "0.000050",
        response: okResponse(3),
      });
      let commitB: ReturnType<ReceiptRepository["commitTerminal"]> | undefined;
      let resultB: Awaited<ReturnType<ReceiptRepository["commitTerminal"]>> | undefined;
      let concurrentError: unknown;
      let settled: PromiseSettledResult<
        Awaited<ReturnType<ReceiptRepository["commitTerminal"]>>
      >[] = [];
      try {
        await waitForAdvisoryWaiter();
        commitB = repository.commitTerminal({
          identity: identityB,
          chargeAmountUsd: "0.000050",
          response: okResponse(4),
        });
        resultB = await withTimeout(commitB, "organization B commit");
        expect(resultB.outcome).toBe("committed");
        expect(await advisoryWaiterCount()).toBeGreaterThanOrEqual(1);

        const visibleWhileAWaited = await setupClient.query<{
          organization_id: string;
          credit_balance: string;
          receipt_count: string;
          ledger_count: string;
        }>(`
          SELECT organization.id AS organization_id,
                 organization.credit_balance::text AS credit_balance,
                 count(DISTINCT receipt.id)::text AS receipt_count,
                 count(DISTINCT ledger.id)::text AS ledger_count
            FROM organizations AS organization
       LEFT JOIN org_storage_head_receipts AS receipt
              ON receipt.organization_id = organization.id
       LEFT JOIN credit_transactions AS ledger
              ON ledger.organization_id = organization.id
           WHERE organization.id IN ('${ORG_A}', '${ORG_B}')
        GROUP BY organization.id
        ORDER BY organization.id
        `);
        expect(visibleWhileAWaited.rows).toEqual([
          {
            organization_id: ORG_A,
            credit_balance: "10.000000",
            receipt_count: "0",
            ledger_count: "0",
          },
          {
            organization_id: ORG_B,
            credit_balance: "9.999950",
            receipt_count: "1",
            ledger_count: "1",
          },
        ]);
      } catch (error) {
        concurrentError = error;
      } finally {
        await releaseGate(gate).catch(() => {});
        settled = await Promise.allSettled(commitB ? [commitA, commitB] : [commitA]);
        await cleanupGate(gate);
      }

      if (concurrentError !== undefined) throw concurrentError;
      const [settledA, settledB] = settled;
      if (!settledA || !settledB) throw new Error("Expected both organization commits to settle");
      expect(settledA.status).toBe("fulfilled");
      expect(settledB.status).toBe("fulfilled");
      if (settledA.status !== "fulfilled" || settledB.status !== "fulfilled") {
        throw new Error("Expected both organization commits to succeed");
      }
      if (resultB === undefined)
        throw new Error("Expected organization B to complete independently");
      expect(settledA.value.outcome).toBe("committed");
      expect(settledB.value).toEqual(resultB);

      const finalBalances = await setupClient.query<{
        id: string;
        credit_balance: string;
      }>(`
        SELECT id, credit_balance::text AS credit_balance
          FROM organizations
         ORDER BY id
      `);
      expect(finalBalances.rows).toEqual([
        { id: ORG_A, credit_balance: "9.999950" },
        { id: ORG_B, credit_balance: "9.999950" },
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});
