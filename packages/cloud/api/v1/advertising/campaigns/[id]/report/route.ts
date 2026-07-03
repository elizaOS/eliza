/**
 * GET /api/v1/advertising/campaigns/[id]/report — JSON/CSV campaign performance export.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_DATE_RANGE_MS = 365 * 24 * 60 * 60 * 1000;

const ReportQuerySchema = z
  .object({
    format: z.enum(["json", "csv"]).default("json"),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  })
  .refine(
    (data) => {
      if (!data.startDate && !data.endDate) return true;
      if (data.startDate && data.endDate) {
        return new Date(data.startDate) <= new Date(data.endDate);
      }
      return false;
    },
    {
      message:
        "startDate and endDate must be provided together, with startDate <= endDate",
    },
  )
  .refine(
    (data) => {
      if (!data.startDate || !data.endDate) return true;
      return (
        new Date(data.endDate).getTime() - new Date(data.startDate).getTime() <=
        MAX_DATE_RANGE_MS
      );
    },
    { message: "Date range cannot exceed 1 year" },
  );

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const parsed = ReportQuerySchema.safeParse({
      format: c.req.query("format") ?? "json",
      startDate: c.req.query("startDate") || undefined,
      endDate: c.req.query("endDate") || undefined,
    });

    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid report parameters",
          details: parsed.error.issues.map((issue) => issue.message),
        },
        400,
      );
    }

    const dateRange =
      parsed.data.startDate && parsed.data.endDate
        ? {
            start: new Date(parsed.data.startDate),
            end: new Date(parsed.data.endDate),
          }
        : undefined;

    const report = await advertisingService.getCampaignPerformanceReport(
      id,
      user.organization_id,
      dateRange,
    );

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
