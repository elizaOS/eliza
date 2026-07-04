// Handles v1 cloud API v1 apps id earnings route traffic with route-local auth expectations.
import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { appEarningsService } from "@/lib/services/app-earnings";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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

    const daysParam = new URL(request.url).searchParams.get("days");
    const days = daysParam
      ? Math.min(Math.max(parseInt(daysParam, 10), 1), 90)
      : 30;

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
