/**
 * Funding decisions of Worker inference admission against a real primary.
 *
 * A locally affordable request obtains a shared durable lease. A snapshot
 * that would refuse is decided again from the primary before
 * the refusal is returned, and a debit the balance cannot cover collects what
 * is left, so no organization can repeat a call it did not pay for and none is
 * refused after it paid. Real PGlite, real credit ledger and real projection
 * fill; the organization gate is a recorded port.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { InferenceAdmissionSnapshot } from "./inference-auth-cache";

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
let admission: typeof import("./organization-inference-admission");
let snapshots: typeof import("./inference-admission-snapshot");
let credits: typeof import("./credits");
let bindings: typeof import("../runtime/cloud-bindings");

/** Primary statements issued while a request is being decided. */
let primaryCounting = false;
let primaryStatements = 0;
const gatePaths: string[] = [];
/** A test's own gate answer for a path; undefined falls through to the default. */
let gateReply: ((path: string) => Response | undefined) | undefined;

const gate = {
  INFERENCE_ADMISSION_GATES: {
    getByName() {
      return {
        async fetch(request: Request) {
          const path = new URL(request.url).pathname;
          gatePaths.push(path);
          const reply = gateReply?.(path);
          if (reply) return reply;
          const body = (await request.json()) as { estimatedCostUsd?: number };
          // The controlled gate acknowledges the exact requested exposure.
          return Response.json({
            hydrated: true,
            admitted: true,
            dispatched: true,
            availableUsd: 1,
            requiredUsd: 0.01,
            settlementFenced: true,
            estimatedCostUsd: body.estimatedCostUsd ?? 0.01,
            settled: true,
            published: true,
            allowed: true,
            committed: true,
          });
        },
      };
    },
  },
};

beforeAll(async () => {
  client = await import("../../db/client");
  database = client.getPgliteClientForTests();
  const { createBillingSnapshotFixture } = await import(
    "../../db/repositories/account-billing-snapshot-test-fixture"
  );
  await createBillingSnapshotFixture((query) => database.exec(query), "");
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
  const raw = database as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ["query", "exec", "transaction"]) {
    const original = raw[method]!.bind(raw);
    raw[method] = (...args: unknown[]) => {
      if (primaryCounting) primaryStatements += 1;
      return original(...args);
    };
  }
  admission = await import("./organization-inference-admission");
  snapshots = await import("./inference-admission-snapshot");
  credits = await import("./credits");
  bindings = await import("../runtime/cloud-bindings");
}, 120_000);

afterEach(() => {
  primaryCounting = false;
  gateReply = undefined;
  admission.__clearRequestedInferenceEntryRewrites();
  snapshots.resetInferenceAdmissionMemoryCacheForTests();
});

afterAll(async () => {
  await client?.closeDatabaseConnectionsForTests();
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function seedOrganization(
  balance: string,
): Promise<{ organizationId: string; userId: string }> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  await database.query("INSERT INTO users(id) VALUES ($1)", [userId]);
  await database.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,
       settings,is_active,auto_top_up_enabled,account_lifecycle_state,billing_email)
     VALUES ($1,$2,0,0,'{}',true,false,'active',NULL)`,
    [organizationId, balance],
  );
  return { organizationId, userId };
}

async function ledger(organizationId: string): Promise<{ balance: number; debits: number[] }> {
  const { rows } = await database.query<{ balance: string }>(
    "SELECT credit_balance::text AS balance FROM organizations WHERE id=$1",
    [organizationId],
  );
  const debits = await database.query<{ amount: string }>(
    "SELECT amount::text AS amount FROM credit_transactions WHERE organization_id=$1 ORDER BY created_at",
    [organizationId],
  );
  return {
    balance: Number(rows[0]?.balance),
    debits: debits.rows.map((row) => Number(row.amount)),
  };
}

/** The snapshot a cached auth entry carries: read from the primary, then aged. */
async function carriedSnapshot(
  organizationId: string,
  ageMs: number,
): Promise<InferenceAdmissionSnapshot> {
  const snapshot = await snapshots.loadInferenceAdmissionSnapshot(organizationId);
  return {
    ...snapshot,
    balance: { ...snapshot.balance, balanceAt: Date.now() - ageMs },
  };
}

interface Decision {
  admitted?: Awaited<ReturnType<typeof admission.admitOrganizationInference>>;
  error?: unknown;
  /** Store calls made before the decision returned. */
  primaryStatements: number;
  gateCalls: string[];
  background: Promise<unknown>[];
  entryRefreshes: number;
}

async function decide(
  org: { organizationId: string; userId: string },
  carried: InferenceAdmissionSnapshot,
  estimateUsd: number,
  requestId: string = randomUUID(),
): Promise<Decision> {
  const background: Promise<unknown>[] = [];
  let entryRefreshes = 0;
  gatePaths.length = 0;
  primaryStatements = 0;
  primaryCounting = true;
  let admitted: Decision["admitted"];
  let error: unknown;
  try {
    admitted = await bindings.runWithCloudBindingsAsync(gate, () =>
      admission.admitOrganizationInference({
        context: {
          organizationId: org.organizationId,
          userId: org.userId,
          model: "qwen-3.8-27b",
          provider: "cerebras",
          billingSource: "cerebras",
          requestId,
        },
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        flatCost: { totalCost: estimateUsd, baseTotalCost: estimateUsd, platformMarkup: 0 },
        executionCtx: {
          waitUntil(task) {
            background.push(task);
          },
        },
        admissionSnapshot: carried,
        refreshAuthEntry: () => {
          entryRefreshes += 1;
        },
      }),
    );
  } catch (caught) {
    error = caught;
  } finally {
    primaryCounting = false;
  }
  return {
    admitted,
    error,
    primaryStatements,
    gateCalls: [...gatePaths],
    background,
    get entryRefreshes() {
      return entryRefreshes;
    },
  };
}

async function drain(decision: Decision): Promise<void> {
  for (let settled = 0; settled < decision.background.length; ) {
    const pending = decision.background.slice(settled);
    settled = decision.background.length;
    await bindings.runWithCloudBindingsAsync(gate, () => Promise.allSettled(pending));
  }
}

const FRESH = 0;
const AGED = 10 * 60_000;

test("a balance below the request's estimate is refused before the provider with no store call", async () => {
  const org = await seedOrganization("0.100000");
  const decision = await decide(org, await carriedSnapshot(org.organizationId, FRESH), 1);
  expect(decision.admitted).toBeUndefined();
  expect(decision.error).toBeInstanceOf(credits.InsufficientCreditsError);
  expect(decision.error).toMatchObject({ required: 1, available: 0.1 });
  expect(decision.primaryStatements).toBe(0);
  expect(decision.gateCalls).toEqual([]);
  // A locally affordable request still obtains a shared durable lease.
  const affordable = await decide(org, await carriedSnapshot(org.organizationId, FRESH), 0.05);
  expect(affordable.admitted?.mode).toBe("durable_object_debit");
  expect(affordable.primaryStatements).toBe(0);
  expect(affordable.gateCalls).toEqual(["/lease"]);
});

test("an aged refusing snapshot is decided again from the primary and still refuses a balance below the estimate", async () => {
  const org = await seedOrganization("0.100000");
  const decision = await decide(org, await carriedSnapshot(org.organizationId, AGED), 1);
  expect(decision.error).toBeInstanceOf(credits.InsufficientCreditsError);
  expect(decision.error).toMatchObject({ required: 1, available: 0.1 });
  expect(decision.primaryStatements).toBeGreaterThan(0);
});

test("an uncollectable debit collects the remaining balance once and the next request is refused", async () => {
  const org = await seedOrganization("0.100000");
  const carried = await carriedSnapshot(org.organizationId, FRESH);
  const decision = await decide(org, carried, 0.05);
  expect(decision.admitted?.mode).toBe("durable_object_debit");

  // The provider used more than the estimate and more than the balance.
  const settle = () =>
    bindings.runWithCloudBindingsAsync(gate, () => decision.admitted!.settle(0.5));
  const reconciliation = await settle();
  expect(reconciliation).toMatchObject({
    actualCost: 0.5,
    collectedAmount: 0.1,
    adjustmentType: "uncollected_overage",
  });
  expect(await ledger(org.organizationId)).toEqual({ balance: 0, debits: [-0.1] });
  // Settlement rewrites the caller's cached entry and refills the projection.
  expect(decision.entryRefreshes).toBe(1);
  await drain(decision);

  // The same admission settles once: a repeat returns the first result.
  expect(await settle()).toEqual(reconciliation);
  expect(await ledger(org.organizationId)).toEqual({
    balance: 0,
    debits: [-0.1],
  });

  // The entry another isolate still carries shows the old balance. This
  // isolate holds the refilled projection, so the request is refused.
  const next = await decide(org, carried, 0.05);
  expect(next.admitted).toBeUndefined();
  expect(next.error).toBeInstanceOf(credits.InsufficientCreditsError);
  expect(next.error).toMatchObject({ available: 0 });
  expect(await ledger(org.organizationId)).toEqual({ balance: 0, debits: [-0.1] });
});

test("an entry showing no credit admits the very next request after a credit grant commits", async () => {
  const org = await seedOrganization("0.000000");
  const carried = await carriedSnapshot(org.organizationId, AGED);
  expect(carried.balance.balanceUsd).toBe(0);

  // The grant commits through the credit ledger, outside any Worker request,
  // so nothing rewrites the cached auth entry.
  await credits.creditsService.addCredits({
    organizationId: org.organizationId,
    amount: 5,
    description: "Granted credit",
    deferCacheInvalidation: true,
  });

  const admitted = await decide(org, carried, 0.05);
  expect(admitted.error).toBeUndefined();
  expect(admitted.admitted?.mode).toBe("durable_object_debit");
  // The refusal was decided again from the primary, and the entry is rewritten.
  expect(admitted.primaryStatements).toBeGreaterThan(0);
  expect(admitted.entryRefreshes).toBe(1);

  // The refilled projection avoids primary reads; the shared lease remains required.
  const warm = await decide(org, carried, 0.05);
  expect(warm.admitted?.mode).toBe("durable_object_debit");
  expect(warm.primaryStatements).toBe(0);
  expect(warm.gateCalls).toEqual(["/lease"]);
});

test("a refusal read from the primary in the last second is not read again, and is after that", async () => {
  const org = await seedOrganization("0.000000");
  const carried = await carriedSnapshot(org.organizationId, AGED);
  const refused = await decide(org, carried, 0.05);
  expect(refused.error).toBeInstanceOf(credits.InsufficientCreditsError);
  expect(refused.primaryStatements).toBeGreaterThan(0);
  await drain(refused);

  // The isolate just read this refusal from the primary: a repeat costs no read.
  const repeated = await decide(org, carried, 0.05);
  expect(repeated.error).toBeInstanceOf(credits.InsufficientCreditsError);
  expect(repeated.primaryStatements).toBe(0);

  await credits.creditsService.addCredits({
    organizationId: org.organizationId,
    amount: 5,
    description: "Granted credit",
    deferCacheInvalidation: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const admitted = await decide(org, carried, 0.05);
  expect(admitted.admitted?.mode).toBe("durable_object_debit");
});

test("a held entry admits the very next request after the hold is released", async () => {
  const org = await seedOrganization("5.000000");
  const carried: InferenceAdmissionSnapshot = {
    ...(await carriedSnapshot(org.organizationId, AGED)),
    billingHold: true,
  };
  const decision = await decide(org, carried, 0.05);
  expect(decision.error).toBeUndefined();
  expect(decision.admitted?.mode).toBe("durable_object_debit");
  expect(decision.entryRefreshes).toBe(1);
});

test("a refusal that the primary cannot be read for stands", async () => {
  const org = await seedOrganization("0.000000");
  const carried = await carriedSnapshot(org.organizationId, AGED);
  await database.query("DELETE FROM organizations WHERE id = $1", [org.organizationId]);
  const decision = await decide(org, carried, 0.05);
  expect(decision.admitted).toBeUndefined();
  expect(decision.error).toBeInstanceOf(credits.InsufficientCreditsError);
});

test("a recovery of the same request after a top-up collects nothing on top of the remainder", async () => {
  const org = await seedOrganization("0.100000");
  const requestId = randomUUID();
  const first = await decide(
    org,
    await carriedSnapshot(org.organizationId, FRESH),
    0.05,
    requestId,
  );
  await bindings.runWithCloudBindingsAsync(gate, () => first.admitted!.settle(0.5));
  await drain(first);
  expect(await ledger(org.organizationId)).toEqual({
    balance: 0,
    debits: [-0.1],
  });

  // Credit arrives, then another isolate (or the gate alarm) settles the same
  // request id again from a fresh admission: the whole charge is affordable
  // now, and the request was already settled for the remainder.
  await credits.creditsService.addCredits({
    organizationId: org.organizationId,
    amount: 5,
    description: "Granted credit",
    deferCacheInvalidation: true,
  });
  snapshots.resetInferenceAdmissionMemoryCacheForTests();
  const replay = await decide(
    org,
    await carriedSnapshot(org.organizationId, FRESH),
    0.05,
    requestId,
  );
  expect(replay.admitted?.mode).toBe("durable_object_debit");
  await bindings.runWithCloudBindingsAsync(gate, () => replay.admitted!.settle(0.5));
  await drain(replay);
  const after = await ledger(org.organizationId);
  expect(after.balance).toBe(5);
  expect(after.debits.filter((amount) => amount < 0)).toEqual([-0.1]);

  // The fast-path debit under the same identity is the same single row too.
  const fastPath = await import("./inference-billing-fast-path");
  await bindings.runWithCloudBindingsAsync(gate, () =>
    fastPath.debitInferenceCost(
      {
        requestId,
        organizationId: org.organizationId,
        userId: org.userId,
        model: "qwen-3.8-27b",
        provider: "cerebras",
        billingSource: "cerebras",
      },
      0.5,
      "deferred",
    ),
  );
  const direct = await ledger(org.organizationId);
  expect(direct.balance).toBe(5);
  expect(direct.debits.filter((amount) => amount < 0)).toEqual([-0.1]);
});

test("a refused durable dispatch leaves the original hold and performs no unfenced debit", async () => {
  const org = await seedOrganization("0.100000");
  const decision = await decide(org, await carriedSnapshot(org.organizationId, FRESH), 0.05);
  expect(decision.admitted?.mode).toBe("durable_object_debit");
  expect(decision.gateCalls).toEqual(["/lease"]);
  gateReply = (path) =>
    path === "/dispatch" ? new Response("unavailable", { status: 503 }) : undefined;
  await expect(
    bindings.runWithCloudBindingsAsync(gate, () => decision.admitted!.markProviderDispatched!()),
  ).rejects.toBeDefined();
  expect(await ledger(org.organizationId)).toEqual({ balance: 0.1, debits: [] });
});

test("a gate that cannot settle the lease still refreshes the cached standing", async () => {
  const org = await seedOrganization("5.000000");
  const decision = await decide(org, await carriedSnapshot(org.organizationId, FRESH), 0.05);
  // The lease is committed and fenced; only the final settlement is lost.
  gateReply = (path) =>
    path === "/dispatch"
      ? Response.json({ dispatched: true })
      : path === "/settlement-fence"
        ? Response.json({ settlementFenced: true, estimatedCostUsd: 0.05 })
        : path === "/settle"
          ? new Response("unavailable", { status: 503 })
          : undefined;
  await expect(
    bindings.runWithCloudBindingsAsync(gate, () => decision.admitted!.settle(0.05)),
  ).rejects.toBeDefined();
  expect(gatePaths).toContain("/settle");
  expect(await ledger(org.organizationId)).toEqual({
    balance: 4.95,
    debits: [-0.05],
  });
  // Credit remains, so only the failed gate step asked for the refresh.
  expect(decision.entryRefreshes).toBe(1);
  await drain(decision);
});

test("a client retrying a refusal does not start an entry rewrite per request", async () => {
  const org = await seedOrganization("0.000000");

  // The entry already refuses for the facts the primary holds: nothing to
  // rewrite, however often the request is repeated and re-read.
  const refusing = await carriedSnapshot(org.organizationId, AGED);
  let rewrites = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const refused = await decide(org, refusing, 0.05);
    expect(refused.error).toBeInstanceOf(credits.InsufficientCreditsError);
    rewrites += refused.entryRefreshes;
    await drain(refused);
  }
  expect(rewrites).toBe(0);

  // An entry that still shows credit disagrees with the refusal this isolate
  // just read from the primary: it is rewritten once, not once per request.
  const stale: InferenceAdmissionSnapshot = {
    ...refusing,
    balance: { ...refusing.balance, balanceUsd: 5, balanceRevision: "stale" },
  };
  let staleRewrites = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const refused = await decide(org, stale, 0.05);
    expect(refused.error).toBeInstanceOf(credits.InsufficientCreditsError);
    staleRewrites += refused.entryRefreshes;
    await drain(refused);
  }
  expect(staleRewrites).toBe(1);
});

test("every funding refusal admission raises maps to 402 for routes that classify by error name", async () => {
  const { getErrorStatusCode } = await import("../api/errors");
  const { failureResponse } = await import("../api/cloud-worker-errors");
  const context = {
    json: (body: unknown, status: number, headers?: Record<string, string>) =>
      new Response(JSON.stringify(body), { status, headers }),
  } as unknown as Parameters<typeof failureResponse>[0];

  // An exhausted plan allowance, as a subscriber's entry refuses it.
  const org = await seedOrganization("0.000000");
  const base = await carriedSnapshot(org.organizationId, FRESH);
  const exhausted = await decide(
    org,
    {
      ...base,
      subscriptionFunded: true,
      funding: { balanceUsd: 0, balanceRevision: base.balance.balanceRevision },
    },
    0.05,
  );
  expect(exhausted.error).toBeInstanceOf(admission.AllowanceExhaustedError);
  // A billing hold, and plain exhausted credit.
  const held = await decide(org, { ...base, billingHold: true }, 0.05);
  expect(held.error).toBeInstanceOf(credits.BillingHoldActiveError);
  const broke = await decide(org, base, 0.05);
  expect(broke.error).toBeInstanceOf(credits.InsufficientCreditsError);

  for (const refusal of [exhausted.error, held.error, broke.error]) {
    expect(getErrorStatusCode(refusal)).toBe(402);
    expect(failureResponse(context, refusal).status).toBe(402);
  }
});
