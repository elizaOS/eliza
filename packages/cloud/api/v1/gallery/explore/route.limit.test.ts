/**
 * GET /api/v1/gallery/explore `limit` is explore-page size identity,
 * leftover tax after v1 gallery list pagination. Stock develop used
 * parseClampedLimit, which treated `1e2` / `12px` / `007` / `foo` as
 * the default 20 instead of a 400. type / status stay untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const listRandomPublicImageSummaries = mock(async () => [
  {
    id: "gen-1",
    type: "image",
    storage_url: "https://cdn.example/1.png",
    thumbnail_url: null,
    prompt_preview: "a cat",
    model: "flux",
    status: "completed",
    created_at: "2026-08-17T00:00:00.000Z",
    completed_at: "2026-08-17T00:00:01.000Z",
    dimensions: "512x512",
    mime_type: "image/png",
    file_size: 12,
  },
]);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { AGGRESSIVE: {}, STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
}));
mock.module("@/lib/services/generations", () => ({
  generationsService: {
    listRandomPublicImageSummaries,
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/", route);

describe("GET /api/v1/gallery/explore limit identity", () => {
  beforeEach(() => {
    listRandomPublicImageSummaries.mockClear();
  });

  test.each(["", "?limit=", "?limit"])(
    "accepts %s as the default explore page of 20",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(200);
      expect(listRandomPublicImageSummaries).toHaveBeenCalledTimes(1);
      expect(listRandomPublicImageSummaries).toHaveBeenCalledWith(20);
    },
  );

  test("accepts limit=10 as an exact explore page size", async () => {
    const response = await app.request("/?limit=10");
    expect(response.status).toBe(200);
    expect(listRandomPublicImageSummaries).toHaveBeenCalledWith(10);
  });

  test("caps a canonical oversize limit at 100", async () => {
    const response = await app.request("/?limit=101");
    expect(response.status).toBe(200);
    expect(listRandomPublicImageSummaries).toHaveBeenCalledWith(100);
  });

  test.each(["1e2", "12px", "007", "0", "abc", "-1", "50abc", " 10", "10 "])(
    "rejects prefix-coerced limit=%s before listRandomPublicImageSummaries",
    async (token) => {
      const response = await app.request(
        `/?limit=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(listRandomPublicImageSummaries).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?limit=10&limit=10",
    "?limit=10&limit=20",
    "?limit=&limit=10",
    "?limit=foo&limit=10",
  ])(
    "rejects duplicate limit values in %s before listRandomPublicImageSummaries",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(listRandomPublicImageSummaries).not.toHaveBeenCalled();
    },
  );
});
