/**
 * GET /api/v1/ballots/:id?public=1 must reject malformed ids with 400 and
 * treat well-formed missing UUIDs as 404 — never an internal 500 from a
 * Postgres UUID cast (#18071). Rate limiter and repository are doubled;
 * the route module is real.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as secretBallotsRepoActual from "@/db/repositories/secret-ballots";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";

const MISSING_UUID = "00000000-0000-4000-8000-000000000099";
const getBallot = mock();

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { STANDARD: {}, STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/db/repositories/secret-ballots", () => ({
  ...secretBallotsRepoActual,
  secretBallotsRepository: {
    ...secretBallotsRepoActual.secretBallotsRepository,
    getBallot,
  },
}));

const ballotRoute = (await import("../v1/ballots/[id]/route")).default;
const app = new Hono().route("/api/v1/ballots/:id", ballotRoute);

afterAll(() => {
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module(
    "@/db/repositories/secret-ballots",
    () => secretBallotsRepoActual,
  );
});

beforeEach(() => {
  getBallot.mockReset();
  getBallot.mockResolvedValue(null);
});

async function getPublicBallot(id: string) {
  return app.request(`/api/v1/ballots/${id}?public=1`, { method: "GET" });
}

describe("GET /api/v1/ballots/:id?public=1 id validation (#18071)", () => {
  test("malformed id returns 400 without touching the repository", async () => {
    const res = await getPublicBallot("qa-invalid");

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      success?: boolean;
      error?: string;
    };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid ballot id");
    expect(getBallot).not.toHaveBeenCalled();
  });

  test("well-formed missing UUID returns 404", async () => {
    const res = await getPublicBallot(MISSING_UUID);

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      success?: boolean;
      error?: string;
    };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Ballot not found");
    expect(getBallot).toHaveBeenCalledWith(MISSING_UUID);
  });
});

describe("parseBallotIdParam", () => {
  test("accepts RFC UUID variants 1-5", async () => {
    const { parseBallotIdParam } = await import("../v1/ballots/ballot-id");
    expect(parseBallotIdParam(MISSING_UUID)).toEqual({
      ok: true,
      id: MISSING_UUID,
    });
    expect(parseBallotIdParam("qa-invalid")).toEqual({
      ok: false,
      error: "Invalid ballot id",
    });
    expect(parseBallotIdParam(undefined)).toEqual({
      ok: false,
      error: "Missing ballot id",
    });
  });
});
