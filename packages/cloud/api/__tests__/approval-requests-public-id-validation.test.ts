/**
 * GET /api/v1/approval-requests/:id?public=1 must reject malformed ids with
 * 400 and treat well-formed missing UUIDs as 404 — never an internal 500
 * from a Postgres UUID cast or colliding table shape (#18074). Rate limiter
 * and service are doubled; the route module is real.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as approvalRepoActual from "@/db/repositories/approval-requests";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as approvalServiceActual from "@/lib/services/approval-requests";

const MISSING_UUID = "00000000-0000-4000-8000-000000000000";
const getPublic = mock(async (_id: string) => null);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { STANDARD: {}, STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/approval-requests", () => ({
  ...approvalServiceActual,
  createApprovalRequestsService: () => ({
    getPublic,
    get: mock(async () => null),
  }),
}));

mock.module("@/db/repositories/approval-requests", () => ({
  ...approvalRepoActual,
  approvalRequestsRepository: {},
}));

const approvalRoute = (await import("../v1/approval-requests/[id]/route"))
  .default;
const app = new Hono().route("/api/v1/approval-requests/:id", approvalRoute);

afterAll(() => {
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module(
    "@/lib/services/approval-requests",
    () => approvalServiceActual,
  );
  mock.module(
    "@/db/repositories/approval-requests",
    () => approvalRepoActual,
  );
});

beforeEach(() => {
  getPublic.mockReset();
  getPublic.mockResolvedValue(null);
});

async function getPublicApproval(id: string) {
  return app.request(`/api/v1/approval-requests/${id}?public=1`, {
    method: "GET",
  });
}

describe("GET /api/v1/approval-requests/:id?public=1 id validation (#18074)", () => {
  test("malformed id returns 400 without touching the service", async () => {
    const res = await getPublicApproval("qa-invalid");

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      success?: boolean;
      error?: string;
    };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid approval request id");
    expect(getPublic).not.toHaveBeenCalled();
  });

  test("well-formed missing UUID returns 404", async () => {
    const res = await getPublicApproval(MISSING_UUID);

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      success?: boolean;
      error?: string;
    };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Approval request not found");
    expect(getPublic).toHaveBeenCalledWith(MISSING_UUID);
  });
});
