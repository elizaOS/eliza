/**
 * Regression coverage for GET /api/v1/models/[...model] auth handling.
 *
 * The route's broad try/catch used to swallow the AuthenticationError thrown
 * by requireAuthOrApiKey and convert it into a 500 "Failed to fetch model
 * details". An unauthenticated request must surface as a 401 (and other typed
 * ApiErrors must keep their status), while genuine downstream failures stay 500.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
// Spread the real modules: bun's `mock.module` replaces the registry entry
// process-wide, so dropping the other real exports would break later test
// files that import from them.
import * as authActual from "@/lib/auth";
import * as providersActual from "@/lib/providers";
import * as modelCatalogActual from "@/lib/services/model-catalog";
import * as loggerActual from "@/lib/utils/logger";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";

const requireAuthOrApiKey = mock();
const getCachedGatewayModelById = mock();
const getProviderForModel = mock();

// Capture the real implementation BEFORE mock.module runs: the `authActual`
// namespace is a live binding, so after mock.module it resolves to the mock
// itself (delegating through it would recurse forever).
const realRequireAuthOrApiKey = authActual.requireAuthOrApiKey;

mock.module("@/lib/auth", () => ({
  ...authActual,
  requireAuthOrApiKey,
}));

mock.module("@/lib/services/model-catalog", () => ({
  ...modelCatalogActual,
  getCachedGatewayModelById,
}));

mock.module("@/lib/providers", () => ({
  ...providersActual,
  getProviderForModel,
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

// Mount exactly the way the codegen wires it in _router.generated.ts so the
// named-splat param the handler reads (`c.req.param("*")`) is populated.
const MODELS_DETAIL_MOUNT = "/api/v1/models/:*{.+}";

const modelsDetailRoute = (await import("../v1/models/[...model]/route"))
  .default;
const app = new Hono().route(MODELS_DETAIL_MOUNT, modelsDetailRoute);

afterAll(() => {
  mock.module("@/lib/auth", () => authActual);
  mock.module("@/lib/services/model-catalog", () => modelCatalogActual);
  mock.module("@/lib/providers", () => providersActual);
  mock.module("@/lib/utils/logger", () => loggerActual);
});

beforeEach(() => {
  requireAuthOrApiKey.mockReset();
  getCachedGatewayModelById.mockReset();
  getProviderForModel.mockReset();

  // Default to the REAL auth resolution so the unauthenticated case exercises
  // the genuine no-credentials path (throws AuthenticationError, status 401).
  requireAuthOrApiKey.mockImplementation(realRequireAuthOrApiKey);
});

function getModel(model: string, headers: Record<string, string> = {}) {
  return app.request(`/api/v1/models/${model}`, { method: "GET", headers });
}

describe("GET /api/v1/models/[...model] auth handling", () => {
  test("unauthenticated request returns 401, not 500", async () => {
    const res = await getModel("openai/gpt-5-mini");

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      success?: boolean;
      error?: string;
      code?: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe("authentication_required");
    // The pre-fix symptom: the generic 500 body leaking out of the catch.
    expect(body.error).not.toBe("Failed to fetch model details");
  });

  test("invalid API key returns 401, not 500", async () => {
    // requireAuthOrApiKey throws AuthenticationError("Invalid or expired API
    // key") for unknown keys; simulate that without a DB round-trip.
    requireAuthOrApiKey.mockImplementation(async () => {
      const { AuthenticationError } = await import("@/lib/api/errors");
      throw new AuthenticationError("Invalid or expired API key");
    });

    const res = await getModel("openai/gpt-5-mini", {
      "X-API-Key": "eliza_definitely_not_a_real_key",
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("authentication_required");
  });

  test("authenticated request still resolves the model (200)", async () => {
    requireAuthOrApiKey.mockResolvedValue({
      user: { id: USER, organization_id: ORG },
      authMethod: "api_key",
    });
    getCachedGatewayModelById.mockResolvedValue({
      id: "openai/gpt-5-mini",
      object: "model",
    });

    const res = await getModel("openai/gpt-5-mini");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toBe("openai/gpt-5-mini");
  });

  test("downstream failure after successful auth still returns 500", async () => {
    requireAuthOrApiKey.mockResolvedValue({
      user: { id: USER, organization_id: ORG },
      authMethod: "api_key",
    });
    getCachedGatewayModelById.mockResolvedValue(null);
    getProviderForModel.mockImplementation(() => {
      throw new Error("gateway exploded");
    });

    const res = await getModel("openai/gpt-5-mini");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("Failed to fetch model details");
  });
});
