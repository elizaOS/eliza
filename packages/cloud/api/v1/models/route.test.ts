import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as languageModelActual from "@/lib/providers/language-model";
import * as modelCatalogActual from "@/lib/services/model-catalog";
import * as loggerActual from "@/lib/utils/logger";

const getCurrentUser = mock(async () => null);
const getAiProviderConfigurationError = mock(
  () => "No AI provider is configured",
);
const hasAnyAiProviderConfigured = mock(() => true);
const getCachedMergedModelCatalog = mock(
  async (): Promise<Array<{ id: string; object: string }>> => [
    { id: "openai/gpt-5-mini", object: "model" },
  ],
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  getCurrentUser,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getAiProviderConfigurationError,
  hasAnyAiProviderConfigured,
}));

mock.module("@/lib/services/model-catalog", () => ({
  ...modelCatalogActual,
  getCachedMergedModelCatalog,
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    error: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/services/model-catalog", () => modelCatalogActual);
  mock.module("@/lib/utils/logger", () => loggerActual);
});

describe("GET /api/v1/models cache policy", () => {
  beforeEach(() => {
    getCurrentUser.mockClear();
    getCurrentUser.mockResolvedValue(null);
    getAiProviderConfigurationError.mockClear();
    getAiProviderConfigurationError.mockReturnValue(
      "No AI provider is configured",
    );
    hasAnyAiProviderConfigured.mockClear();
    hasAnyAiProviderConfigured.mockReturnValue(true);
    getCachedMergedModelCatalog.mockClear();
    getCachedMergedModelCatalog.mockResolvedValue([
      { id: "openai/gpt-5-mini", object: "model" },
    ]);
  });

  test("successful catalogs remain publicly cacheable", async () => {
    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=3600, stale-while-revalidate=7200",
    );
    await expect(response.json()).resolves.toEqual({
      object: "list",
      data: [{ id: "openai/gpt-5-mini", object: "model" }],
    });
  });

  test("a rejected best-effort auth probe does not fail or uncache the catalog", async () => {
    getCurrentUser.mockRejectedValueOnce(new Error("session unavailable"));

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=3600, stale-while-revalidate=7200",
    );
    expect(getCachedMergedModelCatalog).toHaveBeenCalledTimes(1);
  });

  test("catalog failures cannot inherit the public cache policy", async () => {
    getCachedMergedModelCatalog.mockRejectedValueOnce(
      new Error("catalog unavailable"),
    );

    const response = await app.request("/");

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Cache-Control")).not.toContain("s-maxage");
  });

  test("configuration errors are explicitly non-cacheable", async () => {
    hasAnyAiProviderConfigured.mockReturnValueOnce(false);

    const response = await app.request("/");

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Cache-Control")).not.toContain("s-maxage");
    expect(getCachedMergedModelCatalog).not.toHaveBeenCalled();
  });
});
