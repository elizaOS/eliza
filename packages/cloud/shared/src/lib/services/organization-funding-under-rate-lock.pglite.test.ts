/**
 * Worker chat admission reads organization funding under the rate decision's
 * policy lock instead of a third transaction. Runs the real rate-limit,
 * funding and dispatch-fence transactions on PGlite; only the organization
 * Durable Object is a fake binding that records what it is asked to commit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "61000000-0000-4000-8000-0000000000c1";
const USER = "63000000-0000-4000-8000-0000000000c1";
const KEY = "64000000-0000-4000-8000-0000000000c1";

let database: typeof import("../../db/client");
let rateLimit: typeof import("../middleware/rate-limit");
let admission: typeof import("./organization-inference-admission");
let bindings: typeof import("../runtime/cloud-bindings");
let telemetry: typeof import("../observability/cloud-backend-observability");

type GateCall = { path: string; body: Record<string, unknown> };
let gateCalls: GateCall[] = [];
let rateAllowed = true;
const gates = {
  getByName: () => ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      gateCalls.push({ path, body });
      if (path === "/rate-limit") {
        const resetAt = Date.now() + 60_000;
        return rateAllowed
          ? Response.json({ allowed: true, remaining: 5, resetAt })
          : Response.json(
              { allowed: false, remaining: 0, resetAt, retryAfter: 60 },
              { status: 429 },
            );
      }
      if (path === "/lease-dispatched") {
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
const env = {
  INFERENCE_ADMISSION_GATES: gates,
  INFERENCE_DEFERRED_ADMISSION: "true",
  INFERENCE_OPTIMISTIC_BILLING: "true",
  INFERENCE_BILLING_LEDGER: "db",
  INFERENCE_SNAPSHOT_ADMISSION_ENABLED: "false",
};

async function exec(query: string): Promise<void> {
  await database.getPgliteClientForTests().exec(query);
}

beforeAll(async () => {
  database = await import("../../db/client");
  await createBillingSnapshotFixture(exec, "");
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${ORG}', '10', 7, 0, '{}', true, false, 'active')`);
  await exec(`INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, rate_limit, is_active, usage_count, created_at, updated_at, user_created)
    VALUES ('${KEY}', 'mobile', 'hc1', 'pc1', '${ORG}', '${USER}', 1000, true, 0, now(), now(), true)`);
  rateLimit = await import("../middleware/rate-limit");
  admission = await import("./organization-inference-admission");
  bindings = await import("../runtime/cloud-bindings");
  telemetry = await import("../observability/cloud-backend-observability");
}, 120_000);

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

/**
 * One Worker chat admission: rate decision, organization admission, then the
 * provider-boundary dispatch. `observe` passes the funding read into the rate
 * decision's lock exactly as the chat route does.
 */
async function chatAdmission(
  requestId: string,
  observe: boolean,
  beforeDispatch?: () => Promise<void>,
) {
  const background: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (promise: Promise<unknown>) => void background.push(promise) };
  let observation:
    | import("./organization-inference-admission").OrganizationFundingObservation
    | undefined;
  let hookRuns = 0;
  const outcome = await bindings.runWithCloudBindingsAsync(env, () =>
    telemetry.observeCloudRequest(
      { id: requestId, traceId: requestId, method: "POST", path: "/api/v1/chat/completions" },
      async () => {
        const limited = await rateLimit.enforceOrgRateLimit(ORG, "completions", {
          cacheOnly: true,
          executionCtx,
          apiKeyId: KEY,
          userId: USER,
          underAdmittedPolicyLock: observe
            ? async (policy, tx) => {
                hookRuns += 1;
                observation = await admission.observeOrganizationFundingUnderPolicyLock(
                  tx,
                  policy,
                  {
                    organizationId: ORG,
                    executionCtx,
                  },
                );
              }
            : undefined,
        });
        if (limited) return { result: { status: limited.status }, status: limited.status };
        try {
          const admitted = await admission.admitOrganizationInference({
            context: {
              organizationId: ORG,
              userId: USER,
              model: "qwen-3.8-27b",
              provider: "cerebras",
              billingSource: "cerebras",
              requestId,
            },
            estimatedInputTokens: 1,
            estimatedOutputTokens: 1,
            flatCost: { totalCost: 0.25, baseTotalCost: 0.25, platformMarkup: 0 },
            executionCtx,
            atomicProviderBoundary: true,
            fundingObservation: observation,
          });
          await beforeDispatch?.();
          await admitted.markProviderDispatched?.();
          return { result: { status: 200 }, status: 200 };
        } catch (error) {
          return { result: { status: 0, error }, status: 500 };
        }
      },
    ),
  );
  await Promise.allSettled(background);
  const request = telemetry.getCloudTelemetrySnapshot().requests.find((r) => r.id === requestId);
  const calls = gateCalls;
  gateCalls = [];
  return {
    ...outcome,
    hookRuns,
    observation,
    // writeTransaction records one "transaction" operation per BEGIN..COMMIT.
    transactions: request?.dbWriteCalls,
    lease: calls.find((call) => call.path.startsWith("/lease"))?.body,
  };
}

describe("funding read under the rate decision's policy lock", () => {
  test("removes one transaction and commits the identical lease", async () => {
    const before = await chatAdmission("req_funding_lock_baseline", false);
    const after = await chatAdmission("req_funding_lock_observed", true);
    expect(before.status).toBe(200);
    expect(after.status).toBe(200);
    // Rate decision, funding read, dispatch fence -> rate decision (with the
    // funding read inside it), dispatch fence.
    expect(before.transactions).toBe(3);
    expect(after.transactions).toBe(2);
    expect(after.hookRuns).toBe(1);
    const strip = (body: Record<string, unknown> | undefined) => {
      const { requestId: _r, recovery: _c, preProviderCancellationToken: _t, ...rest } = body ?? {};
      return rest;
    };
    expect(after.lease).toBeDefined();
    expect(strip(after.lease)).toEqual(strip(before.lease));
    expect(after.lease).toMatchObject({
      balanceUsd: 10,
      balanceRevision: "7",
      estimatedCostUsd: 0.25,
    });
  }, 60_000);

  test("a refused rate decision reads no funding and dispatches nothing", async () => {
    rateAllowed = false;
    try {
      const refused = await chatAdmission("req_funding_lock_refused", true);
      expect(refused.status).toBe(429);
      expect(refused.hookRuns).toBe(0);
      expect(refused.lease).toBeUndefined();
      expect(refused.transactions).toBe(1);
    } finally {
      rateAllowed = true;
    }
  }, 60_000);

  test("a billing hold still refuses admission with the same error and no lease", async () => {
    await exec(`INSERT INTO organization_payment_reversal_holds(organization_id, reason, stripe_dispute_id)
      VALUES ('${ORG}', 'chargeback_lost', 'dp_funding_lock')`);
    try {
      const { BillingHoldActiveError } = await import("./billing-hold");
      const before = await chatAdmission("req_funding_lock_hold_baseline", false);
      const after = await chatAdmission("req_funding_lock_hold_observed", true);
      expect(before.error).toBeInstanceOf(BillingHoldActiveError);
      expect(after.error).toBeInstanceOf(BillingHoldActiveError);
      // The hold is admission's refusal; the rate decision itself still admitted.
      expect(after.hookRuns).toBe(1);
      expect(before.lease).toBeUndefined();
      expect(after.lease).toBeUndefined();
    } finally {
      await exec(
        `DELETE FROM organization_payment_reversal_holds WHERE organization_id = '${ORG}'`,
      );
    }
  }, 60_000);

  test("a policy change after the observation fails dispatch closed before any lease", async () => {
    const { advanceOrganizationPolicyGeneration } = await import(
      "../../db/repositories/organization-policy-generation"
    );
    const { writeTransaction } = await import("../../db/helpers");
    const bump = () =>
      bindings.runWithCloudBindingsAsync(env, () =>
        writeTransaction((tx) =>
          advanceOrganizationPolicyGeneration(tx, {
            organizationId: ORG,
            reason: "test",
            actor: "system:test",
            change: { reason: "funding-lock" },
          }),
        ).then(() => undefined),
      );
    const before = await chatAdmission("req_funding_lock_stale_baseline", false, bump);
    const after = await chatAdmission("req_funding_lock_stale_observed", true, bump);
    expect(before.error).toMatchObject({ code: "ORGANIZATION_POLICY_STALE" });
    expect(after.error).toMatchObject({ code: "ORGANIZATION_POLICY_STALE" });
    expect(before.lease).toBeUndefined();
    expect(after.lease).toBeUndefined();
  }, 60_000);
});
