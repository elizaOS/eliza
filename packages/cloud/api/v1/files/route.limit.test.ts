/**
 * GET /api/v1/files `limit` is files-page size identity, leftover tax
 * after gallery explore / inbox limits. Stock develop used
 * z.coerce.number(), which treated `1e2` / `007` / `0x10` as a page
 * size instead of a 400. offset / source / kind / mimeType / q stay
 * untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const list = mock(async () => ({
  items: [],
  limit: 50,
  offset: 0,
  hasMore: false,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: class ApiError extends Error {},
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
  jsonError: () => {
    throw new Error("jsonError");
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn: () => undefined, info: () => undefined },
}));
mock.module("@/lib/services/cloud-files", () => ({
  CloudFileQuotaExceededError: class CloudFileQuotaExceededError extends Error {},
  cloudFilesService: { list },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/", route);

describe("GET /api/v1/files limit identity", () => {
  beforeEach(() => {
    list.mockClear();
  });

  test.each(["", "?limit=", "?limit"])(
    "accepts %s as the default files page of 50",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(200);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: "org-1", limit: 50 }),
      );
    },
  );

  test("accepts limit=10 as an exact files page size", async () => {
    const response = await app.request("/?limit=10");
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", limit: 10 }),
    );
  });

  test("caps a canonical oversize limit at 200", async () => {
    const response = await app.request("/?limit=201");
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", limit: 200 }),
    );
  });

  test.each(["1e2", "12px", "007", "0", "abc", "-1", "50abc", " 10", "10 ", "0x10"])(
    "rejects prefix-coerced limit=%s before cloudFilesService.list",
    async (token) => {
      const response = await app.request(
        `/?limit=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(list).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?limit=10&limit=10",
    "?limit=10&limit=20",
    "?limit=&limit=10",
    "?limit=foo&limit=10",
  ])(
    "rejects duplicate limit values in %s before cloudFilesService.list",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(list).not.toHaveBeenCalled();
    },
  );
});
