import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { advertisingService } from "@/lib/services/advertising";
import { z } from "zod";

export const dynamic = "force-dynamic";

const MAX_DATE_RANGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

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
        const range =
          new Date(data.endDate).getTime() - new Date(data.startDate).getTime();
        return range <= MAX_DATE_RANGE_MS;
      }
      return true;
    },
    { message: "Date range cannot exceed 1 year" },
  );

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/v1/advertising/campaigns/[id]/analytics
 * Gets campaign analytics/metrics.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const searchParams = request.nextUrl.searchParams;
  const startDate = searchParams.get("startDate") || undefined;
  const endDate = searchParams.get("endDate") || undefined;

  const dateValidation = DateRangeSchema.safeParse({ startDate, endDate });
  if (!dateValidation.success) {
    return NextResponse.json(
      {
        error: "Invalid date parameters",
        details: dateValidation.error.issues.map((e) => e.message),
      },
      { status: 400 },
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
    user.organization_id!,
    dateRange,
  );

  return NextResponse.json({
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
      ? {
          start: dateRange.start.toISOString(),
          end: dateRange.end.toISOString(),
        }
      : null,
  });
}
