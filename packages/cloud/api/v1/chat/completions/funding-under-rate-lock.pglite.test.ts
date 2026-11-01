/**
 * The Worker chat route reads organization funding inside the rate decision's
 * policy-lock transaction only when its cache-only dependency reads settled
 * first. This runs the real `handleChatCompletionsPOST` on PGlite with the
 * real rate decision, organization admission and dispatch fence. The stand-ins
 * are the organization Durable Object binding (it holds the rate decision open
 * on a gate), auth resolution, the pooled-credential lookup (the dependency
 * gate) and the provider endpoint. The same request runs in both orders:
 * dependencies first (the funding read joins the rate decision) and the rate
 * decision first (admission keeps its own transaction, the base path). Every
 * outcome must match between the two orders.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { ElizaError } from "@elizaos/core";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const ORG = "61000000-0000-4000-8000-0000000000d1";
const APP_OWNER = "61000000-0000-4000-8000-0000000000d2";
const USER = "63000000-0000-4000-8000-0000000000d1";
const APP = "65000000-0000-4000-8000-0000000000d1";
const CEREBRAS_MODEL = "gpt-oss-120b";
const ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-6";

type Order = "dependencies-first" | "rate-first" | "ungated";
type Signal = { promise: Promise<void>; resolve(): void };

let database: typeof import("@elizaos/cloud-shared/db/client");
let bindings: typeof import("@elizaos/cloud-shared/lib/runtime/cloud-bindings");

let suspended = false;
let poolResult: unknown = { kind: "ready", credential: null };
let holdFault: ((executor: unknown) => Promise<void>) | undefined;

/** Per-request observations; the route runs one request at a time. */
interface Trace {
  firstTransaction: number;
  doPaths: string[];
  lease?: Record<string, unknown>;
  /** Request-relative ordinal of the transaction each billing-hold read ran in. */
  holdReads: number[];
  transactionsAtDispatch?: number;
  dependenciesSettled: Signal;
  rateDecided: Signal;
  order: Order;
}
let trace: Trace | undefined;
let begun = 0;
let activeTransaction = 0;

function relative(ordinal: number): number {
  return trace ? ordinal - trace.firstTransaction : ordinal;
}

const gates = {
  getByName: () => ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      trace?.doPaths.push(path);
      if (path === "/rate-limit") {
        // Hold the admitted decision inside its transaction until the
        // dependency reads have settled (and their observer ran).
        if (trace?.order === "dependencies-first") {
          await trace.dependenciesSettled.promise;
          await Bun.sleep(5);
        }
        return Response.json({
          allowed: true,
          remaining: 5,
          resetAt: Date.now() + 60_000,
        });
      }
      if (path.startsWith("/lease")) {
        if (trace) trace.lease = body;
        const required = body.estimatedCostUsd as number;
        return Response.json({
          admitted: true,
          dispatched: true,
          requiredUsd: required,
          availableUsd: (body.balanceUsd as number) - required,
        });
      }
      return Response.json({}, { status: 202 });
    },
  }),
};

function bindingEnv(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    INFERENCE_ADMISSION_GATES: gates,
    INFERENCE_DEFERRED_ADMISSION: "true",
    INFERENCE_OPTIMISTIC_BILLING: "true",
    INFERENCE_BILLING_LEDGER: "db",
    INFERENCE_SNAPSHOT_ADMISSION_ENABLED: "false",
    CEREBRAS_API_KEY: "csk-funding-lock-route",
    ...overrides,
  };
}

async function exec(query: string): Promise<void> {
  await database.getPgliteClientForTests().exec(query);
}

beforeAll(async () => {
  database = await import("@elizaos/cloud-shared/db/client");
  bindings = await import("@elizaos/cloud-shared/lib/runtime/cloud-bindings");
  const { pushSchemaToTestDb } = await import(
    "../../../../shared/src/db/push-schema-for-tests"
  );
  const { aiPricingEntries } = await import(
    "../../../../shared/src/db/schemas/ai-pricing"
  );
  await pushSchemaToTestDb({ aiPricingEntries });
  const { createBillingSnapshotFixture } = await import(
    "../../../../shared/src/db/repositories/account-billing-snapshot-test-fixture"
  );
  await createBillingSnapshotFixture(exec, "");
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${ORG}', '10', 7, 0, '{}', true, false, 'active')`);
  const { aiPricingRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/ai-pricing"
  );
  for (const [chargeType, unitPrice] of [
    ["input", 1e-6],
    ["output", 2e-6],
  ] as const) {
    await aiPricingRepository.createManualOverride({
      billingSource: "cerebras",
      provider: "cerebras",
      model: CEREBRAS_MODEL,
      productFamily: "language",
      chargeType,
      unit: "token",
      unitPrice,
      dimensionKey: "*",
      dimensions: {},
      reason: "test: isolated prices",
      updatedBy: "test",
    });
  }
  // Workers price from cache only; warm it the way a previous request would.
  const { calculateCost } = await import("@elizaos/cloud-shared/lib/pricing");
  await bindings.runWithCloudBindingsAsync(bindingEnv({}), () =>
    calculateCost(CEREBRAS_MODEL, "cerebras", 1, 1, "cerebras"),
  );

  // Count transactions and name the one whose callback is running. PGlite
  // serves one connection, like a Worker request.
  const pg = database.getPgliteClientForTests();
  const realTransaction = pg.transaction.bind(pg);
  pg.transaction = ((callback: Parameters<typeof pg.transaction>[0]) =>
    realTransaction(async (tx) => {
      const ordinal = ++begun;
      activeTransaction = ordinal;
      try {
        return await callback(tx);
      } finally {
        activeTransaction = 0;
        // Auth is resolved without Postgres: the first transaction is the rate decision.
        if (relative(ordinal) === 1) trace?.rateDecided.resolve();
      }
    })) as typeof pg.transaction;

  const { billingHoldService } = await import(
    "@elizaos/cloud-shared/lib/services/billing-hold"
  );
  const assertNoHold = billingHoldService.assertNoHold.bind(billingHoldService);
  spyOn(billingHoldService, "assertNoHold").mockImplementation(
    async (organizationId, executor) => {
      trace?.holdReads.push(relative(activeTransaction));
      if (holdFault) return holdFault(executor);
      return assertNoHold(organizationId, executor);
    },
  );

  const { getTeamPoolRegistry } = await import(
    "@elizaos/cloud-shared/lib/services/team-credential-pool"
  );
  spyOn(getTeamPoolRegistry(), "selectCredentialCacheOnly").mockImplementation(
    (async () => {
      if (trace?.order === "rate-first") await trace.rateDecided.promise;
      trace?.dependenciesSettled.resolve();
      return poolResult;
    }) as never,
  );

  const { appsService } = await import(
    "@elizaos/cloud-shared/lib/services/apps"
  );
  spyOn(
    appsService,
    "getAuthorizedMonetizedAppForUserCacheOnly",
  ).mockImplementation((async () => ({
    kind: "ready",
    app: {
      id: APP,
      organization_id: APP_OWNER,
      monetization_enabled: true,
      inference_markup_percentage: "0",
      is_active: true,
    },
  })) as never);

  const authContext = await import(
    "@elizaos/cloud-shared/lib/services/inference-auth-context"
  );
  const realAuthContext = { ...authContext };
  mock.module(
    "@elizaos/cloud-shared/lib/services/inference-auth-context",
    () => ({
      ...realAuthContext,
      resolveInferenceAuthContext: async () =>
        suspended
          ? { kind: "suspended", reason: "moderation_blocked" }
          : {
              kind: "authorized",
              source: "cache",
              ctx: { userId: USER, orgId: ORG },
            },
    }),
  );

  spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    if (trace && trace.transactionsAtDispatch === undefined)
      trace.transactionsAtDispatch = begun - trace.firstTransaction;
    if (url !== "https://api.cerebras.ai/v1/chat/completions")
      throw new Error(`unexpected provider request: ${url}`);
    return Response.json({
      id: "chatcmpl-funding-lock",
      object: "chat.completion",
      created: 1,
      model: CEREBRAS_MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  }) as typeof fetch);
}, 120_000);

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

beforeEach(() => {
  suspended = false;
  poolResult = { kind: "ready", credential: null };
  holdFault = undefined;
});

async function send(
  order: Order,
  options: {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    env?: Record<string, unknown>;
  } = {},
) {
  const { handleChatCompletionsPOST } = await import("./route");
  trace = {
    firstTransaction: begun,
    doPaths: [],
    holdReads: [],
    dependenciesSettled: Promise.withResolvers<void>(),
    rateDecided: Promise.withResolvers<void>(),
    order,
  };
  const background: Promise<unknown>[] = [];
  const response = await bindings.runWithCloudBindingsAsync(
    bindingEnv(options.env ?? {}),
    () =>
      handleChatCompletionsPOST(
        new Request("https://api.eliza.app/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...options.headers },
          body: JSON.stringify(
            options.body ?? {
              model: CEREBRAS_MODEL,
              messages: [{ role: "user", content: "hi" }],
            },
          ),
        }),
        { executionCtx: { waitUntil: (task) => void background.push(task) } },
      ),
  );
  // A refusal returned before the rate verdict leaves it running; let it end.
  if (!suspended) await trace.rateDecided.promise;
  await Promise.allSettled(background);
  const body = (await response.json()) as Record<string, unknown>;
  const completed = trace;
  trace = undefined;
  return {
    status: response.status,
    body: "error" in body ? body.error : { object: body.object },
    // Telemetry headers show which phase produced the response.
    headers: [...response.headers.keys()].sort(),
    ...completed,
    /** The funding read ran inside the rate decision's transaction. */
    readUnderRateLock: completed.holdReads.includes(1),
  };
}

/** What the caller sees: status, error body and header names. */
function response(result: Awaited<ReturnType<typeof send>>) {
  return { status: result.status, body: result.body, headers: result.headers };
}

/** The same request in both orders: the funding read joins the rate decision, or not. */
async function bothOrders(options: Parameters<typeof send>[1] = {}) {
  const observed = await send("dependencies-first", options);
  const base = await send("rate-first", options);
  return { observed, base };
}

describe("chat route: funding read under the rate decision's policy lock", () => {
  test("dependencies first: the rate decision reads funding and admission reuses it", async () => {
    const { observed, base } = await bothOrders();
    expect(observed.status).toBe(200);
    expect(response(base)).toEqual(response(observed));
    // Rate decision with the funding read inside it, dispatch fence ->
    // rate decision, admission's funding transaction, dispatch fence.
    expect(observed.readUnderRateLock).toBe(true);
    expect(observed.holdReads).toEqual([1]);
    expect(observed.transactionsAtDispatch).toBe(2);
    expect(base.readUnderRateLock).toBe(false);
    expect(base.holdReads).toEqual([2]);
    expect(base.transactionsAtDispatch).toBe(3);
    const strip = (body: Record<string, unknown> | undefined) => {
      const {
        requestId: _r,
        recovery: _c,
        preProviderCancellationToken: _t,
        ...rest
      } = body ?? {};
      return rest;
    };
    expect(observed.lease).toMatchObject({
      balanceUsd: 10,
      balanceRevision: "7",
    });
    expect(strip(observed.lease)).toEqual(strip(base.lease));
  }, 60_000);

  describe("requests that organization credits do not fund never read under the lock", () => {
    test("a monetized app funds the request", async () => {
      // App funding settles against app tables this fixture does not model,
      // so only the funding read is compared, not the app admission outcome.
      const { observed, base } = await bothOrders({
        headers: { "X-App-Id": APP },
      });
      expect(observed.doPaths).toContain("/rate-limit");
      expect(observed.readUnderRateLock).toBe(false);
      expect(base.readUnderRateLock).toBe(false);
    }, 60_000);

    test("a pooled credential serves the request", async () => {
      poolResult = {
        kind: "ready",
        credential: {
          credentialId: "pooled-funding-lock",
          providerId: "cerebras-api",
          apiKey: "csk-pooled-funding-lock",
          label: "pooled",
        },
      };
      const { observed, base } = await bothOrders();
      expect(observed.status).toBe(200);
      expect(observed.holdReads).toEqual([]);
      expect(base.holdReads).toEqual([]);
      // Only the rate decision: pooled credentials take no organization lease.
      expect(observed.transactionsAtDispatch).toBe(1);
      expect(base.transactionsAtDispatch).toBe(1);
      expect(response(base)).toEqual(response(observed));
    }, 60_000);

    test("no platform credential is configured", async () => {
      const { observed, base } = await bothOrders({
        env: { CEREBRAS_API_KEY: "" },
      });
      expect(observed.status).toBe(503);
      expect(observed.body).toMatchObject({ code: "ai_not_configured" });
      expect(observed.holdReads).toEqual([]);
      expect(response(base)).toEqual(response(observed));
    }, 60_000);

    test("a blocked user is refused before the rate decision", async () => {
      suspended = true;
      const blocked = await send("ungated");
      expect(blocked.status).toBe(403);
      expect(blocked.doPaths).not.toContain("/rate-limit");
      expect(blocked.holdReads).toEqual([]);
    }, 60_000);
  });

  describe("refusals keep the base precedence and mapping", () => {
    // The typed policy refusals the funding reads raise (the capacity read's
    // requireOrganizationPolicyBalance, a policy stamp check), thrown by the
    // read itself so both orders meet the same failure.
    const policyRefusal = (code: string) => () => {
      holdFault = async () => {
        throw new ElizaError("Organization policy refused admission", {
          code,
          context: { organizationId: ORG },
          severity: "ephemeral",
        });
      };
    };
    const databaseError = () => {
      // A real Postgres error aborts the transaction the read runs in.
      holdFault = async (executor) => {
        await (
          executor as { execute(query: unknown): Promise<unknown> }
        ).execute(sql`select 1/0`);
      };
    };

    test("a model refusal still wins", async () => {
      databaseError();
      const refused = await send("ungated", {
        body: {
          model: CEREBRAS_MODEL,
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "extreme",
        },
      });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: "invalid_reasoning_effort" });
      expect(refused.holdReads).toEqual([]);
    }, 60_000);

    test("a dependency refusal still wins", async () => {
      databaseError();
      poolResult = { kind: "warming" };
      const { observed, base } = await bothOrders({
        env: { CEREBRAS_API_KEY: "" },
      });
      expect(observed.status).toBe(503);
      expect(observed.body).toMatchObject({
        code: "inference_dependency_cache_warming",
      });
      expect(observed.holdReads).toEqual([]);
      expect(response(base)).toEqual(response(observed));
    }, 60_000);

    for (const [name, fault] of [
      [
        "an unavailable policy",
        policyRefusal("ORGANIZATION_POLICY_UNAVAILABLE"),
      ],
      ["a stale policy", policyRefusal("ORGANIZATION_POLICY_STALE")],
      ["a database error", databaseError],
    ] as const) {
      test(`a pricing refusal still wins over ${name} in the funding read`, async () => {
        fault();
        const { observed, base } = await bothOrders({
          body: {
            model: ANTHROPIC_MODEL,
            messages: [{ role: "user", content: "hi" }],
            webSearchEnabled: true,
          },
          env: { ANTHROPIC_API_KEY: "sk-ant-funding-lock-route" },
        });
        // The read ran under the lock and failed; the failure is admission's.
        expect(observed.readUnderRateLock).toBe(true);
        expect(observed.status).toBe(503);
        expect(observed.body).toMatchObject({
          code: "billing_cache_warming",
          details: { dependency: "pricing" },
        });
        expect(base.readUnderRateLock).toBe(false);
        expect(response(base)).toEqual(response(observed));
      }, 60_000);
    }

    for (const [name, code] of [
      ["an unavailable", "ORGANIZATION_POLICY_UNAVAILABLE"],
      ["a stale", "ORGANIZATION_POLICY_STALE"],
    ] as const) {
      test(`${name} policy in the funding read maps exactly as base`, async () => {
        policyRefusal(code)();
        const { observed, base } = await bothOrders();
        expect(observed.readUnderRateLock).toBe(true);
        expect(observed.body).not.toMatchObject({
          code: "rate_limit_cache_warming",
        });
        expect(observed.lease).toBeUndefined();
        expect(response(base)).toEqual(response(observed));
        expect(base.lease).toBeUndefined();
      }, 60_000);
    }

    test("a database error maps exactly as base and leaves the rate decision admitted", async () => {
      databaseError();
      const { observed, base } = await bothOrders();
      expect(observed.readUnderRateLock).toBe(true);
      expect(observed.status).toBe(500);
      expect(observed.lease).toBeUndefined();
      expect(response(base)).toEqual(response(observed));
      // The aborted read-only transaction ended without failing the request.
      holdFault = undefined;
      const next = await send("dependencies-first");
      expect(next.status).toBe(200);
      expect(next.transactionsAtDispatch).toBe(2);
    }, 60_000);

    test("a billing hold refuses admission exactly as base", async () => {
      await exec(`INSERT INTO organization_payment_reversal_holds(organization_id, reason, stripe_dispute_id)
        VALUES ('${ORG}', 'chargeback_lost', 'dp_funding_lock_route')`);
      try {
        const { observed, base } = await bothOrders();
        expect(observed.readUnderRateLock).toBe(true);
        expect(observed.status).toBe(402);
        expect(observed.body).toMatchObject({ type: "insufficient_quota" });
        expect(observed.lease).toBeUndefined();
        expect(response(base)).toEqual(response(observed));
        expect(base.lease).toBeUndefined();
      } finally {
        await exec(
          `DELETE FROM organization_payment_reversal_holds WHERE organization_id = '${ORG}'`,
        );
      }
    }, 60_000);
  });
});
