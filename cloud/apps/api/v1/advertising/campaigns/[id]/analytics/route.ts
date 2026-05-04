/**
 * GET /api/v1/advertising/campaigns/[id]/analytics — campaign analytics/metrics.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_DATE_RANGE_MS = 365 * 24 * 60 * 60 * 1000;

const DateRangeSchema = z
  .object({
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return new Date(data.startDate) <= new Date(data.endDate);
      }
      return true;
    },
    { message: "startDate must be before or equal to endDate" },
  )
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        const range = new Date(data.endDate).getTime() - new Date(data.startDate).getTime();
        return range <= MAX_DATE_RANGE_MS;
      }
      return true;
    },
    { message: "Date range cannot exceed 1 year" },
  );

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    const startDate = c.req.query("startDate") || undefined;
    const endDate = c.req.query("endDate") || undefined;

    const dateValidation = DateRangeSchema.safeParse({ startDate, endDate });
    if (!dateValidation.success) {
      return c.json(
        {
          error: "Invalid date parameters",
          details: dateValidation.error.issues.map((e) => e.message),
        },
        400,
      );
    }

    const dateRange =
      dateValidation.data.startDate && dateValidation.data.endDate
        ? {
            start: new Date(dateValidation.data.startDate),
            end: new Date(dateValidation.data.endDate),
          }
        : undefined;

    const metrics = await advertisingService.getCampaignMetrics(
      id,
      user.organization_id,
      dateRange,
    );

    return c.json({
      campaignId: id,
      metrics: {
        spend: metrics.spend,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        conversions: metrics.conversions,
        ctr: metrics.ctr,
        cpc: metrics.cpc,
        cpm: metrics.cpm,
        roas: metrics.roas,
      },
      dateRange: dateRange
        ? { start: dateRange.start.toISOString(), end: dateRange.end.toISOString() }
        : null,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
