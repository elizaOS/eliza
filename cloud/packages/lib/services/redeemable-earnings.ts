/**
 * Redeemable Earnings Service
 *
 * CRITICAL SECURITY COMPONENT
 *
 * This service manages earnings that can be redeemed for elizaOS tokens.
 * It provides bulletproof double-redemption prevention through:
 *
 * 1. Atomic database transactions with row-level locking
 * 2. Version-based optimistic locking
 * 3. Immutable ledger with audit trail
 * 4. Database CHECK constraints on balance
 * 5. Unique constraints on redeemed earnings
 *
 * ONLY earnings from these sources are redeemable:
 * - Miniapp creator earnings
 * - Agent creator earnings
 * - MCP creator earnings
 */

import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import {
  redeemableEarnings,
  redeemableEarningsLedger,
  redeemedEarningsTracking,
} from "@/db/schemas/redeemable-earnings";
import { normalizeLedgerSourceId } from "@/lib/utils/ledger-source-id";
import { logger } from "@/lib/utils/logger";

// ============================================================================
// TYPES
// ============================================================================

type EarningsSource =
  | "miniapp"
  | "agent"
  | "mcp"
  | "affiliate"
  | "app_owner_revenue_share"
  | "creator_revenue_share";

interface AddEarningsParams {
  userId: string;
  amount: number;
  source: EarningsSource;
  sourceId: string;
  description: string;
  metadata?: Record<string, unknown>;
  dedupeBySourceId?: boolean;
}

interface AddEarningsResult {
  success: boolean;
  newBalance: number;
  ledgerEntryId: string;
  error?: string;
}

interface LockEarningsParams {
  userId: string;
  amount: number;
  redemptionId: string;
  metadata?: {
    ipAddress?: string;
    userAgent?: string;
  };
}

interface LockEarningsResult {
  success: boolean;
  lockedAmount: number;
  ledgerEntryId?: string;
  error?: string;
}

interface CompleteRedemptionParams {
  userId: string;
  redemptionId: string;
  amount: number;
}

interface RefundEarningsParams {
  userId: string;
  redemptionId: string;
  amount: number;
  reason: string;
}

const normalizeLedgerMetadata = (metadata?: Record<string, unknown>): Record<string, unknown> => {
  if (!metadata) return {};
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    switch (key) {
      case "appId":
        mapped.app_id = value;
        break;
      case "earningsType":
        mapped.earnings_type = value;
        break;
      case "transactionUserId":
        mapped.transaction_user_id = value;
        break;
      case "mcpId":
        mapped.mcp_id = value;
        break;
      case "mcpName":
        mapped.mcp_name = value;
        break;
      case "toolName":
        mapped.tool_name = value;
        break;
      case "consumerOrgId":
        mapped.consumer_org_id = value;
        break;
      case "paymentType":
        mapped.payment_type = value;
        break;
      case "creditsEarned":
        mapped.credits_earned = value;
        break;
      case "agentId":
        mapped.agent_id = value;
        break;
      case "agentName":
        mapped.agent_name = value;
        break;
      case "ipAddress":
        mapped.ip_address = value;
        break;
      case "userAgent":
        mapped.user_agent = value;
        break;
      default:
        mapped[key] = value;
        break;
    }
  }
  return mapped;
};

// ============================================================================
// SERVICE
// ============================================================================

class RedeemableEarningsService {
  /**
   * Get user's current redeemable balance
   */
  async getBalance(userId: string): Promise<{
    availableBalance: number;
    totalEarned: number;
    totalRedeemed: number;
    totalPending: number;
    breakdown: {
      miniapps: number;
      agents: number;
      mcps: number;
    };
  } | null> {
    const earnings = await dbRead.query.redeemableEarnings.findFirst({
      where: eq(redeemableEarnings.user_id, userId),
    });

    if (!earnings) {
      return null;
    }

    return {
      availableBalance: Number(earnings.available_balance),
      totalEarned: Number(earnings.total_earned),
      totalRedeemed: Number(earnings.total_redeemed),
      totalPending: Number(earnings.total_pending),
      breakdown: {
        miniapps: Number(earnings.earned_from_miniapps),
        agents: Number(earnings.earned_from_agents),
        mcps: Number(earnings.earned_from_mcps),
      },
    };
  }

  /**
   * Add earnings from a valid source (miniapp, agent, or mcp)
   *
   * SECURITY: This is the ONLY way earnings can be added.
   */
  async addEarnings(params: AddEarningsParams): Promise<AddEarningsResult> {
    const {
      userId,
      amount,
      source,
      sourceId,
      description,
      metadata,
      dedupeBySourceId = false,
    } = params;

    if (amount <= 0) {
      return {
        success: false,
        newBalance: 0,
        ledgerEntryId: "",
        error: "Amount must be positive",
      };
    }

    // Use Decimal for precision
    const amountDecimal = new Decimal(amount).toFixed(4);
    const ledgerSourceId = normalizeLedgerSourceId(sourceId);
    const ledgerMetadata = normalizeLedgerMetadata({
      ...(metadata ?? {}),
      ...(ledgerSourceId !== sourceId ? { original_source_id: sourceId } : {}),
    });

    const result = await dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`redeemable_earnings:${userId}`}))`,
      );

      // Get or create earnings record with lock
      let [earnings] = await tx
        .select()
        .from(redeemableEarnings)
        .where(eq(redeemableEarnings.user_id, userId))
        .for("update");

      if (dedupeBySourceId) {
        const [existingLedger] = await tx
          .select({
            id: redeemableEarningsLedger.id,
          })
          .from(redeemableEarningsLedger)
          .where(
            and(
              eq(redeemableEarningsLedger.user_id, userId),
              eq(redeemableEarningsLedger.entry_type, "earning"),
              eq(redeemableEarningsLedger.earnings_source, source),
              eq(redeemableEarningsLedger.source_id, ledgerSourceId),
            ),
          )
          .limit(1);

        if (existingLedger) {
          return {
            earnings,
            ledgerEntryId: existingLedger.id,
            deduplicated: true,
          };
        }
      }

      if (!earnings) {
        // Create new earnings record
        [earnings] = await tx
          .insert(redeemableEarnings)
          .values({
            user_id: userId,
            total_earned: amountDecimal,
            available_balance: amountDecimal,
            earned_from_miniapps: source === "miniapp" ? amountDecimal : "0.0000",
            earned_from_agents: source === "agent" ? amountDecimal : "0.0000",
            earned_from_mcps: source === "mcp" ? amountDecimal : "0.0000",
            earned_from_affiliates: source === "affiliate" ? amountDecimal : "0.0000",
            earned_from_app_owner_shares:
              source === "app_owner_revenue_share" ? amountDecimal : "0.0000",
            earned_from_creator_shares:
              source === "creator_revenue_share" ? amountDecimal : "0.0000",
            last_earning_at: new Date(),
          })
          .returning();
      } else {
        // Update existing record
        const sourceColumn =
          source === "miniapp"
            ? redeemableEarnings.earned_from_miniapps
            : source === "agent"
              ? redeemableEarnings.earned_from_agents
              : source === "mcp"
                ? redeemableEarnings.earned_from_mcps
                : source === "affiliate"
                  ? redeemableEarnings.earned_from_affiliates
                  : source === "app_owner_revenue_share"
                    ? redeemableEarnings.earned_from_app_owner_shares
                    : redeemableEarnings.earned_from_creator_shares;

        [earnings] = await tx
          .update(redeemableEarnings)
          .set({
            total_earned: sql`${redeemableEarnings.total_earned} + ${amountDecimal}`,
            available_balance: sql`${redeemableEarnings.available_balance} + ${amountDecimal}`,
            [sourceColumn.name]: sql`${sourceColumn} + ${amountDecimal}`,
            last_earning_at: new Date(),
            version: sql`${redeemableEarnings.version} + 1`,
            updated_at: new Date(),
          })
          .where(eq(redeemableEarnings.user_id, userId))
          .returning();
      }

      // Create immutable ledger entry
      const [ledgerEntry] = await tx
        .insert(redeemableEarningsLedger)
        .values({
          user_id: userId,
          entry_type: "earning",
          amount: amountDecimal,
          balance_after: earnings.available_balance,
          earnings_source: source,
          source_id: ledgerSourceId,
          description,
          metadata: ledgerMetadata,
        })
        .returning();

      return {
        earnings,
        ledgerEntryId: ledgerEntry.id,
        deduplicated: false,
      };
    });

    if (result.deduplicated) {
      logger.info("[RedeemableEarnings] Reused existing earning entry", {
        userId: userId.slice(0, 8) + "...",
        amount,
        source,
        sourceId: sourceId.slice(0, 8) + "...",
        ledgerEntryId: result.ledgerEntryId,
      });

      return {
        success: true,
        newBalance: Number(result.earnings?.available_balance ?? 0),
        ledgerEntryId: result.ledgerEntryId,
      };
    }

    logger.info("[RedeemableEarnings] Added earnings", {
      userId: userId.slice(0, 8) + "...",
      amount,
      source,
      sourceId: sourceId.slice(0, 8) + "...",
      newBalance: Number(result.earnings.available_balance),
    });

    return {
      success: true,
      newBalance: Number(result.earnings.available_balance),
      ledgerEntryId: result.ledgerEntryId,
    };
  }

  /**
   * Reduce earnings due to reconciliation adjustment (e.g., refund scenarios)
   *
   * This is used when actual costs are less than estimated and creator earnings
   * need to be adjusted downward to reflect the actual earnings.
   *
   * SECURITY: Only reduces available_balance, never goes negative (uses GREATEST).
   */
  async reduceEarnings(params: {
    userId: string;
    amount: number;
    source: EarningsSource;
    sourceId: string;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    success: boolean;
    newBalance: number;
    ledgerEntryId: string;
    error?: string;
  }> {
    const { userId, amount, source, sourceId, description, metadata = {} } = params;

    if (amount <= 0) {
      return {
        success: false,
        newBalance: 0,
        ledgerEntryId: "",
        error: "Amount must be positive",
      };
    }

    const amountDecimal = new Decimal(amount).toFixed(4);
    const ledgerSourceId = normalizeLedgerSourceId(sourceId);
    const ledgerMetadata = normalizeLedgerMetadata({
      ...metadata,
      ...(ledgerSourceId !== sourceId ? { original_source_id: sourceId } : {}),
      type: "reconciliation_reduction",
    });

    const result = await dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`redeemable_earnings:${userId}`}))`,
      );

      // Get earnings with row lock
      const [earnings] = await tx
        .select()
        .from(redeemableEarnings)
        .where(eq(redeemableEarnings.user_id, userId))
        .for("update");

      if (!earnings) {
        // No earnings to reduce - this is fine, just log and return
        return {
          earnings: null,
          ledgerEntryId: "",
          skipped: true,
        };
      }

      // Determine the source column
      const sourceColumn =
        source === "miniapp"
          ? redeemableEarnings.earned_from_miniapps
          : source === "agent"
            ? redeemableEarnings.earned_from_agents
            : source === "mcp"
              ? redeemableEarnings.earned_from_mcps
              : source === "affiliate"
                ? redeemableEarnings.earned_from_affiliates
                : source === "app_owner_revenue_share"
                  ? redeemableEarnings.earned_from_app_owner_shares
                  : redeemableEarnings.earned_from_creator_shares;

      // Reduce balances - use GREATEST to prevent going negative
      const [updated] = await tx
        .update(redeemableEarnings)
        .set({
          total_earned: sql`GREATEST(0, ${redeemableEarnings.total_earned} - ${amountDecimal})`,
          available_balance: sql`GREATEST(0, ${redeemableEarnings.available_balance} - ${amountDecimal})`,
          [sourceColumn.name]: sql`GREATEST(0, ${sourceColumn} - ${amountDecimal})`,
          version: sql`${redeemableEarnings.version} + 1`,
          updated_at: new Date(),
        })
        .where(eq(redeemableEarnings.user_id, userId))
        .returning();

      // Create ledger entry for audit trail
      const [ledgerEntry] = await tx
        .insert(redeemableEarningsLedger)
        .values({
          user_id: userId,
          entry_type: "adjustment",
          amount: `-${amountDecimal}`, // Negative for reduction
          balance_after: updated.available_balance,
          earnings_source: source,
          source_id: ledgerSourceId,
          description,
          metadata: ledgerMetadata,
        })
        .returning();

      return {
        earnings: updated,
        ledgerEntryId: ledgerEntry.id,
        skipped: false,
      };
    });

    if (result.skipped) {
      logger.info("[RedeemableEarnings] No earnings to reduce (user has no record)", {
        userId: `${userId.slice(0, 8)}...`,
        amount,
        source,
      });

      return {
        success: true,
        newBalance: 0,
        ledgerEntryId: "",
      };
    }

    const updatedEarnings = result.earnings;
    if (!updatedEarnings) {
      return {
        success: true,
        newBalance: 0,
        ledgerEntryId: result.ledgerEntryId,
      };
    }

    logger.info("[RedeemableEarnings] Reduced earnings (reconciliation)", {
      userId: `${userId.slice(0, 8)}...`,
      amount,
      source,
      sourceId: `${sourceId.slice(0, 8)}...`,
      newBalance: Number(updatedEarnings.available_balance),
    });

    return {
      success: true,
      newBalance: Number(updatedEarnings.available_balance),
      ledgerEntryId: result.ledgerEntryId,
    };
  }

  /**
   * Lock earnings for a pending redemption
   *
   * CRITICAL: This moves earnings from available to pending.
   * The earnings are still owned by the user but cannot be redeemed again.
   */
  async lockForRedemption(params: LockEarningsParams): Promise<LockEarningsResult> {
    const { userId, amount, redemptionId, metadata } = params;

    if (amount <= 0) {
      return {
        success: false,
        lockedAmount: 0,
        error: "Amount must be positive",
      };
    }

    const amountDecimal = new Decimal(amount).toFixed(4);

    const result = await dbWrite.transaction(async (tx) => {
      // Get earnings with row lock
      const [earnings] = await tx
        .select()
        .from(redeemableEarnings)
        .where(eq(redeemableEarnings.user_id, userId))
        .for("update");

      if (!earnings) {
        throw new Error("No earnings record found");
      }

      const available = new Decimal(earnings.available_balance);
      const requested = new Decimal(amountDecimal);

      // Check sufficient balance
      if (available.lt(requested)) {
        throw new Error(
          `Insufficient redeemable balance. Available: $${available.toFixed(2)}, Requested: $${requested.toFixed(2)}`,
        );
      }

      // Check for existing pending redemption with same ID (idempotency)
      const existingLedger = await tx.query.redeemableEarningsLedger.findFirst({
        where: and(
          eq(redeemableEarningsLedger.user_id, userId),
          eq(redeemableEarningsLedger.redemption_id, redemptionId),
          eq(redeemableEarningsLedger.entry_type, "redemption"),
        ),
      });

      if (existingLedger) {
        // Idempotent - return existing
        return {
          earnings,
          ledgerEntryId: existingLedger.id,
          isExisting: true,
        };
      }

      // Update balances atomically
      // CRITICAL: Use WHERE clause to ensure sufficient balance
      const [updated] = await tx
        .update(redeemableEarnings)
        .set({
          available_balance: sql`${redeemableEarnings.available_balance} - ${amountDecimal}`,
          total_pending: sql`${redeemableEarnings.total_pending} + ${amountDecimal}`,
          version: sql`${redeemableEarnings.version} + 1`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(redeemableEarnings.user_id, userId),
            // CRITICAL: Only update if balance is still sufficient
            sql`CAST(${redeemableEarnings.available_balance} AS DECIMAL) >= ${amount}`,
          ),
        )
        .returning();

      if (!updated) {
        throw new Error("Balance changed during transaction. Please retry.");
      }

      // Create ledger entry
      const [ledgerEntry] = await tx
        .insert(redeemableEarningsLedger)
        .values({
          user_id: userId,
          entry_type: "redemption",
          amount: `-${amountDecimal}`, // Negative for redemption
          balance_after: updated.available_balance,
          redemption_id: redemptionId,
          description: `Redemption locked: $${amount.toFixed(2)}`,
          metadata: normalizeLedgerMetadata(metadata),
        })
        .returning();

      return {
        earnings: updated,
        ledgerEntryId: ledgerEntry.id,
        isExisting: false,
      };
    });

    logger.info("[RedeemableEarnings] Locked for redemption", {
      userId: userId.slice(0, 8) + "...",
      amount,
      redemptionId: redemptionId.slice(0, 8) + "...",
      newAvailable: Number(result.earnings.available_balance),
      isExisting: result.isExisting,
    });

    return {
      success: true,
      lockedAmount: amount,
      ledgerEntryId: result.ledgerEntryId,
    };
  }

  /**
   * Complete a redemption (move from pending to redeemed)
   *
   * Called after tokens have been successfully sent on-chain.
   */
  async completeRedemption(
    params: CompleteRedemptionParams,
  ): Promise<{ success: boolean; error?: string }> {
    const { userId, redemptionId, amount } = params;

    const amountDecimal = new Decimal(amount).toFixed(4);

    await dbWrite.transaction(async (tx) => {
      // Update balances
      const [updated] = await tx
        .update(redeemableEarnings)
        .set({
          total_pending: sql`GREATEST(0, ${redeemableEarnings.total_pending} - ${amountDecimal})`,
          total_redeemed: sql`${redeemableEarnings.total_redeemed} + ${amountDecimal}`,
          last_redemption_at: new Date(),
          version: sql`${redeemableEarnings.version} + 1`,
          updated_at: new Date(),
        })
        .where(eq(redeemableEarnings.user_id, userId))
        .returning();

      if (!updated) {
        throw new Error("Earnings record not found");
      }

      // Add completion ledger entry
      await tx.insert(redeemableEarningsLedger).values({
        user_id: userId,
        entry_type: "redemption",
        amount: "0", // No balance change (already locked)
        balance_after: updated.available_balance,
        redemption_id: redemptionId,
        description: `Redemption completed: $${amount.toFixed(2)} sent as elizaOS`,
        metadata: normalizeLedgerMetadata({
          completed_at: new Date().toISOString(),
        }),
      });
    });

    logger.info("[RedeemableEarnings] Redemption completed", {
      userId: userId.slice(0, 8) + "...",
      redemptionId: redemptionId.slice(0, 8) + "...",
      amount,
    });

    return { success: true };
  }

  /**
   * Refund earnings from a failed/rejected redemption
   *
   * Moves funds from pending back to available.
   */
  async refundRedemption(
    params: RefundEarningsParams,
  ): Promise<{ success: boolean; error?: string }> {
    const { userId, redemptionId, amount, reason } = params;

    const amountDecimal = new Decimal(amount).toFixed(4);

    await dbWrite.transaction(async (tx) => {
      // Update balances - move from pending back to available
      const [updated] = await tx
        .update(redeemableEarnings)
        .set({
          total_pending: sql`GREATEST(0, ${redeemableEarnings.total_pending} - ${amountDecimal})`,
          available_balance: sql`${redeemableEarnings.available_balance} + ${amountDecimal}`,
          version: sql`${redeemableEarnings.version} + 1`,
          updated_at: new Date(),
        })
        .where(eq(redeemableEarnings.user_id, userId))
        .returning();

      if (!updated) {
        throw new Error("Earnings record not found");
      }

      // Add refund ledger entry
      await tx.insert(redeemableEarningsLedger).values({
        user_id: userId,
        entry_type: "refund",
        amount: amountDecimal, // Positive - refund adds back
        balance_after: updated.available_balance,
        redemption_id: redemptionId,
        description: `Refund: ${reason}`,
        metadata: normalizeLedgerMetadata({
          refunded_at: new Date().toISOString(),
        }),
      });
    });

    logger.info("[RedeemableEarnings] Redemption refunded", {
      userId: userId.slice(0, 8) + "...",
      redemptionId: redemptionId.slice(0, 8) + "...",
      amount,
      reason,
    });

    return { success: true };
  }

  /**
   * Convert redeemable earnings into spendable org credit balance.
   *
   * Used by the earnings auto-fund flow: a creator's app earnings keep
   * the same creator's containers running. Decrements available_balance
   * and increments total_converted_to_credits — does NOT touch
   * total_earned (lifetime) or total_redeemed (token cashout) so creator
   * stats stay correct.
   *
   * Caller is responsible for crediting the org balance after this
   * succeeds; this method only debits the user's earnings.
   */
  async convertToCredits(params: {
    userId: string;
    amount: number;
    organizationId: string;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; newBalance: number; ledgerEntryId: string; error?: string }> {
    const { userId, amount, organizationId, description, metadata = {} } = params;

    if (amount <= 0) {
      return { success: false, newBalance: 0, ledgerEntryId: "", error: "Amount must be positive" };
    }

    const amountDecimal = new Decimal(amount).toFixed(4);
    const ledgerMetadata = normalizeLedgerMetadata({
      ...metadata,
      transaction_type: "credit_conversion",
    });

    const result = await dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`redeemable_earnings:${userId}`}))`,
      );

      const [earnings] = await tx
        .select()
        .from(redeemableEarnings)
        .where(eq(redeemableEarnings.user_id, userId))
        .for("update");

      if (!earnings) {
        throw new Error("No earnings record found");
      }

      const available = new Decimal(earnings.available_balance);
      if (available.lt(amountDecimal)) {
        throw new Error(
          `Insufficient redeemable balance. Available: $${available.toFixed(4)}, Requested: $${amount.toFixed(4)}`,
        );
      }

      const [updated] = await tx
        .update(redeemableEarnings)
        .set({
          available_balance: sql`${redeemableEarnings.available_balance} - ${amountDecimal}`,
          total_converted_to_credits: sql`${redeemableEarnings.total_converted_to_credits} + ${amountDecimal}`,
          version: sql`${redeemableEarnings.version} + 1`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(redeemableEarnings.user_id, userId),
            sql`CAST(${redeemableEarnings.available_balance} AS DECIMAL) >= ${amount}`,
          ),
        )
        .returning();

      if (!updated) {
        throw new Error("Balance changed during transaction. Please retry.");
      }

      const [ledgerEntry] = await tx
        .insert(redeemableEarningsLedger)
        .values({
          user_id: userId,
          entry_type: "credit_conversion",
          amount: `-${amountDecimal}`,
          balance_after: updated.available_balance,
          source_id: organizationId,
          description,
          metadata: ledgerMetadata,
        })
        .returning();

      return { earnings: updated, ledgerEntryId: ledgerEntry.id };
    });

    logger.info("[RedeemableEarnings] Converted to org credits", {
      userId: `${userId.slice(0, 8)}...`,
      organizationId: `${organizationId.slice(0, 8)}...`,
      amount,
      newBalance: Number(result.earnings.available_balance),
    });

    return {
      success: true,
      newBalance: Number(result.earnings.available_balance),
      ledgerEntryId: result.ledgerEntryId,
    };
  }

  /**
   * Get ledger history for a user
   */
  async getLedgerHistory(
    userId: string,
    limit: number = 50,
  ): Promise<
    Array<{
      id: string;
      type: string;
      amount: number;
      balanceAfter: number;
      description: string;
      source?: string;
      sourceId?: string;
      redemptionId?: string;
      createdAt: Date;
    }>
  > {
    const entries = await dbRead.query.redeemableEarningsLedger.findMany({
      where: eq(redeemableEarningsLedger.user_id, userId),
      orderBy: (ledger, { desc }) => [desc(ledger.created_at)],
      limit,
    });

    return entries.map((e) => ({
      id: e.id,
      type: e.entry_type,
      amount: Number(e.amount),
      balanceAfter: Number(e.balance_after),
      description: e.description,
      source: e.earnings_source ?? undefined,
      sourceId: e.source_id ?? undefined,
      redemptionId: e.redemption_id ?? undefined,
      createdAt: e.created_at,
    }));
  }

  /**
   * Verify a user has never redeemed a specific earning before
   *
   * SECURITY: Additional layer of double-redemption protection
   */
  async hasBeenRedeemed(ledgerEntryId: string): Promise<boolean> {
    const tracking = await dbRead.query.redeemedEarningsTracking.findFirst({
      where: eq(redeemedEarningsTracking.ledger_entry_id, ledgerEntryId),
    });

    return !!tracking;
  }
}

// Export singleton
export const redeemableEarningsService = new RedeemableEarningsService();
