/** Real paid proxy guard and proxy engine with explicit caller standing, durable admission and provider boundaries; no live effects. */
import { beforeEach, expect, mock, test } from "bun:test";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import type { PreparedPaidProxyBody } from "../src/lib/guarded-paid-proxy";

type Admission = { admissionSnapshot?: unknown; executionCtx?: unknown };
class InsufficientCredits extends Error {
  required = 0.01;
  available = 0;
}
let caller: object;
let funded = true;
let provided = 0;
let admissions: Admission[] = [];
let settled: number[] = [];
let waits: Promise<unknown>[] = [];
let standaloneCredentialChecks = 0;
const user = { id: "proxy-user", organization_id: "proxy-org" };
const worker = {
  waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
  passThroughOnException() {},
  props: {},
};

mock.module("../src/lib/generative-route-auth", () => ({
  getGenerativeExecutionContext: (c: { executionCtx: unknown }) =>
    c.executionCtx,
  requireGenerativeRouteCaller: async () => {
    if (caller instanceof ApiError) throw caller;
    return caller;
  },
  asGenerativeCacheApiError: () => null,
}));
const lib = "../../shared/src/lib";
mock.module(`${lib}/services/organization-inference-admission`, () => ({
  InferenceAdmissionUnavailableError: class extends Error {},
  admitOrganizationInference: async (params: Admission) => {
    admissions.push(params);
    if (!funded) throw new InsufficientCredits();
    return {
      settle: async (usd: number) => void settled.push(usd),
      settleUnknown: async () => {},
    };
  },
}));
mock.module(`${lib}/services/credits`, () => ({
  InsufficientCreditsError: InsufficientCredits,
}));
// Engine infrastructure the combined Worker path must not reach here.
const unused = () => {
  throw Error("not on the combined Worker path");
};
mock.module(`${lib}/auth`, () => ({
  requireAuth: unused,
  requireAuthOrApiKey: unused,
  requireAuthOrApiKeyWithOrg: unused,
  requireAuthWithOrg: unused,
}));
mock.module(`${lib}/services/allowance-first-credits`, () => ({
  reserveAllowanceEligibleCredits: unused,
}));
mock.module(`${lib}/middleware/rate-limit`, () => ({ withRateLimit: unused }));
mock.module(`${lib}/cache/client`, () => ({
  cache: { get: unused, set: unused },
}));
mock.module(`${lib}/services/usage`, () => ({
  usageService: { create: async () => {} },
}));
mock.module(`${lib}/utils/logger`, () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));
mock.module(`${lib}/services/inference-admission-gate`, () => ({}));
mock.module(`${lib}/services/inference-billing-fast-path`, () => ({
  InferenceBillingUnavailableError: class extends Error {},
}));
mock.module(`${lib}/services/inference-credential-revocation`, () => ({
  InferenceCredentialRevocationUnavailableError: class extends Error {},
  InferenceCredentialRevokedError: class extends Error {},
  inferenceCredentialRevocationReason: String,
  assertInferenceCredentialActive: async () => {
    standaloneCredentialChecks++;
  },
}));
mock.module(`${lib}/services/proxy/pricing`, () => ({
  PricingNotFoundError: class extends Error {},
}));
const { executeGuardedPaidProxyWithPreflight } = await import(
  "../src/lib/guarded-paid-proxy"
);

const tokenBalances: PreparedPaidProxyBody = {
  config: {
    id: "chain-data",
    name: "Chain data",
    auth: "apiKeyWithOrg",
    getCost: async () => 0.01,
  },
  work: async () => {
    provided++;
    return { response: Response.json({ balances: [] }) };
  },
  body: { method: "getTokenBalances" },
};
const app = new Hono<AppEnv>().get("/:chain", (c) =>
  executeGuardedPaidProxyWithPreflight(c, () =>
    c.req.param("chain") === "eth"
      ? tokenBalances
      : c.json({ error: "Invalid chain" }, 400),
  ),
);
function call(chain = "eth") {
  return app.request(`/${chain}`, {}, { NODE_ENV: "production" }, worker);
}
// Authoritative resolution (combined auth cache not qualified) has no snapshot.
const authoritative = {
  user,
  apiKeyId: "proxy-key",
  authSource: "compatibility",
  appScopeId: null,
};

beforeEach(() => {
  funded = true;
  provided = 0;
  admissions = [];
  settled = [];
  waits = [];
  standaloneCredentialChecks = 0;
});

test.each([true, false])(
  "deferred credential stays owned through async preflight (paid work: %s)",
  async (paidWork) => {
    caller = {
      ...authoritative,
      credential: {
        kind: "api_key",
        credentialId: "proxy-key",
        userId: user.id,
      },
    };
    let entered!: () => void;
    const preflightEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const preflightGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedApp = new Hono<AppEnv>().get("/", (c) =>
      executeGuardedPaidProxyWithPreflight(c, async () => {
        entered();
        await preflightGate;
        return paidWork
          ? tokenBalances
          : c.json({ error: "Invalid chain" }, 400);
      }),
    );
    const pending = delayedApp.request(
      "/",
      {},
      { NODE_ENV: "production" },
      worker,
    );
    await preflightEntered;
    release();
    const response = await pending;
    await Promise.all(waits);
    expect(response.status).toBe(paidWork ? 200 : 400);
    expect(provided).toBe(paidWork ? 1 : 0);
    expect(admissions).toHaveLength(paidWork ? 1 : 0);
    expect(standaloneCredentialChecks).toBe(paidWork ? 0 : 1);
  },
);
test("authoritatively authorized Worker caller without a snapshot is admitted durably, not refused", async () => {
  caller = authoritative;
  const response = await call();
  expect(response.status).toBe(200);
  expect<unknown>(await response.json()).toEqual({ balances: [] });
  expect(provided).toBe(1);
  expect(admissions).toHaveLength(1);
  expect(admissions[0]?.executionCtx).toBe(worker);
  expect(admissions[0]?.admissionSnapshot).toBeUndefined();
  await Promise.all(waits);
  expect(settled).toEqual([0.01]);
  // Route-local validation answers before any admission or provider work.
  expect((await call("not-a-chain")).status).toBe(400);
  expect(admissions).toHaveLength(1);
  expect(provided).toBe(1);
});
test("Worker caller with a combined snapshot still hands it to admission", async () => {
  const admissionSnapshot = { balance: { balanceUsd: 5 } };
  caller = {
    ...authoritative,
    authSource: "combined_cache",
    admissionSnapshot,
  };
  const response = await call();
  expect(response.status).toBe(200);
  expect(provided).toBe(1);
  expect(admissions).toHaveLength(1);
  expect(admissions[0]?.admissionSnapshot).toBe(admissionSnapshot);
});
test("durable admission still refuses an unfunded snapshot-less caller before the provider", async () => {
  caller = authoritative;
  funded = false;
  const response = await call();
  expect(response.status).toBe(402);
  expect(admissions).toHaveLength(1);
  expect(provided).toBe(0);
});
test("a standing denial is still returned without admission or provider work", async () => {
  caller = new ApiError(403, "access_denied", "Account is not eligible");
  const response = await call();
  expect(response.status).toBe(403);
  expect(((await response.json()) as { code: string }).code).toBe(
    "access_denied",
  );
  expect(admissions).toHaveLength(0);
  expect(provided).toBe(0);
});
