import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const ORG_ID = "org-1";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

const getCampaignDayparting = mock();
const updateCampaignDayparting = mock();
const duplicateCampaign = mock();
mock.module("@/lib/services/advertising", () => ({
  advertisingService: {
    getCampaignDayparting,
    updateCampaignDayparting,
    duplicateCampaign,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const { default: daypartingRoute } = await import(
  "../v1/advertising/campaigns/[id]/dayparting/route"
);
const { default: duplicateRoute } = await import(
  "../v1/advertising/campaigns/[id]/duplicate/route"
);

const app = new Hono();
app.route("/api/v1/advertising/campaigns/:id/dayparting", daypartingRoute);
app.route("/api/v1/advertising/campaigns/:id/duplicate", duplicateRoute);

const schedule = {
  timezone: "America/Los_Angeles",
  windows: [
    { daysOfWeek: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" },
  ],
};

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  getCampaignDayparting.mockReset();
  updateCampaignDayparting.mockReset();
  duplicateCampaign.mockReset();
  requireUserOrApiKeyWithOrg.mockResolvedValue({ organization_id: ORG_ID });
});

describe("campaign dayparting routes", () => {
  test("GET returns the persisted dayparting schedule", async () => {
    getCampaignDayparting.mockResolvedValue(schedule);

    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/dayparting`,
    );
    const body = (await res.json()) as {
      success: boolean;
      campaignId: string;
      dayparting: unknown;
    };

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      campaignId: CAMPAIGN_ID,
      dayparting: schedule,
    });
    expect(getCampaignDayparting).toHaveBeenCalledWith(CAMPAIGN_ID, ORG_ID);
  });

  test("PUT rejects invalid timezone before touching the service", async () => {
    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/dayparting`,
      {
        method: "PUT",
        body: JSON.stringify({
          dayparting: {
            timezone: "Mars/Base",
            windows: [
              { daysOfWeek: [1], startTime: "09:00", endTime: "17:00" },
            ],
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(res.status).toBe(400);
    expect(updateCampaignDayparting).not.toHaveBeenCalled();
  });

  test("PUT rejects inverted local windows before touching the service", async () => {
    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/dayparting`,
      {
        method: "PUT",
        body: JSON.stringify({
          dayparting: {
            timezone: "America/Los_Angeles",
            windows: [
              { daysOfWeek: [1], startTime: "18:00", endTime: "09:00" },
            ],
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(res.status).toBe(400);
    expect(updateCampaignDayparting).not.toHaveBeenCalled();
  });

  test("PUT updates dayparting with the authenticated organization", async () => {
    updateCampaignDayparting.mockResolvedValue({
      id: CAMPAIGN_ID,
      status: "draft",
      metadata: { dayparting: schedule },
      updated_at: new Date("2026-07-02T00:00:00.000Z"),
    });

    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/dayparting`,
      {
        method: "PUT",
        body: JSON.stringify({ dayparting: schedule }),
        headers: { "content-type": "application/json" },
      },
    );
    const body = (await res.json()) as { dayparting: unknown };

    expect(res.status).toBe(200);
    expect(body.dayparting).toEqual(schedule);
    expect(updateCampaignDayparting).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      ORG_ID,
      schedule,
    );
  });
});

describe("campaign duplicate route", () => {
  test("POST duplicates a campaign through the org-scoped service", async () => {
    duplicateCampaign.mockResolvedValue({
      campaign: {
        id: "copy-1",
        name: "Launch Copy",
        platform: "meta",
        objective: "traffic",
        status: "draft",
        budget_type: "daily",
        budget_amount: "100.00",
        budget_currency: "USD",
        credits_allocated: "0.00",
        external_campaign_id: null,
        metadata: { dayparting: schedule, source_campaign_id: CAMPAIGN_ID },
        created_at: new Date("2026-07-02T00:00:00.000Z"),
      },
      creativesCopied: 2,
    });

    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/duplicate`,
      {
        method: "POST",
        body: JSON.stringify({ name: "Launch Copy" }),
        headers: { "content-type": "application/json" },
      },
    );
    const body = (await res.json()) as {
      creativesCopied: number;
      campaign: { status: string };
    };

    expect(res.status).toBe(201);
    expect(body.creativesCopied).toBe(2);
    expect(body.campaign.status).toBe("draft");
    expect(duplicateCampaign).toHaveBeenCalledWith(CAMPAIGN_ID, ORG_ID, {
      name: "Launch Copy",
    });
  });

  test("POST rejects invalid copy names before touching the service", async () => {
    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/duplicate`,
      {
        method: "POST",
        body: JSON.stringify({ name: "" }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(res.status).toBe(400);
    expect(duplicateCampaign).not.toHaveBeenCalled();
  });
});
