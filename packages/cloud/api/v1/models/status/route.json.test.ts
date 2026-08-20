/** Verifies malformed and schema-invalid JSON handling for the model-status endpoint. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { HonoRequest } from "hono/request";

const getCachedMergedModelCatalog = mock(async () => [
  { id: "openai/gpt-5-mini" },
]);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: async () => null,
}));

mock.module("@/lib/models", () => ({
  isGroqNativeModel: () => false,
}));

mock.module("@/lib/providers", () => ({
  hasGroqProviderConfigured: () => false,
}));

mock.module("@/lib/providers/language-model", () => ({
  getAiProviderConfigurationError: () => "No AI provider is configured",
  hasAnyAiProviderConfigured: () => true,
  hasGatewayProviderConfigured: () => true,
}));

mock.module("@/lib/services/model-catalog", () => ({
  getCachedMergedModelCatalog,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/models/status malformed JSON", () => {
  beforeEach(() => {
    getCachedMergedModelCatalog.mockClear();
  });

  test("returns 400 instead of 500 and never reads the catalog", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(getCachedMergedModelCatalog).not.toHaveBeenCalled();
  });

  test.each(["null", '"openai/gpt-5-mini"', "12", "[]"])(
    "rejects a valid non-object JSON body %s without reading the catalog",
    async (body) => {
      const response = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "modelIds array is required",
      });
      expect(getCachedMergedModelCatalog).not.toHaveBeenCalled();
    },
  );

  test("canonical JSON still checks model availability", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelIds: ["openai/gpt-5-mini"] }),
    });
    expect(response.status).toBe(200);
    expect(getCachedMergedModelCatalog).toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      models: [{ modelId: "openai/gpt-5-mini", available: true }],
    });
  });

  test("preserves non-syntax request decoding failures as server errors", async () => {
    const originalJson = HonoRequest.prototype.json;
    HonoRequest.prototype.json = mock(async () => {
      throw new Error("request stream failed");
    }) as typeof HonoRequest.prototype.json;

    try {
      const response = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelIds: ["openai/gpt-5-mini"] }),
      });
      expect(response.status).toBe(500);
      expect(getCachedMergedModelCatalog).not.toHaveBeenCalled();
    } finally {
      HonoRequest.prototype.json = originalJson;
    }
  });
});
