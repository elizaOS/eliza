/**
 * Proves the generic paid proxy engine consumes a pre-resolved combined
 * admission, marks before dispatch, and retains exactly one async settlement.
 */

import { beforeEach, expect, mock, test } from "bun:test";
import { InferenceCredentialRevokedError } from "../inference-credential-revocation";
import type { ServiceConfig } from "./types";

const legacyAuth = mock(async () => {
  throw new Error("legacy auth must not run");
});
const genericReserve = mock(async () => {
  throw new Error("generic reserve must not run");
});
const admit = mock();
const proxyCacheGet = mock();
const proxyCacheSet = mock();
const rateLimitWrap = mock((handler: unknown) => handler);

class TestInsufficientCreditsError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super("Insufficient credits");
  }
}

mock.module("../../auth", () => ({
  requireAuth: legacyAuth,
  requireAuthOrApiKey: legacyAuth,
  requireAuthOrApiKeyWithOrg: legacyAuth,
  requireAuthWithOrg: legacyAuth,
}));
mock.module("../credits", () => ({
  creditsService: { reserve: genericReserve },
  InsufficientCreditsError: TestInsufficientCreditsError,
}));
mock.module("../organization-inference-admission", () => ({
  admitOrganizationInference: admit,
}));
mock.module("../../cache/client", () => ({
  cache: { get: proxyCacheGet, set: proxyCacheSet },
}));
mock.module("../usage", () => ({
  usageService: { create: mock(async () => undefined) },
}));
mock.module("../../middleware/rate-limit", () => ({
  withRateLimit: rateLimitWrap,
}));
mock.module("./pricing", () => ({
  PricingNotFoundError: class PricingNotFoundError extends Error {},
}));

const [{ InferenceBalanceCacheWarmingError }, { createHandler }] = await Promise.all([
  import("../inference-billing-fast-path"),
  import("./engine"),
]);

const config: ServiceConfig = {
  id: "evm-rpc",
  name: "EVM RPC",
  auth: "apiKeyWithOrg",
  getCost: async () => 0.25,
};
const snapshot = {
  balance: { balanceUsd: 10, balanceAt: Date.now(), balanceRevision: "7" },
  rateLimits: {
    completionsRpm: 10,
    embeddingsRpm: 10,
    standardRpm: 10,
    strictRpm: 10,
  },
};

beforeEach(() => {
  legacyAuth.mockClear();
  genericReserve.mockClear();
  admit.mockReset();
  proxyCacheGet.mockClear();
  proxyCacheSet.mockClear();
  rateLimitWrap.mockClear();
});

test("combined admission orders mark before dispatch and returns before settlement", async () => {
  const credential = {
    kind: "api_key" as const,
    credentialId: "key-1",
    userId: "user-1",
  };
  const order: string[] = [];
  let finishSettlement: (() => void) | undefined;
  const settlement = new Promise<void>((resolve) => {
    finishSettlement = resolve;
  });
  const settle = mock(async () => {
    order.push("settle");
    await settlement;
    return null;
  });
  admit.mockResolvedValue({
    mode: "durable_object_debit",
    markProviderDispatched: async () => {
      order.push("mark");
    },
    settle,
    settleUnknown: settle,
  });
  const retained: Promise<unknown>[] = [];
  const work = mock(async ({ auth }) => {
    expect(auth.apiKey?.id).toBe("key-1");
    order.push("dispatch");
    return { response: Response.json({ ok: true }) };
  });
  const handler = createHandler(config, work, {
    mode: "combined",
    auth: {
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-1" },
    },
    admissionSnapshot: snapshot,
    executionCtx: { waitUntil: (promise) => retained.push(promise) },
    requestId: "rpc-1",
    credentialForAdmission: () => credential,
  });

  const response = await handler(
    new Request("https://api.test/api/v1/rpc/ethereum", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
    }),
  );

  expect(response.status).toBe(200);
  expect(order).toEqual(["mark", "dispatch", "settle"]);
  expect(legacyAuth).not.toHaveBeenCalled();
  expect(genericReserve).not.toHaveBeenCalled();
  expect(admit).toHaveBeenCalledTimes(1);
  expect(admit.mock.calls[0]?.[0].apiKeyId).toBe("key-1");
  expect(admit.mock.calls[0]?.[0].admissionSnapshot).toBe(snapshot);
  expect(admit.mock.calls[0]?.[0].credential).toBe(credential);
  expect(settle).toHaveBeenCalledTimes(1);
  expect(proxyCacheGet).not.toHaveBeenCalled();
  expect(proxyCacheSet).not.toHaveBeenCalled();
  expect(retained).toHaveLength(1);
  finishSettlement?.();
  await Promise.all(retained);
});

test("combined warming failure is a sanitized retryable 503 before provider dispatch", async () => {
  admit.mockRejectedValueOnce(new InferenceBalanceCacheWarmingError());
  const work = mock(async () => ({ response: new Response("not reached") }));
  const handler = createHandler(config, work, {
    mode: "combined",
    auth: { user: { id: "user-1", organization_id: "org-1" } },
    admissionSnapshot: snapshot,
    executionCtx: { waitUntil: () => undefined },
    requestId: "rpc-warming",
  });

  const response = await handler(
    new Request("https://api.test/api/v1/rpc/ethereum", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
    }),
  );

  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toEqual({
    success: false,
    error: "Provider admission is unavailable; retry shortly",
    code: "service_unavailable",
    details: { retryable: true, retryAfterSeconds: 1 },
  });
  expect(work).not.toHaveBeenCalled();
  expect(genericReserve).not.toHaveBeenCalled();
});

test("explicit local compatibility retains the configured proxy limiter", () => {
  createHandler({ ...config, rateLimit: { windowMs: 60_000, maxRequests: 10 } }, mock(), {
    mode: "compatibility",
    auth: { user: { id: "user-1", organization_id: "org-1" } },
    requestId: "local-compatibility",
  });

  expect(rateLimitWrap).toHaveBeenCalledTimes(1);
});

test("combined admission denial performs zero provider dispatch", async () => {
  admit.mockRejectedValueOnce(new TestInsufficientCreditsError(0.25, 0));
  const work = mock(async () => ({ response: new Response("not reached") }));
  const handler = createHandler(config, work, {
    mode: "combined",
    auth: { user: { id: "user-1", organization_id: "org-1" } },
    admissionSnapshot: snapshot,
    executionCtx: { waitUntil: () => undefined },
    requestId: "rpc-denied",
  });

  const response = await handler(
    new Request("https://api.test/api/v1/rpc/ethereum", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
    }),
  );

  expect(response.status).toBe(402);
  expect(work).not.toHaveBeenCalled();
  expect(legacyAuth).not.toHaveBeenCalled();
  expect(genericReserve).not.toHaveBeenCalled();
});

test("combined credential denial is a safe standing response with zero dispatch", async () => {
  admit.mockRejectedValueOnce(new InferenceCredentialRevokedError("session_binding_revoked"));
  const work = mock(async () => ({ response: new Response("not reached") }));
  const handler = createHandler(config, work, {
    mode: "combined",
    auth: { user: { id: "user-1", organization_id: "org-1" } },
    admissionSnapshot: snapshot,
    credential: {
      kind: "steward_session",
      userId: "user-1",
      stewardUserId: "steward-1",
      issuedAt: 1,
    },
    executionCtx: { waitUntil: () => undefined },
    requestId: "rpc-revoked",
  });

  const response = await handler(
    new Request("https://api.test/api/v1/rpc/ethereum", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
    }),
  );

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    error: "Authentication required",
    code: "authentication_required",
    details: { reason: "credential_inactive" },
  });
  expect(work).not.toHaveBeenCalled();
});
