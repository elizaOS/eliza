/**
 * GET /api/v1/apps/:id/promote `history` is promote-history identity,
 * not leftover tax on promote-assets platform. Stock develop treated
 * any non-exact `true` token as suggestions, so `history=TRUE` still
 * returned the suggestion catalog.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getPromotionHistory = mock(async () => [{ id: "hist-1" }]);
const getPromotionSuggestions = mock(async () => [{ id: "sug-1" }]);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKey: null,
  }),
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: async () => false,
}));
mock.module("@/lib/services/app-promotion", () => ({
  appPromotionService: {
    getPromotionHistory,
    getPromotionSuggestions,
    promoteApp: mock(async () => ({ totalCreditsUsed: 0, errors: [] })),
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: promoteRoute } = await import("./route");

function buildApp() {
  const app = new Hono();
  app.route("/api/v1/apps/:id/promote", promoteRoute);
  return app;
}

function get(query = "") {
  return buildApp().request(`/api/v1/apps/app-1/promote${query}`);
}

describe("GET /api/v1/apps/:id/promote history identity", () => {
  beforeEach(() => {
    getPromotionHistory.mockClear();
    getPromotionSuggestions.mockClear();
  });

  test.each(["", "?history=", "?history=false"])(
    "accepts %s as promotion suggestions",
    async (query) => {
      const response = await get(query);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([{ id: "sug-1" }]);
      expect(getPromotionSuggestions).toHaveBeenCalledTimes(1);
      expect(getPromotionHistory).not.toHaveBeenCalled();
    },
  );

  test("accepts history=true as promotion history", async () => {
    const response = await get("?history=true");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: "hist-1" }]);
    expect(getPromotionHistory).toHaveBeenCalledTimes(1);
    expect(getPromotionSuggestions).not.toHaveBeenCalled();
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo"])(
    "rejects history=%s before history and suggestions",
    async (token) => {
      const response = await get(`?history=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid history");
      expect(getPromotionHistory).not.toHaveBeenCalled();
      expect(getPromotionSuggestions).not.toHaveBeenCalled();
    },
  );
});
