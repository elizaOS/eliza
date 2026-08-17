/**
 * GET /api/v1/admin/moderation `limit` is violations page-size identity.
 * Stock develop used z.coerce.number(), which treated `1e2` / `007` /
 * `0x10` as a page size instead of a 400. view / userId stay untouched.
 * Missing / empty still means 100.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getRecentViolations = mock(async () => []);
const getUsersFlaggedForReview = mock(async () => []);
const getBannedUsers = mock(async () => []);
const listAdmins = mock(async () => []);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireAdmin: async () => ({
    user: { id: "admin-1", wallet_address: "0xadmin", organization_id: "org-1" },
    role: "super_admin",
  }),
  requireUserOrApiKey: async () => ({ id: "admin-1" }),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: class ApiError extends Error {
    status = 500;
    constructor(status: number, _code: string, message: string) {
      super(message);
      this.status = status;
    }
    toJSON() {
      return { error: this.message };
    }
  },
  ValidationError: (message: string) => {
    const err = new Error(message);
    err.name = "ValidationError";
    return err;
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
  },
}));
mock.module("@/lib/services/admin", () => ({
  adminService: {
    getRecentViolations,
    getUsersFlaggedForReview,
    getBannedUsers,
    listAdmins,
    getUserDetails: mock(async () => ({})),
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/", route);

describe("GET /api/v1/admin/moderation limit identity", () => {
  beforeEach(() => {
    getRecentViolations.mockClear();
  });

  test.each(["?view=violations", "?view=violations&limit=", "?view=violations&limit"])(
    "accepts %s as the default moderation violations page of 100",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(200);
      expect(getRecentViolations).toHaveBeenCalledTimes(1);
      expect(getRecentViolations).toHaveBeenCalledWith(100);
    },
  );

  test("accepts limit=10 as an exact moderation violations page size", async () => {
    const response = await app.request("/?view=violations&limit=10");
    expect(response.status).toBe(200);
    expect(getRecentViolations).toHaveBeenCalledWith(10);
  });

  test("rejects a canonical oversize limit before getRecentViolations", async () => {
    const response = await app.request("/?view=violations&limit=1001");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Invalid limit");
    expect(getRecentViolations).not.toHaveBeenCalled();
  });

  test.each([
    "1e2",
    "12px",
    "007",
    "0",
    "abc",
    "-1",
    "50abc",
    " 10",
    "10 ",
    "0x10",
  ])(
    "rejects prefix-coerced limit=%s before getRecentViolations",
    async (token) => {
      const response = await app.request(
        `/?view=violations&limit=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(getRecentViolations).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?view=violations&limit=10&limit=10",
    "?view=violations&limit=10&limit=20",
    "?view=violations&limit=&limit=10",
    "?view=violations&limit=foo&limit=10",
  ])(
    "rejects duplicate limit values in %s before getRecentViolations",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(getRecentViolations).not.toHaveBeenCalled();
    },
  );
});
