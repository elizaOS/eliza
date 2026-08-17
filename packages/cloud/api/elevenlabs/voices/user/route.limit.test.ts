/**
 * GET /api/elevenlabs/voices/user `limit` is voices-page size identity,
 * leftover tax after files / gallery explore. Stock develop used
 * z.coerce.number(), which treated `1e2` / `007` / `0x10` as a page
 * size instead of a 400. includeInactive / cloneType / offset stay
 * untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getUserVoices = mock(async () => []);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: {
      id: "user-1",
      organization_id: "org-1",
    },
  }),
}));
mock.module("@/lib/api/errors", () => ({
  getErrorStatusCode: () => 500,
  getSafeErrorMessage: () => "error",
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
}));
mock.module("@/lib/services/voice-cloning", () => ({
  voiceCloningService: { getUserVoices },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/", route);

describe("GET /api/elevenlabs/voices/user limit identity", () => {
  beforeEach(() => {
    getUserVoices.mockClear();
  });

  test.each(["", "?limit=", "?limit"])(
    "accepts %s as the default voices page of 50",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { limit: number };
      expect(body.limit).toBe(50);
      expect(getUserVoices).toHaveBeenCalledTimes(1);
    },
  );

  test("accepts limit=10 as an exact voices page size", async () => {
    const response = await app.request("/?limit=10");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { limit: number };
    expect(body.limit).toBe(10);
    expect(getUserVoices).toHaveBeenCalledTimes(1);
  });

  test("caps a canonical oversize limit at 100", async () => {
    const response = await app.request("/?limit=101");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { limit: number };
    expect(body.limit).toBe(100);
    expect(getUserVoices).toHaveBeenCalledTimes(1);
  });

  test.each(["1e2", "12px", "007", "0", "abc", "-1", "50abc", " 10", "10 ", "0x10"])(
    "rejects prefix-coerced limit=%s before voiceCloningService.getUserVoices",
    async (token) => {
      const response = await app.request(
        `/?limit=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(getUserVoices).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?limit=10&limit=10",
    "?limit=10&limit=20",
    "?limit=&limit=10",
    "?limit=foo&limit=10",
  ])(
    "rejects duplicate limit values in %s before voiceCloningService.getUserVoices",
    async (query) => {
      const response = await app.request(`/${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid limit");
      expect(getUserVoices).not.toHaveBeenCalled();
    },
  );
});
