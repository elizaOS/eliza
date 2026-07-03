/**
 * GET /api/v1/advertising/campaigns/[id]/public-report — token-scoped public campaign report.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { advertisingService } from "@/lib/services/advertising";
import type { AppEnv } from "@/types/cloud-worker-env";

const PublicReportQuerySchema = z.object({
  token: z.string().min(1),
  format: z.enum(["json", "csv"]).default("json"),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const id = c.req.param("id")!;
    const parsed = PublicReportQuerySchema.safeParse({
      token: c.req.query("token"),
      format: c.req.query("format") ?? "json",
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid report parameters", details: parsed.error.flatten() },
        400,
      );
    }

    const claims = await advertisingService.verifyCampaignReportToken(
      parsed.data.token,
    );
    if (claims.campaignId !== id) {
      return c.json({ error: "Invalid campaign report token" }, 403);
    }

    const report = await advertisingService.generateCampaignReport(
      claims.campaignId,
      claims.organizationId,
    );

    if (parsed.data.format === "csv") {
      const csv = advertisingService.formatCampaignReportCsv(report);
      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="campaign-${id}-performance-report.csv"`,
        },
      });
    }

    return c.json({
      report,
      token: { tokenId: claims.tokenId, expiresAt: claims.expiresAt },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
