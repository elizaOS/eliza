/**
 * Proves agent-billing lease fencing against real PostgreSQL timestamp
 * precision. The harness injects a future lease with explicit microseconds so
 * node-postgres must round-trip it through a millisecond-only Date.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { agentBillingRuns } from "../../schemas/compute-billing";

const SKIP_REASON =
  "[agent billing lease precision] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  MOCK_REDIS: process.env.MOCK_REDIS,
  NODE_ENV: process.env.NODE_ENV,
};

let postgres: EphemeralPostgres | null = null;
let isolatedDatabaseName: string | null = null;
let cleanupPromise: Promise<void> | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("../../client").dbWrite | undefined;
let agentBillingRunRepository:
  | typeof import("../agent-billing-runs").agentBillingRunRepository
  | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string, databaseName: string): Promise<string> {
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: baseDsn });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  return url.toString();
}

async function cleanupHarnessOnce(): Promise<void> {
  const acquiredPostgres = postgres;
  const databaseToDrop = isolatedDatabaseName;
  let firstError: unknown;
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      firstError ??= error;
    }
  };

  await capture(async () => {
    await closeDatabaseConnectionsForTests?.();
  });
  closeDatabaseConnectionsForTests = undefined;
  dbWrite = undefined;
  agentBillingRunRepository = undefined;

  if (acquiredPostgres && databaseToDrop) {
    let admin: Client | undefined;
    let connected = false;
    await capture(async () => {
      admin = new Client({ connectionString: acquiredPostgres.dsn });
      await admin.connect();
      connected = true;
    });
    if (admin && connected) {
      await capture(async () => {
        await admin?.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseToDrop],
        );
      });
      await capture(async () => {
        await admin?.query(`DROP DATABASE IF EXISTS "${databaseToDrop}"`);
      });
    }
    if (admin) {
      await capture(async () => {
        await admin?.end();
      });
    }
  }

  await capture(async () => {
    await acquiredPostgres?.stop();
  });
  postgres = null;
  isolatedDatabaseName = null;

  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    await capture(async () => {
      restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
    });
  }

  if (firstError) throw firstError;
}

function cleanupHarness(): Promise<void> {
  cleanupPromise ??= cleanupHarnessOnce();
  return cleanupPromise;
}

async function initializeHarness(): Promise<void> {
  postgres = await acquireEphemeralPostgres();
  if (!postgres) {
    console.warn(SKIP_REASON);
    return;
  }

  isolatedDatabaseName = `eliza_agent_billing_lease_${randomUUID().replaceAll("-", "")}`;
  const isolatedDsn = await createIsolatedDatabase(postgres.dsn, isolatedDatabaseName);
  process.env.DATABASE_URL = isolatedDsn;
  process.env.TEST_DATABASE_URL = isolatedDsn;
  process.env.MOCK_REDIS = "1";
  process.env.NODE_ENV = "test";

  const clientModule = await import("../../client");
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  dbWrite = clientModule.dbWrite;
  const repositoryModule = await import("../agent-billing-runs");
  agentBillingRunRepository = repositoryModule.agentBillingRunRepository;
}

async function setLeaseWithSubmillisecondPrecision(runId: string): Promise<void> {
  if (!dbWrite) throw new Error("real PostgreSQL harness was not initialized");
  await dbWrite
    .update(agentBillingRuns)
    .set({
      lease_expires_at: sql`date_trunc('milliseconds', clock_timestamp() + INTERVAL '5 minutes') + INTERVAL '456 microseconds'`,
      updated_at: sql`date_trunc('milliseconds', clock_timestamp())`,
    })
    .where(eq(agentBillingRuns.id, runId));
}

async function readLeaseSubmillisecondPrecision(runId: string): Promise<number> {
  if (!dbWrite) throw new Error("real PostgreSQL harness was not initialized");
  const [row] = await dbWrite
    .select({
      submillisecond: sql<string>`mod(
        extract(microseconds FROM ${agentBillingRuns.lease_expires_at})::bigint,
        1000
      )::text`,
    })
    .from(agentBillingRuns)
    .where(eq(agentBillingRuns.id, runId));
  if (!row) throw new Error("agent billing run was not found");
  return Number(row.submillisecond);
}

afterAll(cleanupHarness, 60_000);

try {
  await initializeHarness();
} catch (error) {
  try {
    await cleanupHarness();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "PostgreSQL agent-billing harness initialization and cleanup both failed",
    );
  }
  throw error;
}

beforeAll(async () => {
  if (!dbWrite) return;
  const { apply } = await pushSchema({ agentBillingRuns } as never, dbWrite as never);
  await apply();
}, 60_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("agent billing lease precision", () => {
  test("renews and completes a submillisecond lease without weakening token fencing", async () => {
    if (!dbWrite || !agentBillingRunRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const input = {
      invocationKey: `manual:agent-billing:lease-precision:${randomUUID()}`,
      triggerKind: "manual" as const,
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 5 * 60_000,
    };
    const first = await agentBillingRunRepository.startOrLoad(input);
    if (!first.leaseToken) throw new Error("expected initial lease token");

    await dbWrite
      .update(agentBillingRuns)
      .set({
        lease_expires_at: sql`date_trunc('milliseconds', clock_timestamp() - INTERVAL '1 second')`,
        updated_at: sql`date_trunc('milliseconds', clock_timestamp() - INTERVAL '2 seconds')`,
      })
      .where(eq(agentBillingRuns.id, first.run.id));
    const recovered = await agentBillingRunRepository.startOrLoad(input);
    if (!recovered.leaseToken) throw new Error("expected recovered lease token");
    expect(recovered.leaseToken).not.toBe(first.leaseToken);

    await setLeaseWithSubmillisecondPrecision(first.run.id);
    expect(await readLeaseSubmillisecondPrecision(first.run.id)).toBe(456);
    await expect(
      agentBillingRunRepository.renewLease(first.run.id, first.leaseToken, 5 * 60_000),
    ).rejects.toMatchObject({ code: "AGENT_BILLING_RUN_LEASE_LOST" });
    await expect(
      agentBillingRunRepository.complete(first.run.id, first.leaseToken, {
        status: "succeeded",
        sandboxesProcessed: 1,
        sandboxesBilled: 1,
        warningsSent: 0,
        sandboxesShutdown: 0,
        errors: 0,
        totalRevenue: "0.100000",
        errorSamples: [],
      }),
    ).rejects.toMatchObject({ code: "AGENT_BILLING_RUN_LEASE_LOST" });

    const renewed = await agentBillingRunRepository.renewLease(
      first.run.id,
      recovered.leaseToken,
      5 * 60_000,
    );
    expect(renewed).toMatchObject({
      id: first.run.id,
      status: "started",
      lease_token: recovered.leaseToken,
    });
    expect(await readLeaseSubmillisecondPrecision(first.run.id)).toBe(0);

    await setLeaseWithSubmillisecondPrecision(first.run.id);
    expect(await readLeaseSubmillisecondPrecision(first.run.id)).toBe(456);
    const completionInput = {
      status: "succeeded" as const,
      sandboxesProcessed: 1,
      sandboxesBilled: 1,
      warningsSent: 0,
      sandboxesShutdown: 0,
      errors: 0,
      totalRevenue: "0.100000",
      errorSamples: [],
    };
    const completions = await Promise.all([
      agentBillingRunRepository.complete(first.run.id, recovered.leaseToken, completionInput),
      agentBillingRunRepository.complete(first.run.id, recovered.leaseToken, completionInput),
    ]);
    expect(completions.map((result) => result.completedByCaller).sort()).toEqual([false, true]);
    expect(completions.map((result) => result.terminalReplay).sort()).toEqual([false, true]);
    expect(completions[0]!.run).toEqual(completions[1]!.run);
    expect(completions[0]!.run).toMatchObject({
      id: first.run.id,
      status: "succeeded",
      lease_token: recovered.leaseToken,
      lease_expires_at: null,
    });

    const fresh = await agentBillingRunRepository.startOrLoad({
      ...input,
      invocationKey: `manual:agent-billing:lease-normalization:${randomUUID()}`,
    });
    expect(await readLeaseSubmillisecondPrecision(fresh.run.id)).toBe(0);
  }, 30_000);
});
