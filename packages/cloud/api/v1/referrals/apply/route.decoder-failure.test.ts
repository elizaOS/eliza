/**
 * Exercises the referral-application JSON decoder with real request bodies.
 * Mocked auth and services isolate syntax failures from body-stream failures at the route boundary.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORG_ID = "00000000-0000-4000-8000-0000000000bb";

const requireUserOrApiKeyWithOrg =
  mock<
    (context: unknown) => Promise<{ id: string; organization_id: string }>
  >();
const applyReferralCode = mock<() => Promise<never>>();
const failureResponse = mock(
  (c: { json: (body: unknown, status: number) => unknown }) =>
    c.json({ success: false, error: "An unexpected error occurred" }, 500),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/referrals", () => ({
  referralsService: { applyReferralCode },
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({ failureResponse }));
mock.module("@/lib/utils/cors", () => ({ getCorsHeaders: () => ({}) }));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/referrals/apply decoder failures", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    applyReferralCode.mockClear();
    failureResponse.mockClear();
    requireUserOrApiKeyWithOrg.mockImplementation(async () => ({
      id: USER_ID,
      organization_id: ORG_ID,
    }));
    applyReferralCode.mockImplementation(async () => {
      throw new Error("applyReferralCode must not run");
    });
  });

  test("propagates a non-syntax body-read failure to the 500 boundary", async () => {
    const request = new Request("http://test.local/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer eliza_test_key",
      },
      body: "{}",
    });
    Object.defineProperty(request, "text", {
      value: () => Promise.reject(new TypeError("terminated")),
    });

    const response = await app.fetch(request);

    expect(response.status).toBe(500);
    expect(failureResponse).toHaveBeenCalledTimes(1);
    expect(applyReferralCode).not.toHaveBeenCalled();
  });

  test("keeps malformed JSON at the caller-facing 400 boundary", async () => {
    const response = await app.fetch(
      new Request("http://test.local/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer eliza_test_key",
        },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(failureResponse).not.toHaveBeenCalled();
    expect(applyReferralCode).not.toHaveBeenCalled();
  });
});
