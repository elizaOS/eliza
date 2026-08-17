/**
 * POST /api/invites/accept untrusted JSON body contract.
 *
 * Hono 4.13 `c.req.json()` is a bare `JSON.parse`. The handler catch maps
 * SyntaxError through `failureResponse` to HTTP 500 ("An unexpected error
 * occurred") instead of a caller 400. Membership mutation must not run.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "00000000-0000-4000-8000-0000000000bb";
const ORG_ID = "00000000-0000-4000-8000-0000000000aa";

const requireUserOrApiKey = mock(async () => ({
  id: USER_ID,
  organization_id: ORG_ID,
}));
const acceptInvite = mock(async () => {
  throw new Error("acceptInvite must not run");
});

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKey,
}));

mock.module("@/lib/services/invites", () => ({
  invitesService: { acceptInvite },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const { default: app } = await import("./route");

function post(raw: string) {
  return app.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: raw,
    }),
  );
}

describe("POST /api/invites/accept JSON body", () => {
  beforeEach(() => {
    requireUserOrApiKey.mockClear();
    acceptInvite.mockClear();
    acceptInvite.mockImplementation(async () => {
      throw new Error("acceptInvite must not run");
    });
  });

  test.each(["", "   ", "{", "not-json"])(
    "rejects malformed invite body %j with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        success: false,
        error: "Invalid JSON body",
      });
      expect(acceptInvite).not.toHaveBeenCalled();
      expect(requireUserOrApiKey).toHaveBeenCalled();
    },
  );

  test("still accepts a canonical object body", async () => {
    acceptInvite.mockResolvedValue({
      organization_id: ORG_ID,
      invited_role: "member",
      accepted_at: "2026-08-17T00:00:00.000Z",
    });

    const res = await post(JSON.stringify({ token: "invite-token" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: {
        organization_id: ORG_ID,
        role: "member",
        accepted_at: "2026-08-17T00:00:00.000Z",
      },
    });
    expect(acceptInvite).toHaveBeenCalledTimes(1);
    expect(acceptInvite).toHaveBeenCalledWith("invite-token", USER_ID);
  });

  test("still 400s a parseable object missing token via zod", async () => {
    const res = await post("{}");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Validation error");
    expect(acceptInvite).not.toHaveBeenCalled();
  });
});
