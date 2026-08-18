/**
 * POST /api/v1/referrals/apply decoder-failure contract.
 *
 * decodeRequestJson maps only JSON SyntaxError to the caller 400; a stream or
 * decoder fault while reading the body (c.req.text() rejecting with a
 * non-SyntaxError) must propagate to the route's failureResponse 500 boundary
 * instead of being blamed on the caller. Mocked auth/services; the route app
 * and the shared decoder are real.
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
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse,
}));
mock.module("@/lib/utils/cors", () => ({
  getCorsHeaders: () => ({}),
}));
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

  test("a non-SyntaxError body-read fault reaches the 500 boundary, not the 400 caller error", async () => {
    // A request whose body stream breaks mid-read: text() rejects with a
    // TypeError the way undici surfaces a terminated stream.
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

  test("malformed JSON syntax still yields the caller 400 without touching the service", async () => {
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
