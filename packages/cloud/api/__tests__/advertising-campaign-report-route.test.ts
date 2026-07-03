import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ValidationError } from "@/lib/api/cloud-worker-errors";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const ORG_ID = "00000000-0000-4000-8000-000000000010";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000011";

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

const generateCampaignReport = mock();
const formatCampaignReportCsv = mock();
const mintCampaignReportToken = mock();
const verifyCampaignReportToken = mock();
const revokeCampaignReportToken = mock();
mock.module("@/lib/services/advertising", () => ({
  advertisingService: {
    generateCampaignReport,
    formatCampaignReportCsv,
    mintCampaignReportToken,
    verifyCampaignReportToken,
    revokeCampaignReportToken,
  },
}));

const { default: reportRoute } = await import(
  "../v1/advertising/campaigns/[id]/report/route"
);
const { default: publicReportRoute } = await import(
  "../v1/advertising/campaigns/[id]/public-report/route"
);
const { default: revokeRoute } = await import(
  "../v1/advertising/campaigns/[id]/report/tokens/revoke/route"
);

const app = new Hono();
app.route("/api/v1/advertising/campaigns/:id/report", reportRoute);
app.route(
  "/api/v1/advertising/campaigns/:id/report/tokens/revoke",
  revokeRoute,
);
app.route("/api/v1/advertising/campaigns/:id/public-report", publicReportRoute);

const report = {
  campaign: {
    id: CAMPAIGN_ID,
    name: "Summer Launch",
    platform: "meta",
    providerCampaignId: "meta-123",
    adAccountId: "account-1",
    appId: null,
    objective: "traffic",
    status: "active",
  },
  dateRange: {
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-02T00:00:00.000Z",
  },
  spend: {
    amount: 12.34,
    currency: "USD",
    credits: 13.57,
    source: "transactions",
  },
  metrics: {
    spend: 12.34,
    impressions: 1000,
    clicks: 50,
    conversions: 5,
    providerConversions: 4,
    firstPartyConversions: 1,
    ctr: 0.05,
    cpc: 0.2468,
    cpm: 12.34,
    roas: 0,
    conversionRate: 0.1,
    conversionValue: 25,
  },
  budget: {
    type: "daily",
    amount: 100,
    currency: "USD",
    creditsAllocated: 110,
    creditsSpent: 13.57,
  },
  attribution: {
    conversions: 5,
    providerConversions: 4,
    firstPartyConversions: 1,
    conversionValue: 25,
    source: "first_party_attribution",
  },
  generatedAt: "2026-07-03T00:00:00.000Z",
};

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  generateCampaignReport.mockReset();
  formatCampaignReportCsv.mockReset();
  mintCampaignReportToken.mockReset();
  verifyCampaignReportToken.mockReset();
  revokeCampaignReportToken.mockReset();

  requireUserOrApiKeyWithOrg.mockResolvedValue({ organization_id: ORG_ID });
  generateCampaignReport.mockResolvedValue(report);
  formatCampaignReportCsv.mockReturnValue(
    "field,value\ncampaign_id,00000000-0000-4000-8000-000000000011\n",
  );
  mintCampaignReportToken.mockResolvedValue({
    token: "v1.token",
    tokenId: "token-1",
    expiresAt: "2026-07-10T00:00:00.000Z",
  });
  verifyCampaignReportToken.mockResolvedValue({
    campaignId: CAMPAIGN_ID,
    organizationId: ORG_ID,
    tokenId: "token-1",
    expiresAt: "2026-07-10T00:00:00.000Z",
  });
});

describe("campaign performance report routes", () => {
  test("exports JSON with server-computed report fields and date filters", async () => {
    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report?startDate=2026-07-01T00:00:00.000Z&endDate=2026-07-02T00:00:00.000Z`,
    );
    const body = (await res.json()) as { report: typeof report };

    expect(res.status).toBe(200);
    expect(body.report.metrics.ctr).toBe(0.05);
    expect(body.report.spend.source).toBe("transactions");
    expect(generateCampaignReport).toHaveBeenCalledWith(CAMPAIGN_ID, ORG_ID, {
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-07-02T00:00:00.000Z"),
    });
  });

  test("exports CSV with attachment headers", async () => {
    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report?format=csv`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(
      `campaign-${CAMPAIGN_ID}-performance-report.csv`,
    );
    expect(await res.text()).toContain("campaign_id");
    expect(formatCampaignReportCsv).toHaveBeenCalledWith(report);
  });

  test("denies cross-org campaign reports through the org-scoped service", async () => {
    generateCampaignReport.mockRejectedValueOnce(
      new Error("Campaign not found"),
    );

    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report`,
    );
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(404);
    expect(body.error).toBe("Campaign not found");
    expect(generateCampaignReport).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      ORG_ID,
      undefined,
    );
  });

  test("empty campaigns export zero metrics instead of client-computed defaults", async () => {
    generateCampaignReport.mockResolvedValueOnce({
      ...report,
      spend: {
        amount: 0,
        currency: "USD",
        credits: 0,
        source: "campaign_metrics",
      },
      metrics: {
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        ctr: 0,
        cpc: 0,
        cpm: 0,
        roas: 0,
        conversionRate: 0,
      },
    });

    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report`,
    );
    const body = (await res.json()) as { report: typeof report };

    expect(res.status).toBe(200);
    expect(body.report.metrics).toMatchObject({
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      ctr: 0,
      cpc: 0,
      cpm: 0,
      conversionRate: 0,
    });
  });

  test("mints and revokes a public report token", async () => {
    const mint = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report`,
      {
        method: "POST",
        body: JSON.stringify({ expiresInSeconds: 3600 }),
        headers: { "content-type": "application/json" },
      },
    );
    const mintBody = (await mint.json()) as {
      tokenId: string;
      publicReportUrl: string;
    };

    expect(mint.status).toBe(200);
    expect(mintBody.tokenId).toBe("token-1");
    expect(mintBody.publicReportUrl).toContain("/public-report?token=");
    expect(mintCampaignReportToken).toHaveBeenCalledWith(CAMPAIGN_ID, ORG_ID, {
      ttlSeconds: 3600,
    });

    const revoke = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report/tokens/revoke`,
      {
        method: "POST",
        body: JSON.stringify({ tokenId: "token-1" }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(revoke.status).toBe(200);
    expect(revokeCampaignReportToken).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      ORG_ID,
      "token-1",
    );
  });

  test("public report token exports without session auth", async () => {
    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/public-report?token=v1.token`,
    );
    const body = (await res.json()) as {
      report: typeof report;
      token: { tokenId: string };
    };

    expect(res.status).toBe(200);
    expect(body.report.campaign.id).toBe(CAMPAIGN_ID);
    expect(body.token.tokenId).toBe("token-1");
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(generateCampaignReport).toHaveBeenCalledWith(CAMPAIGN_ID, ORG_ID);
  });

  test("public report rejects expired tokens before exporting", async () => {
    verifyCampaignReportToken.mockRejectedValueOnce(
      ValidationError("Campaign report token has expired"),
    );

    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/public-report?token=expired`,
    );

    expect(res.status).toBe(400);
    expect(generateCampaignReport).not.toHaveBeenCalled();
  });

  test("public report rejects revoked tokens before exporting", async () => {
    verifyCampaignReportToken.mockRejectedValueOnce(
      ValidationError("Campaign report token has been revoked"),
    );

    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/public-report?token=revoked`,
    );

    expect(res.status).toBe(400);
    expect(generateCampaignReport).not.toHaveBeenCalled();
  });
});
