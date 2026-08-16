/**
 * Serves authenticated app-earnings summaries and chart data.
 * It validates the requested chart window before any app or earnings lookup.
 */
import { parsePositiveInteger } from "@elizaos/shared/utils/number-parsing";
import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { appEarningsService } from "@/lib/services/app-earnings";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

/**
 * GET /api/v1/apps/[id]/earnings
 * Gets earnings data for a specific app including summary, breakdown, chart data, and transaction history.
 * Requires ownership verification.
 *
 * Query Parameters:
 * - `days`: Number of days for chart data (1-90, default: 30).
 *
 * @param request - Request with optional days query parameter.
 * @param params - Route parameters containing the app ID.
 * @returns Earnings summary, breakdown by period, chart data, recent transactions, and monetization settings.
 */
async function __hono_GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const rawDays = new URL(request.url).searchParams.get("days");
    const parsedDays = parsePositiveInteger(rawDays);
    if (
      rawDays !== null &&
      rawDays !== "" &&
      (parsedDays === undefined ||
        rawDays !== String(parsedDays) ||
        parsedDays > MAX_DAYS)
    ) {
      return Response.json(
        { success: false, error: "Invalid days" },
        { status: 400 },
      );
    }
    const days = parsedDays ?? DEFAULT_DAYS;

    const app = await appsService.getById(id);

    if (!app) {
      return Response.json(
        { success: false, error: "App not found" },
        { status: 404 },
      );
    }

    if (app.organization_id !== user.organization_id) {
      return Response.json(
        { success: false, error: "Access denied" },
        { status: 403 },
      );
    }
    if (await isAppKeyOutOfScope(apiKey?.id, id)) {
      return Response.json(
        { success: false, error: "Access denied" },
        { status: 403 },
      );
    }

    const summary = await appEarningsService.getEarningsSummary(id);
    const breakdown = await appEarningsService.getEarningsBreakdown(id);
    const recentTransactions = await appEarningsService.getTransactionHistory(
      id,
      { limit: 10 },
    );
    const chartData = await appEarningsService.getDailyEarningsChart(id, days);

    return Response.json({
      success: true,
      earnings: { summary, breakdown, recentTransactions, chartData },
      monetization: {
        enabled: app.monetization_enabled,
        inferenceMarkupPercentage: Number(app.inference_markup_percentage),
        purchaseSharePercentage: Number(app.purchase_share_percentage),
        platformOffsetAmount: Number(app.platform_offset_amount),
        totalCreatorEarnings: Number(app.total_creator_earnings),
        totalPlatformRevenue: Number(app.total_platform_revenue),
      },
    });
  } catch (error) {
    // error-policy:J1 route boundary translates failures into structured HTTP errors.
    logger.error("Failed to get app earnings:", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get app earnings",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
export default __hono_app;
