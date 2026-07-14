/**
 * Regression coverage for launch-audit input validation: these routes used to
 * let malformed JSON escape as a 500 from req.json(). They should fail closed
 * as caller-error 400s before provider, billing, or API-key side effects.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as authActual from "@/lib/auth";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
import * as rateLimitHonoActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { InferenceAuthTelemetry } from "@/lib/services/inference-auth-context";
import * as inferenceAuthActual from "@/lib/services/inference-auth-context";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";

const requireAuthOrApiKeyWithOrg = mock();
const requireUserOrApiKeyWithOrg = mock();
const requireUserWithOrg = mock();
const enforceOrgRateLimit = mock();
const resolveInferenceAuthContext = mock();
let authExecutionCtx: unknown;

mock.module("@/lib/auth", () => ({
  ...authActual,
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
  requireUserWithOrg,
}));

mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitHonoActual,
  RateLimitPresets: {
    ...rateLimitHonoActual.RateLimitPresets,
    RELAXED: {},
    STANDARD: {},
  },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthActual,
  resolveInferenceAuthContext,
}));

const chatModule = await import("../v1/chat/completions/route");
const { handleChatCompletionsPOST } = chatModule;
const embeddingsRoute = (await import("../v1/embeddings/route")).default;
const apiKeysRoute = (await import("../v1/api-keys/route")).default;

afterAll(() => {
  mock.module("@/lib/auth", () => authActual);
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/middleware/rate-limit", () => rateLimitActual);
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitHonoActual,
  );
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthActual,
  );
});

beforeEach(() => {
  requireAuthOrApiKeyWithOrg.mockReset();
  requireUserOrApiKeyWithOrg.mockReset();
  requireUserWithOrg.mockReset();
  enforceOrgRateLimit.mockReset();
  resolveInferenceAuthContext.mockReset();
  authExecutionCtx = undefined;

  requireAuthOrApiKeyWithOrg.mockResolvedValue({
    user: { id: USER, organization_id: ORG },
    apiKey: { id: "api-key-id" },
  });
  requireUserOrApiKeyWithOrg.mockImplementation(
    async (c: { set: (k: string, v: unknown) => void }) => {
      c.set("apiKeyId", "api-key-id");
      return { id: USER, organization_id: ORG };
    },
  );
  requireUserWithOrg.mockResolvedValue({ id: USER, organization_id: ORG });
  enforceOrgRateLimit.mockResolvedValue(null);
  resolveInferenceAuthContext.mockImplementation(
    async (
      _request: Request,
      options?: {
        onTelemetry?(value: InferenceAuthTelemetry): void;
        executionCtx?: unknown;
      },
    ) => {
      authExecutionCtx = options?.executionCtx;
      options?.onTelemetry?.({
        v: 1,
        traceId: "01890f47-6c4a-7b2d-8f31-123456789abc",
        authSource: "other",
        controlledProbe: "off",
        cacheAvailability: "not_checked",
        cacheBackend: "none",
        cacheRead: "not_run",
        authoritative: "not_run",
        cacheWrite: "not_run",
        result: "slow_path",
        timings: {
          extractMs: 0.1,
          cacheAvailabilityMs: null,
          cacheReadMs: null,
          keyLookupMs: null,
          userOrgLookupMs: null,
          moderationMs: null,
          cacheWriteMs: null,
          totalMs: 0.1,
        },
      });
      return { kind: "slow_path", reason: "non_api_key" };
    },
  );
});

function malformedJsonRequest(path = "/") {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer eliza_test_key",
      "Content-Type": "application/json",
    },
    body: "{",
  });
}

async function expectStatus(res: Response, expected: number) {
  if (res.status !== expected) {
    throw new Error(
      `expected HTTP ${expected}, got ${res.status}: ${await res.text()}`,
    );
  }
}

describe("malformed JSON body handling", () => {
  test("chat completions returns 400 before model/provider work", async () => {
    const executionCtx = { waitUntil: (_promise: Promise<unknown>) => {} };
    const res = await handleChatCompletionsPOST(malformedJsonRequest(), {
      skipOrgRateLimit: true,
      executionCtx,
    });

    await expectStatus(res, 400);
    const body = (await res.json()) as {
      error?: { type?: string; code?: string };
    };
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.code).toBe("missing_required_parameter");
    expect(res.headers.get("X-Eliza-Auth-Trace")).toContain("result=slow_path");
    expect(res.headers.get("Server-Timing")).toContain("auth_resolve;dur=0.1");
    expect(authExecutionCtx).toBe(executionCtx);
  });

  test("embeddings returns 400 before embedding or billing work", async () => {
    const res = await embeddingsRoute.fetch(malformedJsonRequest());

    await expectStatus(res, 400);
    const body = (await res.json()) as {
      error?: { type?: string; code?: string };
    };
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.code).toBe("missing_required_parameter");
  });

  test("api key creation returns 400 for an unparseable body", async () => {
    const res = await apiKeysRoute.fetch(malformedJsonRequest());

    await expectStatus(res, 400);
    const body = (await res.json()) as { error?: string; details?: string };
    expect(body.error).toBe("Invalid JSON body");
    expect(body.details).toBe("Request body must be a valid JSON object");
  });
});
