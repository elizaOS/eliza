/**
 * POST /api/signup-code/redeem — auth rejection status regression tests.
 *
 * requireUserWithOrg rejects with typed ApiErrors: 401 only when no caller
 * is authenticated, and 403 for an inactive user, an inactive organization,
 * or an account without an organization. The route used to answer every
 * rejection with 401, so a signed-in caller in a fenced state was told to
 * authenticate again. Every other requireUserWithOrg route preserves the
 * typed status (via failureResponse); this route must preserve it too.
 *
 * Only the auth boundary, the rate limiter, and the signup-code service are
 * stubbed; the route handler itself is the real module.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  ApiError,
  AuthenticationError,
  ForbiddenError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";

let authMode:
  | "unauth"
  | "inactive-org"
  | "inactive-user"
  | "no-org"
  | "db-failure"
  | "ok" = "ok";

mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserWithOrg: async () => {
    if (authMode === "unauth") throw AuthenticationError();
    if (authMode === "inactive-org")
      throw ForbiddenError("Organization is inactive");
    if (authMode === "inactive-user")
      throw ForbiddenError("User account is inactive");
    if (authMode === "no-org")
      throw new ApiError(
        403,
        "access_denied",
        "This feature requires a full account. Please sign up to continue.",
      );
    if (authMode === "db-failure") throw new Error("database unavailable");
    return {
      id: "user-1",
      organization_id: "org-1",
      organization: { id: "org-1", is_active: true },
      is_active: true,
    };
  },
}));

mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    RateLimitPresets: { CRITICAL: {} },
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }),
);

mock.module("@elizaos/cloud-shared/lib/services/signup-code", () => ({
  ERRORS: {
    INVALID_CODE: "Invalid signup code",
    ALREADY_USED: "Your account has already used a signup code",
  },
  redeemSignupCode: async () => {
    throw new Error("Invalid signup code");
  },
}));

const { default: app } = await import("../signup-code/redeem/route");

async function post() {
  return app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "WELCOME-1" }),
  });
}

async function bodyOf(res: Response): Promise<{ error: string }> {
  return (await res.json()) as { error: string };
}

describe("POST /api/signup-code/redeem auth rejection status", () => {
  test("an unauthenticated caller still gets 401", async () => {
    authMode = "unauth";
    const res = await post();
    expect(res.status).toBe(401);
    expect(await bodyOf(res)).toEqual({ error: "Authentication required" });
  });

  test("an inactive organization gets 403, not 401", async () => {
    authMode = "inactive-org";
    const res = await post();
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toEqual({ error: "Organization is inactive" });
  });

  test("an inactive user gets 403, not 401", async () => {
    authMode = "inactive-user";
    const res = await post();
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toEqual({ error: "User account is inactive" });
  });

  test("an account without an organization gets 403, not 401", async () => {
    authMode = "no-org";
    const res = await post();
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toEqual({
      error:
        "This feature requires a full account. Please sign up to continue.",
    });
  });

  test("a non-ApiError auth failure is rethrown as 500, not flattened to 401", async () => {
    authMode = "db-failure";
    const res = await post();
    expect(res.status).toBe(500);
    expect(await bodyOf(res)).toEqual({ error: "Failed to redeem code" });
  });

  test("an authenticated caller still reaches the redeem path (400 on a bad code)", async () => {
    authMode = "ok";
    const res = await post();
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: "Invalid signup code" });
  });
});
