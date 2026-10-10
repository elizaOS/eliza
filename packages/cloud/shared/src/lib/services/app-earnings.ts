/**
 * Service for managing app earnings and revenue tracking.
 */

import { ElizaError } from "@elizaos/core";
import {
  type AppEarningsTransaction,
  appEarningsRepository,
} from "../../db/repositories/app-earnings";
import { parseEarningsNumber } from "../../db/repositories/app-earnings-numeric";
import { logger } from "../utils/logger";

/**
 * Summary of app earnings.
 */
export interface EarningsSummary {
  totalLifetimeEarnings: number;
  totalInferenceEarnings: number;
  totalPurchaseEarnings: number;
  pendingBalance: number;
  withdrawableBalance: number;
  totalWithdrawn: number;
  payoutThreshold: number;
}

/**
 * Earnings breakdown by period.
 */
export interface EarningsBreakdown {
  period: "day" | "week" | "month" | "all_time";
  inferenceEarnings: number;
  purchaseEarnings: number;
  total: number;
}

/**
 * Service for tracking and querying app earnings and revenue.
 */
export class AppEarningsService {
  async getEarningsSummary(appId: string): Promise<EarningsSummary | null> {
    const earnings = await appEarningsRepository.findByAppId(appId);

    if (!earnings) {
      return null;
    }

    return {
      totalLifetimeEarnings: parseEarningsNumber(
        earnings.total_lifetime_earnings,
        "total_lifetime_earnings",
      ),
      totalInferenceEarnings: parseEarningsNumber(
        earnings.total_inference_earnings,
        "total_inference_earnings",
      ),
      totalPurchaseEarnings: parseEarningsNumber(
        earnings.total_purchase_earnings,
        "total_purchase_earnings",
      ),
      pendingBalance: parseEarningsNumber(earnings.pending_balance, "pending_balance"),
      withdrawableBalance: parseEarningsNumber(
        earnings.withdrawable_balance,
        "withdrawable_balance",
      ),
      totalWithdrawn: parseEarningsNumber(earnings.total_withdrawn, "total_withdrawn"),
      payoutThreshold: parseEarningsNumber(earnings.payout_threshold, "payout_threshold"),
    };
  }

  async getEarningsBreakdown(appId: string): Promise<{
    today: EarningsBreakdown;
    thisWeek: EarningsBreakdown;
    thisMonth: EarningsBreakdown;
    allTime: EarningsBreakdown;
  }> {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const allTimeStart = new Date(2020, 0, 1); // Far past date

    const todayTotals = await appEarningsRepository.getTransactionTotalsByType(
      appId,
      startOfDay,
      now,
    );
    const weekTotals = await appEarningsRepository.getTransactionTotalsByType(
      appId,
      startOfWeek,
      now,
    );
    const monthTotals = await appEarningsRepository.getTransactionTotalsByType(
      appId,
      startOfMonth,
      now,
    );
    const allTimeTotals = await appEarningsRepository.getTransactionTotalsByType(
      appId,
      allTimeStart,
      now,
    );

    return {
      today: {
        period: "day",
        inferenceEarnings: todayTotals.inference_markup,
        purchaseEarnings: todayTotals.purchase_share,
        total: todayTotals.inference_markup + todayTotals.purchase_share,
      },
      thisWeek: {
        period: "week",
        inferenceEarnings: weekTotals.inference_markup,
        purchaseEarnings: weekTotals.purchase_share,
        total: weekTotals.inference_markup + weekTotals.purchase_share,
      },
      thisMonth: {
        period: "month",
        inferenceEarnings: monthTotals.inference_markup,
        purchaseEarnings: monthTotals.purchase_share,
        total: monthTotals.inference_markup + monthTotals.purchase_share,
      },
      allTime: {
        period: "all_time",
        inferenceEarnings: allTimeTotals.inference_markup,
        purchaseEarnings: allTimeTotals.purchase_share,
        total: allTimeTotals.inference_markup + allTimeTotals.purchase_share,
      },
    };
  }

  async getDailyEarningsChart(
    appId: string,
    days: number = 30,
  ): Promise<
    Array<{
      date: string;
      inferenceEarnings: number;
      purchaseEarnings: number;
      total: number;
    }>
  > {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const data = await appEarningsRepository.getDailyEarnings(appId, startDate, endDate);

    return data.map((d) => ({
      date: d.date,
      inferenceEarnings: d.inference_earnings,
      purchaseEarnings: d.purchase_earnings,
      total: d.total,
    }));
  }

  async getTransactionHistory(
    appId: string,
    options?: {
      limit?: number;
      offset?: number;
      type?: "inference_markup" | "purchase_share" | "withdrawal" | "adjustment";
    },
  ): Promise<AppEarningsTransaction[]> {
    // An omitted or non-finite limit is the default page of 50. An explicit
    // finite limit, including 0, is a page — `limit || 50` treated 0 as missing,
    // and `Math.max(0, NaN)` is `NaN`.
    const rawLimit = options?.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.max(0, rawLimit) : 50;
    if (options?.type) {
      return await appEarningsRepository.listTransactionsByType(appId, options.type, limit);
    }

    return await appEarningsRepository.listTransactions(appId, limit, options?.offset || 0);
  }

  async updatePayoutThreshold(appId: string, threshold: number): Promise<void> {
    // NaN and Infinity bypass a comparison-only guard and PostgreSQL NUMERIC
    // accepts both, so validate finiteness before writing the threshold.
    if (!Number.isFinite(threshold) || threshold < 1) {
      throw new ElizaError("Payout threshold must be a finite amount of at least $1.00", {
        code: "APP_EARNINGS_PAYOUT_THRESHOLD_INVALID",
        context: { appId, threshold },
      });
    }

    await appEarningsRepository.updatePayoutThreshold(appId, threshold);

    logger.info("[AppEarnings] Updated payout threshold", { appId, threshold });
  }
}

// Export singleton instance
export const appEarningsService = new AppEarningsService();
