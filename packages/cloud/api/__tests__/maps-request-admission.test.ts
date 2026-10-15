/** Real route/admission orchestration with explicit authority and provider boundaries; no live effects. */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

let locked = false,
  admitted = 0,
  dispatched = 0,
  usage = 0;
let status = "active",
  expiry = "2099-01-01T00:00:00Z",
  signal: AbortController;
let response: () => Promise<Response> = async () =>
  Response.json({ admitted: true });
const caller = {
  user: { id: "maps-user", organization_id: "maps-org" },
  apiKeyId: "maps-key",
  admissionSnapshot: { balance: { balanceUsd: 0 }, funding: { balanceUsd: 0 } },
};
mock.module("../src/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller: async () => caller,
  getGenerativeExecutionContext: () => undefined,
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-policy-admission",
  () => ({
    withOrganizationPolicyReadAdmission: async (
      _org: string,
      _expected: unknown,
      operation: (policy: unknown) => Promise<unknown>,
    ) => {
      locked = true;
      try {
        return await operation({
          subscriptionFunded: status === "active",
          authority: {
            generation: "1",
            effectiveFrom: "2020-01-01T00:00:00Z",
            effectiveUntil: expiry,
          },
          get balance() {
            throw Error("Maps must not read monetary allowance");
          },
        });
      } finally {
        locked = false;
      }
    },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/subscription-entitlement-token",
  () => ({
    readOrganizationEntitlementSummary: async () => ({
      plan: { status },
      rateTier: "selected_test",
      effectiveUntil: new Date(expiry),
    }),
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/inference-admission-gate",
  () => ({
    callMapsRequestAllowance: async (_request: unknown, outcome?: string) => {
      if (outcome) {
        usage++;
        return Response.json({ recorded: true });
      }
      expect(locked).toBe(true);
      admitted++;
      return response();
    },
  }),
);
const { admitMapsRequest, authenticateMapsCaller } = await import(
  "../src/lib/maps-request-admission"
);
const { createMapsRoute } = await import("../src/lib/maps-route");
const previous = process.env.INFERENCE_STRONG_REVOCATION_ENABLED;
afterAll(() => {
  if (previous === undefined)
    delete process.env.INFERENCE_STRONG_REVOCATION_ENABLED;
  else process.env.INFERENCE_STRONG_REVOCATION_ENABLED = previous;
});
beforeEach(() => {
  process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "true";
  admitted = dispatched = usage = 0;
  locked = false;
  status = "active";
  expiry = "2099-01-01T00:00:00Z";
  signal = new AbortController();
  response = async () => Response.json({ admitted: true });
});
function app() {
  return createMapsRoute("search", {
    authenticate: authenticateMapsCaller,
    admitRequest: admitMapsRequest,
    entitlement: async () => {
      throw Error("legacy entitlement path");
    },
    admit: async () => {
      throw Error("isolate limiter path");
    },
    provider: () =>
      ({
        coverage: () => ({ providerId: "test", attribution: "fixture" }),
        search: async () => {
          expect(locked).toBe(false);
          dispatched++;
          return [];
        },
      }) as never,
  });
}
let ip = 0;
function call(body: unknown = { query: "test" }, key = "request") {
  return app().request(
    "/",
    {
      method: "POST",
      signal: signal.signal,
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
        "cf-connecting-ip": `192.0.2.${++ip}`,
      },
      body: JSON.stringify(body),
    },
    { NODE_ENV: "test" },
  );
}
test("active subscription with zero inference funds uses separate Maps allowance without monetary reads", async () => {
  const result = await call();
  expect(result.status).toBe(200);
  expect(admitted).toBe(1);
  expect(dispatched).toBe(1);
  expect(usage).toBe(1);
});
test("revoked subscription never consumes allowance or dispatches", async () => {
  status = "none";
  expect((await call()).status).toBe(403);
  expect(admitted).toBe(0);
  expect(dispatched).toBe(0);
});
test("invalid body and pre-admission cancellation never consume", async () => {
  expect((await call({ query: "" })).status).toBe(400);
  signal.abort();
  expect((await call()).status).toBe(408);
  expect(admitted).toBe(0);
  expect(dispatched).toBe(0);
});
test("unknown admission acknowledgement and duplicate ID refuse provider dispatch without retry", async () => {
  response = async () => {
    throw Error("lost ack");
  };
  expect((await call()).status).toBe(503);
  expect(admitted).toBe(1);
  expect(dispatched).toBe(0);
  response = async () =>
    Response.json(
      { error: { code: "maps_request_already_admitted" } },
      { status: 409 },
    );
  expect((await call()).status).toBe(409);
  expect(admitted).toBe(2);
  expect(dispatched).toBe(0);
});
test("null non-OK allowance body stays a typed Maps error", async () => {
  response = async () =>
    new Response("null", {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  const result = await call();
  expect(result.status).toBe(429);
  expect(((await result.json()) as { code: string }).code).toBe(
    "maps_access_denied",
  );
  expect(admitted).toBe(1);
  expect(dispatched).toBe(0);
});
test("cancellation after admission remains consumed and records cancellation", async () => {
  response = async () => {
    signal.abort();
    return Response.json({ admitted: true });
  };
  expect((await call()).status).toBe(408);
  expect(admitted).toBe(1);
  expect(dispatched).toBe(0);
  expect(usage).toBe(1);
});
test("missing operator revocation configuration is actionable and never an upgrade or charge", async () => {
  delete process.env.INFERENCE_STRONG_REVOCATION_ENABLED;
  const result = await call();
  expect(result.status).toBe(503);
  expect(((await result.json()) as { code: string }).code).toBe(
    "maps_allowance_unconfigured",
  );
  expect(admitted).toBe(0);
});
