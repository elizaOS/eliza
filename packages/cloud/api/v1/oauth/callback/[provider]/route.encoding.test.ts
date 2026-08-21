/** Exercises malformed OAuth provider segments for GET and POST callbacks. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getByStateTokenHash = mock(async () => null);
const getOAuthIntentsService = mock(() => ({
  getByStateTokenHash,
  markDenied: mock(),
  markBound: mock(),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  getIpKey: () => "test-ip",
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/oauth-intents-default", () => ({
  getOAuthIntentsService,
}));

mock.module("@/lib/services/oauth-callback-bus", () => ({
  createOAuthCallbackBus: () => ({
    publish: mock(async () => undefined),
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/api/v1/oauth/callback/:provider", route);

function callbackUrl(provider: string, query = "state=oauth-state"): string {
  return `https://api.example.test/api/v1/oauth/callback/${provider}?${query}`;
}

describe("GET /api/v1/oauth/callback/:provider encoding", () => {
  beforeEach(() => {
    getByStateTokenHash.mockClear();
    getOAuthIntentsService.mockClear();
  });

  test("unsupported provider is untouched", async () => {
    const response = await app.fetch(
      new Request(callbackUrl("not-a-provider")),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: "Unsupported provider",
    });
    expect(getByStateTokenHash).not.toHaveBeenCalled();
  });

  test("canonical provider still reaches intent lookup", async () => {
    const response = await app.fetch(new Request(callbackUrl("google")));
    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: "Unknown state token",
    });
    expect(getByStateTokenHash).toHaveBeenCalledTimes(1);
  });

  test("canonical percent-encoded letter still decodes before lookup", async () => {
    const response = await app.fetch(new Request(callbackUrl("g%6Fogle")));
    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: "Unknown state token",
    });
    expect(getByStateTokenHash).toHaveBeenCalledTimes(1);
  });

  test.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed provider %s with 400",
    async (token) => {
      const response = await app.fetch(new Request(callbackUrl(token)));
      expect(response.status).toBe(400);
      expect((await response.json()) as unknown).toEqual({
        success: false,
        error: "invalid provider: malformed URL encoding",
      });
      expect(getByStateTokenHash).not.toHaveBeenCalled();
    },
  );

  test("POST rejects malformed provider before intent lookup", async () => {
    const response = await app.fetch(
      new Request(callbackUrl("%"), { method: "POST" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: "invalid provider: malformed URL encoding",
    });
    expect(getByStateTokenHash).not.toHaveBeenCalled();
  });
});
