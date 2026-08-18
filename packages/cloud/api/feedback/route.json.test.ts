/**
 * POST /api/feedback used to let c.req.json() throw uncaught.
 * Malformed JSON is caller error (400), not a 500.
 */
import { describe, expect, mock, test } from "bun:test";

const send = mock(async () => true);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/email", () => ({
  emailService: { send },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

describe("POST /api/feedback malformed JSON", () => {
  test("returns 400 instead of 500 and never sends email", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("canonical JSON still sends feedback", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comment: "hello" }),
    });
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalled();
  });
});
