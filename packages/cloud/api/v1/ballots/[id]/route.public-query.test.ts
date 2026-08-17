/**
 * GET /api/v1/ballots/:id `public` is checkout-visibility identity,
 * leftover tax after payment-request public (#20954). Stock develop
 * treated every non-exact `1` token as the authenticated creator view,
 * so `public=true` still required auth instead of a 400.
 * Ballot id parser stays untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const BALLOT_ID = "11111111-1111-4111-8111-111111111111";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const getMock = mock(async (_id: string, _organizationId: string) => null);
const getBallotMock = mock(async (_id: string) => null);

const ballotRow = {
  id: BALLOT_ID,
  organizationId: "org-1",
  agentId: "agent-1",
  purpose: "secret vote",
  participants: [],
  threshold: 1,
  status: "open",
  tallyResult: null,
  expiresAt: new Date("2026-01-02T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  metadata: { tokenHashByIdentity: { voter: "secret-hash" } },
};

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/db/repositories/secret-ballots", () => ({
  secretBallotsRepository: { getBallot: getBallotMock },
}));
mock.module("@/lib/services/secret-ballots", () => ({
  createSecretBallotsService: () => ({ get: getMock }),
  redactSecretBallotForPublic: (row: typeof ballotRow) => ({
    ...row,
    metadata: {},
  }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (
    c: { json: (body: unknown, status: number) => Response },
    _error: unknown,
  ) => c.json({ success: false, error: "internal error" }, 500),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

function expectNoLookup() {
  expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  expect(getMock).not.toHaveBeenCalled();
  expect(getBallotMock).not.toHaveBeenCalled();
}

describe("GET /api/v1/ballots/:id public visibility identity", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    getMock.mockClear();
    getBallotMock.mockClear();
    getMock.mockResolvedValue(ballotRow);
    getBallotMock.mockResolvedValue(ballotRow);
  });

  test.each(["", "?public="])(
    "accepts %s as the authenticated creator view",
    async (query) => {
      const response = await app.request(`/${BALLOT_ID}${query}`);
      expect(response.status).toBe(200);
      expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith(BALLOT_ID, "org-1");
      expect(getBallotMock).not.toHaveBeenCalled();
    },
  );

  test("accepts public=1 as the unauthenticated redacted ballot", async () => {
    const response = await app.request(`/${BALLOT_ID}?public=1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      ballot: { id: string; metadata: Record<string, unknown> };
    };
    expect(body.success).toBe(true);
    expect(body.ballot.id).toBe(BALLOT_ID);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(getBallotMock).toHaveBeenCalledWith(BALLOT_ID);
    expect(getMock).not.toHaveBeenCalled();
  });

  test.each(["true", "yes", "TRUE", "0", "foo", "1e2", "1.0", "+1", " 1"])(
    "rejects public=%s before public or creator lookup",
    async (token) => {
      const response = await app.request(
        `/${BALLOT_ID}?public=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/public/i);
      expectNoLookup();
    },
  );

  test.each([
    "?public=1&public=1",
    "?public=1&public=",
    "?public=&public=1",
    "?public=foo&public=1",
  ])("rejects duplicate public values in %s before lookup", async (query) => {
    const response = await app.request(`/${BALLOT_ID}${query}`);
    expect(response.status).toBe(400);
    expectNoLookup();
  });
});
