/**
 * Exercises the real app-users Hono route with mocked auth and service boundaries.
 * It pins strict limit validation before any app or app-user lookup.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getById = mock(async () => ({
  id: "app-1",
  organization_id: "org-1",
}));
const getAppUsers = mock(async () => [{ id: "user-1" }]);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { organization_id: "org-1" },
    apiKey: null,
  }),
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: async () => false,
}));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById, getAppUsers },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock() },
}));

const route = (await import("../v1/apps/[id]/users/route")).default;
const app = new Hono().route("/api/v1/apps/:id/users", route);

function listUsers(query = "") {
  return app.request(`/api/v1/apps/app-1/users${query}`);
}

describe("GET /api/v1/apps/:id/users limit validation", () => {
  beforeEach(() => {
    getById.mockClear();
    getAppUsers.mockClear();
  });

  test("passes undefined when limit is absent", async () => {
    const response = await listUsers();

    expect(response.status).toBe(200);
    expect(getAppUsers).toHaveBeenCalledWith("app-1", undefined);
  });

  test("passes a valid positive base-10 integer unchanged", async () => {
    const response = await listUsers("?limit=20");

    expect(response.status).toBe(200);
    expect(getAppUsers).toHaveBeenCalledWith("app-1", 20);
  });

  test.each([
    ["empty", ""],
    ["malformed", "abc"],
    ["zero", "0"],
    ["negative", "-1"],
    ["partial", "20abc"],
    ["fractional", "1.5"],
    ["exponent form", "2e3"],
    ["unsafe integer", "9007199254740992"],
  ])("rejects %s limits before app lookup", async (_name, limit) => {
    const response = await listUsers(`?limit=${encodeURIComponent(limit)}`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      success: boolean;
      error: string;
    };
    expect(body).toEqual({ success: false, error: "Invalid limit" });
    expect(getById).not.toHaveBeenCalled();
    expect(getAppUsers).not.toHaveBeenCalled();
  });
});
