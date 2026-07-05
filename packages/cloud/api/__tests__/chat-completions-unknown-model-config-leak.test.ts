/**
 * Provider-config leak repro for POST /api/v1/chat/completions (#13406).
 *
 * On prod, a request for an unknown/unconfigured model surfaced the raw
 * provider-configuration error to the DIRECT API caller — including the
 * Vercel AI Gateway SDK's setup guidance naming `AI_GATEWAY_API_KEY`. The
 * route boundary must translate that class of failure into a clean
 * "model '<x>' is not available" client error (echoing the model id only)
 * while the internal detail stays in server logs.
 *
 * The harness follows this package's route-test pattern: auth/billing/catalog
 * are stubbed at their module boundaries, but the components under test are
 * REAL — the route's error boundary, the real provider resolution
 * (`getLanguageModel`), the real AI SDK, and the real `@ai-sdk/gateway`
 * client speaking HTTP to a local stub upstream that answers 401 exactly like
 * the gateway does, so the SDK raises its real GatewayAuthenticationError
 * (the message that leaked in prod).
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import * as pricingActual from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as inferenceAuthContextActual from "@/lib/services/inference-auth-context";
import * as fastPathActual from "@/lib/services/inference-billing-fast-path";
import * as billingLedgerActual from "@/lib/services/inference-billing-ledger";
import * as modelCatalogActual from "@/lib/services/model-catalog";
import * as creditReservationActual from "@/lib/utils/credit-reservation";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const UNKNOWN_MODEL = "totally/unknown-model";

// Strings from the internal configuration errors (ours and the gateway
// SDK's contextual auth message) that must never appear in a client body.
const INTERNAL_MARKERS = [
  "AI_GATEWAY_API_KEY",
  "OPENROUTER_API_KEY",
  "environment variable",
  "apiKey",
  "vercel.com",
];

// --- local stub playing the EXTERNAL Vercel AI Gateway -----------------------
// Answers every request 401 with the gateway's error shape; the real
// @ai-sdk/gateway client converts that into GatewayAuthenticationError whose
// contextual message embeds the AI_GATEWAY_API_KEY setup guidance.
const gatewayStub = Bun.serve({
  port: 0,
  fetch: () =>
    Response.json(
      { error: { type: "authentication_error", message: "Invalid API key" } },
      { status: 401 },
    ),
});

const ENV_KEYS = [
  "AI_GATEWAY_API_KEY",
  "AIGATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "OPENROUTER_API_KEY",
] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
process.env.AI_GATEWAY_API_KEY = "test-invalid-gateway-key";
process.env.AI_GATEWAY_BASE_URL = `http://127.0.0.1:${gatewayStub.port}`;
delete process.env.AIGATEWAY_API_KEY;
delete process.env.OPENROUTER_API_KEY;

// --- module-boundary stubs (auth + billing, not under test) ------------------
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthContextActual,
  isInferenceHotPathCacheEnabled: () => true,
  resolveInferenceAuthContext: async () => ({
    kind: "authorized",
    ctx: { userId: USER, orgId: ORG, apiKeyId: API_KEY_ID },
  }),
}));

mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost: async () => ({
    totalCost: 0.01,
    inputCost: 0.005,
    outputCost: 0.005,
  }),
}));

mock.module("@/lib/services/model-catalog", () => ({
  ...modelCatalogActual,
  getCachedGatewayModelById: async () => null,
}));

mock.module("@/lib/services/content-moderation", () => ({
  ...contentModerationActual,
  contentModerationService: {
    ...contentModerationActual.contentModerationService,
    shouldBlockUser: async () => false,
    moderateInBackground: () => {},
  },
}));

mock.module("@/lib/services/inference-billing-fast-path", () => ({
  ...fastPathActual,
  isOptimisticBillingEnabled: () => true,
  isOptimisticBackstopAvailable: () => true,
  getGateBalanceUsd: async () => 100,
  resolveSafeBalanceThresholdUsd: () => 5,
  writePendingInferenceCharge: async () => true,
  createOptimisticDebitSettler: () => async () => null,
}));

mock.module("@/lib/services/inference-billing-ledger", () => ({
  ...billingLedgerActual,
  resolveInferenceBillingLedger: () => "kv",
  admitInferenceChargeViaLedger: async () => ({ admitted: true }),
  createLedgerDebitSettler: () => async () => null,
}));

mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits: async () => ({
    reservedAmount: 0.015,
    reconcile: async () => null,
  }),
}));

mock.module("@/lib/utils/credit-reservation", () => ({
  ...creditReservationActual,
  createCreditReservationSettler: () => async () => null,
}));

// Import the route AFTER the mocks so it binds to the stubs. `ai` and
// `@/lib/providers/language-model` stay real — they are under test.
const { handleChatCompletionsPOST } = await import(
  "../v1/chat/completions/route"
);

afterAll(() => {
  gatewayStub.stop(true);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthContextActual,
  );
  mock.module("@/lib/pricing", () => pricingActual);
  mock.module("@/lib/services/model-catalog", () => modelCatalogActual);
  mock.module(
    "@/lib/services/content-moderation",
    () => contentModerationActual,
  );
  mock.module(
    "@/lib/services/inference-billing-fast-path",
    () => fastPathActual,
  );
  mock.module(
    "@/lib/services/inference-billing-ledger",
    () => billingLedgerActual,
  );
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module("@/lib/utils/credit-reservation", () => creditReservationActual);
});

function makeRequest(stream: boolean): Request {
  return new Request("https://api.test/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: UNKNOWN_MODEL,
      messages: [{ role: "user", content: "hello" }],
      stream,
    }),
  });
}

describe("chat/completions unknown-model provider-config leak (#13406)", () => {
  test("non-streaming: clean 400 model_not_available, no internal config detail in the body", async () => {
    const res = await handleChatCompletionsPOST(makeRequest(false), {
      skipOrgRateLimit: true,
    });
    const bodyText = await res.text();

    for (const marker of INTERNAL_MARKERS) {
      expect(bodyText).not.toContain(marker);
    }

    expect(res.status).toBe(400);
    const body = JSON.parse(bodyText) as {
      error: { message: string; type: string; code: string };
    };
    expect(body.error.message).toBe(
      `model '${UNKNOWN_MODEL}' is not available on this deployment`,
    );
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("model_not_available");
  });

  test("streaming: terminal error chunk is sanitized and the stream still ends with [DONE]", async () => {
    const res = await handleChatCompletionsPOST(makeRequest(true), {
      skipOrgRateLimit: true,
    });
    expect(res.status).toBe(200);
    const sse = await res.text();

    for (const marker of INTERNAL_MARKERS) {
      expect(sse).not.toContain(marker);
    }

    expect(sse).toContain(
      `model '${UNKNOWN_MODEL}' is not available on this deployment`,
    );
    expect(sse).toContain('"type":"invalid_request_error"');
    expect(sse).toContain("data: [DONE]");
  });

  test("resolution failure with no serving key is a classified configuration error, internal detail intact for logs", () => {
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      let caught: unknown;
      try {
        languageModelActual.getLanguageModel(UNKNOWN_MODEL);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(languageModelActual.isProviderConfigurationError(caught)).toBe(
        true,
      );
      // The operator-facing message keeps naming the missing configuration —
      // sanitization happens at the API boundary, not at the throw site.
      expect((caught as Error).message).toContain("OPENROUTER_API_KEY");
    } finally {
      process.env.AI_GATEWAY_API_KEY = "test-invalid-gateway-key";
    }
  });
});
