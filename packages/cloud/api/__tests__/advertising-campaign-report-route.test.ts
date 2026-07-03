import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { NotFoundError } from "@/lib/api/cloud-worker-errors";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";
const SHARE_ID = "00000000-0000-4000-8000-0000000000aa";

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

const getCampaignPerformanceReport = mock();
const formatCampaignPerformanceCsv = mock();
const createCampaignReportShare = mock();
const revokeCampaignReportShare = mock();
const getPublicCampaignPerformanceReport = mock();
mock.module("@/lib/services/advertising", () => ({
  advertisingService: {
    getCampaignPerformanceReport,
    formatCampaignPerformanceCsv,
    createCampaignReportShare,
    revokeCampaignReportShare,
    getPublicCampaignPerformanceReport,
  },
}));

const { default: reportRoute } = await import(
  "../v1/advertising/campaigns/[id]/report/route"
);
const { default: shareRoute } = await import(
  "../v1/advertising/campaigns/[id]/report/share/route"
);
const { default: shareItemRoute } = await import(
  "../v1/advertising/campaigns/[id]/report/share/[shareId]/route"
);
const { default: publicReportRoute } = await import(
  "../v1/advertising/reports/[token]/route"
);

const app = new Hono();
app.route("/api/v1/advertising/campaigns/:id/report", reportRoute);
app.route("/api/v1/advertising/campaigns/:id/report/share", shareRoute);
app.route(
  "/api/v1/advertising/campaigns/:id/report/share/:shareId",
  shareItemRoute,
);
app.route("/api/v1/advertising/reports/:token", publicReportRoute);

function makeReport() {
  return {
    generatedAt: "2026-07-03T00:00:00.000Z",
    campaign: { id: CAMPAIGN_ID, name: "Launch", budgetCurrency: "USD" },
    summary: { spend: 40, impressions: 2000, clicks: 100, conversions: 10 },
  };
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  getCampaignPerformanceReport.mockReset();
  formatCampaignPerformanceCsv.mockReset();
  createCampaignReportShare.mockReset();
  revokeCampaignReportShare.mockReset();
  getPublicCampaignPerformanceReport.mockReset();
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: USER_ID,
    organization_id: ORG_ID,
  });
  getCampaignPerformanceReport.mockResolvedValue(makeReport());
  getPublicCampaignPerformanceReport.mockResolvedValue(makeReport());
  formatCampaignPerformanceCsv.mockReturnValue(
    "campaign_id,spend\ncampaign-1,40\n",
  );
});

describe("campaign performance report routes", () => {
  test("GET returns a JSON report scoped to the authenticated org", async () => {
    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report?startDate=2026-07-01T00:00:00.000Z&endDate=2026-07-02T00:00:00.000Z`,
    );
    const body = (await res.json()) as { success: boolean; report: unknown };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(getCampaignPerformanceReport).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      ORG_ID,
      {
        start: new Date("2026-07-01T00:00:00.000Z"),
        end: new Date("2026-07-02T00:00:00.000Z"),
      },
    );
  });

  test("GET returns CSV when requested", async () => {
    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report?format=csv`,
    );
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("campaign-");
    expect(text).toBe("campaign_id,spend\ncampaign-1,40\n");
    expect(formatCampaignPerformanceCsv).toHaveBeenCalledWith(makeReport());
  });

  test("GET rejects partial date ranges before touching the service", async () => {
    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report?startDate=2026-07-01T00:00:00.000Z`,
    );

    expect(res.status).toBe(400);
    expect(getCampaignPerformanceReport).not.toHaveBeenCalled();
  });

  test("POST creates a public share token", async () => {
    createCampaignReportShare.mockResolvedValue({
      id: SHARE_ID,
      campaignId: CAMPAIGN_ID,
      token: "token-1",
      publicPath: "/api/v1/advertising/reports/token-1",
      expiresAt: "2026-07-10T00:00:00.000Z",
    });

    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report/share`,
      {
        method: "POST",
        body: JSON.stringify({ expiresInHours: 48 }),
        headers: { "content-type": "application/json" },
      },
    );
    const body = (await res.json()) as { share: { publicUrl: string } };

    expect(res.status).toBe(201);
    expect(body.share.publicUrl).toContain(
      "/api/v1/advertising/reports/token-1",
    );
    expect(createCampaignReportShare).toHaveBeenCalledWith({
      campaignId: CAMPAIGN_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      expiresAt: expect.any(Date),
    });
  });

  test("DELETE revokes a share token", async () => {
    revokeCampaignReportShare.mockResolvedValue({
      id: SHARE_ID,
      status: "revoked",
      revokedAt: "2026-07-03T00:00:00.000Z",
    });

    const res = await app.request(
      `/api/v1/advertising/campaigns/${CAMPAIGN_ID}/report/share/${SHARE_ID}`,
      { method: "DELETE" },
    );
    const body = (await res.json()) as { share: { status: string } };

    expect(res.status).toBe(200);
    expect(body.share.status).toBe("revoked");
    expect(revokeCampaignReportShare).toHaveBeenCalledWith(SHARE_ID, ORG_ID);
  });

  test("public report token returns JSON without session auth", async () => {
    const res = await app.request("/api/v1/advertising/reports/token-1");
    const body = (await res.json()) as { success: boolean };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(getPublicCampaignPerformanceReport).toHaveBeenCalledWith("token-1");
  });

  test("public report token returns 404 when missing or expired", async () => {
    getPublicCampaignPerformanceReport.mockRejectedValue(
      NotFoundError("Report share not found or expired"),
    );

    const res = await app.request("/api/v1/advertising/reports/expired-token");
    const body = (await res.json()) as { success: boolean; code: string };

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.code).toBe("resource_not_found");
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  });
});
