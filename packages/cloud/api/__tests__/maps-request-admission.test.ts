/** Real route/admission orchestration with explicit authority and provider boundaries; no live effects. */
import { beforeEach, expect, mock, test } from "bun:test";
import type { MapsPriceObserver } from "@elizaos/cloud-shared/lib/services/maps/contract";

let locked = false,
  admitted = 0,
  dispatched = 0,
  usage = 0;
let status = "active",
  planId = "plus_monthly",
  expiry = "2099-01-01T00:00:00Z",
  signal: AbortController;
let balance = 1;
let creditAdmissions = 0;
let providerMarks = 0;
let settlements: number[] = [];
let creditFailure = false;
let providerFailure = false;
let providerUnknownFailure = false;
let partialUnknownFailure = false;
let quotedAmount = 0.032;
let cancelAfterSuccess = false;
let planChanged = false;
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-inference-admission",
  () => ({
    admitOrganizationInference: async (request: {
      flatCost: { totalCost: number; platformMarkup: number };
    }) => {
      creditAdmissions++;
      expect(locked).toBe(false);
      expect(request.flatCost.totalCost).toBe(quotedAmount);
      expect(request.flatCost.platformMarkup).toBe(0);
      if (creditFailure) throw new InsufficientCreditsError(0.032, 0);
      return {
        mode: planChanged
          ? "durable_object_subscription_funding"
          : "durable_object_debit",
        markProviderDispatched: async () => {
          providerMarks++;
        },
        settle: async (cost: number) => {
          settlements.push(cost);
        },
        settleUnknown: async () => {
          settlements.push(-1);
        },
      };
    },
  }),
);
let response: () => Promise<Response> = async () =>
  Response.json({ admitted: true });
const policyTransaction = { mapsTransaction: true };
const caller = {
  user: { id: "maps-user", organization_id: "maps-org" },
  apiKeyId: "maps-key",
  admissionSnapshot: { balance: { balanceUsd: 0 }, funding: { balanceUsd: 0 } },
};
mock.module("../src/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller: async () => caller,
  getGenerativeExecutionContext: () => undefined,
  resolveInferenceCredentialAdmissionDenial: () => null,
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-policy-admission",
  () => ({
    withOrganizationPolicyReadAdmission: async (
      _org: string,
      _expected: unknown,
      operation: (policy: unknown, tx: unknown) => Promise<unknown>,
    ) => {
      locked = true;
      try {
        return await operation(
          {
            subscriptionFunded: status === "active",
            authority: {
              generation: "1",
              effectiveFrom: "2020-01-01T00:00:00Z",
              effectiveUntil: expiry,
            },
            get balance() {
              if (status === "active")
                throw Error("Included Maps must not read monetary allowance");
              return {
                status: "available",
                value: { balanceUsd: balance, revision: "1" },
              };
            },
          },
          policyTransaction,
        );
      } finally {
        locked = false;
      }
    },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/subscription-entitlement-token",
  () => ({
    readOrganizationEntitlementSummary: async (
      _org: string,
      options: { transaction?: unknown } = {},
    ) => {
      expect(locked).toBe(true);
      expect(options.transaction).toBe(policyTransaction);
      return {
        plan: { id: planId, status },
        rateTier: "custom",
        effectiveUntil: new Date(expiry),
      };
    },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/inference-admission-gate",
  () => ({
    callMapsRequestAllowance: async (
      namespace: unknown,
      request: { policy: { planKey: string } },
      outcome?: string,
    ) => {
      expect(namespace).toBe(mapsGateBinding);
      if (outcome) {
        usage++;
        return Response.json({ recorded: true });
      }
      expect(locked).toBe(true);
      expect(request.policy.planKey).toBe(
        status === "active" ? planId : "default",
      );
      admitted++;
      return response();
    },
  }),
);
const { InsufficientCreditsError } = await import(
  "@elizaos/cloud-shared/lib/services/credits"
);
const { admitMapsRequest, authenticateMapsCaller } = await import(
  "../src/lib/maps-request-admission"
);
const { createMapsRoute } = await import("../src/lib/maps-route");
const mapsGateBinding = {};
let gatesBound = true;
beforeEach(() => {
  gatesBound = true;
  admitted = dispatched = usage = 0;
  balance = 1;
  creditAdmissions = providerMarks = 0;
  settlements = [];
  creditFailure = false;
  providerFailure = false;
  providerUnknownFailure = false;
  partialUnknownFailure = false;
  quotedAmount = 0.032;
  cancelAfterSuccess = false;
  planChanged = false;
  locked = false;
  status = "active";
  planId = "plus_monthly";
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
        creditPrice: () => ({
          amountUsd: quotedAmount,
          sku: "4FDA-34B1-A910",
          priceVersion: "test",
        }),
        coverage: () => ({ providerId: "test", attribution: "fixture" }),
        search: async (
          _request: unknown,
          _signal: AbortSignal,
          reportPrice?: MapsPriceObserver,
        ) => {
          expect(locked).toBe(false);
          dispatched++;
          await reportPrice?.beforeRequest?.();
          if (providerFailure) {
            reportPrice?.requestRejected?.();
            throw Error("Controlled provider failure");
          }
          if (providerUnknownFailure)
            throw Error("Controlled lost provider response");
          reportPrice?.({
            amountUsd: 0.032,
            sku: "4FDA-34B1-A910",
            priceVersion: "test",
          });
          if (partialUnknownFailure) {
            await reportPrice?.beforeRequest?.();
            throw Error("Controlled second request response loss");
          }
          if (cancelAfterSuccess) signal.abort();
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
    {
      NODE_ENV: "test",
      ...(gatesBound ? { INFERENCE_ADMISSION_GATES: mapsGateBinding } : {}),
    },
  );
}
test("active subscription with zero inference funds uses separate Maps allowance without monetary reads", async () => {
  const result = await call();
  expect(result.status).toBe(200);
  expect(admitted).toBe(1);
  expect(dispatched).toBe(1);
  expect(usage).toBe(1);
  expect(creditAdmissions).toBe(0);
  expect(settlements).toEqual([]);
});
test("Pro keeps its Maps plan when the inference tier is overridden", async () => {
  planId = "pro_monthly";
  expect((await call()).status).toBe(200);
  expect(admitted).toBe(1);
  expect(dispatched).toBe(1);
});
test("unknown subscription plan never consumes Maps allowance", async () => {
  planId = "unknown";
  const result = await call();
  expect(result.status).toBe(503);
  expect(((await result.json()) as { code: string }).code).toBe(
    "maps_allowance_unconfigured",
  );
  expect(admitted).toBe(0);
  expect(dispatched).toBe(0);
});
test("revoked subscription never consumes allowance or dispatches", async () => {
  status = "none";
  balance = 0;
  expect((await call()).status).toBe(402);
  expect(admitted).toBe(0);
  expect(dispatched).toBe(0);
});
test("credit-funded Maps reserves and settles provider cost without a plan", async () => {
  status = "none";
  expect((await call()).status).toBe(200);
  expect(creditAdmissions).toBe(1);
  expect(providerMarks).toBe(1);
  expect(settlements).toEqual([0.032]);
  expect(dispatched).toBe(1);
});
test("a credit reservation refusal never dispatches the provider", async () => {
  status = "none";
  creditFailure = true;
  expect((await call()).status).toBe(402);
  expect(creditAdmissions).toBe(1);
  expect(dispatched).toBe(0);
  expect(usage).toBe(1);
});
test("a cancelled credit-funded request refunds before provider dispatch", async () => {
  status = "none";
  response = async () => {
    signal.abort();
    return Response.json({ admitted: true });
  };
  expect((await call()).status).toBe(408);
  expect(dispatched).toBe(0);
  expect(providerMarks).toBe(0);
  expect(settlements).toEqual([0]);
});
test("a failed credit-funded provider request releases its reservation", async () => {
  status = "none";
  providerFailure = true;
  expect((await call()).status).toBe(500);
  expect(providerMarks).toBe(1);
  expect(settlements).toEqual([0]);
});
test("a lost provider response retains unknown settlement instead of refunding", async () => {
  status = "none";
  providerUnknownFailure = true;
  expect((await call()).status).toBe(500);
  expect(providerMarks).toBe(1);
  expect(settlements).toEqual([-1]);
});
test("a known first call does not hide an unresolved second provider call", async () => {
  status = "none";
  quotedAmount = 0.037;
  partialUnknownFailure = true;
  expect((await call()).status).toBe(500);
  expect(providerMarks).toBe(1);
  expect(settlements).toEqual([-1]);
});
test("client cancellation after billable Google work retains the actual cost", async () => {
  status = "none";
  cancelAfterSuccess = true;
  expect((await call()).status).toBe(408);
  expect(settlements).toEqual([0.032]);
});
test("a plan change releases the new reservation and refuses provider dispatch", async () => {
  status = "none";
  planChanged = true;
  expect((await call()).status).toBe(409);
  expect(settlements).toEqual([0]);
  expect(dispatched).toBe(0);
});
test("a duplicate credit-funded request is rejected before another reservation", async () => {
  status = "none";
  response = async () =>
    Response.json(
      { error: { code: "maps_request_already_admitted" } },
      { status: 409 },
    );
  expect((await call()).status).toBe(409);
  expect(creditAdmissions).toBe(0);
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
  gatesBound = false;
  const result = await call();
  expect(result.status).toBe(503);
  expect(((await result.json()) as { code: string }).code).toBe(
    "maps_allowance_unconfigured",
  );
  expect(admitted).toBe(0);
});
