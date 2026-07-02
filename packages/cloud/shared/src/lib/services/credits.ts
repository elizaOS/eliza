/**
 * Credits service for managing organization credit balances and transactions.
 */

import { sql } from "drizzle-orm";
import { type SqlExecutor, sqlRows } from "../../db/execute-helpers";
import { dbWrite, writeTransaction } from "../../db/helpers";
import {
  type CreditPack,
  type CreditTransaction,
  creditPacksRepository,
  creditTransactionsRepository,
  type NewCreditTransaction,
  organizationsRepository,
} from "../../db/repositories";
import { CacheInvalidation } from "../cache/invalidation";
import { invalidateOrganizationCache } from "../cache/organizations-cache";
import { canSendLowCreditsEmail, markLowCreditsEmailSent } from "../email/utils/rate-limiter";
import { calculateCost, getProviderFromModel } from "../pricing";
import { PROVIDER_DEFAULT_MAX_RETRIES, PROVIDER_MAX_BACKOFF_DELAY_MS } from "../providers/_http";
import { logger } from "../utils/logger";
import { getRouteTimeoutMs } from "../utils/request-timeout";
import type { PricingBillingSource } from "./ai-pricing-definitions";
import { emailService } from "./email";
import { organizationsService } from "./organizations";
import { userSessionsService } from "./user-sessions";
import {
  classifyCreditBalance,
  emitWaifuCreditWebhook,
  resolveWaifuWebhookTarget,
} from "./waifu-webhook";

// ============================================================================
// Constants
// ============================================================================

/** Buffer multiplier for cost estimation (default 50%). Configurable via env. */
export const COST_BUFFER = Number(process.env.CREDIT_COST_BUFFER) || 1.5;
/** Minimum reservation amount in USD */
export const MIN_RESERVATION = 0.000001;
/** Epsilon for reconcile float comparisons — 10% of MIN_RESERVATION */
export const EPSILON = MIN_RESERVATION * 0.1;
export const RESERVATION_SETTLEMENT_MARKER = "credit_reservation_v1";
export const APP_CHAT_RESERVATION_SETTLEMENT_MARKER = "app_chat_reservation_v1";
/** Default estimated output tokens when not specified */
export const DEFAULT_OUTPUT_TOKENS = 500;

/**
 * Grace window for the stale-reservation sweep, derived from the WORST-CASE
 * legitimately-in-flight metered request (#11683). The provider HTTP layer
 * retries each call up to PROVIDER_DEFAULT_MAX_RETRIES times (tries = retries
 * + 1), each try holding a fresh per-attempt timeout of up to
 * getRouteTimeoutMs(800) — 800s being the largest metered route budget
 * (`v1/apps/[id]/chat` ROUTE_MAX_DURATION) — with capped backoff between
 * tries, and `withProviderFallback` can run that whole ladder once per
 * provider (primary + fallback). The prior fixed 20-minute grace sat INSIDE
 * that window, so the sweep refunded holds whose settle was still coming and
 * the settle lane then refunded again under its own idempotency key. A truly
 * stranded hold now waits ~2h for its backstop refund — the safe trade
 * (correctness > refund latency).
 */
const SWEEP_MAX_ROUTE_DURATION_SECONDS = 800;
const SWEEP_PROVIDERS_PER_REQUEST = 2;
const SWEEP_SETTLE_MARGIN_MS = 20 * 60 * 1000;
export const RESERVATION_SWEEP_GRACE_MS =
  SWEEP_PROVIDERS_PER_REQUEST *
    ((PROVIDER_DEFAULT_MAX_RETRIES + 1) * getRouteTimeoutMs(SWEEP_MAX_ROUTE_DURATION_SECONDS) +
      PROVIDER_DEFAULT_MAX_RETRIES * PROVIDER_MAX_BACKOFF_DELAY_MS) +
  SWEEP_SETTLE_MARGIN_MS;

// ============================================================================
// Types
// ============================================================================

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
    public readonly reason?: string,
  ) {
    super(
      `Insufficient credits. Required: $${required.toFixed(4)}, Available: $${available.toFixed(4)}`,
    );
    this.name = "InsufficientCreditsError";
  }
}

export interface CreditReservation {
  reservedAmount: number;
  reservationTransactionId?: string | null;
  reconcile: (actualCost: number) => Promise<CreditReconciliationResult | void>;
}

export interface CreditReconciliationResult {
  reservedAmount: number;
  actualCost: number;
  reservationTransactionId?: string | null;
  settlementTransactionIds: string[];
  adjustmentType: "none" | "refund" | "overage" | "uncollected_overage";
}

export interface ReserveCreditsParams {
  organizationId: string;
  userId?: string;
  description: string;
  amount?: number;
  model?: string;
  provider?: string;
  billingSource?: PricingBillingSource;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface ReservationSweepStats {
  scanned: number;
  settled: number;
  skipped: number;
  refunds: number;
  overages: number;
  noops: number;
  uncollectedOverages: number;
  batches: number;
  capHit: boolean;
}

/**
 * Parameters for adding credits to an organization.
 */
export interface AddCreditsParams {
  organizationId: string;
  amount: number;
  description: string;
  metadata?: Record<string, unknown>;
  stripePaymentIntentId?: string;
  /**
   * Internal: execute the mutation on an existing transaction. Used when the
   * caller must hold a DB-level lock across the balance mutation.
   */
  db?: SqlExecutor;
}

/**
 * Parameters for deducting credits from an organization.
 */
export interface DeductCreditsParams {
  /** Organization ID. */
  organizationId: string;
  /** Amount to deduct in USD. */
  amount: number;
  /** Description of the deduction. */
  description: string;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
  /** Optional session token for tracking. */
  session_token?: string;
  /** Optional tokens consumed for usage tracking. */
  tokens_consumed?: number;
  /**
   * Optional idempotency key. When set, a prior committed deduction with the
   * same key returns that transaction instead of deducting again — backed by the
   * unique index on `stripe_payment_intent_id`. Used by {@link reconcile} so a
   * retry after a commit-then-ack-loss cannot double-charge an overage (#10846).
   * Omit it (all existing callers) for the unchanged non-idempotent behavior.
   */
  stripePaymentIntentId?: string;
}

export interface ReserveAndDeductParams extends DeductCreditsParams {
  /** Minimum balance required before deduction (prevents race conditions) */
  minimumBalanceRequired?: number;
}

interface CreditMutationRow {
  org_exists: boolean | string | number | null;
  current_balance: string | number | null;
  new_balance: string | number | null;
  id: string | null;
  organization_id: string | null;
  user_id: string | null;
  amount: string | number | null;
  type: string | null;
  description: string | null;
  metadata: Record<string, unknown> | string | null;
  stripe_payment_intent_id: string | null;
  created_at: Date | string | null;
  settled_at?: Date | string | null;
}

interface ClawbackMutationRow extends CreditMutationRow {
  applied_amount: string | number | null;
  shortfall_amount: string | number | null;
  already_processed: boolean | string | number | null;
}

function isPgTrue(value: boolean | string | number | null | undefined): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function parseNumeric(value: string | number | null | undefined, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    throw new Error(`[CreditsService] Invalid numeric ${fieldName}`);
  }
  return parsed;
}

function parseMetadata(value: CreditMutationRow["metadata"]): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }
  return value;
}

function metadataNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Org-charge a generic stale hold settles to during the stranded-reservation
 * sweep. Generic reservation rows (`credit_reservation_v1`) store
 * `estimated_cost` in ORG-CHARGE units — the same unit as the row amount — so
 * the sweep settles to it directly (missing estimate means exact-cost, no
 * refund). App-chat rows are routed through `sweepAppChatReservation` before
 * this helper because their estimates are in base-cost units and must use the
 * app-credits settle lane for markup and creator-earnings reconciliation.
 */
function staleHoldSettleCost(reservedAmount: number, metadata: Record<string, unknown>): number {
  const estimate =
    metadataNumber(metadata.estimated_cost) ?? metadataNumber(metadata.estimatedCost);
  return estimate ?? reservedAmount;
}

function toCreditTransaction(row: CreditMutationRow): CreditTransaction {
  if (!row.id || !row.organization_id || !row.amount || !row.type || !row.created_at) {
    throw new Error("[CreditsService] Credit mutation did not return a transaction row");
  }

  return {
    id: row.id,
    organization_id: row.organization_id,
    user_id: row.user_id,
    amount: String(row.amount),
    type: row.type,
    description: row.description,
    metadata: parseMetadata(row.metadata),
    stripe_payment_intent_id: row.stripe_payment_intent_id,
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    settled_at:
      row.settled_at == null
        ? null
        : row.settled_at instanceof Date
          ? row.settled_at
          : new Date(row.settled_at),
  };
}

/**
 * Service for managing credits, transactions, and credit packs.
 */
export class CreditsService {
  private async applyCreditIncrease(
    params: AddCreditsParams & {
      transactionType: "credit" | "refund" | "clawback";
    },
  ): Promise<{
    transaction: CreditTransaction;
    newBalance: number;
  }> {
    const {
      organizationId,
      amount,
      description,
      metadata,
      stripePaymentIntentId,
      transactionType,
    } = params;
    const executor = params.db ?? dbWrite;
    const metadataJson = JSON.stringify(metadata ?? {});
    const stripeId = stripePaymentIntentId ?? null;

    const rows = await sqlRows<CreditMutationRow>(
      executor,
      sql`
        WITH org AS (
          SELECT id, credit_balance::numeric AS current_balance
          FROM organizations
          WHERE id = ${organizationId}
          FOR UPDATE
        ),
        inserted AS (
          INSERT INTO credit_transactions (
            organization_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
          )
          SELECT
            org.id,
            ${String(amount)}::numeric,
            ${transactionType},
            ${description},
            ${metadataJson}::jsonb,
            ${stripeId},
            NOW()
          FROM org
          WHERE ${stripeId}::text IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM credit_transactions
               WHERE stripe_payment_intent_id = ${stripeId}
             )
          ON CONFLICT (stripe_payment_intent_id) DO NOTHING
          RETURNING
            id,
            organization_id,
            user_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
        ),
        existing AS (
          SELECT
            id,
            organization_id,
            user_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
          FROM credit_transactions
          WHERE ${stripeId}::text IS NOT NULL
            AND stripe_payment_intent_id = ${stripeId}
          LIMIT 1
        ),
        chosen_transaction AS (
          SELECT * FROM inserted
          UNION ALL
          SELECT * FROM existing
          WHERE NOT EXISTS (SELECT 1 FROM inserted)
          LIMIT 1
        ),
        updated AS (
          UPDATE organizations AS o
          SET
            credit_balance = org.current_balance + ${String(amount)}::numeric,
            updated_at = NOW()
          FROM org
          WHERE o.id = org.id
            AND EXISTS (SELECT 1 FROM inserted)
          RETURNING o.credit_balance AS new_balance
        )
        SELECT
          EXISTS(SELECT 1 FROM org) AS org_exists,
          (SELECT current_balance FROM org) AS current_balance,
          COALESCE((SELECT new_balance FROM updated), (SELECT current_balance FROM org)) AS new_balance,
          chosen_transaction.id,
          chosen_transaction.organization_id,
          chosen_transaction.user_id,
          chosen_transaction.amount,
          chosen_transaction.type,
          chosen_transaction.description,
          chosen_transaction.metadata,
          chosen_transaction.stripe_payment_intent_id,
          chosen_transaction.created_at
        FROM (SELECT 1) AS singleton
        LEFT JOIN chosen_transaction ON true
      `,
    );

    const row = rows[0];
    if (!row || !isPgTrue(row.org_exists)) {
      throw new Error("Organization not found");
    }

    if (!row.id && stripePaymentIntentId && !params.db) {
      const existingTransaction =
        await this.getTransactionByStripePaymentIntent(stripePaymentIntentId);
      if (existingTransaction) {
        const org = await organizationsRepository.findById(organizationId);
        if (!org) {
          throw new Error("Organization not found");
        }
        return {
          transaction: existingTransaction,
          newBalance: Number.parseFloat(String(org.credit_balance)),
        };
      }
    }

    return {
      transaction: toCreditTransaction(row),
      newBalance: parseNumeric(row.new_balance, "new_balance"),
    };
  }

  // Credit Transactions
  async getTransactionById(id: string): Promise<CreditTransaction | undefined> {
    return await creditTransactionsRepository.findById(id);
  }

  /**
   * Read an organization's current credit balance (USD) directly from the DB,
   * bypassing the org service cache (#9899). Used by the optimistic-billing gate
   * so the fast-vs-safe decision is made on a fresh number, not a 5–10 min
   * cached one. Called only on the gate's COLD path (the gate caches its own
   * short-lived hint), so it is not on the per-request hot path. Returns 0 for a
   * missing org so the gate fails safe (slow path).
   */
  async getOrganizationBalanceUsd(organizationId: string): Promise<number> {
    const org = await organizationsRepository.findById(organizationId);
    return org ? Number(org.credit_balance) : 0;
  }

  async getTransactionByStripePaymentIntent(
    paymentIntentId: string,
  ): Promise<CreditTransaction | undefined> {
    return await creditTransactionsRepository.findByStripePaymentIntent(paymentIntentId);
  }

  async listTransactionsByOrganization(
    organizationId: string,
    limit?: number,
  ): Promise<CreditTransaction[]> {
    return await creditTransactionsRepository.listByOrganization(organizationId, limit);
  }

  async listTransactionsByOrganizationAndType(
    organizationId: string,
    type: string,
  ): Promise<CreditTransaction[]> {
    return await creditTransactionsRepository.listByOrganizationAndType(organizationId, type);
  }

  async createTransaction(data: NewCreditTransaction): Promise<CreditTransaction> {
    return await creditTransactionsRepository.create(data);
  }

  async addCredits(params: AddCreditsParams): Promise<{
    transaction: CreditTransaction;
    newBalance: number;
  }> {
    const { organizationId, amount, description, metadata, stripePaymentIntentId, db } = params;

    // IDEMPOTENCY: If stripePaymentIntentId is provided, check for existing transaction
    // This prevents race conditions when both synchronous and webhook calls try to add credits
    if (stripePaymentIntentId && !db) {
      const existingTransaction =
        await this.getTransactionByStripePaymentIntent(stripePaymentIntentId);

      if (existingTransaction) {
        logger.info(
          `[CreditsService] Idempotency: Payment intent ${stripePaymentIntentId} already processed (transaction ${existingTransaction.id})`,
        );

        // Get current balance to return consistent response
        const org = await organizationsRepository.findById(organizationId);
        if (!org) {
          throw new Error("Organization not found");
        }

        return {
          transaction: existingTransaction,
          newBalance: Number.parseFloat(String(org.credit_balance)),
        };
      }
    }

    const result = await this.applyCreditIncrease({
      organizationId,
      amount,
      description,
      metadata,
      stripePaymentIntentId,
      db,
      transactionType: "credit",
    }).then(async (result) => {
      invalidateOrganizationCache(organizationId).catch((error) => {
        logger.error("[CreditsService] Failed to invalidate org cache:", error);
      });
      return result;
    });

    // Invalidate balance cache immediately after transaction
    await CacheInvalidation.onCreditMutation(organizationId);

    return result;
  }

  async deductCredits(params: DeductCreditsParams): Promise<{
    success: boolean;
    newBalance: number;
    transaction: CreditTransaction | null;
    reason?: "insufficient_balance" | "below_minimum" | "org_not_found";
  }> {
    // Delegate to reserveAndDeduct with no minimum balance requirement
    return this.reserveAndDeductCredits(params);
  }

  /**
   * Atomically check balance and deduct credits in a single transaction.
   * This prevents TOCTOU race conditions by using row-level locking.
   *
   * @param minimumBalanceRequired - Optional minimum balance that must exist BEFORE deduction
   *                                 (useful for reserving credits for estimated costs)
   */
  async reserveAndDeductCredits(params: ReserveAndDeductParams): Promise<{
    success: boolean;
    newBalance: number;
    transaction: CreditTransaction | null;
    reason?: "insufficient_balance" | "below_minimum" | "org_not_found";
  }> {
    const {
      organizationId,
      amount,
      description,
      metadata,
      session_token,
      tokens_consumed,
      minimumBalanceRequired = 0,
      stripePaymentIntentId,
    } = params;

    if (amount <= 0) {
      throw new Error("Amount must be positive");
    }

    // Opt-in idempotency: a keyed deduction that already committed (e.g. a
    // reconcile retry after the commit landed but the ack was lost) returns the
    // prior transaction instead of deducting again. The unique index on
    // stripe_payment_intent_id is the concurrency backstop (a racing duplicate
    // aborts the whole atomic statement, and the caller retries into this
    // check). Callers that pass no key keep the exact previous behavior. (#10846)
    if (stripePaymentIntentId) {
      const existing = await this.getTransactionByStripePaymentIntent(stripePaymentIntentId);
      if (existing) {
        return {
          success: true,
          newBalance: await this.getOrganizationBalanceUsd(organizationId),
          transaction: existing,
        };
      }
    }
    const stripeId = stripePaymentIntentId ?? null;

    const metadataJson = JSON.stringify(metadata ?? {});
    const rows = await sqlRows<CreditMutationRow>(
      dbWrite,
      sql`
        WITH org AS (
          SELECT id, credit_balance::numeric AS current_balance
          FROM organizations
          WHERE id = ${organizationId}
          FOR UPDATE
        ),
        eligible AS (
          SELECT
            id,
            current_balance,
            current_balance - ${String(amount)}::numeric AS new_balance
          FROM org
          WHERE current_balance >= ${String(minimumBalanceRequired)}::numeric
            AND current_balance >= ${String(amount)}::numeric
        ),
        updated AS (
          UPDATE organizations AS o
          SET
            credit_balance = eligible.new_balance,
            updated_at = NOW()
          FROM eligible
          WHERE o.id = eligible.id
          RETURNING eligible.new_balance
        ),
        inserted AS (
          INSERT INTO credit_transactions (
            organization_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
          )
          SELECT
            eligible.id,
            ${String(-amount)}::numeric,
            'debit',
            ${description},
            ${metadataJson}::jsonb,
            ${stripeId},
            NOW()
          FROM eligible
          WHERE EXISTS (SELECT 1 FROM updated)
          RETURNING
            id,
            organization_id,
            user_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
        )
        SELECT
          EXISTS(SELECT 1 FROM org) AS org_exists,
          (SELECT current_balance FROM org) AS current_balance,
          (SELECT new_balance FROM updated) AS new_balance,
          inserted.id,
          inserted.organization_id,
          inserted.user_id,
          inserted.amount,
          inserted.type,
          inserted.description,
          inserted.metadata,
          inserted.stripe_payment_intent_id,
          inserted.created_at
        FROM (SELECT 1) AS singleton
        LEFT JOIN inserted ON true
      `,
    );

    const row = rows[0];
    let result:
      | {
          success: true;
          newBalance: number;
          transaction: CreditTransaction;
        }
      | {
          success: false;
          newBalance: number;
          transaction: null;
          reason: "insufficient_balance" | "below_minimum" | "org_not_found";
        };

    if (!row || !isPgTrue(row.org_exists)) {
      result = {
        success: false,
        newBalance: 0,
        transaction: null,
        reason: "org_not_found",
      };
    } else if (!row.id) {
      const currentBalance = parseNumeric(row.current_balance, "current_balance");
      result = {
        success: false,
        newBalance: currentBalance,
        transaction: null,
        reason:
          minimumBalanceRequired > 0 && currentBalance < minimumBalanceRequired
            ? "below_minimum"
            : "insufficient_balance",
      };
    } else {
      result = {
        success: true,
        newBalance: parseNumeric(row.new_balance, "new_balance"),
        transaction: toCreditTransaction(row),
      };
    }

    return await Promise.resolve(result).then(async (result) => {
      // Invalidate organization cache if balance changed
      if (result.success) {
        invalidateOrganizationCache(organizationId).catch((error) => {
          logger.error("[CreditsService] Failed to invalidate org cache:", error);
        });
        // Invalidate balance cache immediately after successful deduction
        await CacheInvalidation.onCreditMutation(organizationId);

        // Track session usage if session_token is provided
        if (session_token) {
          userSessionsService
            .trackUsage({
              session_token,
              credits_used: amount,
              requests_made: 1,
              tokens_consumed: tokens_consumed || 0,
            })
            .catch((error) => {
              logger.error("[CreditsService] Failed to track session usage:", error);
            });
        }

        this.notifyBalanceDecrease(organizationId, result.newBalance, metadata);
      }
      return result;
    });
  }

  /**
   * Fire the post-debit notifications a balance decrease triggers: auto-top-up
   * check, low-credits email, and the waifu webhook that lets a hosted agent
   * downgrade/pause itself when it runs low. Fire-and-forget — a notification
   * failure must never block the billing path. Exposed (not inlined) so EVERY
   * debit path stays at parity: the synchronous reserve calls it here, and the
   * optimistic inference ledger (`inference-billing-ledger.ts`), which mutates the
   * balance with its own transactional SQL rather than through `deductCredits`,
   * calls it after a successful debit so its orgs still get low-balance warnings.
   */
  notifyBalanceDecrease(
    organizationId: string,
    newBalance: number,
    metadata?: Record<string, unknown>,
  ): void {
    this.checkAndTriggerAutoTopUp(organizationId, newBalance).catch((error) => {
      logger.error("[CreditsService] Failed to check auto top-up:", error);
    });
    this.queueLowCreditsEmail(organizationId, newBalance).catch((error) => {
      logger.error("[CreditsService] Failed to queue low credits email:", error);
    });
    this.notifyWaifuCredits(organizationId, newBalance, metadata).catch((error) => {
      logger.error("[CreditsService] Failed to notify waifu credit webhook:", error);
    });
  }

  /**
   * Emit a credit-state transition to waifu when a hosted agent crosses the
   * low / depleted thresholds. No-ops cleanly when the waifu webhook is not
   * configured (resolveWaifuWebhookTarget returns null), so non-waifu orgs and
   * local/dev environments are unaffected.
   */
  private async notifyWaifuCredits(
    organizationId: string,
    newBalance: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const target = resolveWaifuWebhookTarget();
    if (!target) {
      return;
    }

    const threshold = parseInt(process.env.LOW_CREDITS_THRESHOLD || "1000", 10);
    const status = classifyCreditBalance(newBalance, threshold);
    if (!status) {
      return;
    }

    const cloudAgentId =
      typeof metadata?.agent_id === "string"
        ? metadata.agent_id
        : typeof metadata?.agentId === "string"
          ? metadata.agentId
          : undefined;

    await emitWaifuCreditWebhook({
      status,
      organizationId,
      newBalance,
      threshold,
      ...(cloudAgentId ? { cloudAgentId } : {}),
    });
  }

  /**
   * Check if auto top-up should be triggered after credit deduction
   * This is called automatically after every successful credit deduction
   */
  private async checkAndTriggerAutoTopUp(
    organizationId: string,
    newBalance: number,
  ): Promise<void> {
    try {
      // Get organization details
      const org = await organizationsRepository.findById(organizationId);
      if (!org) {
        return;
      }

      // Check if auto top-up is enabled
      if (!org.auto_top_up_enabled) {
        return;
      }

      const threshold = Number(org.auto_top_up_threshold || 0);

      // Check if balance is below threshold
      if (newBalance >= threshold) {
        return;
      }

      logger.info(
        `[CreditsService] Auto top-up triggered: balance $${newBalance.toFixed(2)} < threshold $${threshold.toFixed(2)}`,
      );

      // Import auto top-up service dynamically for lazy loading (only when needed)
      const { autoTopUpService } = await import("./auto-top-up");

      // Execute auto top-up asynchronously (don't block the main operation)
      autoTopUpService.executeAutoTopUp(org).catch((error) => {
        logger.error(
          `[CreditsService] Auto top-up execution failed for org ${organizationId}:`,
          error,
        );
      });
    } catch (error) {
      logger.error(`[CreditsService] Error checking auto top-up for org ${organizationId}:`, error);
    }
  }

  private async queueLowCreditsEmail(
    organizationId: string,
    currentBalance: number,
  ): Promise<void> {
    try {
      const threshold = parseInt(process.env.LOW_CREDITS_THRESHOLD || "1000", 10);

      if (currentBalance <= 0 || currentBalance > threshold) {
        return;
      }

      const canSend = await canSendLowCreditsEmail(organizationId);
      if (!canSend) {
        return;
      }

      const org = await organizationsService.getById(organizationId);
      if (!org) {
        return;
      }

      const recipientEmail = org.billing_email;
      if (!recipientEmail) {
        logger.warn("[CreditsService] No billing email for organization", {
          organizationId,
        });
        return;
      }

      const sent = await emailService.sendLowCreditsEmail({
        email: recipientEmail,
        organizationName: org.name,
        currentBalance,
        threshold,
        billingUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing`,
      });

      if (sent) {
        await markLowCreditsEmailSent(organizationId);
      }
    } catch (error) {
      logger.error(
        `[CreditsService] Error queueing low credits email for org ${organizationId}:`,
        error,
      );
    }
  }

  /**
   * Refund credits (e.g., when a generation fails after deduction)
   * Creates a credit transaction to restore the amount
   */
  async refundCredits(params: AddCreditsParams): Promise<{
    transaction: CreditTransaction;
    newBalance: number;
  }> {
    const { organizationId, amount, description, metadata, stripePaymentIntentId } = params;

    if (amount <= 0) {
      throw new Error("Refund amount must be positive");
    }

    return await this.applyCreditIncrease({
      organizationId,
      amount,
      description,
      metadata,
      // Thread the idempotency key so a reconcile retry doesn't double-refund
      // (applyCreditIncrease dedupes on stripe_payment_intent_id via ON
      // CONFLICT DO NOTHING). (#10846)
      stripePaymentIntentId,
      transactionType: "refund",
    }).then(async (result) => {
      invalidateOrganizationCache(organizationId).catch((error) => {
        logger.error("[CreditsService] Failed to invalidate org cache:", error);
      });
      return result;
    });
  }

  /**
   * Claw back credits after a Stripe refund / chargeback (#10920). The live
   * organizations table forbids negative credit balances, so this applies as much
   * of the clawback as the current balance can cover, floors the balance at zero,
   * and records any unrecovered shortfall in transaction metadata for follow-up.
   * Idempotent on `stripePaymentIntentId` (key it on the refund/dispute so a
   * re-delivered webhook doesn't double-claw).
   */
  async clawbackCredits(params: {
    organizationId: string;
    amount: number;
    description: string;
    stripePaymentIntentId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    transaction: CreditTransaction;
    newBalance: number;
    appliedAmount: number;
    shortfallAmount: number;
    alreadyProcessed: boolean;
  }> {
    if (params.amount <= 0) {
      throw new Error("Clawback amount must be positive");
    }

    const metadataJson = JSON.stringify(params.metadata ?? {});
    const rows = await sqlRows<ClawbackMutationRow>(
      dbWrite,
      sql`
        WITH org AS (
          SELECT id, credit_balance::numeric AS current_balance
          FROM organizations
          WHERE id = ${params.organizationId}
          FOR UPDATE
        ),
        existing AS (
          SELECT
            id,
            organization_id,
            user_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
          FROM credit_transactions
          WHERE stripe_payment_intent_id = ${params.stripePaymentIntentId}
          LIMIT 1
        ),
        candidate AS (
          SELECT
            id,
            current_balance,
            LEAST(${String(params.amount)}::numeric, GREATEST(current_balance, 0)) AS applied_amount,
            GREATEST(current_balance - ${String(params.amount)}::numeric, 0) AS new_balance,
            GREATEST(${String(params.amount)}::numeric - GREATEST(current_balance, 0), 0) AS shortfall_amount
          FROM org
          WHERE NOT EXISTS (SELECT 1 FROM existing)
        ),
        updated AS (
          UPDATE organizations AS o
          SET
            credit_balance = candidate.new_balance,
            updated_at = NOW()
          FROM candidate
          WHERE o.id = candidate.id
          RETURNING o.credit_balance AS new_balance
        ),
        inserted AS (
          INSERT INTO credit_transactions (
            organization_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
          )
          SELECT
            candidate.id,
            -candidate.applied_amount,
            'clawback',
            ${params.description},
            ${metadataJson}::jsonb || jsonb_build_object(
              'requested_clawback_usd', ${String(params.amount)}::numeric,
              'applied_clawback_usd', candidate.applied_amount,
              'unrecovered_clawback_usd', candidate.shortfall_amount
            ),
            ${params.stripePaymentIntentId},
            NOW()
          FROM candidate
          WHERE EXISTS (SELECT 1 FROM updated)
          ON CONFLICT (stripe_payment_intent_id) DO NOTHING
          RETURNING
            id,
            organization_id,
            user_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
        ),
        chosen_transaction AS (
          SELECT * FROM inserted
          UNION ALL
          SELECT * FROM existing
          WHERE NOT EXISTS (SELECT 1 FROM inserted)
          LIMIT 1
        )
        SELECT
          EXISTS(SELECT 1 FROM org) AS org_exists,
          (SELECT current_balance FROM org) AS current_balance,
          COALESCE((SELECT new_balance FROM updated), (SELECT current_balance FROM org)) AS new_balance,
          chosen_transaction.id,
          chosen_transaction.organization_id,
          chosen_transaction.user_id,
          chosen_transaction.amount,
          chosen_transaction.type,
          chosen_transaction.description,
          chosen_transaction.metadata,
          chosen_transaction.stripe_payment_intent_id,
          chosen_transaction.created_at,
          COALESCE((SELECT applied_amount FROM candidate), ABS((SELECT amount FROM existing)), 0) AS applied_amount,
          COALESCE(
            (SELECT shortfall_amount FROM candidate),
            NULLIF((SELECT metadata->>'unrecovered_clawback_usd' FROM existing), '')::numeric,
            0
          ) AS shortfall_amount,
          EXISTS(SELECT 1 FROM existing) AS already_processed
        FROM (SELECT 1) AS singleton
        LEFT JOIN chosen_transaction ON true
      `,
    );

    const row = rows[0];
    if (!row || !isPgTrue(row.org_exists)) {
      throw new Error("Organization not found");
    }
    if (!row.id) {
      const existing = await this.getTransactionByStripePaymentIntent(params.stripePaymentIntentId);
      const org = await organizationsRepository.findById(params.organizationId);
      if (existing && org) {
        const metadata = parseMetadata(existing.metadata);
        return {
          transaction: existing,
          newBalance: Number.parseFloat(String(org.credit_balance)),
          appliedAmount: Math.abs(Number(existing.amount)),
          shortfallAmount: Number(metadata.unrecovered_clawback_usd ?? 0),
          alreadyProcessed: true,
        };
      }
      throw new Error("[CreditsService] Clawback did not return a transaction row");
    }

    const result = {
      transaction: toCreditTransaction(row),
      newBalance: parseNumeric(row.new_balance, "new_balance"),
      appliedAmount: parseNumeric(row.applied_amount, "applied_amount"),
      shortfallAmount: parseNumeric(row.shortfall_amount, "shortfall_amount"),
      alreadyProcessed: isPgTrue(row.already_processed),
    };

    invalidateOrganizationCache(params.organizationId).catch((error) => {
      logger.error("[CreditsService] Failed to invalidate org cache:", error);
    });
    return result;
  }

  /**
   * Total USD already clawed back for a Stripe payment intent (sum of prior
   * `clawback` debits tagged with it). Lets the refund handler claw back only the
   * DELTA of a cumulative `amount_refunded` across multiple partial refunds
   * without double-charging. (#10920)
   *
   * Won-dispute reinstatements (the `refund` row that
   * handleChargeDisputeFundsReinstated writes with
   * metadata.source = 'charge.dispute.funds_reinstated') NET AGAINST the tally:
   * clawback rows carry a negative amount (so `-amount` adds), reinstatement
   * refunds carry a positive amount (so `-amount` subtracts). Without netting,
   * a refund that follows a won dispute would see the stale dispute clawback
   * as "already clawed" and under-claw by that amount. (#11155)
   */
  async getClawedBackUsdForPaymentIntent(paymentIntentId: string): Promise<number> {
    const rows = await sqlRows<{ total: string | number | null }>(
      dbWrite,
      sql`
        SELECT COALESCE(SUM(-amount), 0) AS total
        FROM credit_transactions
        WHERE metadata->>'payment_intent_id' = ${paymentIntentId}
          AND (
            type = 'clawback'
            OR (type = 'refund' AND metadata->>'source' = 'charge.dispute.funds_reinstated')
          )
      `,
    );
    return parseNumeric(rows[0]?.total ?? 0, "clawed_back_total");
  }

  private async reconcileReservationTransaction(params: {
    organizationId: string;
    reservationTransactionId: string;
    actualCost: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<
    | {
        kind: "handled";
        claimed: boolean;
        result: CreditReconciliationResult;
        newBalance?: number;
        balanceDecreaseMetadata?: Record<string, unknown>;
      }
    | { kind: "no_reservation_row" }
  > {
    const { organizationId, reservationTransactionId, actualCost, description, metadata } = params;

    const existingSettlementIds = async (executor: SqlExecutor): Promise<string[]> => {
      const rows = await sqlRows<{ id: string }>(
        executor,
        sql`
          SELECT id
          FROM credit_transactions
          WHERE metadata->>'reservation_transaction_id' = ${reservationTransactionId}
            AND organization_id = ${organizationId}
          ORDER BY created_at ASC
        `,
      );
      return rows.map((row) => row.id);
    };

    const result = await writeTransaction(async (tx) => {
      const reservationRows = await sqlRows<{
        id: string;
        amount: string | number;
        settled_at: Date | string | null;
      }>(
        tx,
        sql`
          SELECT id, amount, settled_at
          FROM credit_transactions
          WHERE id = ${reservationTransactionId}
            AND organization_id = ${organizationId}
            AND type = 'debit'
            AND (
              metadata->>'type' = 'reservation'
              OR (
                metadata->>'type' = 'app_chat_reservation'
                AND metadata->>'settlement_marker' = ${APP_CHAT_RESERVATION_SETTLEMENT_MARKER}
              )
            )
          LIMIT 1
        `,
      );
      const reservation = reservationRows[0];
      if (!reservation) {
        return { kind: "no_reservation_row" as const };
      }

      const reservedAmount = Math.abs(parseNumeric(reservation.amount, "reservation_amount"));

      if (reservation.settled_at !== null) {
        return {
          kind: "handled" as const,
          claimed: false,
          result: {
            reservedAmount,
            actualCost,
            reservationTransactionId,
            settlementTransactionIds: await existingSettlementIds(tx),
            adjustmentType: "none" as const,
          },
        };
      }

      const preexistingSettlementIds = await existingSettlementIds(tx);
      if (preexistingSettlementIds.length > 0) {
        const markedRows = await sqlRows<{ id: string }>(
          tx,
          sql`
            UPDATE credit_transactions
            SET settled_at = NOW()
            WHERE id = ${reservationTransactionId}
              AND organization_id = ${organizationId}
              AND type = 'debit'
              AND (
                metadata->>'type' = 'reservation'
                OR (
                  metadata->>'type' = 'app_chat_reservation'
                  AND metadata->>'settlement_marker' = ${APP_CHAT_RESERVATION_SETTLEMENT_MARKER}
                )
              )
              AND settled_at IS NULL
            RETURNING id
          `,
        );
        return {
          kind: "handled" as const,
          claimed: markedRows.length > 0,
          result: {
            reservedAmount,
            actualCost,
            reservationTransactionId,
            settlementTransactionIds: preexistingSettlementIds,
            adjustmentType: "none" as const,
          },
        };
      }

      const claimedRows = await sqlRows<{
        id: string;
        amount: string | number;
      }>(
        tx,
        sql`
          UPDATE credit_transactions
          SET settled_at = NOW()
          WHERE id = ${reservationTransactionId}
            AND organization_id = ${organizationId}
            AND type = 'debit'
            AND (
              metadata->>'type' = 'reservation'
              OR (
                metadata->>'type' = 'app_chat_reservation'
                AND metadata->>'settlement_marker' = ${APP_CHAT_RESERVATION_SETTLEMENT_MARKER}
              )
            )
            AND settled_at IS NULL
          RETURNING id, amount
        `,
      );
      const claimed = claimedRows[0];
      if (!claimed) {
        return {
          kind: "handled" as const,
          claimed: false,
          result: {
            reservedAmount,
            actualCost,
            reservationTransactionId,
            settlementTransactionIds: await existingSettlementIds(tx),
            adjustmentType: "none" as const,
          },
        };
      }

      const claimedReservedAmount = Math.abs(parseNumeric(claimed.amount, "reservation_amount"));
      const normalizedActualCost = Math.max(actualCost, 0);
      const difference = claimedReservedAmount - normalizedActualCost;
      const baseMetadata = {
        ...metadata,
        reservation_transaction_id: reservationTransactionId,
        reserved: claimedReservedAmount,
        actual: normalizedActualCost,
      };

      if (Math.abs(difference) < EPSILON) {
        return {
          kind: "handled" as const,
          claimed: true,
          result: {
            reservedAmount: claimedReservedAmount,
            actualCost: normalizedActualCost,
            reservationTransactionId,
            settlementTransactionIds: [],
            adjustmentType: "none" as const,
          },
        };
      }

      if (difference > 0) {
        const refundMetadata = JSON.stringify({
          ...baseMetadata,
          type: "reconciliation_refund",
        });
        const refundRows = await sqlRows<{
          id: string | null;
          new_balance: string | number | null;
        }>(
          tx,
          sql`
            WITH org AS (
              SELECT id, credit_balance::numeric AS current_balance
              FROM organizations
              WHERE id = ${organizationId}
              FOR UPDATE
            ),
            updated AS (
              UPDATE organizations AS o
              SET credit_balance = org.current_balance + ${String(difference)}::numeric,
                  updated_at = NOW()
              FROM org
              WHERE o.id = org.id
              RETURNING o.credit_balance AS new_balance
            ),
            inserted AS (
              INSERT INTO credit_transactions (
                organization_id,
                amount,
                type,
                description,
                metadata,
                stripe_payment_intent_id,
                created_at
              )
              SELECT
                org.id,
                ${String(difference)}::numeric,
                'refund',
                ${`${description} (refund)`},
                ${refundMetadata}::jsonb,
                ${`recon:${reservationTransactionId}:refund`},
                NOW()
              FROM org
              WHERE EXISTS (SELECT 1 FROM updated)
              ON CONFLICT (stripe_payment_intent_id) DO NOTHING
              RETURNING id
            )
            SELECT
              (SELECT id FROM inserted) AS id,
              (SELECT new_balance FROM updated) AS new_balance
          `,
        );
        const refund = refundRows[0];
        if (!refund?.id) {
          throw new Error("[CreditsService] Reservation refund settlement did not insert a row");
        }
        return {
          kind: "handled" as const,
          claimed: true,
          newBalance: parseNumeric(refund.new_balance, "new_balance"),
          result: {
            reservedAmount: claimedReservedAmount,
            actualCost: normalizedActualCost,
            reservationTransactionId,
            settlementTransactionIds: [refund.id],
            adjustmentType: "refund" as const,
          },
        };
      }

      const overage = -difference;
      const overageMetadata = JSON.stringify({
        ...baseMetadata,
        type: "reconciliation_overage",
      });
      const overageRows = await sqlRows<{
        id: string | null;
        debited: boolean | string | number | null;
        new_balance: string | number | null;
      }>(
        tx,
        sql`
          WITH org AS (
            SELECT id, credit_balance::numeric AS current_balance
            FROM organizations
            WHERE id = ${organizationId}
            FOR UPDATE
          ),
          updated AS (
            UPDATE organizations AS o
            SET credit_balance = org.current_balance - ${String(overage)}::numeric,
                updated_at = NOW()
            FROM org
            WHERE o.id = org.id
              AND org.current_balance >= ${String(overage)}::numeric
            RETURNING o.credit_balance AS new_balance
          ),
          inserted AS (
            INSERT INTO credit_transactions (
              organization_id,
              amount,
              type,
              description,
              metadata,
              stripe_payment_intent_id,
              created_at
            )
            SELECT
              org.id,
              ${String(-overage)}::numeric,
              'debit',
              ${`${description} (overage)`},
              ${overageMetadata}::jsonb,
              ${`recon:${reservationTransactionId}:overage`},
              NOW()
            FROM org
            WHERE EXISTS (SELECT 1 FROM updated)
            ON CONFLICT (stripe_payment_intent_id) DO NOTHING
            RETURNING id
          )
          SELECT
            EXISTS(SELECT 1 FROM updated) AS debited,
            (SELECT id FROM inserted) AS id,
            (SELECT new_balance FROM updated) AS new_balance
        `,
      );
      const overageRow = overageRows[0];
      if (!isPgTrue(overageRow?.debited)) {
        return {
          kind: "handled" as const,
          claimed: true,
          result: {
            reservedAmount: claimedReservedAmount,
            actualCost: normalizedActualCost,
            reservationTransactionId,
            settlementTransactionIds: [],
            adjustmentType: "uncollected_overage" as const,
          },
        };
      }
      if (!overageRow?.id) {
        throw new Error("[CreditsService] Reservation overage settlement did not insert a row");
      }
      return {
        kind: "handled" as const,
        claimed: true,
        newBalance: parseNumeric(overageRow.new_balance, "new_balance"),
        balanceDecreaseMetadata: {
          ...baseMetadata,
          type: "reconciliation_overage",
        },
        result: {
          reservedAmount: claimedReservedAmount,
          actualCost: normalizedActualCost,
          reservationTransactionId,
          settlementTransactionIds: [overageRow.id],
          adjustmentType: "overage" as const,
        },
      };
    });

    if (result.kind !== "handled" || !result.claimed) {
      return result;
    }

    await CacheInvalidation.onCreditMutation(organizationId).catch((error) => {
      logger.error("[CreditsService] Failed to invalidate credit mutation cache:", error);
    });
    invalidateOrganizationCache(organizationId).catch((error) => {
      logger.error("[CreditsService] Failed to invalidate org cache:", error);
    });
    if (result.balanceDecreaseMetadata && result.newBalance !== undefined) {
      this.notifyBalanceDecrease(organizationId, result.newBalance, result.balanceDecreaseMetadata);
    }
    return result;
  }

  async markReservationSettled(params: {
    organizationId: string;
    reservationTransactionId: string | null | undefined;
  }): Promise<boolean> {
    const { organizationId, reservationTransactionId } = params;
    if (!reservationTransactionId) {
      return false;
    }

    const rows = await sqlRows<{ id: string }>(
      dbWrite,
      sql`
        UPDATE credit_transactions
        SET settled_at = NOW()
        WHERE id = ${reservationTransactionId}
          AND organization_id = ${organizationId}
          AND type = 'debit'
          AND settled_at IS NULL
          AND (
            (
              metadata->>'type' = 'reservation'
              AND metadata->>'settlement_marker' = ${RESERVATION_SETTLEMENT_MARKER}
            )
            OR (
              metadata->>'type' = 'app_chat_reservation'
              AND metadata->>'settlement_marker' = ${APP_CHAT_RESERVATION_SETTLEMENT_MARKER}
            )
          )
        RETURNING id
      `,
    );
    if (rows.length === 0) {
      return false;
    }

    await CacheInvalidation.onCreditMutation(organizationId).catch((error) => {
      logger.error("[CreditsService] Failed to invalidate credit mutation cache:", error);
    });
    invalidateOrganizationCache(organizationId).catch((error) => {
      logger.error("[CreditsService] Failed to invalidate org cache:", error);
    });
    return true;
  }

  /**
   * Reconcile credits after a request completes.
   * Adjusts credits based on actual vs reserved cost.
   * - Refunds excess if actual < reserved
   * - Charges overage if actual > reserved
   * - No-op if costs match (within epsilon for float precision)
   *
   * Includes retry logic for transient failures.
   */
  async reconcile(params: {
    organizationId: string;
    reservedAmount: number;
    actualCost: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreditReconciliationResult> {
    const { organizationId, reservedAmount, actualCost, description, metadata } = params;
    const difference = reservedAmount - actualCost;
    const reservationTxId =
      typeof metadata?.reservation_transaction_id === "string"
        ? metadata.reservation_transaction_id
        : null;

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 100;

    if (reservationTxId) {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const reservationResult = await this.reconcileReservationTransaction({
            organizationId,
            reservationTransactionId: reservationTxId,
            actualCost,
            description,
            metadata,
          });
          if (reservationResult.kind === "handled") {
            return reservationResult.result;
          }
          break;
        } catch (error) {
          if (attempt === MAX_RETRIES) {
            logger.error("[Credits] Reservation reconciliation failed after retries", {
              organizationId,
              reserved: reservedAmount,
              actual: actualCost,
              reservationTransactionId: reservationTxId,
              difference,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            return {
              reservedAmount,
              actualCost,
              reservationTransactionId: reservationTxId,
              settlementTransactionIds: [],
              adjustmentType: difference < 0 ? "uncollected_overage" : "none",
            };
          }
          logger.warn("[Credits] Reservation reconciliation retry", {
            attempt,
            organizationId,
            reservationTransactionId: reservationTxId,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        }
      }
    }

    if (Math.abs(difference) < EPSILON) {
      return {
        reservedAmount,
        actualCost,
        reservationTransactionId: reservationTxId,
        settlementTransactionIds: [],
        adjustmentType: "none",
      };
    }

    const baseMetadata = {
      ...metadata,
      reserved: reservedAmount,
      actual: actualCost,
    };

    // Stable per-(reservation, phase) idempotency key. Threaded into
    // refund/deduct as `stripePaymentIntentId` so a retry of an already-committed
    // reconcile (commit-then-ack-loss) is a no-op instead of a second refund
    // (platform loss) or a second overage charge (consumer double-charge).
    // Without a reservation id there is nothing stable to key on, so we keep the
    // prior non-idempotent behavior. (#10846 finding 2)
    const reconKey = (phase: "refund" | "overage"): string | undefined =>
      reservationTxId ? `recon:${reservationTxId}:${phase}` : undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (difference > 0) {
          const refund = await this.refundCredits({
            organizationId,
            amount: difference,
            description: `${description} (refund)`,
            metadata: { ...baseMetadata, type: "reconciliation_refund" },
            stripePaymentIntentId: reconKey("refund"),
          });
          logger.info("[Credits] Reconciled - refunded excess", {
            organizationId,
            reserved: reservedAmount,
            actual: actualCost,
            refunded: difference,
          });
          return {
            reservedAmount,
            actualCost,
            reservationTransactionId:
              typeof metadata?.reservation_transaction_id === "string"
                ? metadata.reservation_transaction_id
                : null,
            settlementTransactionIds: [refund.transaction.id],
            adjustmentType: "refund",
          };
        }

        const overage = -difference;
        const overageResult = await this.deductCredits({
          organizationId,
          amount: overage,
          description: `${description} (overage)`,
          metadata: { ...baseMetadata, type: "reconciliation_overage" },
          stripePaymentIntentId: reconKey("overage"),
        });
        if (!overageResult.success || !overageResult.transaction) {
          logger.warn("[Credits] Reconciled - overage uncollected", {
            organizationId,
            reserved: reservedAmount,
            actual: actualCost,
            overage,
            balance: overageResult.newBalance,
            reason: overageResult.reason ?? "missing_transaction",
          });
          return {
            reservedAmount,
            actualCost,
            reservationTransactionId:
              typeof metadata?.reservation_transaction_id === "string"
                ? metadata.reservation_transaction_id
                : null,
            settlementTransactionIds: [],
            adjustmentType: "uncollected_overage",
          };
        }
        logger.warn("[Credits] Reconciled - charged overage", {
          organizationId,
          reserved: reservedAmount,
          actual: actualCost,
          overage,
        });
        return {
          reservedAmount,
          actualCost,
          reservationTransactionId:
            typeof metadata?.reservation_transaction_id === "string"
              ? metadata.reservation_transaction_id
              : null,
          settlementTransactionIds: overageResult.transaction ? [overageResult.transaction.id] : [],
          adjustmentType: "overage",
        };
      } catch (error) {
        if (attempt === MAX_RETRIES) {
          logger.error("[Credits] Reconciliation failed after retries", {
            organizationId,
            reserved: reservedAmount,
            actual: actualCost,
            difference,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          // Don't throw - operation completed, just log for manual review
          return {
            reservedAmount,
            actualCost,
            reservationTransactionId:
              typeof metadata?.reservation_transaction_id === "string"
                ? metadata.reservation_transaction_id
                : null,
            settlementTransactionIds: [],
            adjustmentType: difference < 0 ? "uncollected_overage" : "none",
          };
        }
        logger.warn("[Credits] Reconciliation retry", {
          attempt,
          organizationId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }

    return {
      reservedAmount,
      actualCost,
      reservationTransactionId:
        typeof metadata?.reservation_transaction_id === "string"
          ? metadata.reservation_transaction_id
          : null,
      settlementTransactionIds: [],
      adjustmentType: "none",
    };
  }

  async sweepStaleReservations(opts?: {
    graceMs?: number;
    batchSize?: number;
    maxBatches?: number;
  }): Promise<ReservationSweepStats> {
    const graceMs = opts?.graceMs ?? RESERVATION_SWEEP_GRACE_MS;
    const batchSize = opts?.batchSize ?? 200;
    const maxBatches = opts?.maxBatches ?? 50;
    const stats: ReservationSweepStats = {
      scanned: 0,
      settled: 0,
      skipped: 0,
      refunds: 0,
      overages: 0,
      noops: 0,
      uncollectedOverages: 0,
      batches: 0,
      capHit: false,
    };

    for (let batch = 0; batch < maxBatches; batch++) {
      const rows = await sqlRows<{
        id: string;
        organization_id: string;
        amount: string | number;
        description: string | null;
        metadata: Record<string, unknown> | string | null;
      }>(
        dbWrite,
        sql`
          SELECT id, organization_id, amount, description, metadata
          FROM credit_transactions
          WHERE type = 'debit'
            AND (
              (
                metadata->>'type' = 'reservation'
                AND metadata->>'settlement_marker' = ${RESERVATION_SETTLEMENT_MARKER}
              )
              OR (
                metadata->>'type' = 'app_chat_reservation'
                AND metadata->>'settlement_marker' = ${APP_CHAT_RESERVATION_SETTLEMENT_MARKER}
              )
            )
            AND settled_at IS NULL
            AND created_at < NOW() - (${String(graceMs)} || ' milliseconds')::interval
          ORDER BY created_at ASC
          LIMIT ${batchSize}
        `,
      );
      if (rows.length === 0) break;
      stats.batches++;
      stats.scanned += rows.length;

      for (const row of rows) {
        const reservedAmount = Math.abs(parseNumeric(row.amount, "reservation_amount"));
        const reservationMetadata = parseMetadata(row.metadata);
        const description = (row.description ?? "Credit reservation").replace(
          /\s+\(reserved\)$/,
          "",
        );
        try {
          // App-chat holds must settle through the app-credits lane — the SAME
          // lane the route's late settle uses — never the generic reconcile
          // below (#11683): the generic lane keys its refund on
          // `recon:<holdId>:refund` while the route settles under
          // `reconcile-refund:<holdId>` (#11512), so the two writers never
          // cross-deduped and a swept-but-still-in-flight hold was refunded
          // TWICE (minted, cashable credit). The hold amount is also the
          // markup-INCLUSIVE totalCost with the creator's earnings committed
          // at deduct time — settling it against the base-only estimated_cost
          // over-refunded the markup and left unbacked redeemable earnings.
          if (
            reservationMetadata.type === "app_chat_reservation" &&
            reservationMetadata.settlement_marker === APP_CHAT_RESERVATION_SETTLEMENT_MARKER
          ) {
            await this.sweepAppChatReservation(
              { id: row.id, description },
              reservationMetadata,
              stats,
            );
            continue;
          }
          const actualCost = staleHoldSettleCost(reservedAmount, reservationMetadata);
          const settlement = await this.reconcileReservationTransaction({
            organizationId: row.organization_id,
            reservationTransactionId: row.id,
            actualCost,
            description,
            metadata: {
              ...reservationMetadata,
              settlement_source: "stale_reservation_sweep",
            },
          });
          if (settlement.kind !== "handled" || !settlement.claimed) {
            stats.skipped++;
            continue;
          }
          stats.settled++;
          switch (settlement.result.adjustmentType) {
            case "refund":
              stats.refunds++;
              break;
            case "overage":
              stats.overages++;
              break;
            case "uncollected_overage":
              stats.uncollectedOverages++;
              break;
            case "none":
              stats.noops++;
              break;
          }
        } catch (error) {
          stats.skipped++;
          logger.error("[Credits] Stale reservation sweep failed for row", {
            reservationTransactionId: row.id,
            organizationId: row.organization_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (rows.length < batchSize) break;
      if (batch === maxBatches - 1) stats.capHit = true;
    }

    if (stats.capHit) {
      logger.warn("[Credits] Stale reservation sweep hit its batch ceiling", {
        maxBatches,
        batchSize,
        scanned: stats.scanned,
      });
    }
    if (stats.settled > 0 || stats.skipped > 0) {
      logger.warn("[Credits] Swept stale credit reservations", stats);
    }
    return stats;
  }

  /**
   * Settle one stale APP-CHAT hold (`app_chat_reservation_v1`) through
   * `appCreditsService.reconcileCredits` (#11683). Assumes actual == the
   * base-cost estimate the route recorded (same semantic as the generic lane),
   * but reconciles in base-cost space so the markup math and the creator
   * earnings reversal are correct, and keys the refund on
   * `reconcile-refund:<holdId>` — the same key the route's late settle uses —
   * so whichever writer runs second is a no-op.
   */
  private async sweepAppChatReservation(
    row: { id: string; description: string },
    reservationMetadata: Record<string, unknown>,
    stats: ReservationSweepStats,
  ): Promise<void> {
    const appId = typeof reservationMetadata.appId === "string" ? reservationMetadata.appId : null;
    const userId =
      typeof reservationMetadata.userId === "string" ? reservationMetadata.userId : null;
    // What was actually debited, in BASE-cost space (the route's buffered base
    // estimate). `reserved_amount`/`baseCost` are both written by the app-chat
    // deduct; the hold row's `amount` is markup-inclusive and must NOT be used
    // as a base cost.
    const reservedBaseCost =
      metadataNumber(reservationMetadata.reserved_amount) ??
      metadataNumber(reservationMetadata.baseCost);
    if (!appId || !userId || reservedBaseCost === null) {
      stats.skipped++;
      logger.error("[Credits] Stale app-chat reservation is missing reconcile inputs — skipping", {
        reservationTransactionId: row.id,
        hasAppId: appId !== null,
        hasUserId: userId !== null,
        hasReservedBaseCost: reservedBaseCost !== null,
      });
      return;
    }
    const assumedActualBaseCost =
      metadataNumber(reservationMetadata.estimated_cost) ??
      metadataNumber(reservationMetadata.estimatedCost) ??
      reservedBaseCost;

    // Lazy import: app-credits statically imports this module, so a static
    // import here would create a module cycle.
    const { appCreditsService } = await import("./app-credits");
    const result = await appCreditsService.reconcileCredits({
      appId,
      userId,
      estimatedBaseCost: reservedBaseCost,
      actualBaseCost: assumedActualBaseCost,
      description: row.description,
      metadata: { settlement_source: "stale_reservation_sweep" },
      reservationTransactionId: row.id,
    });

    if (result.action === "refund" && result.reconciled) {
      stats.settled++;
      stats.refunds++;
      return;
    }
    if (result.action === "charge") {
      stats.settled++;
      if (result.reconciled) {
        stats.overages++;
      } else {
        stats.uncollectedOverages++;
      }
      return;
    }
    // action === "none": either a below-threshold settle (row marked settled —
    // a noop) or reconcileCredits could not resolve the user/app and left the
    // hold open (skipped; retried next sweep and already error-logged).
    const settledRows = await sqlRows<{ id: string }>(
      dbWrite,
      sql`
        SELECT id
        FROM credit_transactions
        WHERE id = ${row.id}
          AND settled_at IS NOT NULL
        LIMIT 1
      `,
    );
    if (settledRows.length > 0) {
      stats.settled++;
      stats.noops++;
    } else {
      stats.skipped++;
    }
  }

  // ============================================================================
  // Reserve Credits (High-level API)
  // ============================================================================

  /**
   * Reserve credits before an operation.
   * - If `amount` is provided: fixed cost (images, videos, etc.)
   * - If `model` is provided: estimates cost from tokens with 50% buffer
   *
   * Returns a CreditReservation object with a reconcile() method.
   */
  async reserve(params: ReserveCreditsParams): Promise<CreditReservation> {
    const { organizationId, userId, description } = params;

    // Input validation
    if (!organizationId) {
      throw new Error("reserve() requires organizationId");
    }
    if (!description) {
      throw new Error("reserve() requires description");
    }
    if (params.amount !== undefined && params.amount < 0) {
      throw new Error("reserve() amount must be non-negative");
    }

    let reservedAmount: number;
    let estimatedCost: number;
    let model: string | undefined;

    if (params.amount !== undefined) {
      estimatedCost = params.amount;
      reservedAmount = params.amount;
    } else if (params.model) {
      model = params.model;
      const provider = params.provider ?? getProviderFromModel(params.model);
      const estimatedInputTokens = params.estimatedInputTokens ?? 0;
      const estimatedOutputTokens = params.estimatedOutputTokens ?? DEFAULT_OUTPUT_TOKENS;

      const { totalCost } = await calculateCost(
        params.model,
        provider,
        estimatedInputTokens,
        estimatedOutputTokens,
        params.billingSource,
      );

      estimatedCost = totalCost;
      reservedAmount = Math.max(estimatedCost * COST_BUFFER, MIN_RESERVATION);
    } else {
      throw new Error("reserve() requires either `amount` or `model`");
    }

    const result = await this.reserveAndDeductCredits({
      organizationId,
      amount: reservedAmount,
      description: `${description} (reserved)`,
      metadata: {
        user_id: userId,
        type: "reservation",
        settlement_marker: RESERVATION_SETTLEMENT_MARKER,
        estimated_cost: estimatedCost,
        reserved_amount: reservedAmount,
        ...(model && { model }),
      },
    });

    if (!result.success) {
      logger.warn("[Credits] Insufficient credits for reservation", {
        organizationId,
        required: reservedAmount,
        available: result.newBalance,
        reason: result.reason,
      });
      throw new InsufficientCreditsError(reservedAmount, result.newBalance, result.reason);
    }
    if (!result.transaction) {
      throw new Error("[Credits] Reservation did not return a credit transaction");
    }
    const reservationTransactionId = result.transaction.id;

    logger.info("[Credits] Reserved", {
      organizationId,
      reservedAmount,
      ...(model && { model }),
    });

    return {
      reservedAmount,
      reservationTransactionId,
      reconcile: async (actualCost: number) => {
        return await this.reconcile({
          organizationId,
          reservedAmount,
          actualCost,
          description,
          metadata: {
            user_id: userId,
            reservation_transaction_id: reservationTransactionId,
            ...(model && { model }),
          },
        });
      },
    };
  }

  /**
   * Create a no-op reservation for anonymous users.
   */
  createAnonymousReservation(): CreditReservation {
    return {
      reservedAmount: 0,
      reservationTransactionId: null,
      reconcile: async () => {},
    };
  }

  // Credit Packs
  async getCreditPackById(id: string): Promise<CreditPack | undefined> {
    return await creditPacksRepository.findById(id);
  }

  async getCreditPackByStripePriceId(stripePriceId: string): Promise<CreditPack | undefined> {
    return await creditPacksRepository.findByStripePriceId(stripePriceId);
  }

  /**
   * List active credit packs with caching.
   * Credit packs rarely change so we cache aggressively with SWR.
   */
  async listActiveCreditPacks(): Promise<CreditPack[]> {
    // Import cache lazily to avoid circular dependencies
    const { creditPacksCache } = await import("../cache/credit-packs-cache");

    return await creditPacksCache.getWithSWR(async () => {
      return await creditPacksRepository.listActive();
    });
  }

  async listAllCreditPacks(): Promise<CreditPack[]> {
    return await creditPacksRepository.listAll();
  }
}

// Export singleton instance
export const creditsService = new CreditsService();
