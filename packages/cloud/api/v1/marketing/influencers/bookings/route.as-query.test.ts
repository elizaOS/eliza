/**
 * GET /api/v1/marketing/influencers/bookings `as` is marketplace party
 * identity, not leftover X connectionRole or catalog-sort tax. Stock develop
 * treated every non-"influencer" token as the advertiser org list, so
 * `as=INFLUENCER` / `as=advertiser` silently showed the wrong party's bookings.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const listBookingsForOrg = mock(async (_organizationId: string) => [
  { id: "org-booking" },
]);
const listBookingsForInfluencer = mock(async (_userId: string) => [
  { id: "influencer-booking" },
]);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/services/influencer-marketplace", () => ({
  influencerMarketplaceService: {
    listBookingsForOrg,
    listBookingsForInfluencer,
  },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ success: false, error: "internal_error" }, 500),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined },
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/marketing/influencers/bookings", route);

function listBookings(query = "") {
  return app.request(`/api/v1/marketing/influencers/bookings${query}`);
}

function expectNoList() {
  expect(listBookingsForOrg).not.toHaveBeenCalled();
  expect(listBookingsForInfluencer).not.toHaveBeenCalled();
}

describe("GET /api/v1/marketing/influencers/bookings party identity", () => {
  beforeEach(() => {
    listBookingsForOrg.mockClear();
    listBookingsForInfluencer.mockClear();
  });

  test.each([
    ["", "org"],
    ["?as=", "org"],
    ["?as=advertiser", "org"],
    ["?as=influencer", "influencer"],
  ])("accepts %s as %s bookings", async (query, party) => {
    const response = await listBookings(query);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      bookings: Array<{ id: string }>;
    };
    expect(body.success).toBe(true);
    if (party === "influencer") {
      expect(listBookingsForInfluencer).toHaveBeenCalledTimes(1);
      expect(listBookingsForInfluencer).toHaveBeenCalledWith("user-1");
      expect(listBookingsForOrg).not.toHaveBeenCalled();
      expect(body.bookings).toEqual([{ id: "influencer-booking" }]);
    } else {
      expect(listBookingsForOrg).toHaveBeenCalledTimes(1);
      expect(listBookingsForOrg).toHaveBeenCalledWith("org-1");
      expect(listBookingsForInfluencer).not.toHaveBeenCalled();
      expect(body.bookings).toEqual([{ id: "org-booking" }]);
    }
  });

  test.each(["INFLUENCER", "Advertiser", "foo", "1e2", "influencer "])(
    "rejects as=%s before either booking list",
    async (token) => {
      const response = await listBookings(`?as=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/as/i);
      expectNoList();
    },
  );
});
