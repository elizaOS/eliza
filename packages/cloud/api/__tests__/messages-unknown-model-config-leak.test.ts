/**
 * Provider-config leak repro for POST /api/v1/messages (Anthropic-compatible).
 *
 * Sibling of the /v1/chat/completions fix (#13913): a request for an
 * unknown/unconfigured model surfaced the raw provider-configuration error to
 * the DIRECT API caller — including the Vercel AI Gateway SDK's setup guidance
 * naming `AI_GATEWAY_API_KEY` — via `anthropicError("api_error", err.message,
 * 500)` (non-streaming) and the terminal SSE `error` event (streaming). The
 * route boundary must translate that class of failure into a clean, model-scoped
 * error and keep the internal detail in server logs only.
 *
 * Harness mirrors the chat-completions leak test: auth/billing are stubbed at
 * their module boundaries, but the route error boundary, the real provider
 * resolution (`getLanguageModel`), the real AI SDK, and the real `@ai-sdk/gateway`
 * client (speaking HTTP to a local stub that answers 401 exactly like the
 * gateway) are REAL, so the SDK raises its real GatewayAuthenticationError.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import * as pricingActual from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as inferenceAuthContextActual from "@/lib/services/inference-auth-context";
import * as creditReservationActual from "@/lib/utils/credit-reservation";

process.env.NODE_ENV ||= "test";
process.env.RATE_LIMIT_DISABLED = "true";
process.env.MOCK_REDIS = "1";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const UNKNOWN_MODEL = "totally/unknown-model";

// Strings from the internal configuration errors (ours and the gateway SDK's
// contextual auth message) that must never appear in a client body.
const INTERNAL_MARKERS = [
  "AI_GATEWAY_API_KEY",
  "OPENROUTER_API_KEY",
  "environment variable",
  "apiKey",
  "vercel.com",
];

const CLEAN_MESSAGE = `model '${UNKNOWN_MODEL}' is not available on this deployment`;

// --- local stub playing the EXTERNAL Vercel AI Gateway -----------------------
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

mock.module("@/lib/services/content-moderation", () => ({
  ...contentModerationActual,
  contentModerationService: {
    ...contentModerationActual.contentModerationService,
    shouldBlockUser: async () => false,
    moderateInBackground: () => {},
  },
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
const app = (await import("../v1/messages/route")).default;

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
  mock.module(
    "@/lib/services/content-moderation",
    () => contentModerationActual,
  );
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module("@/lib/utils/credit-reservation", () => creditReservationActual);
});

function makeRequest(stream: boolean): Request {
  return new Request("https://api.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: UNKNOWN_MODEL,
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      stream,
    }),
  });
}

function assertNoLeak(bodyText: string): void {
  for (const marker of INTERNAL_MARKERS) {
    expect(bodyText).not.toContain(marker);
  }
}

describe("v1/messages unknown-model provider-config leak", () => {
  test("non-streaming: clean 400 invalid_request_error, no internal config detail", async () => {
    const res = await app.request(makeRequest(false));
    const bodyText = await res.text();

    assertNoLeak(bodyText);
    expect(res.status).toBe(400);
    const body = JSON.parse(bodyText) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe(CLEAN_MESSAGE);
  });

  test("streaming: response carries the clean model-scoped message and never the internal detail", async () => {
    const res = await app.request(makeRequest(true));
    const bodyText = await res.text();

    // The gateway 401 may surface synchronously (outer catch → 400 JSON) or as
    // an in-stream error part (backstop → terminal SSE error event); either way
    // the invariant is the same — the clean message shows, the internal
    // provider/gateway config detail never does.
    assertNoLeak(bodyText);
    expect(bodyText).toContain(CLEAN_MESSAGE);
    expect(bodyText).toContain("invalid_request_error");
  });

  test("getLanguageModel resolution failure is a classified configuration error; internal detail intact for logs", () => {
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
      expect((caught as Error).message).toContain("OPENROUTER_API_KEY");
    } finally {
      process.env.AI_GATEWAY_API_KEY = "test-invalid-gateway-key";
    }
  });
});
