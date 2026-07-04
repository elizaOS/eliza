/**
 * Account-security console contract tests for feature-unavailable auth routes.
 *
 * These endpoints exist so a signed-in console does not discover missing
 * account-security features through 404s. The DTOs must say "unavailable"
 * explicitly until MFA enrollment and revocable session inventory are backed by
 * real services.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock<() => Promise<unknown>>();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const mfaRoute = (await import("../v1/me/mfa/route")).default;
const sessionsRoute = (await import("../v1/sessions/route")).default;
const sessionDetailRoute = (await import("../v1/sessions/[id]/route")).default;

const app = new Hono()
  .route("/api/v1/me/mfa", mfaRoute)
  .route("/api/v1/sessions", sessionsRoute)
  .route("/api/v1/sessions/:id", sessionDetailRoute);

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: "user-1",
    organization_id: "org-1",
  });
});

describe("account-security unavailable routes", () => {
  test("GET /api/v1/me/mfa returns an explicit unavailable DTO", async () => {
    const res = await app.request("/api/v1/me/mfa");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available?: boolean;
      reason?: string;
      enrolled?: boolean;
      method?: string | null;
    };
    expect(body).toEqual({
      available: false,
      reason: "mfa_enrollment_unavailable",
      enrolled: false,
      method: null,
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test("GET /api/v1/sessions returns unavailable instead of a fake empty inventory", async () => {
    const res = await app.request("/api/v1/sessions");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available?: boolean;
      reason?: string;
      sessions?: unknown[];
    };
    expect(body).toEqual({
      available: false,
      reason: "session_inventory_unavailable",
      sessions: [],
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test("DELETE /api/v1/sessions/:id reports revocation as unavailable, not missing", async () => {
    const res = await app.request("/api/v1/sessions/session-1", {
      method: "DELETE",
    });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { code?: string; success?: boolean };
    expect(body.success).toBe(false);
    expect(body.code).toBe("session_revocation_unavailable");
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });
});
