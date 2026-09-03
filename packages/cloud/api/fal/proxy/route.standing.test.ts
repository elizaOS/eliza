/** Proves fal.ai mutations stop at the shared standing gate before pricing or dispatch. */

import { expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import * as aiPricingActual from "@/lib/services/ai-pricing";

let falResponseStatus = 200;
let falProxyError: Error | null = null;
const invokeFalProxy = mock(async () => {
  if (falProxyError) throw falProxyError;
  return new Response("upstream", { status: falResponseStatus });
});
let routeCallerError: ApiError | null = new ApiError(
  403,
  "access_denied",
  "Account is inactive",
  { reason: "account_inactive" },
);
let admissionError: ApiError | null = null;
let admissionEnabled = false;
let dispatchReceiptError: Error | null = null;
const settle = mock(async (_cost: number) => undefined);
const settleUnknown = mock(async () => undefined);
const markProviderDispatched = mock(async () => {
  if (dispatchReceiptError) throw dispatchReceiptError;
});
const admitFlatGenerativeOperation = mock(async () => {
  if (admissionError) throw admissionError;
  if (admissionEnabled) {
    return { settle, settleUnknown, markProviderDispatched };
  }
  throw new Error("unexpected admission success");
});
const requireGenerativeRouteCaller = mock(async () => {
  if (routeCallerError) throw routeCallerError;
  return {
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    admissionSnapshot: undefined,
    credential: {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    },
  };
});

mock.module("@fal-ai/server-proxy", () => ({
  DEFAULT_ALLOWED_URL_PATTERNS: [],
  TARGET_URL_HEADER: "x-fal-target-url",
  getEndpoint: (value: string) => value,
  resolveApiKeyFromEnv: () => "unused",
}));
mock.module("@fal-ai/server-proxy/hono", () => ({
  createRouteHandler: () => invokeFalProxy,
}));
mock.module("@/lib/services/ai-pricing", () => ({
  ...aiPricingActual,
  calculateVideoGenerationCostFromCatalog: async () => ({
    totalCost: 0.1,
    baseTotalCost: 0.1,
    platformMarkup: 0,
  }),
}));
mock.module("@/api-app/lib/generative-route-auth", () => ({
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError: (error: unknown) =>
    error instanceof ApiError ? error : null,
  getGenerativeExecutionContext: () => undefined,
  requireGenerativeRouteCaller,
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const { default: falRoute } = await import("./route");
const app = new Hono().route("/fal/proxy", falRoute);

test("standing denial prevents fal pricing, credit admission, and provider dispatch", async () => {
  routeCallerError = new ApiError(403, "access_denied", "Account is inactive", {
    reason: "account_inactive",
  });
  admissionError = null;
  admissionEnabled = false;
  invokeFalProxy.mockClear();
  const response = await app.request("/fal/proxy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fal-target-url": "fal-ai/veo3",
    },
    body: "{}",
  });

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    code: "access_denied",
    error: "Account is inactive",
    details: { reason: "account_inactive" },
  });
  expect(invokeFalProxy).not.toHaveBeenCalled();
});

test("combined credential denial is returned before fal provider dispatch", async () => {
  routeCallerError = null;
  admissionError = new ApiError(
    401,
    "authentication_required",
    "Authentication required",
    { reason: "credential_inactive" },
  );
  const response = await app.request("/fal/proxy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fal-target-url": "fal-ai/veo3",
    },
    body: JSON.stringify({ model: "fal-ai/veo3" }),
  });

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    code: "authentication_required",
    error: "Authentication required",
    details: { reason: "credential_inactive" },
  });
  expect(invokeFalProxy).not.toHaveBeenCalled();
});

test("ambiguous fal rejection after dispatch uses conservative settlement", async () => {
  routeCallerError = null;
  admissionError = null;
  admissionEnabled = true;
  dispatchReceiptError = null;
  falProxyError = null;
  falResponseStatus = 503;
  invokeFalProxy.mockClear();
  settle.mockClear();
  settleUnknown.mockClear();
  markProviderDispatched.mockClear();

  const response = await app.request("/fal/proxy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fal-target-url": "fal-ai/veo3",
    },
    body: "{}",
  });

  expect(response.status).toBe(503);
  expect(markProviderDispatched).toHaveBeenCalledTimes(1);
  expect(invokeFalProxy).toHaveBeenCalledTimes(1);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(settle).not.toHaveBeenCalled();
});

test("fal transport exception after dispatch uses conservative settlement", async () => {
  routeCallerError = null;
  admissionError = null;
  admissionEnabled = true;
  dispatchReceiptError = null;
  falProxyError = new Error("connection closed after submit");
  falResponseStatus = 200;
  invokeFalProxy.mockClear();
  settle.mockClear();
  settleUnknown.mockClear();
  markProviderDispatched.mockClear();

  const response = await app.request("/fal/proxy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fal-target-url": "fal-ai/veo3",
    },
    body: "{}",
  });

  expect(response.status).toBe(500);
  expect(markProviderDispatched).toHaveBeenCalledTimes(1);
  expect(invokeFalProxy).toHaveBeenCalledTimes(1);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(settle).not.toHaveBeenCalled();
});

test("fal dispatch receipt failure releases before provider invocation", async () => {
  routeCallerError = null;
  admissionError = null;
  admissionEnabled = true;
  dispatchReceiptError = new Error("dispatch receipt unavailable");
  falProxyError = null;
  falResponseStatus = 200;
  invokeFalProxy.mockClear();
  settle.mockClear();
  settleUnknown.mockClear();
  markProviderDispatched.mockClear();

  const response = await app.request("/fal/proxy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fal-target-url": "fal-ai/veo3",
    },
    body: "{}",
  });

  expect(response.status).toBe(500);
  expect(invokeFalProxy).not.toHaveBeenCalled();
  expect(settle).toHaveBeenCalledWith(0);
  expect(settleUnknown).not.toHaveBeenCalled();
});
