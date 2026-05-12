/**
 * Service for managing app earnings and revenue tracking.
 */

import { type AppEarningsTransaction, appEarningsRepository } from "@/db/repositories/app-earnings";
import { appsRepository } from "@/db/repositories/apps";
import { logger } from "@/lib/utils/logger";

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
      totalLifetimeEarnings: Number(earnings.total_lifetime_earnings),
      totalInferenceEarnings: Number(earnings.total_inference_earnings),
      totalPurchaseEarnings: Number(earnings.total_purchase_earnings),
      pendingBalance: Number(earnings.pending_balance),
      withdrawableBalance: Number(earnings.withdrawable_balance),
      totalWithdrawn: Number(earnings.total_withdrawn),
      payoutThreshold: Number(earnings.payout_threshold),
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
    if (options?.type) {
      return await appEarningsRepository.listTransactionsByType(
        appId,
        options.type,
        options?.limit || 50,
      );
    }

    return await appEarningsRepository.listTransactions(
      appId,
      options?.limit || 50,
      options?.offset || 0,
    );
  }

  async updatePayoutThreshold(appId: string, threshold: number): Promise<void> {
    if (threshold < 1) {
      throw new Error("Payout threshold must be at least $1.00");
    }

    await appEarningsRepository.updatePayoutThreshold(appId, threshold);

    logger.info("[AppEarnings] Updated payout threshold", { appId, threshold });
  }

  async releasePendingEarnings(appId: string): Promise<void> {
    await appEarningsRepository.releasePendingToWithdrawable(appId);

    logger.info("[AppEarnings] Released pending earnings", { appId });
  }

  /**
   * Request a withdrawal of app earnings.
   *
   * NOTE: This creates a withdrawal request that is processed manually.
   * The actual payout happens through the creator's redeemable earnings balance,
   * which was credited when the earnings were originally recorded.
   *
   * The withdrawal here tracks that the creator has requested these funds
   * and prevents them from being withdrawn again from this app's balance.
   *
   * @param idempotencyKey - Optional client-provided key for request deduplication
   */
  async requestWithdrawal(
    appId: string,
    amount: number,
    idempotencyKey?: string,
  ): Promise<{ success: boolean; message: string; transactionId?: string }> {
    // Idempotency check: return existing transaction if key was already used
    if (idempotencyKey) {
      const existing = await appEarningsRepository.findTransactionByIdempotencyKey(
        appId,
        idempotencyKey,
      );
      if (existing) {
        logger.info("[AppEarnings] Idempotent withdrawal request (duplicate)", {
          appId,
          idempotencyKey,
          existingTransactionId: existing.id,
        });
        return {
          success: true,
          message: `$${Math.abs(Number(existing.amount)).toFixed(2)} marked as withdrawn. Check your Earnings page to redeem as elizaOS tokens.`,
          transactionId: existing.id,
        };
      }
    }

    const app = await appsRepository.findById(appId);
    if (!app) {
      return { success: false, message: "App not found" };
    }

    if (!app.monetization_enabled) {
      return {
        success: false,
        message: "Monetization is not enabled for this app",
      };
    }

    const result = await appEarningsRepository.processWithdrawal(appId, amount);
    if (!result.success) {
      return { success: false, message: result.message };
    }

    const transaction = await appEarningsRepository.createTransaction({
      app_id: appId,
      type: "withdrawal",
      amount: String(-amount),
      description: `Withdrawal request: $${amount.toFixed(2)}`,
      metadata: {
        requested_at: new Date().toISOString(),
        status: "processing",
        note: "Earnings are available in your redeemable balance for redemption as elizaOS tokens",
        ...(idempotencyKey && { idempotencyKey }),
      },
    });

    logger.info("[AppEarnings] Withdrawal requested", {
      appId,
      amount,
      transactionId: transaction.id,
      idempotencyKey,
    });

    return {
      success: true,
      message: `$${amount.toFixed(2)} marked as withdrawn. Check your Earnings page to redeem as elizaOS tokens.`,
      transactionId: transaction.id,
    };
  }
}

// Export singleton instance
export const appEarningsService = new AppEarningsService();
