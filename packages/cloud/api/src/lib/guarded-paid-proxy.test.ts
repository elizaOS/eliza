/**
 * Proves the paid proxy route adapter consumes one standing decision, forwards
 * its credential and snapshot, and suppresses dispatch after a safe denial.
 */

import { expect, mock, test } from "bun:test";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import type { AppContext } from "@/types/cloud-worker-env";

const combinedStandingRead = mock();
const executionContextRead = mock();
const executeWithBody = mock();

mock.module("./generative-route-auth", () => ({
  asGenerativeCacheApiError: () => null,
  requireGenerativeRouteCaller: combinedStandingRead,
  getGenerativeExecutionContext: executionContextRead,
}));
mock.module("@/lib/services/proxy/engine", () => ({
  executeWithBody,
  createHandler: mock(),
}));

const {
  executeGuardedPaidProxyWithBody,
  executeGuardedPaidProxyWithPreflight,
} = await import("./guarded-paid-proxy");

const snapshot = {
  balance: { balanceUsd: 10, balanceAt: Date.now(), balanceRevision: "9" },
  rateLimits: {
    completionsRpm: 10,
    embeddingsRpm: 10,
    standardRpm: 10,
    strictRpm: 10,
  },
};

function makeContext(): AppContext {
  const request = new Request(
    "https://api.test/api/v1/market/price/solana/token",
  );
  return {
    req: { raw: request, url: request.url },
    env: {},
    get: (key: string) =>
      key === "requestId" ? "paid-proxy-request-1" : undefined,
  } as unknown as AppContext;
}

test("one standing read forwards the credential and admission snapshot", async () => {
  combinedStandingRead.mockReset();
  executionContextRead.mockReset();
  executeWithBody.mockReset();
  combinedStandingRead.mockResolvedValue({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    authSource: "combined_cache",
    admissionSnapshot: snapshot,
    credential: {
      kind: "api_key",
      credentialId: "key-1",
      userId: "user-1",
    },
    appScopeId: null,
  });
  const retained: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => retained.push(promise),
  };
  executionContextRead.mockReturnValue(executionCtx);
  executeWithBody.mockResolvedValue(Response.json({ ok: true }));
  const provider = mock();
  const config = {
    id: "market-data",
    name: "Market data",
    auth: "apiKeyWithOrg" as const,
    getCost: async () => 0.01,
  };

  const response = await executeGuardedPaidProxyWithBody(
    makeContext(),
    config,
    provider,
    { method: "getPrice" },
  );

  expect(response.status).toBe(200);
  expect(combinedStandingRead).toHaveBeenCalledTimes(1);
  expect(executeWithBody).toHaveBeenCalledTimes(1);
  expect(executeWithBody.mock.calls[0]?.[4]).toMatchObject({
    mode: "combined",
    auth: {
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-1" },
    },
    requestId: "paid-proxy-request-1",
    admissionSnapshot: snapshot,
    credential: {
      kind: "api_key",
      credentialId: "key-1",
      userId: "user-1",
    },
    executionCtx,
  });
  const admission = executeWithBody.mock.calls[0]?.[4];
  expect(admission.credentialForAdmission()).toEqual({
    kind: "api_key",
    credentialId: "key-1",
    userId: "user-1",
  });
});

test("disabled auth cache retains authoritative compatibility admission", async () => {
  combinedStandingRead.mockReset();
  executionContextRead.mockReset();
  executeWithBody.mockReset();
  combinedStandingRead.mockResolvedValue({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    authSource: "combined_cache",
    appScopeId: null,
  });
  executionContextRead.mockReturnValue({ waitUntil: () => undefined });
  executeWithBody.mockResolvedValue(Response.json({ ok: true }));
  const context = makeContext();
  Object.assign(context, {
    env: {
      INFERENCE_AUTH_CACHE_ENABLED: "false",
      INFERENCE_STRONG_REVOCATION_ENABLED: "true",
    },
  });

  const response = await executeGuardedPaidProxyWithBody(
    context,
    {
      id: "market-data",
      name: "Market data",
      auth: "apiKeyWithOrg",
      getCost: async () => 0.01,
    },
    mock(),
    { method: "getPrice" },
  );

  expect(response.status).toBe(200);
  expect(executeWithBody.mock.calls[0]?.[4]).toMatchObject({
    mode: "compatibility",
    auth: {
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-1" },
    },
    requestId: "paid-proxy-request-1",
  });
});

test("standing denial preserves its safe reason and suppresses provider dispatch", async () => {
  combinedStandingRead.mockReset();
  executionContextRead.mockReset();
  executeWithBody.mockReset();
  const denial = new ApiError(
    403,
    "access_denied",
    "Organization is inactive",
    { reason: "organization_inactive" },
  );
  combinedStandingRead.mockRejectedValueOnce(denial);

  const response = await executeGuardedPaidProxyWithBody(
    makeContext(),
    {
      id: "market-data",
      name: "Market data",
      auth: "apiKeyWithOrg",
      getCost: async () => 0.01,
    },
    mock(),
    { method: "getPrice" },
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "access_denied",
    details: { reason: "organization_inactive" },
  });
  expect(combinedStandingRead).toHaveBeenCalledTimes(1);
  expect(executeWithBody).not.toHaveBeenCalled();
  expect(denial.details?.reason).toBe("organization_inactive");
});

test("preflight sees the caller after one standing read and can reject without provider admission", async () => {
  combinedStandingRead.mockReset();
  executionContextRead.mockReset();
  executeWithBody.mockReset();
  let resolved = false;
  combinedStandingRead.mockImplementation(async () => {
    resolved = true;
    return {
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: "key-1",
      authSource: "combined_cache",
      admissionSnapshot: snapshot,
      appScopeId: null,
    };
  });
  executionContextRead.mockReturnValue({ waitUntil: () => undefined });

  const response = await executeGuardedPaidProxyWithPreflight(
    makeContext(),
    () => {
      expect(resolved).toBe(true);
      return Response.json({ error: "Invalid input" }, { status: 400 });
    },
  );

  expect(response.status).toBe(400);
  expect(combinedStandingRead).toHaveBeenCalledTimes(1);
  expect(executeWithBody).not.toHaveBeenCalled();
});

test("Worker flag-off mode forwards pre-resolved auth through compatibility admission", async () => {
  combinedStandingRead.mockReset();
  executionContextRead.mockReset();
  executeWithBody.mockReset();
  combinedStandingRead.mockResolvedValue({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    authSource: "combined_cache",
    appScopeId: null,
  });
  executionContextRead.mockReturnValue({ waitUntil: () => undefined });
  executeWithBody.mockResolvedValue(Response.json({ ok: true }));

  const response = await executeGuardedPaidProxyWithBody(
    makeContext(),
    {
      id: "market-data",
      name: "Market data",
      auth: "apiKeyWithOrg",
      getCost: async () => 0.01,
    },
    mock(),
    { method: "getPrice" },
  );

  expect(response.status).toBe(200);
  expect(combinedStandingRead).toHaveBeenCalledTimes(1);
  expect(executeWithBody).toHaveBeenCalledTimes(1);
  expect(executeWithBody.mock.calls[0]?.[4]).toEqual({
    mode: "compatibility",
    auth: {
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-1" },
    },
    requestId: "paid-proxy-request-1",
  });
});

test("enabled auth cache fails closed when its combined snapshot is missing", async () => {
  combinedStandingRead.mockReset();
  executionContextRead.mockReset();
  executeWithBody.mockReset();
  combinedStandingRead.mockResolvedValue({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    authSource: "combined_cache",
    appScopeId: null,
  });
  executionContextRead.mockReturnValue({ waitUntil: () => undefined });
  const context = makeContext();
  Object.assign(context, {
    env: {
      INFERENCE_AUTH_CACHE_ENABLED: "true",
      INFERENCE_STRONG_REVOCATION_ENABLED: "true",
    },
  });

  const response = await executeGuardedPaidProxyWithBody(
    context,
    {
      id: "market-data",
      name: "Market data",
      auth: "apiKeyWithOrg",
      getCost: async () => 0.01,
    },
    mock(),
    { method: "getPrice" },
  );

  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(combinedStandingRead).toHaveBeenCalledTimes(1);
  expect(executeWithBody).not.toHaveBeenCalled();
});

test("production without a Worker lifetime fails closed before reserve or dispatch", async () => {
  combinedStandingRead.mockReset();
  executionContextRead.mockReset();
  executeWithBody.mockReset();
  combinedStandingRead.mockResolvedValue({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: null,
    authSource: "compatibility",
    appScopeId: null,
  });
  executionContextRead.mockReturnValue(undefined);
  const context = makeContext();
  Object.assign(context, { env: { NODE_ENV: "production" } });

  const response = await executeGuardedPaidProxyWithBody(
    context,
    {
      id: "market-data",
      name: "Market data",
      auth: "apiKeyWithOrg",
      getCost: async () => 0.01,
    },
    mock(),
    { method: "getPrice" },
  );

  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(combinedStandingRead).not.toHaveBeenCalled();
  expect(executeWithBody).not.toHaveBeenCalled();
});
