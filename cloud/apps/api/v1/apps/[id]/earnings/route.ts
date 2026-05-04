import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appEarningsService } from "@/lib/services/app-earnings";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

// Generate realistic test data for verifying the earnings dashboard UI
function generateTestData(days: number) {
  const now = new Date();

  // Generate chart data with realistic variance over the period
  const chartData: Array<{
    date: string;
    inferenceEarnings: number;
    purchaseEarnings: number;
    total: number;
  }> = [];

  let totalInference = 0;
  let totalPurchase = 0;
  let todayInference = 0;
  let todayPurchase = 0;
  let weekInference = 0;
  let weekPurchase = 0;
  let monthInference = 0;
  let monthPurchase = 0;

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];

    // Generate varied daily earnings with some randomness
    // More recent days tend to have higher earnings (simulating growth)
    const dayFactor = (days - i) / days;
    const randomFactor = 0.5 + Math.random();

    const inferenceEarnings = parseFloat(
      (dayFactor * randomFactor * 2.5 + Math.random() * 0.5).toFixed(4),
    );
    const purchaseEarnings = parseFloat(
      (dayFactor * randomFactor * 1.2 + Math.random() * 0.3).toFixed(4),
    );

    chartData.push({
      date: dateStr,
      inferenceEarnings,
      purchaseEarnings,
      total: parseFloat((inferenceEarnings + purchaseEarnings).toFixed(4)),
    });

    totalInference += inferenceEarnings;
    totalPurchase += purchaseEarnings;

    // Track period totals
    if (i === 0) {
      todayInference = inferenceEarnings;
      todayPurchase = purchaseEarnings;
    }
    if (i < 7) {
      weekInference += inferenceEarnings;
      weekPurchase += purchaseEarnings;
    }
    if (i < 30) {
      monthInference += inferenceEarnings;
      monthPurchase += purchaseEarnings;
    }
  }

  const totalLifetime = totalInference + totalPurchase;
  const pendingBalance = parseFloat((totalLifetime * 0.15).toFixed(2));
  const totalWithdrawn = parseFloat((totalLifetime * 0.3).toFixed(2));
  const withdrawableBalance = parseFloat(
    (totalLifetime - pendingBalance - totalWithdrawn).toFixed(2),
  );

  const summary = {
    totalLifetimeEarnings: parseFloat(totalLifetime.toFixed(2)),
    totalInferenceEarnings: parseFloat(totalInference.toFixed(2)),
    totalPurchaseEarnings: parseFloat(totalPurchase.toFixed(2)),
    pendingBalance,
    withdrawableBalance,
    totalWithdrawn,
    payoutThreshold: 25.0,
  };

  const breakdown = {
    today: {
      period: "day",
      inferenceEarnings: parseFloat(todayInference.toFixed(2)),
      purchaseEarnings: parseFloat(todayPurchase.toFixed(2)),
      total: parseFloat((todayInference + todayPurchase).toFixed(2)),
    },
    thisWeek: {
      period: "week",
      inferenceEarnings: parseFloat(weekInference.toFixed(2)),
      purchaseEarnings: parseFloat(weekPurchase.toFixed(2)),
      total: parseFloat((weekInference + weekPurchase).toFixed(2)),
    },
    thisMonth: {
      period: "month",
      inferenceEarnings: parseFloat(monthInference.toFixed(2)),
      purchaseEarnings: parseFloat(monthPurchase.toFixed(2)),
      total: parseFloat((monthInference + monthPurchase).toFixed(2)),
    },
    allTime: {
      period: "all_time",
      inferenceEarnings: parseFloat(totalInference.toFixed(2)),
      purchaseEarnings: parseFloat(totalPurchase.toFixed(2)),
      total: parseFloat(totalLifetime.toFixed(2)),
    },
  };

  // Generate realistic recent transactions
  const recentTransactions = [];

  for (let i = 0; i < 10; i++) {
    const txDate = new Date(now);
    txDate.setHours(txDate.getHours() - i * 3 - Math.floor(Math.random() * 3));

    // Weight towards inference_markup (most common)
    const typeRoll = Math.random();
    const type =
      typeRoll < 0.6 ? "inference_markup" : typeRoll < 0.9 ? "purchase_share" : "withdrawal";

    let amount: number;
    let description: string;

    if (type === "inference_markup") {
      amount = parseFloat((0.001 + Math.random() * 0.05).toFixed(4));
      description = `Inference markup from API call`;
    } else if (type === "purchase_share") {
      amount = parseFloat((0.5 + Math.random() * 2).toFixed(4));
      description = `Credit purchase share (${Math.floor(Math.random() * 100 + 10)} credits)`;
    } else {
      amount = parseFloat((-5 - Math.random() * 20).toFixed(4));
      description = `Withdrawal to wallet`;
    }

    recentTransactions.push({
      id: `test-tx-${i}-${Date.now()}`,
      type,
      amount: amount.toString(),
      description,
      created_at: txDate.toISOString(),
      metadata: { test_data: true },
    });
  }

  return {
    summary,
    breakdown,
    chartData,
    recentTransactions,
  };
}

/**
 * GET /api/v1/apps/[id]/earnings
 * Gets earnings data for a specific app including summary, breakdown, chart data, and transaction history.
 * Supports test data generation for UI verification via `testData=true` query parameter.
 * Requires ownership verification.
 *
 * Query Parameters:
 * - `days`: Number of days for chart data (1-90, default: 30).
 * - `testData`: If "true", returns generated test data for UI verification.
 *
 * @param request - Request with optional days and testData query parameters.
 * @param params - Route parameters containing the app ID.
 * @returns Earnings summary, breakdown by period, chart data, recent transactions, and monetization settings.
 */
async function __hono_GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const daysParam = new URL(request.url).searchParams.get("days");
    const days = daysParam ? Math.min(Math.max(parseInt(daysParam, 10), 1), 90) : 30;

    // Check for testData flag - ONLY allowed in development mode
    // Double-check with ENVIRONMENT to prevent misconfigured deployments
    const testDataParam = new URL(request.url).searchParams.get("testData");
    const isDevelopment =
      process.env.NODE_ENV === "development" && process.env.ENVIRONMENT !== "production";
    const useTestData = isDevelopment && testDataParam === "true";

    const app = await appsService.getById(id);

    if (!app) {
      return Response.json({ success: false, error: "App not found" }, { status: 404 });
    }

    if (app.organization_id !== user.organization_id) {
      return Response.json({ success: false, error: "Access denied" }, { status: 403 });
    }

    // Return test data if requested (for UI verification)
    if (useTestData) {
      const testData = generateTestData(days);

      return Response.json({
        success: true,
        testData: true, // Flag to indicate this is test data
        earnings: testData,
        monetization: {
          enabled: true,
          inferenceMarkupPercentage: 15,
          purchaseSharePercentage: 10,
          platformOffsetAmount: 0,
          totalCreatorEarnings: testData.summary.totalLifetimeEarnings,
          totalPlatformRevenue: testData.summary.totalLifetimeEarnings * 0.85,
        },
      });
    }

    const summary = await appEarningsService.getEarningsSummary(id);
    const breakdown = await appEarningsService.getEarningsBreakdown(id);
    const recentTransactions = await appEarningsService.getTransactionHistory(id, { limit: 10 });
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
        error: error instanceof Error ? error.message : "Failed to get app earnings",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
