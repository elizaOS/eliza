/**
 * POST /api/v1/reports/bug used to let c.req.json() throw into
 * failureResponse, which maps SyntaxError to 500. Malformed JSON is caller error.
 */
import { describe, expect, mock, test } from "bun:test";

const send = mock(async () => true);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: "strict" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/email", () => ({
  emailService: { send },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

const { default: app } = await import("./route");

const validBody = {
  description: "startup crashed",
  stepsToReproduce: "open the app",
};

describe("POST /api/v1/reports/bug malformed JSON", () => {
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

  test("canonical JSON still accepts the report", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      },
      {},
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ accepted: true });
    expect(send).toHaveBeenCalled();
  });
});
