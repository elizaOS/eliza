/** Exercises the authenticated, database-free usage-quota tombstone. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Context } from "hono";
import { Hono } from "hono";
import { AuthenticationError } from "@/lib/api/cloud-worker-errors";

const VALID_BEARER = "Bearer eliza_valid-user-token";
const VALID_API_KEY = "eliza_valid-api-key";
const loggerError = mock(() => {});

const requireUserOrApiKeyWithOrg = mock(async (c: Context) => {
  if (c.req.header("X-Test-Auth-Failure") === "unexpected") {
    throw new Error("never-return-this-auth-backend-detail");
  }
  const authorization = c.req.header("Authorization");
  const apiKey = c.req.header("X-API-Key");
  if (authorization === VALID_BEARER || apiKey === VALID_API_KEY) {
    return {
      id: "user-1",
      organization_id: "organization-1",
    };
  }

  throw AuthenticationError();
});

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: loggerError },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/quotas/usage", route);

const RETIRED_BODY = {
  success: false,
  error: "Weekly usage quotas have been retired",
  code: "usage_quotas_retired",
};

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockClear();
  loggerError.mockClear();
});

describe("GET /api/quotas/usage tombstone", () => {
  test("rejects a request without credentials", async () => {
    const response = await app.request("/api/quotas/usage");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "authentication_required",
    });
  });

  test("rejects an invalid bearer credential", async () => {
    const response = await app.request("/api/quotas/usage", {
      headers: { Authorization: "Bearer invalid-user-token" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "authentication_required",
    });
  });

  test("returns the stable 410 body for a valid bearer credential", async () => {
    const response = await app.request("/api/quotas/usage", {
      headers: { Authorization: VALID_BEARER },
    });

    expect(response.status).toBe(410);
    expect((await response.json()) as typeof RETIRED_BODY).toEqual(
      RETIRED_BODY,
    );
  });

  test("returns the stable 410 body for a valid API key", async () => {
    const response = await app.request("/api/quotas/usage", {
      headers: { "X-API-Key": VALID_API_KEY },
    });

    expect(response.status).toBe(410);
    expect((await response.json()) as typeof RETIRED_BODY).toEqual(
      RETIRED_BODY,
    );
  });

  test("records only a value-free signal for an unexpected auth failure", async () => {
    const response = await app.request("/api/quotas/usage", {
      headers: { "X-Test-Auth-Failure": "unexpected" },
    });

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      success: false,
      code: "internal_error",
    });
    expect(text).not.toContain("never-return-this-auth-backend-detail");
    expect(loggerError).toHaveBeenCalledWith(
      "[Quota Usage] Tombstone authentication failed",
      { errorName: "Error" },
    );
  });

  test("does not expose a POST tombstone", async () => {
    const response = await app.request("/api/quotas/usage", {
      method: "POST",
      headers: { Authorization: VALID_BEARER },
    });

    expect(response.status).toBe(404);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  });
});
