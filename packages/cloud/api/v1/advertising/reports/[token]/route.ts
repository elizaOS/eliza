/**
 * GET /api/v1/advertising/reports/[token] — public campaign report by share token.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { advertisingService } from "@/lib/services/advertising";
import type { AppEnv } from "@/types/cloud-worker-env";

const PublicReportQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const token = c.req.param("token")!;
    const parsed = PublicReportQuerySchema.safeParse({
      format: c.req.query("format") ?? "json",
    });

    if (!parsed.success) {
      return c.json(
        { error: "Invalid report parameters", details: parsed.error.flatten() },
        400,
      );
    }

    const report =
      await advertisingService.getPublicCampaignPerformanceReport(token);

    if (parsed.data.format === "csv") {
      return new Response(
        advertisingService.formatCampaignPerformanceCsv(report),
        {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="campaign-${report.campaign.id}-report.csv"`,
          },
        },
      );
    }

    return c.json({ success: true, report });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
