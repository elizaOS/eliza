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
 *
 * ONLY earnings from these sources are redeemable:
 * - Miniapp creator earnings
 * - Agent creator earnings
 * - MCP creator earnings
 */

import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { type DbTransaction, dbRead, dbWrite } from "../../db/client";
import { redeemableEarnings, redeemableEarningsLedger } from "../../db/schemas/redeemable-earnings";
import { normalizeLedgerSourceId } from "../utils/ledger-source-id";
import { logger } from "../utils/logger";
import { parseRedeemableEarningsNumber } from "./redeemable-earnings-numeric";

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
  amount: number | string;
  source: EarningsSource;
  sourceId: string;
  description: string;
  metadata?: Record<string, unknown>;
  dedupeBySourceId?: boolean;
  reversesRedemption?: boolean;
  /**
   * Move the balances by this part of `amount` (0 to `amount`) while the
   * ledger books all of `amount`. Returns a reversal that
   * `reduceEarnings({ capBalanceDebitAtAvailable })` booked partly as ledger
   * debt: the ledger debt is cleared, but the balances get back only what the
   * reversal took from them.
   */
  balanceAmount?: number | string;
  /** Reuse the caller's settlement transaction when this earning is one leg of a larger unit. */
  transaction?: DbTransaction;
}

interface AddEarningsResult {
  success: boolean;
  newBalance: number;
  ledgerEntryId: string;
  /** True when an existing (source, sourceId) ledger entry was reused (dedupeBySourceId). */
  deduplicated?: boolean;
  error?: string;
}

export class RedeemableEarningsReplayMismatchError extends Error {
  constructor(
    readonly source: EarningsSource,
    readonly sourceId: string,
    readonly mismatch: string,
  ) {
    super(`Redeemable earnings replay mismatch for ${source}:${sourceId}: ${mismatch}`);
    this.name = "RedeemableEarningsReplayMismatchError";
  }
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

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      // Code-unit order, not localeCompare: ICU collation is locale-dependent and
      // ranks canonically equivalent distinct keys as equal, so identical ledger
      // metadata could compare unequal across hosts and key insertion order.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalJson(nested)]),
  );
}

function ledgerMetadataMatches(existing: unknown, expected: unknown): boolean {
  return JSON.stringify(canonicalJson(existing)) === JSON.stringify(canonicalJson(expected));
}

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

    // Fail-closed NUMERIC boundary: a corrupt row (`'NaN'::numeric`) must throw
    // rather than surface a `NaN` balance. `availableBalance` gates money-out in
    // the secure token-redemption pre-check
    // (`new Decimal(balance.availableBalance).lt(deductionAmount)` — `Decimal(NaN).lt(x)`
    // is `false`, i.e. the insufficient-balance check would FAIL OPEN over a
    // corrupt row). Throwing here propagates to the redemption route's catch,
    // which fails closed (denies) instead of authorizing against garbage.
    return {
      availableBalance: parseRedeemableEarningsNumber(
        earnings.available_balance,
        "available_balance",
      ),
      totalEarned: parseRedeemableEarningsNumber(earnings.total_earned, "total_earned"),
      totalRedeemed: parseRedeemableEarningsNumber(earnings.total_redeemed, "total_redeemed"),
      totalPending: parseRedeemableEarningsNumber(earnings.total_pending, "total_pending"),
      breakdown: {
        miniapps: parseRedeemableEarningsNumber(
          earnings.earned_from_miniapps,
          "earned_from_miniapps",
        ),
        agents: parseRedeemableEarningsNumber(earnings.earned_from_agents, "earned_from_agents"),
        mcps: parseRedeemableEarningsNumber(earnings.earned_from_mcps, "earned_from_mcps"),
      },
    };
  }

  /**
   * True when an `earning` ledger row already exists for (`source`, `sourceId`).
   *
   * SECURITY (money-out): a Stripe Connect payout debits under one idempotency
   * key, then — on a DEFINITIVE Stripe rejection — compensates by adding an
   * `${key}:refund` earning that restores the balance. The debit's own dedup row
   * (keyed on `key`) is immutable and survives that rollback, so a later same-key
   * retry finds the debit `deduplicated` and skips debiting while firing a FRESH
   * transfer → double-pay. The payout route uses this to detect "this key was
   * already rejected + refunded" (a `${key}:refund` earning exists) and refuse
   * the retry, forcing a fresh idempotency key. Matches the `dedupeBySourceId`
   * lookup (normalized source_id, `entry_type='earning'`).
   */
  async hasEarningBySourceId(params: {
    userId: string;
    source: EarningsSource;
    sourceId: string;
  }): Promise<boolean> {
    if (params.sourceId.trim() === "") {
      throw new Error("Source ID must not be blank");
    }
    const ledgerSourceId = normalizeLedgerSourceId(params.sourceId);
    // This is also the commit-ack verification seam for creator accounting.
    // Read the primary so an immediately committed earning cannot appear
    // absent under replica lag and trigger an unbacked consumer refund.
    const [existing] = await dbWrite
      .select({ id: redeemableEarningsLedger.id })
      .from(redeemableEarningsLedger)
      .where(
        and(
          eq(redeemableEarningsLedger.user_id, params.userId),
          eq(redeemableEarningsLedger.entry_type, "earning"),
          eq(redeemableEarningsLedger.earnings_source, params.source),
          eq(redeemableEarningsLedger.source_id, ledgerSourceId),
        ),
      )
      .limit(1);
    return Boolean(existing);
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
      transaction,
    } = params;

    const inputAmount = new Decimal(amount);
    if (!inputAmount.isFinite() || !inputAmount.gt(0)) {
      return {
        success: false,
        newBalance: 0,
        ledgerEntryId: "",
        error: "Amount must be positive",
      };
    }
    if (sourceId.trim() === "") {
      return {
        success: false,
        newBalance: 0,
        ledgerEntryId: "",
        error: "Source ID must not be blank",
      };
    }

    const quantizedAmount = inputAmount.toDecimalPlaces(6).toDecimalPlaces(4, Decimal.ROUND_DOWN);
    if (!quantizedAmount.gt(0)) {
      return {
        success: false,
        newBalance: 0,
        ledgerEntryId: "",
        error: "Amount is below the minimum ledger precision of 0.0001",
      };
    }
    const amountDecimal = quantizedAmount.toFixed(4);
    const balanceQuantized =
      params.balanceAmount === undefined
        ? quantizedAmount
        : new Decimal(params.balanceAmount).toDecimalPlaces(4, Decimal.ROUND_DOWN);
    if (
      !balanceQuantized.isFinite() ||
      balanceQuantized.lt(0) ||
      balanceQuantized.gt(quantizedAmount)
    ) {
      return {
        success: false,
        newBalance: 0,
        ledgerEntryId: "",
        error: "Balance amount must be between 0 and the earning amount",
      };
    }
    const balanceDecimal = balanceQuantized.toFixed(4);
    const ledgerSourceId = normalizeLedgerSourceId(sourceId);
    const ledgerMetadata = normalizeLedgerMetadata({
      ...(metadata ?? {}),
      ...(ledgerSourceId !== sourceId ? { original_source_id: sourceId } : {}),
    });

    const apply = async (tx: DbTransaction) => {
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
        const globallyVersionedAffiliate =
          source === "affiliate" && ledgerMetadata.affiliatePayoutVersion === 1;
        const [existingLedger] = await tx
          .select({
            id: redeemableEarningsLedger.id,
            userId: redeemableEarningsLedger.user_id,
            entryType: redeemableEarningsLedger.entry_type,
            source: redeemableEarningsLedger.earnings_source,
            sourceId: redeemableEarningsLedger.source_id,
            amount: redeemableEarningsLedger.amount,
            description: redeemableEarningsLedger.description,
            metadata: redeemableEarningsLedger.metadata,
          })
          .from(redeemableEarningsLedger)
          .where(
            and(
              eq(redeemableEarningsLedger.entry_type, "earning"),
              eq(redeemableEarningsLedger.earnings_source, source),
              eq(redeemableEarningsLedger.source_id, ledgerSourceId),
              ...(globallyVersionedAffiliate
                ? [sql`${redeemableEarningsLedger.metadata} ->> 'affiliatePayoutVersion' = '1'`]
                : [eq(redeemableEarningsLedger.user_id, userId)]),
            ),
          )
          .limit(1);

        if (existingLedger) {
          if (source === "affiliate") {
            const mismatch =
              existingLedger.userId !== userId
                ? "affiliate owner differs"
                : existingLedger.entryType !== "earning"
                  ? "entry type differs"
                  : existingLedger.source !== source
                    ? "earnings source differs"
                    : existingLedger.sourceId !== ledgerSourceId
                      ? "normalized source ID differs"
                      : !new Decimal(existingLedger.amount).equals(quantizedAmount)
                        ? "amount differs"
                        : existingLedger.description !== description
                          ? "description differs"
                          : !ledgerMetadataMatches(existingLedger.metadata, ledgerMetadata)
                            ? "metadata differs"
                            : null;
            if (mismatch) {
              throw new RedeemableEarningsReplayMismatchError(source, sourceId, mismatch);
            }
          }
          if (!earnings) {
            throw new RedeemableEarningsReplayMismatchError(
              source,
              sourceId,
              "balance row is missing",
            );
          }
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
            total_earned: balanceDecimal,
            available_balance: balanceDecimal,
            earned_from_miniapps: source === "miniapp" ? balanceDecimal : "0.0000",
            earned_from_agents: source === "agent" ? balanceDecimal : "0.0000",
            earned_from_mcps: source === "mcp" ? balanceDecimal : "0.0000",
            earned_from_affiliates: source === "affiliate" ? balanceDecimal : "0.0000",
            earned_from_app_owner_shares:
              source === "app_owner_revenue_share" ? balanceDecimal : "0.0000",
            earned_from_creator_shares:
              source === "creator_revenue_share" ? balanceDecimal : "0.0000",
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
          .set(
            params.reversesRedemption
              ? {
                  total_redeemed: sql`GREATEST(0, ${redeemableEarnings.total_redeemed} - ${balanceDecimal})`,
                  available_balance: sql`${redeemableEarnings.available_balance} + ${balanceDecimal}`,
                  version: sql`${redeemableEarnings.version} + 1`,
                  updated_at: new Date(),
                }
              : {
                  total_earned: sql`${redeemableEarnings.total_earned} + ${balanceDecimal}`,
                  available_balance: sql`${redeemableEarnings.available_balance} + ${balanceDecimal}`,
                  [sourceColumn.name]: sql`${sourceColumn} + ${balanceDecimal}`,
                  last_earning_at: new Date(),
                  version: sql`${redeemableEarnings.version} + 1`,
                  updated_at: new Date(),
                },
          )
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
    };
    const result = transaction ? await apply(transaction) : await dbWrite.transaction(apply);

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
        // Absent earnings on a dedup replay stays an explicit 0; a present but
        // corrupt NUMERIC throws instead of reporting a fabricated balance.
        newBalance: result.earnings
          ? parseRedeemableEarningsNumber(result.earnings.available_balance, "available_balance")
          : 0,
        ledgerEntryId: result.ledgerEntryId,
        deduplicated: true,
      };
    }

    const addedBalance = parseRedeemableEarningsNumber(
      result.earnings.available_balance,
      "available_balance",
    );
    logger.info("[RedeemableEarnings] Added earnings", {
      userId: userId.slice(0, 8) + "...",
      amount,
      source,
      sourceId: sourceId.slice(0, 8) + "...",
      newBalance: addedBalance,
    });

    return {
      success: true,
      newBalance: addedBalance,
      ledgerEntryId: result.ledgerEntryId,
      deduplicated: false,
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
    /**
     * When true, the debit FAILS CLOSED (success:false, no write) if the
     * locked `available_balance` is < amount, instead of flooring the balance
     * to 0 and reporting success. Required for real money-out debits (Stripe
     * Connect payout) so a stale pre-check, a concurrent double-submit, or
     * read-replica lag can never transfer more than the user actually has.
     * Default false preserves the flooring reconciliation behavior for
     * internal callers.
     */
    requireSufficientBalance?: boolean;
    /**
     * When true, the debit is IDEMPOTENT on `sourceId`: a retry that reuses the
     * same source_id (e.g. a money-out payout's idempotency key) finds the prior
     * adjustment ledger row under the per-user advisory lock and returns it
     * without debiting again. Required for real money-out debits whose caller's
     * downstream side-effect (a Stripe transfer) is itself idempotent — without
     * this, a same-key retry double-DEBITs the ledger while the transfer replays
     * once. Default false preserves the additive reconciliation behavior.
     */
    dedupeBySourceId?: boolean;
    countAsRedeemed?: boolean;
    /**
     * When true, the balances (available, total earned and the source column)
     * drop by at most the locked `available_balance`, while the ledger row
     * still books the full amount as debt that later earnings net against.
     * The row's metadata records the balance debit as
     * `applied_balance_debit_usd`, so a later reinstatement can return exactly
     * that. Without it, reversing earnings already paid out would lower
     * `total_earned` under `total_redeemed` and fail the totals CHECK.
     */
    capBalanceDebitAtAvailable?: boolean;
    /** Reuse an owning settlement transaction so every money leg commits together. */
    transaction?: DbTransaction;
  }): Promise<{
    success: boolean;
    newBalance: number;
    ledgerEntryId: string;
    error?: string;
    deduplicated?: boolean;
  }> {
    const {
      userId,
      amount,
      source,
      sourceId,
      description,
      metadata = {},
      requireSufficientBalance = false,
      dedupeBySourceId = false,
      transaction,
    } = params;

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

    const apply = async (tx: DbTransaction) => {
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
          insufficient: false,
          deduplicated: false,
          currentBalance: 0,
        };
      }

      // Idempotency guard: a retry that reuses the same sourceId must not debit
      // twice. Under the per-user advisory lock the check-then-debit is atomic,
      // so an existing adjustment row for this (source, source_id) means the
      // debit already committed on a prior call — return it unchanged.
      if (dedupeBySourceId) {
        const [existingAdjustment] = await tx
          .select({ id: redeemableEarningsLedger.id })
          .from(redeemableEarningsLedger)
          .where(
            and(
              eq(redeemableEarningsLedger.user_id, userId),
              eq(redeemableEarningsLedger.entry_type, "adjustment"),
              eq(redeemableEarningsLedger.earnings_source, source),
              eq(redeemableEarningsLedger.source_id, ledgerSourceId),
            ),
          )
          .limit(1);
        if (existingAdjustment) {
          return {
            earnings,
            ledgerEntryId: existingAdjustment.id,
            skipped: false,
            insufficient: false,
            deduplicated: true,
            currentBalance: parseRedeemableEarningsNumber(
              earnings.available_balance,
              "available_balance",
            ),
          };
        }
      }

      // Fail-closed money-out guard (computed under the row lock, on the
      // primary): never floor-and-pass when the caller requires the full
      // amount to be debitable.
      if (requireSufficientBalance) {
        const currentBalance = parseRedeemableEarningsNumber(
          earnings.available_balance,
          "available_balance",
        );
        if (new Decimal(currentBalance).lessThan(amountDecimal)) {
          return {
            earnings: null,
            ledgerEntryId: "",
            skipped: false,
            insufficient: true,
            deduplicated: false,
            currentBalance,
          };
        }
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

      const balanceDebit = params.capBalanceDebitAtAvailable
        ? Decimal.max(
            0,
            Decimal.min(
              amountDecimal,
              parseRedeemableEarningsNumber(earnings.available_balance, "available_balance"),
            ),
          ).toFixed(4)
        : amountDecimal;

      // Reduce balances - use GREATEST to prevent going negative
      const [updated] = await tx
        .update(redeemableEarnings)
        .set(
          params.countAsRedeemed
            ? {
                total_redeemed: sql`${redeemableEarnings.total_redeemed} + ${balanceDebit}`,
                available_balance: sql`GREATEST(0, ${redeemableEarnings.available_balance} - ${balanceDebit})`,
                version: sql`${redeemableEarnings.version} + 1`,
                updated_at: new Date(),
              }
            : {
                total_earned: sql`GREATEST(0, ${redeemableEarnings.total_earned} - ${balanceDebit})`,
                available_balance: sql`GREATEST(0, ${redeemableEarnings.available_balance} - ${balanceDebit})`,
                [sourceColumn.name]: sql`GREATEST(0, ${sourceColumn} - ${balanceDebit})`,
                version: sql`${redeemableEarnings.version} + 1`,
                updated_at: new Date(),
              },
        )
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
          metadata: params.capBalanceDebitAtAvailable
            ? { ...ledgerMetadata, applied_balance_debit_usd: balanceDebit }
            : ledgerMetadata,
        })
        .returning();

      return {
        earnings: updated,
        ledgerEntryId: ledgerEntry.id,
        skipped: false,
        insufficient: false,
        deduplicated: false,
        currentBalance: 0,
      };
    };
    const result = transaction ? await apply(transaction) : await dbWrite.transaction(apply);

    if (result.deduplicated) {
      logger.info("[RedeemableEarnings] reduceEarnings deduplicated by sourceId (retry)", {
        userId: `${userId.slice(0, 8)}...`,
        source,
        sourceId: `${sourceId.slice(0, 8)}...`,
      });
      return {
        success: true,
        // Absent earnings on a dedup replay stays an explicit 0; a present but
        // corrupt NUMERIC throws instead of reporting a fabricated balance.
        newBalance: result.earnings
          ? parseRedeemableEarningsNumber(result.earnings.available_balance, "available_balance")
          : 0,
        ledgerEntryId: result.ledgerEntryId,
        deduplicated: true,
      };
    }

    if (result.insufficient) {
      return {
        success: false,
        newBalance: result.currentBalance,
        ledgerEntryId: "",
        error: "Insufficient redeemable balance",
      };
    }

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

    const reducedBalance = parseRedeemableEarningsNumber(
      updatedEarnings.available_balance,
      "available_balance",
    );
    logger.info("[RedeemableEarnings] Reduced earnings (reconciliation)", {
      userId: `${userId.slice(0, 8)}...`,
      amount,
      source,
      sourceId: `${sourceId.slice(0, 8)}...`,
      newBalance: reducedBalance,
    });

    return {
      success: true,
      newBalance: reducedBalance,
      ledgerEntryId: result.ledgerEntryId,
    };
  }

  /**
   * Take back the share of an auto top-up affiliate fee that a refund or a
   * dispute reversed. The fee was credited as payable affiliate earnings when
   * the charge succeeded; without this a refunded or disputed charge still
   * paid the affiliate. `reversedCents` is cumulative for `reversalSeries`
   * (the same series the credit clawback uses). Like the credit clawback, the
   * debit is the series delta capped by what the fee still has to return
   * across every series of the payment (a refund and a dispute of one charge
   * reverse it once); a reinstated dispute no longer counts. An already
   * spent or paid-out fee leaves a negative ledger sum that later affiliate
   * earnings net against, while the balances drop only by what is still
   * available; the row records that applied part, so a won dispute gives back
   * only that, as the credit side reinstates only the applied clawback
   * (#31449).
   */
  async reverseAutoTopUpAffiliateFee(params: {
    paymentIntentId: string;
    reversedCents: bigint;
    chargeCents: bigint;
    reversalSeries: string;
    idempotencyKey: string;
  }): Promise<number> {
    const { paymentIntentId, reversedCents, chargeCents, reversalSeries, idempotencyKey } = params;
    if (reversedCents <= 0n || chargeCents <= 0n) return 0;
    const earning = await this.findAutoTopUpAffiliateEarning(paymentIntentId);
    if (!earning) {
      // Credit settlement can commit before the affiliate projection. Keep the
      // reversal in the retry lane until that earning can be reversed as well.
      throw new ElizaError("Auto top-up affiliate earning is not yet available", {
        code: "AFFILIATE_EARNING_PENDING",
        context: { paymentIntentId },
      });
    }

    const fee = new Decimal(earning.amount);
    const reversed = reversedCents < chargeCents ? reversedCents : chargeCents;
    const target = fee
      .mul(reversed.toString())
      .div(chargeCents.toString())
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    return await dbWrite.transaction(async (tx) => {
      // Same lock reduceEarnings takes, so two events of one series cannot
      // both read the old total and debit the same share twice.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`redeemable_earnings:${earning.userId}`}))`,
      );
      const taken = await this.affiliateFeeReversalState(
        tx,
        earning.userId,
        paymentIntentId,
        reversalSeries,
      );
      const delta = Decimal.min(target.minus(taken.series), fee.minus(taken.total));
      if (delta.lte(0)) return 0;
      const result = await this.reduceEarnings({
        userId: earning.userId,
        amount: delta.toNumber(),
        source: "affiliate",
        sourceId: `affiliate_reversal:${idempotencyKey}`,
        dedupeBySourceId: true,
        description: `Auto top-up affiliate fee reversed — ${idempotencyKey}`,
        metadata: {
          payment_intent_id: paymentIntentId,
          affiliate_reversal_series: reversalSeries,
        },
        capBalanceDebitAtAvailable: true,
        transaction: tx,
      });
      if (!result.success) {
        throw new Error(`Failed to reverse affiliate fee for ${paymentIntentId}: ${result.error}`);
      }
      return result.deduplicated ? 0 : delta.toNumber();
    });
  }

  /**
   * A won dispute returns the affiliate fee share its funds-withdrawn event
   * took back. The ledger gets back the whole debit, but the balances get
   * back only the recorded applied part, never the ledger target, so a fee
   * spent or paid out before the dispute is not paid a second time.
   */
  async reinstateAutoTopUpAffiliateFee(params: {
    paymentIntentId: string;
    reversalSeries: string;
    reinstatementKey: string;
  }): Promise<number> {
    const earning = await this.findAutoTopUpAffiliateEarning(params.paymentIntentId);
    if (!earning) return 0;
    return await dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`redeemable_earnings:${earning.userId}`}))`,
      );
      const taken = await this.affiliateFeeReversalState(
        tx,
        earning.userId,
        params.paymentIntentId,
        params.reversalSeries,
      );
      if (taken.series.lte(0)) return 0;
      // The ledger gets back the whole series debit (its unrecovered part was
      // only ever debt); the balances get back only what the debit took.
      const balanceAmount = Decimal.min(taken.seriesApplied, taken.series);
      const result = await this.addEarnings({
        userId: earning.userId,
        amount: taken.series.toFixed(4),
        balanceAmount: balanceAmount.toFixed(4),
        source: "affiliate",
        sourceId: `affiliate_reinstated:${params.reinstatementKey}`,
        dedupeBySourceId: true,
        description: `Auto top-up affiliate fee reinstated — ${params.reinstatementKey}`,
        metadata: {
          payment_intent_id: params.paymentIntentId,
          affiliate_reinstated_series: params.reversalSeries,
        },
        transaction: tx,
      });
      if (!result.success) {
        throw new Error(
          `Failed to reinstate affiliate fee for ${params.paymentIntentId}: ${result.error}`,
        );
      }
      return result.deduplicated ? 0 : balanceAmount.toNumber();
    });
  }

  private async findAutoTopUpAffiliateEarning(
    paymentIntentId: string,
  ): Promise<{ userId: string; amount: string } | null> {
    const [row] = await dbWrite
      .select({ userId: redeemableEarningsLedger.user_id, amount: redeemableEarningsLedger.amount })
      .from(redeemableEarningsLedger)
      .where(
        and(
          eq(redeemableEarningsLedger.entry_type, "earning"),
          eq(redeemableEarningsLedger.earnings_source, "affiliate"),
          sql`${redeemableEarningsLedger.metadata}->>'payment_intent_id' = ${paymentIntentId}`,
          sql`${redeemableEarningsLedger.metadata}->>'original_source_id' LIKE ${`affiliate_auto_topup:${paymentIntentId}:%`}`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * What reversals of one payment's affiliate fee have taken back: in
   * `series`, and across every series. A reversal series that a won dispute
   * reinstated counts in neither, as in the credit clawback. `seriesApplied`
   * is the part of `series` that the balances actually lost.
   */
  private async affiliateFeeReversalState(
    db: DbTransaction,
    userId: string,
    paymentIntentId: string,
    reversalSeries: string,
  ): Promise<{ series: Decimal; total: Decimal; seriesApplied: Decimal }> {
    const ledger = redeemableEarningsLedger;
    const rows = await db
      .select({
        series: sql<string>`${ledger.metadata}->>'affiliate_reversal_series'`,
        taken: sql<string>`SUM(-${ledger.amount})::text`,
        applied: sql<string>`COALESCE(SUM((${ledger.metadata}->>'applied_balance_debit_usd')::numeric), 0)::text`,
      })
      .from(ledger)
      .where(
        and(
          eq(ledger.user_id, userId),
          eq(ledger.entry_type, "adjustment"),
          eq(ledger.earnings_source, "affiliate"),
          sql`${ledger.metadata}->>'payment_intent_id' = ${paymentIntentId}`,
          sql`${ledger.metadata}->>'affiliate_reversal_series' IS NOT NULL`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${ledger} AS reinstated
            WHERE reinstated.user_id = ${userId}
              AND reinstated.entry_type = 'earning'
              AND reinstated.metadata->>'affiliate_reinstated_series' = ${ledger.metadata}->>'affiliate_reversal_series'
          )`,
        ),
      )
      .groupBy(sql`${ledger.metadata}->>'affiliate_reversal_series'`);
    let series = new Decimal(0);
    let total = new Decimal(0);
    let seriesApplied = new Decimal(0);
    for (const row of rows) {
      const taken = new Decimal(row.taken ?? "0");
      total = total.plus(taken);
      if (row.series === reversalSeries) {
        series = taken;
        seriesApplied = new Decimal(row.applied ?? "0");
      }
    }
    return { series, total, seriesApplied };
  }
}

// Export singleton
export const redeemableEarningsService = new RedeemableEarningsService();
