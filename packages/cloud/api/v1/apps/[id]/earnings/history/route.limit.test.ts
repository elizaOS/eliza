/**
 * GET /api/v1/apps/[id]/earnings/history `limit` is ledger-page size
 * identity, leftover tax after earnings `days` (#20672). Stock develop
 * used z.coerce.number(), which treated `1e2` / `007` / `0x10` as a
 * page size instead of a 400. offset / type stay untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getById = mock(async () => ({
  id: "app-1",
  organization_id: "org-1",
}));
const getTransactionHistory = mock(async () => []);
const isAppKeyOutOfScope = mock(async () => false);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKey: null,
  }),
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope,
}));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById },
}));
mock.module("@/lib/services/app-earnings", () => ({
  appEarningsService: { getTransactionHistory },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id/earnings/history", route);

describe("GET /api/v1/apps/[id]/earnings/history limit identity", () => {
  beforeEach(() => {
    getById.mockClear();
    getTransactionHistory.mockClear();
  });

  test.each(["", "?limit=", "?limit"])(
    "accepts %s as the default earnings-history page of 50",
    async (query) => {
      const response = await app.request(`/app-1/earnings/history${query}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        pagination: { limit: number };
      };
      expect(body.pagination.limit).toBe(50);
      expect(getTransactionHistory).toHaveBeenCalledTimes(1);
      expect(getTransactionHistory).toHaveBeenCalledWith(
        "app-1",
        expect.objectContaining({ limit: 50 }),
      );
    },
  );

  test("accepts limit=10 as an exact earnings-history page size", async () => {
    const response = await app.request("/app-1/earnings/history?limit=10");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pagination: { limit: number };
    };
    expect(body.pagination.limit).toBe(10);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({ limit: 10 }),
    );
  });

  test("caps a canonical oversize limit at 100", async () => {
    const response = await app.request("/app-1/earnings/history?limit=101");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pagination: { limit: number };
    };
    expect(body.pagination.limit).toBe(100);
    expect(getTransactionHistory).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({ limit: 100 }),
    );
  });

  test.each(["1e2", "12px", "007", "0", "abc", "-1", "50abc", " 10", "10 ", "0x10"])(
    "rejects prefix-coerced limit=%s before getTransactionHistory",
    async (token) => {
      const response = await app.request(
        `/app-1/earnings/history?limit=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(getTransactionHistory).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?limit=10&limit=10",
    "?limit=10&limit=20",
    "?limit=&limit=10",
    "?limit=foo&limit=10",
  ])(
    "rejects duplicate limit values in %s before getTransactionHistory",
    async (query) => {
      const response = await app.request(`/app-1/earnings/history${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(getTransactionHistory).not.toHaveBeenCalled();
    },
  );
});
