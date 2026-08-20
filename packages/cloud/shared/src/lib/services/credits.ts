/**
 * Credits service for managing organization credit balances and transactions.
 */

import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { type SqlExecutor, sqlRows } from "../../db/execute-helpers";
import { dbWrite, writeTransaction } from "../../db/helpers";
import {
  appsRepository,
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
import { getRequestTaskDefer } from "../runtime/request-context";
import { logger } from "../utils/logger";
import { getRouteTimeoutMs } from "../utils/request-timeout";
import type { AffiliateBillingAttribution } from "./affiliate-billing-attribution";
import { enqueueCollectedAffiliatePayout } from "./affiliate-payout-outbox";
import type { PricingBillingSource } from "./ai-pricing-definitions";
import { resolveCostBuffer } from "./credits-config";
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
export const COST_BUFFER = resolveCostBuffer();
/** Minimum reservation amount in USD */
export const MIN_RESERVATION = 0.000001;
/** Epsilon for reconcile float comparisons — 10% of MIN_RESERVATION */
export const EPSILON = MIN_RESERVATION * 0.1;
export const RESERVATION_SETTLEMENT_MARKER = "credit_reservation_v1";
export const APP_CHAT_RESERVATION_SETTLEMENT_MARKER = "app_chat_reservation_v1";
/** Default estimated output tokens when not specified */
export const DEFAULT_OUTPUT_TOKENS = 500;

/**
 * Reject corrupt settlement inputs before they can turn a negative cost into a
 * refund larger than its backing reservation. Zero is valid for a completed
 * request that produced no billable usage.
 */
export function assertValidCreditSettlementCosts(params: {
  reservedAmount: number;
  actualCost: number;
  scope: string;
}): void {
  const { reservedAmount, actualCost, scope } = params;
  if (!Number.isFinite(reservedAmount) || reservedAmount < 0) {
    throw new ElizaError(`${scope} received an invalid reserved cost`, {
      code: "INVALID_RESERVED_CREDIT_COST",
      context: { reservedAmount },
      severity: "fatal",
    });
  }
  if (!Number.isFinite(actualCost) || actualCost < 0) {
    throw new ElizaError(`${scope} received an invalid actual cost`, {
      code: "INVALID_ACTUAL_CREDIT_COST",
      context: { actualCost, reservedAmount },
      severity: "fatal",
    });
  }
}

/** Fail and emit a structured alert when a refund lacks sufficient backing. */
export function assertCreditRefundWithinReservation(params: {
  reservedAmount: number;
  refundAmount: number;
  scope: string;
}): void {
  const { reservedAmount, refundAmount, scope } = params;
  if (
    !Number.isFinite(reservedAmount) ||
    reservedAmount < 0 ||
    !Number.isFinite(refundAmount) ||
    refundAmount < 0 ||
    refundAmount - reservedAmount > EPSILON
  ) {
    const error = new ElizaError(`${scope} refund exceeds its backing reservation`, {
      code: "CREDIT_REFUND_EXCEEDS_RESERVATION",
      context: { reservedAmount, refundAmount },
      severity: "fatal",
    });
    logger.error("[Credits] Refusing an unbacked reconciliation refund", {
      reservedAmount,
      refundAmount,
      code: error.code,
    });
    throw error;
  }
}

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

/**
 * Thrown when a reconcile call names a reservation transaction that does not
 * exist (or does not belong to the organization). Settling such a call through
 * the legacy caller-trusted lane would mint a refund for a hold that was never
 * verified, so the settlement is refused instead.
 */
export class ReservationNotFoundError extends ElizaError {
  override readonly name = "ReservationNotFoundError";

  constructor(
    public readonly reservationTransactionId: string,
    public readonly organizationId: string,
  ) {
    super(
      `Reservation transaction ${reservationTransactionId} not found for organization ${organizationId}`,
      {
        code: "CREDIT_RESERVATION_NOT_FOUND",
        context: { organizationId, reservationTransactionId },
        severity: "fatal",
      },
    );
  }
}

/** Refuses a refund that is not tied to an authoritative reservation row. */
export class UnbackedCreditRefundError extends ElizaError {
  override readonly name = "UnbackedCreditRefundError";

  constructor(scope: string) {
    super(`${scope} cannot refund without an authoritative reservation`, {
      code: "CREDIT_REFUND_REQUIRES_RESERVATION",
      context: { scope },
      severity: "fatal",
    });
  }
}

/** Refuses malformed amounts before they can reach a credit-ledger mutation. */
export class InvalidCreditAmountError extends ElizaError {
  override readonly name = "InvalidCreditAmountError";

  constructor(amount: number, operation: "reserve" | "reserve_and_deduct" | "add_credits") {
    const permitsZero = operation === "reserve";
    super(
      permitsZero
        ? "Credit reservation amount must be a finite, non-negative number"
        : operation === "add_credits"
          ? "Credit increase amount must be a positive, finite number"
          : "Credit deduction amount must be a positive, finite number",
      {
        code: "INVALID_CREDIT_AMOUNT",
        context: { amount, operation, permitsZero },
        severity: "fatal",
      },
    );
  }
}

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
  /** Immutable affiliate policy pinned before provider dispatch. */
  affiliateAttribution?: AffiliateBillingAttribution | null;
  /** Global money identity shared by the payout outbox and earnings ledger. */
  affiliatePayoutSourceId?: string | null;
  reconcile: (actualCost: number) => Promise<CreditReconciliationResult | void>;
}

export interface CreditReconciliationResult {
  reservedAmount: number;
  actualCost: number;
  /**
   * Amount the authoritative debit actually collected when it can differ from
   * the caller's attempted actual cost (for example, an alarm replay won).
   */
  collectedAmount?: number;
  reservationTransactionId?: string | null;
  settlementTransactionIds: string[];
  adjustmentType: "none" | "refund" | "overage" | "uncollected_overage";
}

export interface OrganizationBalanceSnapshot {
  balanceUsd: number;
  revision: string;
}

/**
 * Request-local operations triggered after a successful balance decrease.
 * Kept as a typed seam so Worker lifetime behavior can be tested without
 * reaching through private service methods.
 */
export interface PostDebitNotificationOperations {
  checkAutoTopUp: () => Promise<unknown>;
  queueLowCreditsEmail: () => Promise<unknown>;
  notifyWaifuCredits: () => Promise<unknown>;
}

/**
 * Run post-debit notifications under the current request lifetime contract.
 * Worker callers register the exact observed aggregate with `waitUntil`;
 * callers without a request runtime await that same aggregate inline.
 */
export async function runObservedPostDebitNotifications(
  operations: PostDebitNotificationOperations,
): Promise<void> {
  const observe = (label: string, operation: () => Promise<unknown>): Promise<void> =>
    Promise.resolve()
      .then(operation)
      .then(
        () => undefined,
        (error) => {
          // error-policy:J5 Post-debit notifications are best effort, but every
          // rejection is observed before the aggregate reaches waitUntil.
          logger.error(`[CreditsService] ${label}:`, error);
        },
      );

  const task = Promise.all([
    observe("Failed to check auto top-up", operations.checkAutoTopUp),
    observe("Failed to queue low credits email", operations.queueLowCreditsEmail),
    observe("Failed to notify waifu credit webhook", operations.notifyWaifuCredits),
  ]).then(() => undefined);

  const defer = getRequestTaskDefer();
  if (defer) {
    // Register this exact observed Promise; wrapping it after registration
    // would leave the actual notification work outside the Worker lifetime.
    defer(task);
    return;
  }
  await task;
}

/**
 * Nudge the durable auto-top-up state machine after a balance decrease. The
 * service rechecks eligibility under the organization write lock, avoiding a
 * charge decision based on a stale post-debit snapshot.
 */
export async function triggerDurableAutoTopUpForBalanceDecrease(
  organizationId: string,
): Promise<void> {
  const { autoTopUpService } = await import("./auto-top-up");
  await autoTopUpService.executeAutoTopUpForOrganization(organizationId, {
    source: "credit_deduction",
  });
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
  /** Multiplies model-estimated reservations for caller-known markups. */
  estimatedCostMultiplier?: number;
  /**
   * Server-owned settlement facts persisted on the reservation. Affiliate
   * attribution uses this to enqueue its payout atomically with collection.
   */
  metadata?: Record<string, unknown>;
  /**
   * Optional idempotency key for the LOGICAL operation — e.g. one TTS
   * utterance whose client retries the same request over a fallback transport
   * after an ambiguous network outcome (#16425). A reserve whose key already
   * committed returns a handle bound to the ORIGINAL reservation (same
   * transaction id, reservedAmount recovered from its metadata) instead of
   * deducting a second time; settlement stays exactly-once per reservation via
   * the reconcile dedupe (#10846). Namespaced per organization into
   * `stripe_payment_intent_id` (`reserve:<orgId>:<key>`), whose unique index is
   * the concurrency backstop — so a key replayed from another org can never
   * attach to this org's reservation. Omit for the unchanged per-request
   * behavior.
   */
  idempotencyKey?: string;
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

export interface AffiliateInferenceFallbackParams {
  organizationId: string;
  userId: string;
  requestId: string;
  model: string;
  provider: string;
  billingSource: string;
  actualCost: number;
  reservationMetadata: Record<string, unknown>;
}

/**
 * Parameters for adding credits to an organization.
 */
export interface AddCreditsParams {
  organizationId: string;
  /** Exact USD decimal; strings avoid binary floating-point money conversion. */
  amount: number | string;
  description: string;
  metadata?: Record<string, unknown>;
  stripePaymentIntentId?: string;
  /**
   * Internal: execute the mutation on an existing transaction. Used when the
   * caller must hold a DB-level lock across the balance mutation.
   */
  db?: SqlExecutor;
  /**
   * Internal: the transaction owner will invalidate credit caches only after
   * its outer transaction commits. Never use this without a post-commit call
   * to `invalidateCreditCaches`.
   */
  deferCacheInvalidation?: boolean;
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
  /** Internal: execute this ledger mutation inside an owning transaction. */
  db?: SqlExecutor;
  /** Internal: the owner performs post-commit cache and notification work. */
  deferPostCommitEffects?: boolean;
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
    const amountDecimal = new Decimal(amount);
    if (!amountDecimal.isFinite() || !amountDecimal.gt(0)) {
      throw new InvalidCreditAmountError(Number(amount), "add_credits");
    }
    const amountText = amountDecimal.toDecimalPlaces(6).toFixed(6);
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
            ${amountText}::numeric,
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
            credit_balance = org.current_balance + ${amountText}::numeric,
            settings = CASE
              WHEN ${transactionType} = 'credit'
                THEN COALESCE(o.settings, '{}'::jsonb) - 'welcomeBonusWithheld'
              ELSE o.settings
            END,
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
        if (
          existingTransaction.organization_id !== organizationId ||
          existingTransaction.type !== transactionType ||
          !new Decimal(existingTransaction.amount).equals(amountText)
        ) {
          throw new Error("Credit idempotency replay does not match the original settlement");
        }
        return {
          transaction: existingTransaction,
          newBalance: Number.parseFloat(String(org.credit_balance)),
        };
      }
    }

    const transaction = toCreditTransaction(row);
    if (
      transaction.organization_id !== organizationId ||
      transaction.type !== transactionType ||
      !new Decimal(transaction.amount).equals(amountText)
    ) {
      throw new Error("Credit idempotency replay does not match the original settlement");
    }
    return {
      transaction,
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
   *
   * A PRESENT org with a null/non-numeric `credit_balance` is a corrupt read,
   * not a $0 balance: `parseNumeric` throws rather than coercing it to `NaN`.
   * A silent `NaN` here would be written as a poisoned gate hint and, in
   * `getCreditBalanceResponse`, serialized to the client as `balance: null`
   * (#12268 fallback-slop: failed data must not become a success-shaped value).
   */
  async getOrganizationBalanceSnapshot(
    organizationId: string,
  ): Promise<OrganizationBalanceSnapshot> {
    const org = await organizationsRepository.findBalanceSnapshotForWrite(organizationId);
    // error-policy:J6 missing org → 0 is the documented fail-safe (gate slow-paths).
    if (!org) return { balanceUsd: 0, revision: "0" };
    const revision = String(org.balance_revision);
    if (!/^(0|[1-9]\d*)$/.test(revision)) {
      throw new Error("[CreditsService] Invalid organization balance revision");
    }
    return {
      balanceUsd: parseNumeric(org.credit_balance, "credit_balance"),
      revision,
    };
  }

  async getOrganizationBalanceUsd(organizationId: string): Promise<number> {
    return (await this.getOrganizationBalanceSnapshot(organizationId)).balanceUsd;
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
    const {
      organizationId,
      amount,
      description,
      metadata,
      stripePaymentIntentId,
      db,
      deferCacheInvalidation = false,
    } = params;

    const result = await this.applyCreditIncrease({
      organizationId,
      amount,
      description,
      metadata,
      stripePaymentIntentId,
      db,
      transactionType: "credit",
    });

    if (!deferCacheInvalidation) {
      await this.invalidateCreditCaches(organizationId);
    }

    return result;
  }

  /** Invalidates organization and balance caches after the owning DB commit. */
  async invalidateCreditCaches(organizationId: string): Promise<void> {
    await invalidateOrganizationCache(organizationId).catch((error) => {
      logger.error("[CreditsService] Failed to invalidate org cache:", error);
    });
    await CacheInvalidation.onCreditMutation(organizationId);
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
      db,
      deferPostCommitEffects = false,
    } = params;

    // Authoritative money-write guard: `<= 0` alone lets NaN through (the
    // comparison is false), after which `String(amount)::numeric` would reach
    // the balance/ledger CTE as 'NaN'. Every debit path funnels through here,
    // so the finite check lives at this lowest shared boundary (the reserve()
    // wrapper keeps its own guard as defense-in-depth).
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new InvalidCreditAmountError(amount, "reserve_and_deduct");
    }

    const committedKeyedDeduction = async (): Promise<{
      success: true;
      newBalance: number;
      transaction: CreditTransaction;
    } | null> => {
      if (!stripePaymentIntentId) return null;
      const existing =
        await creditTransactionsRepository.findByStripePaymentIntentForWrite(stripePaymentIntentId);
      if (!existing) return null;
      if (existing.organization_id !== organizationId) {
        throw new Error(
          "[CreditsService] Deduction idempotency key belongs to another organization",
        );
      }
      return {
        success: true,
        newBalance: await this.getOrganizationBalanceUsd(organizationId),
        transaction: existing,
      };
    };

    // The unique insert is the first keyed decision. Avoiding an optimistic
    // pre-read both saves a query for new charges and prevents first-call races
    // from reaching the balance update before one winner owns the key. (#10846)
    const stripeId = stripePaymentIntentId ?? null;

    const metadataJson = JSON.stringify(metadata ?? {});
    const applyMutation = async (tx: SqlExecutor) => {
      const mutationRows = await sqlRows<CreditMutationRow>(
        tx,
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
        updated AS (
          UPDATE organizations AS o
          SET
            credit_balance = eligible.new_balance,
            updated_at = NOW()
          FROM eligible
          WHERE o.id = eligible.id
            AND EXISTS (SELECT 1 FROM inserted)
          RETURNING eligible.new_balance
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
      const mutation = mutationRows[0];
      if (mutation?.id && mutation.new_balance === null) {
        throw new Error("[CreditsService] Deduction claim committed without a balance mutation");
      }
      return mutationRows;
    };
    const rows = db ? await applyMutation(db) : await writeTransaction(applyMutation);

    const row = rows[0];
    if (!row?.id && stripePaymentIntentId) {
      // A concurrent winner can be invisible to this statement's MVCC
      // snapshot even though ON CONFLICT observed it. The next statement sees
      // the committed row and returns the same logical result.
      const replay = await committedKeyedDeduction();
      if (replay) return replay;
    }
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
      if (result.success && !deferPostCommitEffects) {
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

        await this.notifyBalanceDecrease(organizationId, result.newBalance, metadata);
      }
      return result;
    });
  }

  /**
   * Fire the post-debit notifications a balance decrease triggers: auto-top-up
   * check, low-credits email, and the waifu webhook that lets a hosted agent
   * downgrade/pause itself when it runs low. Worker requests register the
   * observed aggregate with request-scoped `waitUntil`; non-Worker callers
   * await the same aggregate. The periodic durable sweep remains the auto-top-up
   * recovery backstop if a Worker reaches its post-response time limit. Exposed
   * (not inlined) so EVERY debit path stays at parity: the synchronous reserve
   * calls it here, and the optimistic inference ledger
   * (`inference-billing-ledger.ts`), which mutates the balance with its own
   * transactional SQL rather than through `deductCredits`, calls it after a
   * successful debit so its orgs still get low-balance warnings.
   */
  async notifyBalanceDecrease(
    organizationId: string,
    newBalance: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await runObservedPostDebitNotifications({
      checkAutoTopUp: () => triggerDurableAutoTopUpForBalanceDecrease(organizationId),
      queueLowCreditsEmail: () => this.queueLowCreditsEmail(organizationId, newBalance),
      notifyWaifuCredits: () => this.notifyWaifuCredits(organizationId, newBalance, metadata),
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
        billingUrl: `${process.env.NEXT_PUBLIC_APP_URL}/cloud/billing`,
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
    const {
      organizationId,
      amount,
      description,
      metadata,
      stripePaymentIntentId,
      db,
      deferCacheInvalidation = false,
    } = params;

    const refundAmount = new Decimal(String(amount));
    if (!refundAmount.isFinite() || !refundAmount.gt(0)) {
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
      db,
      deferCacheInvalidation: true,
      transactionType: "refund",
    }).then(async (result) => {
      if (!deferCacheInvalidation) {
        await this.invalidateCreditCaches(organizationId);
      }
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
    /** Cumulative authoritative reversal target; delta is derived under the org lock. */
    cumulativeTargetAmount?: number;
    /** Original grant PI whose reversal ledger is serialized. */
    originalPaymentIntentId?: string;
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
    if (
      params.cumulativeTargetAmount !== undefined &&
      (!Number.isFinite(params.cumulativeTargetAmount) || params.cumulativeTargetAmount <= 0)
    ) {
      throw new Error("Cumulative clawback target must be positive");
    }

    const metadataJson = JSON.stringify(params.metadata ?? {});
    const cumulativeTarget =
      params.cumulativeTargetAmount === undefined ? null : String(params.cumulativeTargetAmount);
    const originalPaymentIntentId = params.originalPaymentIntentId ?? null;
    const rows = await writeTransaction(async (tx) => {
      const lockRows = await sqlRows<{ id: string }>(
        tx,
        sql`SELECT id FROM organizations WHERE id = ${params.organizationId} FOR UPDATE`,
      );
      if (!lockRows[0]) throw new Error("Organization not found");

      // The reversal query runs as a second READ COMMITTED statement after
      // acquiring the org lock. A contender that waited for this lock now gets
      // a fresh snapshot containing the winner's committed clawback before it
      // derives its cumulative delta.
      return await sqlRows<ClawbackMutationRow>(
        tx,
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
        grant_lock AS (
          SELECT id
          FROM credit_transactions
          WHERE stripe_payment_intent_id = ${originalPaymentIntentId}
          FOR UPDATE
        ),
        prior_reversal AS (
          SELECT COALESCE(SUM(-ct.amount), 0)::numeric AS total
          FROM org
          LEFT JOIN credit_transactions AS ct
            ON ct.metadata->>'payment_intent_id' = ${originalPaymentIntentId}
            AND (
              ct.type = 'clawback'
              OR (ct.type = 'refund' AND ct.metadata->>'source' = 'charge.dispute.funds_reinstated')
            )
        ),
        candidate AS (
          SELECT
            org.id,
            org.current_balance,
            LEAST(target.requested_amount, GREATEST(org.current_balance, 0)) AS applied_amount,
            GREATEST(org.current_balance - target.requested_amount, 0) AS new_balance,
            GREATEST(target.requested_amount - GREATEST(org.current_balance, 0), 0) AS shortfall_amount,
            target.requested_amount
          FROM org
          CROSS JOIN prior_reversal
          CROSS JOIN LATERAL (
            SELECT CASE
              WHEN ${cumulativeTarget}::numeric IS NULL THEN ${String(params.amount)}::numeric
              ELSE GREATEST(${cumulativeTarget}::numeric - prior_reversal.total, 0)
            END AS requested_amount
          ) AS target
          WHERE NOT EXISTS (SELECT 1 FROM existing)
            AND (${originalPaymentIntentId}::text IS NULL OR EXISTS (SELECT 1 FROM grant_lock))
            AND target.requested_amount > 0
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
              'requested_clawback_usd', candidate.requested_amount,
              'cumulative_clawback_target_usd', ${cumulativeTarget}::numeric,
              'applied_clawback_usd', candidate.applied_amount,
              'unrecovered_clawback_usd', candidate.shortfall_amount
            ),
            ${params.stripePaymentIntentId},
            NOW()
          FROM candidate
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
        updated AS (
          UPDATE organizations AS o
          SET
            credit_balance = candidate.new_balance,
            -- A Stripe refund/dispute must never look like fresh usage and
            -- automatically charge the saved card again. Disable atomically
            -- with the clawback; an operator/user can explicitly re-enable it.
            auto_top_up_enabled = false,
            updated_at = NOW()
          FROM candidate
          WHERE o.id = candidate.id
            AND EXISTS (SELECT 1 FROM inserted)
          RETURNING o.credit_balance AS new_balance
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
    });

    const row = rows[0];
    if (!row || !isPgTrue(row.org_exists)) {
      throw new Error("Organization not found");
    }
    if (!row.id) {
      if (cumulativeTarget !== null && originalPaymentIntentId) {
        const priorRows = await sqlRows<ClawbackMutationRow>(
          dbWrite,
          sql`
            SELECT
              id,
              organization_id,
              user_id,
              amount,
              type,
              description,
              metadata,
              stripe_payment_intent_id,
              created_at,
              0::numeric AS new_balance,
              0::numeric AS applied_amount,
              0::numeric AS shortfall_amount,
              true AS already_processed,
              true AS org_exists,
              0::numeric AS current_balance
            FROM credit_transactions
            WHERE metadata->>'payment_intent_id' = ${originalPaymentIntentId}
              AND type = 'clawback'
            ORDER BY created_at DESC
            LIMIT 1
          `,
        );
        const prior = priorRows[0];
        const org = await organizationsRepository.findById(params.organizationId);
        if (prior?.id && org) {
          return {
            transaction: toCreditTransaction(prior),
            newBalance: parseNumeric(org.credit_balance, "credit_balance"),
            appliedAmount: 0,
            shortfallAmount: 0,
            alreadyProcessed: true,
          };
        }
      }
      const existing = await this.getTransactionByStripePaymentIntent(params.stripePaymentIntentId);
      const org = await organizationsRepository.findById(params.organizationId);
      if (existing && org) {
        const metadata = parseMetadata(existing.metadata);
        // Fail-closed replay parse. A bare `Number(... ?? 0)` reported a
        // corrupt row (`'NaN'::numeric` amount or shortfall) as "fully
        // recovered, shortfall $0", so the caller never followed up the
        // unrecovered amount. Absent shortfall metadata still settles as 0 to
        // match the SQL path's `COALESCE(..., 0)`; only a present-but-corrupt
        // value throws.
        const rawShortfall = metadata.unrecovered_clawback_usd;
        return {
          transaction: existing,
          newBalance: parseNumeric(org.credit_balance, "credit_balance"),
          appliedAmount: Math.abs(parseNumeric(existing.amount, "clawback_amount")),
          shortfallAmount:
            rawShortfall === undefined || rawShortfall === null || rawShortfall === ""
              ? 0
              : parseNumeric(rawShortfall as string | number, "unrecovered_clawback_usd"),
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
        metadata: Record<string, unknown> | string | null;
        settled_at: Date | string | null;
      }>(
        tx,
        sql`
          SELECT id, amount, metadata, settled_at
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
      const reservationMetadata = parseMetadata(reservation.metadata);
      const normalizedActualCost = actualCost;
      assertValidCreditSettlementCosts({
        reservedAmount,
        actualCost: normalizedActualCost,
        scope: "CreditsService.reconcileReservationTransaction",
      });
      const enqueueAffiliatePayout = async (collectedTotalCost: number): Promise<void> => {
        await enqueueCollectedAffiliatePayout(tx, {
          reservationMetadata,
          actualTotalCost: normalizedActualCost,
          collectedTotalCost,
        });
      };

      if (reservation.settled_at !== null) {
        const settlementTransactionIds = await existingSettlementIds(tx);
        await enqueueAffiliatePayout(
          normalizedActualCost > reservedAmount && settlementTransactionIds.length === 0
            ? reservedAmount
            : normalizedActualCost,
        );
        return {
          kind: "handled" as const,
          claimed: false,
          result: {
            reservedAmount,
            actualCost: normalizedActualCost,
            reservationTransactionId,
            settlementTransactionIds,
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
        await enqueueAffiliatePayout(normalizedActualCost);
        return {
          kind: "handled" as const,
          claimed: markedRows.length > 0,
          result: {
            reservedAmount,
            actualCost: normalizedActualCost,
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
            -- Native storage reservations are settled only after a strong R2
            -- HEAD proves the immutable generation present or absent.
            AND NOT (metadata ? 'storage_operation_id')
            AND settled_at IS NULL
          RETURNING id, amount
        `,
      );
      const claimed = claimedRows[0];
      if (!claimed) {
        const settlementTransactionIds = await existingSettlementIds(tx);
        await enqueueAffiliatePayout(
          normalizedActualCost > reservedAmount && settlementTransactionIds.length === 0
            ? reservedAmount
            : normalizedActualCost,
        );
        return {
          kind: "handled" as const,
          claimed: false,
          result: {
            reservedAmount,
            actualCost: normalizedActualCost,
            reservationTransactionId,
            settlementTransactionIds,
            adjustmentType: "none" as const,
          },
        };
      }

      const claimedReservedAmount = Math.abs(parseNumeric(claimed.amount, "reservation_amount"));
      const difference = claimedReservedAmount - normalizedActualCost;
      const baseMetadata = {
        ...metadata,
        reservation_transaction_id: reservationTransactionId,
        reserved: claimedReservedAmount,
        actual: normalizedActualCost,
      };

      if (Math.abs(difference) < EPSILON) {
        await enqueueAffiliatePayout(normalizedActualCost);
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
        assertCreditRefundWithinReservation({
          reservedAmount: claimedReservedAmount,
          refundAmount: difference,
          scope: "CreditsService.reconcileReservationTransaction",
        });
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
        await enqueueAffiliatePayout(normalizedActualCost);
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
        await enqueueAffiliatePayout(claimedReservedAmount);
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
      await enqueueAffiliatePayout(normalizedActualCost);
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
      await this.notifyBalanceDecrease(
        organizationId,
        result.newBalance,
        result.balanceDecreaseMetadata,
      );
    }
    return result;
  }

  /**
   * Collect a deferred affiliate request whose authoritative hold was refused.
   *
   * The payer debit and payout intent share one transaction. Available balance
   * is collected up to the actual charge, while the outbox derives earnings
   * only from the affiliate-markup portion of that collected amount.
   */
  async collectAffiliateInferenceFallback(
    params: AffiliateInferenceFallbackParams,
  ): Promise<CreditReconciliationResult> {
    const actual = new Decimal(params.actualCost);
    if (!actual.isFinite() || actual.isNegative()) {
      throw new Error("[CreditsService] Affiliate fallback actual cost is invalid");
    }
    if (actual.isZero()) {
      return {
        reservedAmount: 0,
        actualCost: 0,
        settlementTransactionIds: [],
        adjustmentType: "none",
      };
    }

    const debitKey = `inference-debit:${params.organizationId}:${params.requestId}`;
    const actualCost = actual.toDecimalPlaces(6).toNumber();
    const payoutSourceId = (
      params.reservationMetadata.affiliatePayout as { sourceId?: unknown } | undefined
    )?.sourceId;
    const outcome = await writeTransaction(async (tx) => {
      const [org] = await sqlRows<{ current_balance: string | number }>(
        tx,
        sql`
          SELECT credit_balance::numeric AS current_balance
          FROM organizations
          WHERE id = ${params.organizationId}
          FOR UPDATE
        `,
      );
      if (!org) {
        return {
          collectedAmount: 0,
          actualCost,
          newBalance: 0,
          transactionId: null,
          inserted: false,
        };
      }

      const [existing] = await sqlRows<{
        id: string;
        organization_id: string;
        amount: string | number;
        metadata: Record<string, unknown> | string | null;
      }>(
        tx,
        sql`
          SELECT id, organization_id, amount, metadata
          FROM credit_transactions
          WHERE stripe_payment_intent_id = ${debitKey}
          LIMIT 1
        `,
      );
      if (existing) {
        const existingMetadata = parseMetadata(existing.metadata);
        const collectedAmount = Math.abs(
          parseNumeric(existing.amount, "affiliate_fallback_amount"),
        );
        const persistedActualCost = parseNumeric(
          typeof existingMetadata.actualCostUsd === "string" ||
            typeof existingMetadata.actualCostUsd === "number"
            ? existingMetadata.actualCostUsd
            : null,
          "affiliate_fallback_actual_cost",
        );
        if (
          existing.organization_id !== params.organizationId ||
          existingMetadata.requestId !== params.requestId ||
          existingMetadata.affiliatePayoutSourceId !== payoutSourceId ||
          existingMetadata.model !== params.model ||
          existingMetadata.provider !== params.provider ||
          existingMetadata.billingSource !== params.billingSource ||
          persistedActualCost < 0 ||
          collectedAmount - persistedActualCost > EPSILON
        ) {
          throw new Error("[CreditsService] Affiliate fallback replay mismatch");
        }
        if (Math.abs(persistedActualCost - actualCost) > EPSILON) {
          logger.warn(
            "[CreditsService] Affiliate inference replay retained the first committed amount",
            {
              organizationId: params.organizationId,
              requestId: params.requestId,
              attemptedActualCost: actualCost,
              persistedActualCost,
            },
          );
        }
        await enqueueCollectedAffiliatePayout(tx, {
          reservationMetadata: params.reservationMetadata,
          actualTotalCost: persistedActualCost,
          collectedTotalCost: collectedAmount,
        });
        return {
          collectedAmount,
          actualCost: persistedActualCost,
          newBalance: parseNumeric(org.current_balance, "current_balance"),
          transactionId: existing.id,
          inserted: false,
        };
      }

      const currentBalance = new Decimal(org.current_balance);
      if (!currentBalance.isFinite() || currentBalance.isNegative()) {
        throw new Error("[CreditsService] Affiliate fallback balance is invalid");
      }
      const collected = Decimal.min(currentBalance, actual).toDecimalPlaces(6);
      if (!collected.gt(0)) {
        return {
          collectedAmount: 0,
          actualCost,
          newBalance: currentBalance.toNumber(),
          transactionId: null,
          inserted: false,
        };
      }

      const newBalance = currentBalance.minus(collected);
      const transactionMetadata = JSON.stringify({
        ...params.reservationMetadata,
        user_id: params.userId,
        requestId: params.requestId,
        model: params.model,
        provider: params.provider,
        billingSource: params.billingSource,
        type: "inference_optimistic",
        source: "deferred_affiliate_fallback",
        actualCostUsd: actual.toFixed(6),
        collectedAmountUsd: collected.toFixed(6),
        affiliatePayoutSourceId: payoutSourceId,
      });
      const [transaction] = await sqlRows<{ id: string }>(
        tx,
        sql`
          WITH updated AS (
            UPDATE organizations
            SET credit_balance = ${newBalance.toFixed(6)}::numeric,
                updated_at = NOW()
            WHERE id = ${params.organizationId}
            RETURNING id
          )
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
            id,
            ${collected.negated().toFixed(6)}::numeric,
            'debit',
            ${`Inference (deferred affiliate fallback): ${params.model}`},
            ${transactionMetadata}::jsonb,
            ${debitKey},
            NOW()
          FROM updated
          RETURNING id
        `,
      );
      if (!transaction) {
        throw new Error("[CreditsService] Affiliate fallback debit did not insert");
      }
      await enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: params.reservationMetadata,
        actualTotalCost: actualCost,
        collectedTotalCost: collected.toNumber(),
      });
      return {
        collectedAmount: collected.toNumber(),
        actualCost,
        newBalance: newBalance.toNumber(),
        transactionId: transaction.id,
        inserted: true,
      };
    });

    if (outcome.inserted) {
      await CacheInvalidation.onCreditMutation(params.organizationId);
      invalidateOrganizationCache(params.organizationId).catch((error) => {
        // error-policy:J7 the authoritative debit and shared invalidation have
        // committed; this legacy cache eviction is separately observable.
        logger.error("[CreditsService] Failed to invalidate org cache:", error);
      });
      await this.notifyBalanceDecrease(params.organizationId, outcome.newBalance, {
        requestId: params.requestId,
        model: params.model,
        source: "deferred_affiliate_fallback",
      });
    }

    return {
      reservedAmount: outcome.collectedAmount,
      actualCost: outcome.actualCost,
      collectedAmount: outcome.collectedAmount,
      settlementTransactionIds: outcome.transactionId ? [outcome.transactionId] : [],
      adjustmentType:
        outcome.collectedAmount + EPSILON >= outcome.actualCost ? "none" : "uncollected_overage",
    };
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
    assertValidCreditSettlementCosts({
      reservedAmount,
      actualCost,
      scope: "CreditsService.reconcile",
    });
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
          // A named reservation that matches no row means the hold was never
          // verified. Falling through to the legacy lane would refund
          // `reservedAmount - actualCost` keyed only on caller-supplied numbers
          // — minting credit with no corresponding debit. Refuse instead.
          throw new ReservationNotFoundError(reservationTxId, organizationId);
        } catch (error) {
          // error-policy:J2 retry the same transaction-scoped settlement, then
          // surface its failure so a durable reservation remains recoverable.
          if (error instanceof ReservationNotFoundError) {
            // The row is absent, not busy. Retrying cannot help.
            throw error;
          }
          if (attempt === MAX_RETRIES) {
            logger.error("[Credits] Reservation reconciliation failed after retries", {
              organizationId,
              reserved: reservedAmount,
              actual: actualCost,
              reservationTransactionId: reservationTxId,
              difference,
              error: error instanceof Error ? error.message : "Unknown error",
            });
            throw error;
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

    // The reservation-backed lane returns above. This legacy lane remains only
    // for charge-only compatibility and therefore has no authoritative
    // transaction from which to derive a stable key.

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (difference > 0) {
          const error = new UnbackedCreditRefundError("CreditsService.reconcile");
          logger.error("[Credits] Refusing refund without an authoritative reservation", {
            organizationId,
            reserved: reservedAmount,
            actual: actualCost,
            refund: difference,
            code: error.code,
          });
          throw error;
        }

        const overage = -difference;
        const overageResult = await this.deductCredits({
          organizationId,
          amount: overage,
          description: `${description} (overage)`,
          metadata: { ...baseMetadata, type: "reconciliation_overage" },
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
        if (error instanceof UnbackedCreditRefundError) {
          // Contract failures cannot become backed through a retry.
          throw error;
        }
        if (attempt === MAX_RETRIES) {
          logger.error("[Credits] Reconciliation failed after retries", {
            organizationId,
            reserved: reservedAmount,
            actual: actualCost,
            difference,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          // error-policy:J2 surface the exhausted settlement failure. The old
          // behavior returned a success-shaped result (`adjustmentType:
          // "none"`) here, which made a lost refund (org keeps overpaying) or
          // an uncharged overage indistinguishable from a clean settle.
          throw error;
        }
        logger.warn("[Credits] Reconciliation retry", {
          attempt,
          organizationId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }

    // Unreachable: every retry-loop iteration either returns or throws, and
    // the final attempt rethrows. Kept as a guard so a future refactor cannot
    // silently reintroduce a success-shaped default.
    throw new Error("[CreditsService] reconcile exited retry loop without settling");
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
              { id: row.id, description, organizationId: row.organization_id },
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
    row: { id: string; description: string; organizationId: string },
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
    const storedMarkupPercentage =
      metadataNumber(reservationMetadata.markupPercentage) ??
      metadataNumber(reservationMetadata.markup_percentage);
    const storedCreatorMarkup =
      metadataNumber(reservationMetadata.creatorMarkup) ??
      metadataNumber(reservationMetadata.creator_markup);
    const markupPercentage =
      storedMarkupPercentage ??
      (storedCreatorMarkup !== null && reservedBaseCost > 0
        ? (storedCreatorMarkup / reservedBaseCost) * 100
        : 0);

    const currentApp = await appsRepository.findById(appId);
    const storedCreatorUserId =
      typeof reservationMetadata.creatorUserId === "string"
        ? reservationMetadata.creatorUserId
        : typeof reservationMetadata.creator_user_id === "string"
          ? reservationMetadata.creator_user_id
          : null;
    const appName =
      typeof reservationMetadata.appName === "string" ? reservationMetadata.appName : appId;
    if (markupPercentage > 0 && !storedCreatorUserId) {
      stats.skipped++;
      logger.error("[Credits] Stale app-chat reservation has no charge-time creator — skipping", {
        reservationTransactionId: row.id,
        appId,
      });
      return;
    }
    const app =
      currentApp ??
      (storedCreatorUserId || markupPercentage === 0
        ? {
            name: appName,
            created_by_user_id: storedCreatorUserId,
            monetization_enabled: markupPercentage > 0,
            platform_offset_amount: 0,
            purchase_share_percentage: 0,
            inference_markup_percentage: markupPercentage,
            persistAppEarnings: false,
          }
        : null);
    if (!app) {
      stats.skipped++;
      logger.error(
        "[Credits] Stale app-chat reservation is missing app accounting inputs — skipping",
        {
          reservationTransactionId: row.id,
          appId,
          hasCreatorUserId: storedCreatorUserId !== null,
          markupPercentage,
        },
      );
      return;
    }
    const chargeTimeApp = {
      ...app,
      created_by_user_id: storedCreatorUserId ?? app.created_by_user_id,
      monetization_enabled: markupPercentage > 0,
      platform_offset_amount: 0,
      purchase_share_percentage: 0,
      inference_markup_percentage: markupPercentage,
    };

    // Lazy import: app-credits statically imports this module, so a static
    // import here would create a module cycle.
    const { appCreditsService } = await import("./app-credits");
    const result = await appCreditsService.reconcileCredits({
      appId,
      userId,
      organizationId: row.organizationId,
      estimatedBaseCost: reservedBaseCost,
      actualBaseCost: assumedActualBaseCost,
      description: row.description,
      metadata: {
        settlement_source: "stale_reservation_sweep",
        charge_time_markup_percentage: markupPercentage,
      },
      app: chargeTimeApp,
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
    // `< 0` alone lets NaN through (the comparison is false), and a NaN
    // reservation amount would be written as a 'NaN'::numeric debit row.
    if (params.amount !== undefined && (!Number.isFinite(params.amount) || params.amount < 0)) {
      throw new InvalidCreditAmountError(params.amount, "reserve");
    }
    if (
      params.estimatedCostMultiplier !== undefined &&
      (!Number.isFinite(params.estimatedCostMultiplier) || params.estimatedCostMultiplier < 0)
    ) {
      throw new Error("reserve() estimatedCostMultiplier must be non-negative");
    }

    const estimatedCostMultiplier = params.estimatedCostMultiplier ?? 1;
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

      estimatedCost = totalCost * estimatedCostMultiplier;
      reservedAmount = Math.max(estimatedCost * COST_BUFFER, MIN_RESERVATION);
    } else {
      throw new Error("reserve() requires either `amount` or `model`");
    }

    // #16425: an idempotency key names the LOGICAL operation so a client retry
    // (e.g. the forced-cloud TTS direct→proxy fallback after an ambiguous
    // network outcome) replays the committed reservation instead of deducting
    // again. Org-scoped so a key from another tenant can never attach here.
    const idempotencyMarker = params.idempotencyKey
      ? `reserve:${organizationId}:${params.idempotencyKey}`
      : undefined;

    const reserveOnce = () =>
      this.reserveAndDeductCredits({
        organizationId,
        amount: reservedAmount,
        description: `${description} (reserved)`,
        ...(idempotencyMarker && { stripePaymentIntentId: idempotencyMarker }),
        metadata: {
          ...(params.metadata ?? {}),
          user_id: userId,
          type: "reservation",
          settlement_marker: RESERVATION_SETTLEMENT_MARKER,
          estimated_cost: estimatedCost,
          reserved_amount: reservedAmount,
          ...(estimatedCostMultiplier !== 1 && {
            estimated_cost_multiplier: estimatedCostMultiplier,
          }),
          ...(model && { model }),
        },
      });

    let result: Awaited<ReturnType<typeof reserveOnce>>;
    try {
      result = await reserveOnce();
    } catch (error) {
      // Keyed concurrency backstop (#10846 pattern): a racing duplicate aborts
      // the whole atomic statement on the stripe_payment_intent_id unique
      // index. Retry once — the pre-committed-transaction check then resolves
      // to the winner's reservation and this call replays it.
      if (!idempotencyMarker) throw error;
      result = await reserveOnce();
    }

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

    // On a keyed REPLAY the transaction is the original reservation, whose
    // reserved amount may differ from this call's estimate (e.g. a retried
    // utterance re-estimated after a pricing refresh). The handle must carry
    // the ORIGINAL amount so reconcile's refund/overage math settles the row
    // that was actually deducted.
    if (idempotencyMarker) {
      const originalReserved = Number(
        (result.transaction.metadata as { reserved_amount?: unknown } | null)?.reserved_amount,
      );
      if (Number.isFinite(originalReserved) && originalReserved > 0) {
        reservedAmount = originalReserved;
      }
    }

    logger.info("[Credits] Reserved", {
      organizationId,
      reservedAmount,
      ...(model && { model }),
      ...(idempotencyMarker && { keyed: true }),
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
            ...(params.metadata ?? {}),
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
