/**
 * POST /api/v1/referrals/apply untrusted JSON body contract.
 *
 * Hono 4.13 `c.req.json()` is a bare `JSON.parse`. The handler catch maps
 * SyntaxError through `failureResponse` to HTTP 500 instead of a caller 400.
 * Referral apply must not write an affiliate binding on garbage.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORG_ID = "00000000-0000-4000-8000-0000000000bb";

const requireUserOrApiKeyWithOrg =
  mock<
    (context: unknown) => Promise<{ id: string; organization_id: string }>
  >();
const applyReferralCode =
  mock<
    (
      userId: string,
      organizationId: string,
      code: string,
    ) => Promise<{ success: boolean; message: string }>
  >();

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
  failureResponse: mock(
    (c: { json: (body: unknown, status: number) => unknown }) =>
      c.json({ success: false, error: "An unexpected error occurred" }, 500),
  ),
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

function post(raw: string, auth = true) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth) headers.Authorization = "Bearer eliza_test_key";
  return app.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers,
      body: raw,
    }),
  );
}

describe("POST /api/v1/referrals/apply JSON body", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    applyReferralCode.mockClear();
    requireUserOrApiKeyWithOrg.mockImplementation(async () => ({
      id: USER_ID,
      organization_id: ORG_ID,
    }));
    applyReferralCode.mockImplementation(async () => {
      throw new Error("applyReferralCode must not run");
    });
  });

  test.each(["", "   ", "{", "not-json"])(
    "rejects malformed referral body %j with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect((await res.json()) as unknown).toEqual({
        error: "Invalid JSON body",
      });
      expect(requireUserOrApiKeyWithOrg).toHaveBeenCalled();
      expect(applyReferralCode).not.toHaveBeenCalled();
    },
  );

  test.each(['["CODE"]', '"CODE"', "null", "12"])(
    "rejects non-object referral body %s with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect((await res.json()) as unknown).toEqual({
        error: "Invalid JSON body",
      });
      expect(applyReferralCode).not.toHaveBeenCalled();
    },
  );

  test("still 400s a parseable object missing code via zod", async () => {
    const res = await post("{}");

    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({
      error: "Invalid referral code format.",
    });
    expect(applyReferralCode).not.toHaveBeenCalled();
  });

  test("still applies a canonical object body", async () => {
    applyReferralCode.mockResolvedValue({
      success: true,
      message: "Referral applied",
    });

    const res = await post(JSON.stringify({ code: "FRIEND1" }));

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({
      success: true,
      message: "Referral applied",
    });
    expect(applyReferralCode).toHaveBeenCalledTimes(1);
    expect(applyReferralCode.mock.calls[0]).toEqual([
      USER_ID,
      ORG_ID,
      "FRIEND1",
    ]);
  });
});
