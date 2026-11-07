/** Canonical accounting on real PGlite; RPC/actor lease retention is qualified separately. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { InferenceBalanceFence } from "./credits";
import type { OrganizationInferenceAdmissionRecovery } from "./inference-admission-recovery";

// Run this file in its own test process, as with the other PGlite billing suites.
const fixtureEnvironment = {
  DATABASE_URL: "pglite://memory",
  TEST_DATABASE_URL: "pglite://memory",
  ENVIRONMENT: "local",
  NODE_ENV: "test",
  MOCK_REDIS: "1",
  CACHE_ENABLED: "true",
  CACHE_BACKEND: "memory",
  INFERENCE_FUNDED_BUDGET_ADMISSION: "false",
  AUTO_TOP_UP_DURABLE_ENABLED: "false",
  LOW_CREDITS_THRESHOLD: "0",
  ELIZA_CLOUD_WEBHOOK_URL: "",
};
const previousEnvironment = new Map(
  Object.keys(fixtureEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, fixtureEnvironment);

type DatabaseClient = typeof import("../../db/client");
let client: DatabaseClient;
let database: ReturnType<DatabaseClient["getPgliteClientForTests"]>;
let recover: typeof import("./inference-admission-recovery").recoverExpiredInferenceAdmissionLease;

beforeAll(async () => {
  client = await import("../../db/client");
  database = client.getPgliteClientForTests();
  const { createBillingSnapshotFixture } = await import(
    "../../db/repositories/account-billing-snapshot-test-fixture"
  );
  await createBillingSnapshotFixture((query) => database.exec(query), "");
  // Reuse the real billing migration fixture and its production revision trigger.
  await database.exec(`
    ALTER TABLE credit_transactions ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE credit_transactions ADD COLUMN user_id uuid;
    ALTER TABLE credit_transactions ADD COLUMN description text;
    ALTER TABLE credit_transactions ADD COLUMN created_at timestamp DEFAULT now();
    ALTER TABLE credit_transactions ADD COLUMN settled_at timestamp;
  `);
  const revisionMigration = await readFile(
    new URL("../../db/migrations/0177_organization_balance_revision.sql", import.meta.url),
    "utf8",
  );
  for (const statement of revisionMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  ({ recoverExpiredInferenceAdmissionLease: recover } = await import(
    "./inference-admission-recovery"
  ));
}, 120_000);

afterAll(async () => {
  await client?.closeDatabaseConnectionsForTests();
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function seed(requestId: string): Promise<OrganizationInferenceAdmissionRecovery> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  await database.query("INSERT INTO users(id) VALUES ($1)", [userId]);
  await database.query(
    `
    INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,
      settings,is_active,auto_top_up_enabled,account_lifecycle_state,billing_email)
    VALUES ($1,'100.000000',0,0,'{}',true,false,'active',NULL)
  `,
    [organizationId],
  );
  return {
    version: 1,
    kind: "organization",
    organizationId,
    requestId,
    userId,
    model: "qwen-3.8-27b",
    provider: "cerebras",
    billingSource: "cerebras",
    description: "Owned synthetic recovery fixture",
    accounting: { kind: "direct_debit" },
  };
}

async function snapshot(organizationId: string) {
  const { rows } = await database.query<{ balance: string; revision: string; debits: number }>(
    `
    SELECT credit_balance::text AS balance,balance_revision::text AS revision,
      (SELECT count(*)::integer FROM credit_transactions WHERE organization_id=$1) AS debits
    FROM organizations WHERE id=$1
  `,
    [organizationId],
  );
  const row = rows[0];
  if (!row) throw new Error("Synthetic recovery organization is missing");
  return { balance: Number(row.balance), revision: row.revision, debits: row.debits };
}

function fence(
  organizationId: string,
  calls: string[],
  rejectPublication = false,
): InferenceBalanceFence {
  return {
    async lowerCommittedBalance(balance, revision) {
      const committed = await snapshot(organizationId);
      expect(committed).toEqual({ balance, revision, debits: 1 });
      calls.push("lower");
    },
    async publishAuthoritativeBalance(balance, revision) {
      expect(calls.at(-1)).toBe("lower");
      const committed = await snapshot(organizationId);
      expect(committed).toEqual({ balance, revision, debits: 1 });
      calls.push("publish");
      if (rejectPublication) throw new Error("Owned publication failure after commit");
    },
  };
}

test("direct recovery debits once and replays the same accounting result", async () => {
  const context = await seed("owned-direct-recovery");
  const calls: string[] = [];
  const first = await recover(context, 1, {
    inferenceBalanceFence: fence(context.organizationId, calls),
  });
  const committed = await snapshot(context.organizationId);
  expect(committed).toEqual({ balance: 99, revision: first.balanceRevision, debits: 1 });
  expect(first).toMatchObject({ balanceUsd: 99, collectedUsd: 1, gateConsumedUsd: 1 });
  expect(calls).toEqual(["lower", "publish"]);
  const replayCalls: string[] = [];
  const replay = await recover(context, 1, {
    inferenceBalanceFence: fence(context.organizationId, replayCalls),
  });
  expect(replay).toEqual(first);
  expect(await snapshot(context.organizationId)).toEqual(committed);
  expect(replayCalls).toEqual(["lower", "publish"]);
}, 60_000);

test("a post-commit callback failure returns no recovery result and replays without another debit", async () => {
  const context = await seed("owned-recovery-publish-failure");
  const calls: string[] = [];
  await expect(
    recover(context, 1, { inferenceBalanceFence: fence(context.organizationId, calls, true) }),
  ).rejects.toThrow();
  const committed = await snapshot(context.organizationId);
  expect(committed.balance).toBe(99);
  expect(committed.debits).toBe(1);
  expect(calls).toEqual(["lower", "publish"]);
  // The actor applies a recovery result only on fulfillment; this rejection
  // must retain its lease. The separate real actor/RPC suite proves that part.
  const result = await recover(context, 1, {
    inferenceBalanceFence: fence(context.organizationId, []),
  });
  expect(result.balanceRevision).toBe(committed.revision);
  expect(await snapshot(context.organizationId)).toEqual(committed);
}, 60_000);

test("a database failure rolls back the debit and ledger claim", async () => {
  const context = await seed("owned-recovery-rollback");
  await database.exec(`
    CREATE FUNCTION reject_owned_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.metadata->>'requestId' = 'owned-recovery-rollback' THEN
        RAISE EXCEPTION 'owned recovery rollback';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_owned_recovery BEFORE INSERT ON credit_transactions
      FOR EACH ROW EXECUTE FUNCTION reject_owned_recovery();
  `);
  const calls: string[] = [];
  try {
    await expect(
      recover(context, 1, { inferenceBalanceFence: fence(context.organizationId, calls) }),
    ).rejects.toThrow();
    expect(await snapshot(context.organizationId)).toEqual({
      balance: 100,
      revision: "0",
      debits: 0,
    });
    expect(calls).toEqual([]);
  } finally {
    await database.exec(
      "DROP TRIGGER reject_owned_recovery ON credit_transactions; DROP FUNCTION reject_owned_recovery()",
    );
  }
}, 60_000);
