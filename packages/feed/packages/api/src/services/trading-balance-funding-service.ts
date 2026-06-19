import {
  and,
  balanceTransactions,
  db,
  desc,
  eq,
  inArray,
  sql,
  users,
  WELCOME_BONUS_BALANCE_DESCRIPTION,
} from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import { CACHE_KEYS, invalidateCache } from "../cache";

const FUNDING_TRANSACTION_TYPES = [
  "deposit",
  "crypto_purchase",
  "stripe_purchase",
  "stripe_refund",
  "stripe_dispute",
  "stripe_dispute_won",
] as const;

export interface TradingBalanceFundingResult {
  success: boolean;
  balanceDelta: number;
  newBalance: number;
  alreadyProcessed?: boolean;
  error?: string;
  transactionId?: string;
}

export interface TradingBalanceFundingHistoryItem {
  id: string;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description: string | null;
  relatedId: string | null;
  createdAt: Date;
}

export class TradingBalanceFundingService {
  /**
   * Economic baseline for portfolio PnL uses:
   * netContributions = totalDeposited - totalWithdrawn.
   *
   * Rules retained here:
   * - capital entering the trading wallet increments totalDeposited
   * - refunds/disputes increment totalWithdrawn by the reversed economic amount
   * - dispute reversals decrement totalWithdrawn to restore net contributions
   */
  private static async afterBalanceMutation(userId: string): Promise<void> {
    await Promise.allSettled([
      invalidateCache(userId, { namespace: CACHE_KEYS.USER_BALANCE }),
      invalidateCache(userId, { namespace: CACHE_KEYS.USER }),
    ]);
  }

  static async getFundingHistory(
    userId: string,
    limit = 100,
  ): Promise<TradingBalanceFundingHistoryItem[]> {
    const transactions = await db
      .select({
        id: balanceTransactions.id,
        type: balanceTransactions.type,
        amount: balanceTransactions.amount,
        balanceBefore: balanceTransactions.balanceBefore,
        balanceAfter: balanceTransactions.balanceAfter,
        description: balanceTransactions.description,
        relatedId: balanceTransactions.relatedId,
        createdAt: balanceTransactions.createdAt,
      })
      .from(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, userId),
          inArray(balanceTransactions.type, [...FUNDING_TRANSACTION_TYPES]),
        ),
      )
      .orderBy(desc(balanceTransactions.createdAt))
      .limit(limit);

    return transactions.map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      amount: Number(transaction.amount),
      balanceBefore: Number(transaction.balanceBefore),
      balanceAfter: Number(transaction.balanceAfter),
      description: transaction.description,
      relatedId: transaction.relatedId,
      createdAt: transaction.createdAt,
    }));
  }

  static async awardWelcomeBonus(
    userId: string,
    amount: number,
  ): Promise<TradingBalanceFundingResult> {
    const result = await db.transaction(async (tx) => {
      const [existingTransaction] = await tx
        .select({ id: balanceTransactions.id })
        .from(balanceTransactions)
        .where(
          and(
            eq(balanceTransactions.userId, userId),
            eq(
              balanceTransactions.description,
              WELCOME_BONUS_BALANCE_DESCRIPTION,
            ),
          ),
        )
        .limit(1);

      if (existingTransaction) {
        const [existingUser] = await tx
          .select({ virtualBalance: users.virtualBalance })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        return {
          success: true,
          balanceDelta: 0,
          newBalance: Number(existingUser?.virtualBalance ?? 0),
          alreadyProcessed: true,
        };
      }

      const [user] = await tx
        .select({ virtualBalance: users.virtualBalance })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user) {
        return {
          success: false,
          balanceDelta: 0,
          newBalance: 0,
          error: "User not found",
        };
      }

      const balanceBefore = Number(user.virtualBalance ?? 0);
      const balanceAfter = balanceBefore + amount;
      const transactionId = await generateSnowflakeId();

      await tx
        .update(users)
        .set({
          virtualBalance: sql`COALESCE(CAST("virtualBalance" AS NUMERIC), 0) + ${amount}`,
          totalDeposited: sql`COALESCE(CAST("totalDeposited" AS NUMERIC), 0) + ${amount}`,
        })
        .where(eq(users.id, userId));

      await tx.insert(balanceTransactions).values({
        id: transactionId,
        userId,
        type: "deposit",
        amount: String(amount),
        balanceBefore: String(balanceBefore),
        balanceAfter: String(balanceAfter),
        description: WELCOME_BONUS_BALANCE_DESCRIPTION,
      });

      return {
        success: true,
        balanceDelta: amount,
        newBalance: balanceAfter,
        transactionId,
      };
    });

    if (result.success && !result.alreadyProcessed) {
      logger.info(
        "Welcome bonus funded to trading balance",
        { userId, amount, newBalance: result.newBalance },
        "TradingBalanceFundingService",
      );
      await TradingBalanceFundingService.afterBalanceMutation(userId);
    }

    return result;
  }

  static async creditAdminFunding(
    userId: string,
    amount: number,
    reason: string,
    description?: string,
  ): Promise<TradingBalanceFundingResult> {
    const result = await db.transaction(async (tx) => {
      const [user] = await tx
        .select({ virtualBalance: users.virtualBalance })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user) {
        return {
          success: false,
          balanceDelta: 0,
          newBalance: 0,
          error: "User not found",
        };
      }

      const balanceBefore = Number(user.virtualBalance ?? 0);
      const balanceAfter = balanceBefore + amount;
      const transactionId = await generateSnowflakeId();

      await tx
        .update(users)
        .set({
          virtualBalance: sql`COALESCE(CAST("virtualBalance" AS NUMERIC), 0) + ${amount}`,
          totalDeposited: sql`COALESCE(CAST("totalDeposited" AS NUMERIC), 0) + ${amount}`,
        })
        .where(eq(users.id, userId));

      await tx.insert(balanceTransactions).values({
        id: transactionId,
        userId,
        type: "deposit",
        amount: String(amount),
        balanceBefore: String(balanceBefore),
        balanceAfter: String(balanceAfter),
        description: description || reason,
      });

      return {
        success: true,
        balanceDelta: amount,
        newBalance: balanceAfter,
        transactionId,
      };
    });

    if (!result.success) {
      return result;
    }

    logger.info(
      "Credited trading balance via admin funding adjustment",
      { userId, amount, reason, newBalance: result.newBalance },
      "TradingBalanceFundingService",
    );

    await TradingBalanceFundingService.afterBalanceMutation(userId);

    return result;
  }

  static async fundPurchase(
    userId: string,
    amountUSD: number,
    paymentRequestId: string,
    paymentTxHash?: string,
    paymentProvider: "crypto" | "stripe" = "crypto",
  ): Promise<TradingBalanceFundingResult> {
    const balanceDelta = Math.floor(amountUSD * 100);
    const transactionType = `${paymentProvider}_purchase`;
    const relatedId = paymentTxHash || paymentRequestId;

    const result = await db.transaction(async (tx) => {
      const [existingTransaction] = await tx
        .select({
          id: balanceTransactions.id,
          amount: balanceTransactions.amount,
        })
        .from(balanceTransactions)
        .where(
          and(
            eq(balanceTransactions.userId, userId),
            eq(balanceTransactions.type, transactionType),
            eq(balanceTransactions.relatedId, relatedId),
          ),
        )
        .limit(1);

      if (existingTransaction) {
        const [existingUser] = await tx
          .select({ virtualBalance: users.virtualBalance })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        logger.info(
          "Trading balance purchase already processed",
          { userId, paymentRequestId, paymentProvider, relatedId },
          "TradingBalanceFundingService",
        );
        return {
          success: true,
          balanceDelta: Number(existingTransaction.amount),
          newBalance: Number(existingUser?.virtualBalance ?? 0),
          alreadyProcessed: true,
          transactionId: existingTransaction.id,
        };
      }

      const [user] = await tx
        .select({ virtualBalance: users.virtualBalance })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user) {
        return {
          success: false,
          balanceDelta: 0,
          newBalance: 0,
          error: "User not found",
        };
      }

      const balanceBefore = Number(user.virtualBalance ?? 0);
      const balanceAfter = balanceBefore + balanceDelta;
      const transactionId = await generateSnowflakeId();

      await tx
        .update(users)
        .set({
          virtualBalance: sql`COALESCE(CAST("virtualBalance" AS NUMERIC), 0) + ${balanceDelta}`,
          totalDeposited: sql`COALESCE(CAST("totalDeposited" AS NUMERIC), 0) + ${balanceDelta}`,
        })
        .where(eq(users.id, userId));

      await tx.insert(balanceTransactions).values({
        id: transactionId,
        userId,
        type: transactionType,
        amount: String(balanceDelta),
        balanceBefore: String(balanceBefore),
        balanceAfter: String(balanceAfter),
        relatedId,
        description: JSON.stringify({
          amountUSD,
          balanceUnitsPerDollar: 100,
          purchasedAt: new Date().toISOString(),
          paymentProvider,
          paymentRequestId,
          paymentTxHash,
        }),
      });

      return {
        success: true,
        balanceDelta,
        newBalance: balanceAfter,
        transactionId,
      };
    });

    if (result.success && !result.alreadyProcessed) {
      logger.info(
        "Funded trading balance from purchase",
        { userId, amountUSD, balanceDelta, paymentRequestId, paymentProvider },
        "TradingBalanceFundingService",
      );
      await TradingBalanceFundingService.afterBalanceMutation(userId);
    }

    return result;
  }

  static async reversePurchaseFunding(
    userId: string,
    paymentIntentId: string,
    reason: "refund" | "dispute",
    amountUSD: number,
    stripeEventId: string,
  ): Promise<TradingBalanceFundingResult> {
    const requestedDeduction = Math.floor(amountUSD * 100);
    const transactionType =
      reason === "refund" ? "stripe_refund" : "stripe_dispute";

    const result = await db.transaction(async (tx) => {
      const [existingReversal] = await tx
        .select({
          id: balanceTransactions.id,
          amount: balanceTransactions.amount,
        })
        .from(balanceTransactions)
        .where(
          and(
            eq(balanceTransactions.userId, userId),
            eq(balanceTransactions.relatedId, stripeEventId),
          ),
        )
        .limit(1);

      if (existingReversal) {
        const [existingUser] = await tx
          .select({ virtualBalance: users.virtualBalance })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        logger.info(
          "Trading balance reversal already processed",
          { userId, stripeEventId, reason },
          "TradingBalanceFundingService",
        );
        return {
          success: true,
          balanceDelta: Number(existingReversal.amount),
          newBalance: Number(existingUser?.virtualBalance ?? 0),
          alreadyProcessed: true,
          transactionId: existingReversal.id,
        };
      }

      const [user] = await tx
        .select({ virtualBalance: users.virtualBalance })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user) {
        return {
          success: false,
          balanceDelta: 0,
          newBalance: 0,
          error: "User not found",
        };
      }

      const balanceBefore = Number(user.virtualBalance ?? 0);
      const balanceAfter = Math.max(0, balanceBefore - requestedDeduction);
      const actualDeduction = balanceBefore - balanceAfter;
      const transactionId = await generateSnowflakeId();

      await tx
        .update(users)
        .set({
          virtualBalance: sql`GREATEST(0, COALESCE(CAST("virtualBalance" AS NUMERIC), 0) - ${requestedDeduction})`,
          totalWithdrawn: sql`COALESCE(CAST("totalWithdrawn" AS NUMERIC), 0) + ${requestedDeduction}`,
        })
        .where(eq(users.id, userId));

      await tx.insert(balanceTransactions).values({
        id: transactionId,
        userId,
        type: transactionType,
        amount: String(-actualDeduction),
        balanceBefore: String(balanceBefore),
        balanceAfter: String(balanceAfter),
        relatedId: stripeEventId,
        description: JSON.stringify({
          amountUSD,
          balanceUnitsRequested: requestedDeduction,
          balanceUnitsDeducted: actualDeduction,
          originalPaymentIntentId: paymentIntentId,
          reversalReason: reason,
          reversedAt: new Date().toISOString(),
        }),
      });

      return {
        success: true,
        balanceDelta: -actualDeduction,
        newBalance: balanceAfter,
        transactionId,
      };
    });

    if (result.success && !result.alreadyProcessed) {
      logger.info(
        "Reversed trading balance funding",
        {
          userId,
          paymentIntentId,
          reason,
          amountUSD,
          balanceDelta: result.balanceDelta,
          newBalance: result.newBalance,
          stripeEventId,
        },
        "TradingBalanceFundingService",
      );
      await TradingBalanceFundingService.afterBalanceMutation(userId);
    }

    return result;
  }

  static async creditDisputeWon(
    userId: string,
    disputeId: string,
    amountUSD: number,
    stripeEventId: string,
  ): Promise<TradingBalanceFundingResult> {
    const balanceDelta = Math.floor(amountUSD * 100);

    const result = await db.transaction(async (tx) => {
      const [existingCredit] = await tx
        .select({
          id: balanceTransactions.id,
          amount: balanceTransactions.amount,
        })
        .from(balanceTransactions)
        .where(
          and(
            eq(balanceTransactions.userId, userId),
            eq(balanceTransactions.relatedId, stripeEventId),
          ),
        )
        .limit(1);

      if (existingCredit) {
        const [existingUser] = await tx
          .select({ virtualBalance: users.virtualBalance })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        logger.info(
          "Dispute win funding credit already processed",
          { userId, stripeEventId, disputeId },
          "TradingBalanceFundingService",
        );
        return {
          success: true,
          balanceDelta: Number(existingCredit.amount),
          newBalance: Number(existingUser?.virtualBalance ?? 0),
          alreadyProcessed: true,
          transactionId: existingCredit.id,
        };
      }

      const [user] = await tx
        .select({ virtualBalance: users.virtualBalance })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user) {
        return {
          success: false,
          balanceDelta: 0,
          newBalance: 0,
          error: "User not found",
        };
      }

      const balanceBefore = Number(user.virtualBalance ?? 0);
      const balanceAfter = balanceBefore + balanceDelta;
      const transactionId = await generateSnowflakeId();

      await tx
        .update(users)
        .set({
          virtualBalance: sql`COALESCE(CAST("virtualBalance" AS NUMERIC), 0) + ${balanceDelta}`,
          totalWithdrawn: sql`GREATEST(0, COALESCE(CAST("totalWithdrawn" AS NUMERIC), 0) - ${balanceDelta})`,
        })
        .where(eq(users.id, userId));

      await tx.insert(balanceTransactions).values({
        id: transactionId,
        userId,
        type: "stripe_dispute_won",
        amount: String(balanceDelta),
        balanceBefore: String(balanceBefore),
        balanceAfter: String(balanceAfter),
        relatedId: stripeEventId,
        description: JSON.stringify({
          amountUSD,
          balanceUnitsCredited: balanceDelta,
          disputeId,
          creditedAt: new Date().toISOString(),
        }),
      });

      return {
        success: true,
        balanceDelta,
        newBalance: balanceAfter,
        transactionId,
      };
    });

    if (result.success && !result.alreadyProcessed) {
      logger.info(
        "Re-credited trading balance after dispute win",
        {
          userId,
          disputeId,
          amountUSD,
          balanceDelta,
          newBalance: result.newBalance,
          stripeEventId,
        },
        "TradingBalanceFundingService",
      );
      await TradingBalanceFundingService.afterBalanceMutation(userId);
    }

    return result;
  }
}
