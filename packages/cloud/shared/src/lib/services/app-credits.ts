/**
 * Service for managing app-specific credit balances and purchases.
 */

import { eq, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { appEarningsRepository } from "../../db/repositories/app-earnings";
import { type App, appsRepository } from "../../db/repositories/apps";
import { organizationsRepository } from "../../db/repositories/organizations";
import { usersRepository } from "../../db/repositories/users";
import { apps } from "../../db/schemas/apps";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { getRequestIdempotencyKey } from "../runtime/request-context";
import { logger } from "../utils/logger";
import {
  computeInferenceCharge,
  computePurchaseSplit,
  computeReconciliation,
} from "./app-credit-math";
import {
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
  MIN_RESERVATION,
} from "./credits";
import { redeemableEarningsService } from "./redeemable-earnings";

/**
 * Subset of app row used to compute inference cost markup. Cached per appId on
 * the LLM hot path so /v1/messages, /v1/chat/completions, /v1/chat don't hit
 * Postgres for monetization config on every request. Re-derive per-call cost
 * from these inputs locally.
 */
interface CostMarkupConfig {
  monetizationEnabled: boolean;
  inferenceMarkupPercentage: number;
}

interface AppCreditAccountingApp {
  name?: string | null;
  created_by_user_id?: string | null;
  monetization_enabled: boolean;
  platform_offset_amount?: number | string | null;
  purchase_share_percentage?: number | string | null;
  inference_markup_percentage?: number | string | null;
  persistAppEarnings?: boolean;
}

/** Negative-cache marker for missing apps. */
interface NoneMarker {
  __none: true;
}

/**
 * Invalidate the cached app row + markup config after a mutation that touches
 * fields read on the LLM hot path (monetization toggle, markup %, earnings
 * counters, etc.). Direct cache.del to avoid a circular dependency on
 * appsService — both modules sit in the same layer.
 */
async function invalidateAppCacheKeys(appId: string, slug?: string): Promise<void> {
  const promises: Promise<void>[] = [
    cache.del(CacheKeys.app.byId(appId)),
    cache.del(CacheKeys.app.costMarkup(appId)),
  ];
  if (slug) {
    promises.push(cache.del(CacheKeys.app.bySlug(slug)));
  }
  await Promise.all(promises);
}

/**
 * Threshold for reconciliation - differences below this are ignored (6 decimal precision)
 */
const RECONCILIATION_THRESHOLD = 0.000001;

/**
 * The charge stage ("leg") of a creator-earnings movement, threaded explicitly
 * from every call site into the dedupe key.
 *
 * #10847 follow-up: one request legitimately makes SEVERAL distinct earnings
 * movements under the SAME request idempotency key — e.g. `apps/[id]/chat`
 * calls `deductCredits` (estimate) and then `reconcileCredits` (actual) in one
 * request. Keying dedupe on `${chargeKey}:${type}` alone made the reconcile
 * top-up collide with the deduct-time credit and get silently dropped
 * (creator under-credited). The leg keeps a true retry of the SAME movement
 * idempotent while never conflating two DIFFERENT movements.
 */
type CreatorEarningsLeg = "deduct" | "reconcile_charge" | "purchase";

/** Charge stage for earnings reversals — same rationale as {@link CreatorEarningsLeg}. */
type CreatorEarningsReversalLeg = "reconcile_refund" | "compensation_reversal";

/**
 * Maximum metadata size in bytes (10KB) to prevent storage bloat and DOS attacks
 */
const MAX_METADATA_SIZE_BYTES = 10240;

/**
 * Maximum nesting depth for metadata objects to prevent stack overflow
 */
const MAX_METADATA_DEPTH = 5;

/**
 * Validates metadata object for size and depth constraints.
 * Returns sanitized metadata or throws on violation.
 */
function validateMetadata(
  metadata: Record<string, unknown> | undefined,
  context: string,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  // Check serialized size
  const serialized = JSON.stringify(metadata);
  if (serialized.length > MAX_METADATA_SIZE_BYTES) {
    throw new Error(
      `${context}: Metadata exceeds maximum size of ${MAX_METADATA_SIZE_BYTES} bytes`,
    );
  }

  // Check nesting depth
  const checkDepth = (obj: unknown, depth: number): void => {
    if (depth > MAX_METADATA_DEPTH) {
      throw new Error(
        `${context}: Metadata exceeds maximum nesting depth of ${MAX_METADATA_DEPTH}`,
      );
    }
    if (obj && typeof obj === "object") {
      for (const value of Object.values(obj)) {
        checkDepth(value, depth + 1);
      }
    }
  };
  checkDepth(metadata, 1);

  return metadata;
}

/**
 * Thread the caller's stable per-charge id into the metadata consumed by
 * `recordCreatorEarnings`/`reverseCreatorEarnings`. The key is passed RAW:
 * stage discrimination lives in ONE place — the `leg` component of the
 * earnings dedupe sourceId (`${chargeKey}:${type}:${leg}`) — so the estimate
 * deduct and a later reconcile adjustment each dedupe independently without a
 * second, route-level phase suffix (#10847 follow-up composing with #10892).
 */
function withChargeIdempotencyKey(
  metadata: Record<string, unknown> | undefined,
  idempotencyKey: string | undefined,
): Record<string, unknown> | undefined {
  if (!idempotencyKey) return metadata;
  return {
    ...metadata,
    idempotencyKey,
  };
}

function mapAppReconciliationToCreditResult(
  result: AppCreditReconciliationResult,
  reservedAmount: number,
  actualCost: number,
  reservationTransactionId: string | null,
): CreditReconciliationResult {
  let adjustmentType: CreditReconciliationResult["adjustmentType"] = "none";

  if (result.action === "refund" && result.reconciled) {
    adjustmentType = "refund";
  } else if (result.action === "charge") {
    adjustmentType = result.reconciled ? "overage" : "uncollected_overage";
  }

  return {
    reservedAmount,
    actualCost,
    reservationTransactionId,
    settlementTransactionIds: [],
    adjustmentType,
  };
}

/**
 * Parameters for purchasing app credits.
 */
export interface AppCreditPurchaseParams {
  appId: string;
  userId: string;
  organizationId: string;
  purchaseAmount: number;
  stripePaymentIntentId?: string; // For deduplication on webhook retries
}

/**
 * Result of purchasing app credits.
 *
 * `newBalance` is the purchasing user's ORGANIZATION credit balance — app
 * purchases and app inference share the single org ledger (#8253).
 */
export interface AppCreditPurchaseResult {
  success: boolean;
  creditsAdded: number;
  platformOffset: number;
  creatorEarnings: number;
  newBalance: number;
}

/**
 * Parameters for deducting app credits.
 */
export interface AppCreditDeductionParams {
  appId: string;
  userId: string;
  baseCost: number;
  description: string;
  metadata?: Record<string, unknown>;
  /** Optional: pass pre-fetched app to avoid N+1 query */
  app?: App;
}

/**
 * Result of deducting app credits.
 */
export interface AppCreditDeductionResult {
  success: boolean;
  baseCost: number;
  creatorMarkup: number;
  totalCost: number;
  creatorEarnings: number;
  newBalance: number;
  transactionId?: string;
  message?: string;
}

/**
 * Parameters for atomically reserving app inference credits before model work.
 */
export interface AppCreditInferenceReservationParams {
  appId: string;
  userId: string;
  estimatedBaseCost: number;
  description: string;
  metadata?: Record<string, unknown>;
  /**
   * Stable request id used to dedupe creator earnings across settlement
   * retries. Pass the SAME value for the whole request: the earnings layer
   * appends the movement leg (deduct / reconcile_charge / reconcile_refund /
   * compensation_reversal) to the dedupe key, so the upfront estimate and a
   * later reconcile adjustment each credit the creator exactly once.
   */
  idempotencyKey?: string;
  /** Optional: pass pre-fetched app to avoid N+1 query */
  app?: App;
}

/**
 * Parameters for reconciling app credits after actual usage is known.
 */
export interface AppCreditReconciliationParams {
  appId: string;
  userId: string;
  /**
   * Server-only override for settling a known debit row against the org that
   * originally paid it. Stale app-chat sweeps can run long after the user moved
   * orgs, so recomputing this from the mutable user row is unsafe.
   */
  organizationId?: string;
  estimatedBaseCost: number;
  actualBaseCost: number;
  description: string;
  metadata?: Record<string, unknown>;
  /** Optional: pass pre-fetched app to avoid N+1 query */
  app?: AppCreditAccountingApp;
  /**
   * SERVER-GENERATED id of the reservation's deduct transaction
   * (credit_transactions.id, a DB UUID). When present, the reconcile
   * refund/charge legs are made idempotent by keying their synthetic
   * stripePaymentIntentId on it (`reconcile-refund:<id>` /
   * `reconcile-charge:<id>`), so a re-invoked settle of the SAME reservation
   * dedupes on the credit_transactions unique index instead of moving money
   * twice (#11512). MUST never be a client-supplied value: that unique index
   * is global (not org-scoped), so a client-controlled key would let one
   * org's settle dedupe away another org's refund or overage charge.
   */
  reservationTransactionId?: string | null;
}

/**
 * Result of reconciling app credits.
 */
export interface AppCreditReconciliationResult {
  reconciled: boolean;
  difference: number;
  action: "refund" | "charge" | "none";
  adjustedAmount: number;
  newBalance: number;
}

/**
 * Service for managing app-specific credit balances, purchases, and deductions.
 */
export class AppCreditsService {
  /** The org credit balance — the single ledger app purchases fund and app inference debits (#8253). */
  private async readOrgBalance(organizationId: string): Promise<number> {
    const org = await organizationsRepository.findById(organizationId);
    return org ? Number.parseFloat(String(org.credit_balance)) : 0;
  }

  async processPurchase(params: AppCreditPurchaseParams): Promise<AppCreditPurchaseResult> {
    const { appId, userId, organizationId, purchaseAmount, stripePaymentIntentId } = params;

    const app = await appsRepository.findById(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }

    // Deduplication check for Stripe webhook retries
    if (stripePaymentIntentId) {
      const existingTransaction = await appEarningsRepository.findTransactionByPaymentIntent(
        appId,
        stripePaymentIntentId,
      );
      if (existingTransaction) {
        logger.info("[AppCredits] Duplicate purchase detected, skipping", {
          appId,
          userId,
          stripePaymentIntentId,
        });
        return {
          success: true,
          creditsAdded: 0, // Already processed
          platformOffset: 0,
          creatorEarnings: 0,
          newBalance: await this.readOrgBalance(organizationId),
        };
      }
    }

    // Only apply platform offset and creator share if monetization is enabled;
    // users always get full credits for their purchase. Math in app-credit-math.ts.
    const { platformOffset, creatorEarnings, creditsToAdd } = computePurchaseSplit(purchaseAmount, {
      monetizationEnabled: app.monetization_enabled,
      platformOffsetAmount: Number(app.platform_offset_amount),
      purchaseSharePercentage: Number(app.purchase_share_percentage),
      inferenceMarkupPercentage: Number(app.inference_markup_percentage),
    });

    logger.info("[AppCredits] Processing purchase", {
      appId,
      userId,
      purchaseAmount,
      platformOffset,
      creatorEarnings,
      creditsToAdd,
    });

    // Credit the purchasing user's ORG balance — the same ledger
    // `deductCredits()` debits — so purchased credits are spendable on app
    // inference (#8253: previously this funded the per-app
    // `app_credit_balances` pool, which the spend path no longer reads, so
    // purchased credits were stranded).
    const { newBalance } = await creditsService.addCredits({
      organizationId,
      amount: creditsToAdd,
      description: `App credit purchase (${app.name ?? appId})`,
      metadata: {
        appId,
        userId,
        purchaseAmount,
        platformOffset,
        creatorEarnings,
        type: "app_credit_purchase",
      },
      ...(stripePaymentIntentId && { stripePaymentIntentId }),
    });

    // Track app user activity for purchase (this will create app_users record if new user)
    await this.trackAppUserActivity(app, userId, "0.00", {
      type: "purchase",
      purchaseAmount,
      creditsAdded: creditsToAdd,
      ...(stripePaymentIntentId && { stripePaymentIntentId }),
    });

    // CRITICAL: Always create a transaction record for deduplication purposes
    // Even when monetization is disabled, we need to track the purchase
    if (app.monetization_enabled && creatorEarnings > 0) {
      const { deduplicated } = await this.recordCreatorEarnings(
        appId,
        userId,
        "purchase_share",
        creatorEarnings,
        "purchase",
        {
          purchaseAmount,
          platformOffset,
          creatorSharePercentage: Number(app.purchase_share_percentage),
          ...(stripePaymentIntentId && { stripePaymentIntentId }),
        },
        app, // Pass app to avoid N+1 query
      );

      // A dedup retry already counted this purchase — incrementing again would
      // drift the apps aggregate away from the redeemable ledger (#10847).
      if (!deduplicated) {
        await dbWrite
          .update(apps)
          .set({
            total_creator_earnings: sql`${apps.total_creator_earnings} + ${creatorEarnings}`,
            total_platform_revenue: sql`${apps.total_platform_revenue} + ${platformOffset}`,
            updated_at: new Date(),
          })
          .where(eq(apps.id, appId));
      }
    } else if (stripePaymentIntentId) {
      // Monetization disabled but still need transaction record for deduplication
      await appEarningsRepository.createTransaction({
        app_id: appId,
        user_id: userId,
        type: "credit_purchase",
        amount: "0", // No earnings when monetization disabled
        description: "Credit purchase (monetization disabled)",
        metadata: {
          purchaseAmount,
          creditsAdded: creditsToAdd,
          stripePaymentIntentId,
          monetizationDisabled: true,
        },
      });
    }

    return {
      success: true,
      creditsAdded: creditsToAdd,
      platformOffset,
      creatorEarnings,
      newBalance,
    };
  }

  async reserveInferenceCredits(
    params: AppCreditInferenceReservationParams,
  ): Promise<CreditReservation> {
    const { appId, userId, estimatedBaseCost, description, metadata, idempotencyKey, app } = params;

    // A $0 estimate (free/unpriced model) must still open a valid hold:
    // reserveAndDeductCredits throws on amount <= 0, which surfaced as a 500 on
    // /v1/chat/completions and /v1/messages for monetized apps. Floor the hold
    // at MIN_RESERVATION — the same floor the org-credits reservation path
    // applies — and reconcile trues it up to actual cost (refunding the floor
    // when actual stays $0).
    const flooredEstimate = Math.max(estimatedBaseCost, MIN_RESERVATION);

    const deduction = await this.deductCredits({
      appId,
      userId,
      baseCost: flooredEstimate,
      description,
      metadata: withChargeIdempotencyKey(metadata, idempotencyKey),
      app,
    });

    if (!deduction.success) {
      throw new InsufficientCreditsError(
        deduction.totalCost,
        deduction.newBalance,
        "insufficient_balance",
      );
    }

    const reservationTransactionId = deduction.transactionId ?? null;

    return {
      reservedAmount: deduction.totalCost,
      reservationTransactionId,
      reconcile: async (actualBaseCost: number) => {
        const reconciliation = await this.reconcileCredits({
          appId,
          userId,
          // Reconcile against the FLOORED estimate — that is what was actually
          // debited; using the raw $0 estimate would skip refunding the floor.
          estimatedBaseCost: flooredEstimate,
          actualBaseCost,
          description,
          metadata: withChargeIdempotencyKey(metadata, idempotencyKey),
          app,
          // Server-generated key for the reconcile legs' idempotent ledger
          // writes (#11512) — the deduct row's own transaction id, never the
          // client idempotencyKey (globally-unique index ⇒ a client key would
          // collide across orgs).
          reservationTransactionId,
        });

        return mapAppReconciliationToCreditResult(
          reconciliation,
          deduction.totalCost,
          actualBaseCost,
          reservationTransactionId,
        );
      },
    };
  }

  async deductCredits(params: AppCreditDeductionParams): Promise<AppCreditDeductionResult> {
    const {
      appId,
      userId,
      baseCost,
      description,
      metadata: rawMetadata,
      app: providedApp,
    } = params;

    // Validate metadata size and depth
    const metadata = validateMetadata(rawMetadata, "deductCredits");

    // Use provided app to avoid N+1 query, or fetch if not provided
    const app = providedApp ?? (await appsRepository.findById(appId));
    if (!app) {
      return {
        success: false,
        baseCost,
        creatorMarkup: 0,
        totalCost: baseCost,
        creatorEarnings: 0,
        newBalance: 0,
        message: `App not found: ${appId}`,
      };
    }

    // Only apply markup if monetization is enabled; otherwise users pay base
    // cost only and the creator earns nothing. Math in app-credit-math.ts.
    const { markupPercentage, creatorMarkup, totalCost } = computeInferenceCharge(baseCost, {
      monetizationEnabled: app.monetization_enabled,
      platformOffsetAmount: Number(app.platform_offset_amount),
      purchaseSharePercentage: Number(app.purchase_share_percentage),
      inferenceMarkupPercentage: Number(app.inference_markup_percentage),
    });

    // Debit from the user's organization credit balance. Atomic via row-lock.
    // Switched from `app_credit_balances` (per-app pre-purchased pool) to the
    // org balance so any signed-in user with cloud credits can use any
    // monetized app without a separate top-up. App dev still earns the
    // markup via `recordCreatorEarnings()` below.
    const user = await usersRepository.findById(userId);
    if (!user?.organization_id) {
      return {
        success: false,
        baseCost,
        creatorMarkup,
        totalCost,
        creatorEarnings: 0,
        newBalance: 0,
        message: `User has no organization: ${userId}`,
      };
    }
    const orgDeduct = await creditsService.reserveAndDeductCredits({
      organizationId: user.organization_id,
      amount: totalCost,
      description: description ?? `App inference (${app.name ?? appId})`,
      metadata: {
        ...metadata,
        appId,
        userId,
        baseCost,
        creatorMarkup,
        totalCost,
        markupPercentage,
        creatorUserId: app.created_by_user_id,
        appName: app.name,
      },
    });

    if (!orgDeduct.success) {
      return {
        success: false,
        baseCost,
        creatorMarkup,
        totalCost,
        creatorEarnings: 0,
        newBalance: orgDeduct.newBalance,
        message: `Insufficient cloud credits. Required: $${totalCost.toFixed(2)}, Available: $${orgDeduct.newBalance.toFixed(2)}`,
      };
    }

    // #10846: track whether the creator earnings were committed, so a failure in
    // the *following* (non-co-transactional) apps-counter update can reverse them
    // instead of leaving unbacked earnings minted when the consumer is refunded.
    let creatorEarningsRecorded = false;
    try {
      // Track app user activity (creates/updates app_users record)
      await this.trackAppUserActivity(app, userId, totalCost.toFixed(4), metadata);

      if (app.monetization_enabled && creatorMarkup > 0) {
        const { deduplicated } = await this.recordCreatorEarnings(
          appId,
          userId,
          "inference_markup",
          creatorMarkup,
          "deduct",
          {
            baseCost,
            markupPercentage,
            totalCost,
            description,
            chargeTransactionId: orgDeduct.transaction?.id,
            ...metadata,
          },
          app, // Pass app to avoid N+1 query
        );
        // Earnings (app-earnings ledger + creator redeemable balance) are now
        // committed; the apps aggregate counter below is a separate write. On a
        // dedup retry THIS attempt minted nothing new, so there is nothing to
        // reverse in the compensation path and nothing to count again (#10847).
        creatorEarningsRecorded = !deduplicated;

        if (!deduplicated) {
          await dbWrite
            .update(apps)
            .set({
              total_creator_earnings: sql`${apps.total_creator_earnings} + ${creatorMarkup}`,
              total_platform_revenue: sql`${apps.total_platform_revenue} + ${baseCost}`,
              updated_at: new Date(),
            })
            .where(eq(apps.id, appId));
        }
      }
    } catch (postDebitError) {
      logger.error("[AppCredits] Post-debit accounting failed, compensating charge", {
        appId,
        userId,
        baseCost,
        creatorMarkup,
        totalCost,
        chargeTransactionId: orgDeduct.transaction?.id,
        error: postDebitError instanceof Error ? postDebitError.message : String(postDebitError),
      });
      // #10846: if the creator earnings were already committed (recordCreatorEarnings
      // succeeded, the apps-counter update then threw), reverse them BEFORE
      // compensating the consumer — otherwise the consumer nets to zero while the
      // creator keeps `creatorMarkup` of redeemable earnings nobody paid for. This
      // mirrors the reconcileCredits refund branch, which already pairs the two.
      // The apps aggregate counter was never incremented (its update is what threw),
      // so it needs no adjustment here. Best-effort + logged: a reversal failure must
      // not mask the original error or block the consumer refund.
      if (creatorEarningsRecorded) {
        try {
          await this.reverseCreatorEarnings(appId, userId, creatorMarkup, "compensation_reversal", {
            type: "compensation_reversal",
            baseCost,
            markupPercentage,
            totalCost,
            description,
            chargeTransactionId: orgDeduct.transaction?.id,
            reason: "post_debit_accounting_failed",
            ...metadata,
          });
        } catch (reversalError) {
          logger.error(
            "[AppCredits] Failed to reverse creator earnings during compensation — manual reconciliation may be needed",
            {
              appId,
              userId,
              creatorMarkup,
              chargeTransactionId: orgDeduct.transaction?.id,
              error: reversalError instanceof Error ? reversalError.message : String(reversalError),
            },
          );
        }
      }
      await creditsService.addCredits({
        organizationId: user.organization_id,
        amount: totalCost,
        description: `Compensation refund for failed app inference (${app.name ?? appId})`,
        metadata: {
          appId,
          userId,
          baseCost,
          creatorMarkup,
          totalCost,
          originalChargeTransactionId: orgDeduct.transaction?.id,
          reason: "post_debit_accounting_failed",
          ...metadata,
        },
      });
      throw postDebitError;
    }

    logger.info("[AppCredits] Deducted credits", {
      appId,
      userId,
      baseCost,
      creatorMarkup,
      totalCost,
      newBalance: orgDeduct.newBalance,
    });

    return {
      success: true,
      baseCost,
      creatorMarkup,
      totalCost,
      creatorEarnings: creatorMarkup,
      newBalance: orgDeduct.newBalance,
      transactionId: orgDeduct.transaction?.id,
    };
  }

  /**
   * Reconcile credits after actual usage is known.
   *
   * This handles the difference between estimated and actual costs:
   * - If actual < estimated: refund the difference to user
   * - If actual > estimated: charge the additional amount (if balance allows)
   * - Also adjusts creator earnings accordingly
   *
   * Threshold: Only reconcile if difference > $0.000001 (6 decimal precision)
   */
  async reconcileCredits(
    params: AppCreditReconciliationParams,
  ): Promise<AppCreditReconciliationResult> {
    const {
      appId,
      userId,
      organizationId: providedOrganizationId,
      estimatedBaseCost,
      actualBaseCost,
      description,
      metadata: rawMetadata,
      reservationTransactionId,
      app: providedApp,
    } = params;

    // Validate metadata size and depth
    const metadata = validateMetadata(rawMetadata, "reconcileCredits");
    const settlementMetadata = reservationTransactionId
      ? { ...metadata, reservation_transaction_id: reservationTransactionId }
      : metadata;

    // #11512: idempotency key for the org-credit legs below, threaded as a
    // synthetic, namespaced stripePaymentIntentId. creditsService dedupes on
    // the credit_transactions.stripe_payment_intent_id unique index, so a
    // re-invoked reconcile (a settle retry after a mid-reconcile throw, where
    // the org refund already COMMITTED before reverseCreatorEarnings / the
    // apps-counter update threw) returns the first transaction as a no-op
    // instead of refunding or charging the org a second time.
    //
    // The key MUST be SERVER-GENERATED. That unique index is GLOBAL — not
    // org-scoped — so a client-controlled key (Idempotency-Key header,
    // x-request-id, metadata.idempotencyKey) would let Org A's reconcile
    // dedupe away Org B's refund or overage charge when both send the same
    // key: a cross-tenant collision where the user silently loses a legit
    // refund and the platform silently skips an overage charge. We therefore
    // key on the reservation's own deduct-transaction id
    // (credit_transactions.id, a DB-generated UUID): stable across
    // re-settles of the SAME reservation, globally unique across
    // reservations and orgs. Same pattern as the org-credits path's
    // `recon:<txid>:<phase>` keys (#10846). The `reconcile-refund:` /
    // `reconcile-charge:` prefixes keep the synthetic keys disjoint from
    // real Stripe intent ids (`pi_…`) and those `recon:` keys. When no
    // reservation transaction id is available (the apps/[id]/chat
    // direct-reconcile paths), we pass NO key — the prior non-idempotent
    // behavior, backstopped by those routes' settle-started flags and the
    // settler's first-call-wins guard (createCreditReservationSettler) — and
    // NEVER fall back to a client-supplied value.
    const chargeKey = reservationTransactionId || null;

    // #11683: the creator-earnings legs below must dedupe across ALL writers
    // that can settle the SAME reservation — the route's late settle and the
    // stale-reservation sweep run in different request contexts, so the ALS
    // request key (and any client-echoed metadata.idempotencyKey) differs
    // between them and the reversal/top-up would double-apply even though the
    // org-credit leg deduped on `reconcile-refund:<id>`/`reconcile-charge:<id>`.
    // Key the earnings legs on the same server-generated reservation deduct
    // transaction id (threaded as metadata.idempotencyKey, which
    // recordCreatorEarnings/reverseCreatorEarnings prefer over the ALS key);
    // the movement leg still disambiguates reconcile_refund vs
    // reconcile_charge. Unkeyed callers keep the prior request-scoped dedup.
    const earningsLegMetadata = (extra: Record<string, unknown>): Record<string, unknown> => ({
      ...extra,
      ...settlementMetadata,
      ...(chargeKey && { idempotencyKey: `reconcile:${chargeKey}` }),
    });

    const baseCostDifference = actualBaseCost - estimatedBaseCost;

    // Resolve the org once — every branch below charges or refunds against the
    // org credit balance, not a per-app pool. Stale-settlement callers pass the
    // original debit row's org id; interactive callers use the user's current
    // organization.
    let organizationId = providedOrganizationId ?? null;
    if (!organizationId) {
      const user = await usersRepository.findById(userId);
      organizationId = user?.organization_id ?? null;
    }
    if (!organizationId) {
      logger.error("[AppCredits] User not found during reconciliation", { userId });
      return {
        reconciled: false,
        difference: baseCostDifference,
        action: "none",
        adjustedAmount: 0,
        newBalance: 0,
      };
    }

    const markReservationSettled = async (reason: string): Promise<void> => {
      if (!reservationTransactionId) return;
      try {
        await creditsService.markReservationSettled({
          organizationId,
          reservationTransactionId,
        });
      } catch (error) {
        logger.error("[AppCredits] Failed to mark app reservation settled", {
          appId,
          userId,
          organizationId,
          reservationTransactionId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const readOrgBalance = async (): Promise<number> => {
      const org = await organizationsRepository.findById(organizationId);
      return org ? Number.parseFloat(String(org.credit_balance)) : 0;
    };

    // Skip reconciliation for negligible differences
    if (Math.abs(baseCostDifference) < RECONCILIATION_THRESHOLD) {
      await markReservationSettled("no_adjustment");
      return {
        reconciled: false,
        difference: 0,
        action: "none",
        adjustedAmount: 0,
        newBalance: await readOrgBalance(),
      };
    }

    // Use provided app to avoid N+1 query, or fetch if not provided
    const app: AppCreditAccountingApp | undefined =
      providedApp ?? (await appsRepository.findById(appId));
    if (!app) {
      logger.error("[AppCredits] App not found during reconciliation", { appId });
      return {
        reconciled: false,
        difference: baseCostDifference,
        action: "none",
        adjustedAmount: 0,
        newBalance: await readOrgBalance(),
      };
    }

    // Calculate the total cost difference including markup. Math in app-credit-math.ts.
    const { markupPercentage, totalCostDifference, creatorMarkupDifference } =
      computeReconciliation(baseCostDifference, {
        monetizationEnabled: app.monetization_enabled,
        platformOffsetAmount: Number(app.platform_offset_amount),
        purchaseSharePercentage: Number(app.purchase_share_percentage),
        inferenceMarkupPercentage: Number(app.inference_markup_percentage),
      });

    if (baseCostDifference < 0) {
      // REFUND: Actual was less than estimated. Add credit back to the org
      // balance and reverse the creator's earnings for the over-charged delta.
      const refundAmount = Math.abs(totalCostDifference);
      const creatorEarningsReduction = Math.abs(creatorMarkupDifference);

      const { newBalance } = await creditsService.refundCredits({
        organizationId,
        amount: refundAmount,
        description: `App reconciliation refund (${app.name ?? appId})`,
        // Idempotent per reservation (#11512): a re-invoked reconcile must not
        // credit the org a second refund (2×reserved − actual = minted,
        // cashable credit).
        stripePaymentIntentId: chargeKey ? `reconcile-refund:${chargeKey}` : undefined,
        metadata: {
          appId,
          userId,
          baseCostDifference,
          estimatedBaseCost,
          actualBaseCost,
          markupPercentage,
          ...settlementMetadata,
        },
      });

      // Reverse creator earnings if monetization is enabled and there was markup
      if (app.monetization_enabled && creatorEarningsReduction > 0) {
        let reversal: { deduplicated: boolean };
        try {
          reversal = await this.reverseCreatorEarnings(
            appId,
            userId,
            creatorEarningsReduction,
            "reconcile_refund",
            earningsLegMetadata({
              type: "reconciliation_refund",
              baseCostDifference,
              estimatedBaseCost,
              actualBaseCost,
              description,
            }),
            app,
          );
        } catch (reversalError) {
          logger.error(
            "[AppCredits] Creator-earnings reversal failed after the reconcile refund committed",
            {
              appId,
              userId,
              organizationId,
              refundAmount,
              creatorEarningsReduction,
              error: reversalError instanceof Error ? reversalError.message : String(reversalError),
            },
          );
          // #10846 mirror for the refund branch: the refund above has already
          // committed, and the reversal is not co-transactional with it. On the
          // KEYED path (reserveInferenceCredits has the server-generated
          // reservation transaction id) retries through the settler with the
          // first actual cost: the refund dedupes on
          // `reconcile-refund:<reservationTransactionId>` (#11512) and this
          // reversal then completes, so the retry heals the pair. Compensating
          // there would strand the org overcharged after the retry. On the
          // UNKEYED path (the app-chat and generate-image routes settle once
          // and never re-invoke) there is NO retry: without compensation the org
          // keeps the refund while the creator keeps the matching markup as
          // unbacked REDEEMABLE earnings. Undo the refund (best-effort + logged,
          // like the #10846 reversal) so the creator's markup stays backed by a
          // real charge, then rethrow.
          if (!chargeKey) {
            try {
              const compensation = await creditsService.reserveAndDeductCredits({
                organizationId,
                amount: refundAmount,
                description: `Compensation charge for failed reconciliation refund (${app.name ?? appId})`,
                metadata: {
                  appId,
                  userId,
                  baseCostDifference,
                  estimatedBaseCost,
                  actualBaseCost,
                  creatorEarningsReduction,
                  reason: "reconcile_refund_reversal_failed",
                  ...settlementMetadata,
                },
              });
              if (!compensation.success) {
                logger.error(
                  "[AppCredits] Failed to compensate reconcile refund after reversal failure — manual reconciliation may be needed",
                  { appId, userId, organizationId, refundAmount },
                );
              }
            } catch (compensationError) {
              logger.error(
                "[AppCredits] Failed to compensate reconcile refund after reversal failure — manual reconciliation may be needed",
                {
                  appId,
                  userId,
                  organizationId,
                  refundAmount,
                  error:
                    compensationError instanceof Error
                      ? compensationError.message
                      : String(compensationError),
                },
              );
            }
          }
          throw reversalError;
        }

        // A dedup retry already applied this reduction — decrementing again
        // would drift the apps aggregate below the redeemable ledger (#10847).
        if (!reversal.deduplicated) {
          await dbWrite
            .update(apps)
            .set({
              total_creator_earnings: sql`GREATEST(0, ${apps.total_creator_earnings} - ${creatorEarningsReduction})`,
              total_platform_revenue: sql`GREATEST(0, ${apps.total_platform_revenue} - ${Math.abs(baseCostDifference)})`,
              updated_at: new Date(),
            })
            .where(eq(apps.id, appId));
        }
      }

      logger.info("[AppCredits] Reconciliation: Refunded overcharge to org balance", {
        appId,
        userId,
        organizationId,
        estimatedBaseCost,
        actualBaseCost,
        refundAmount,
        creatorEarningsReduction,
        newBalance,
      });

      await markReservationSettled("refund");

      return {
        reconciled: true,
        difference: baseCostDifference,
        action: "refund",
        adjustedAmount: refundAmount,
        newBalance,
      };
    }

    // CHARGE: Actual exceeded estimated — debit the delta from the org balance.
    // `reserveAndDeductCredits` is atomic with row-level locking, so concurrent
    // calls can't double-spend.
    const additionalCharge = totalCostDifference;

    const orgDeduct = await creditsService.reserveAndDeductCredits({
      organizationId,
      amount: additionalCharge,
      description: `App reconciliation charge (${app.name ?? appId})`,
      // Symmetric idempotency (#11512): a re-invoked reconcile must not debit
      // the overage from the org twice.
      stripePaymentIntentId: chargeKey ? `reconcile-charge:${chargeKey}` : undefined,
      metadata: {
        appId,
        userId,
        baseCostDifference,
        estimatedBaseCost,
        actualBaseCost,
        markupPercentage,
        creatorMarkupDifference,
        ...settlementMetadata,
      },
    });

    if (orgDeduct.success) {
      if (app.monetization_enabled && creatorMarkupDifference > 0) {
        const { deduplicated } = await this.recordCreatorEarnings(
          appId,
          userId,
          "inference_markup",
          creatorMarkupDifference,
          "reconcile_charge",
          earningsLegMetadata({
            type: "reconciliation_adjustment",
            baseCostDifference,
            description,
          }),
          app,
        );

        // A dedup retry already counted this top-up — see the deduct leg (#10847).
        if (!deduplicated) {
          await dbWrite
            .update(apps)
            .set({
              total_creator_earnings: sql`${apps.total_creator_earnings} + ${creatorMarkupDifference}`,
              total_platform_revenue: sql`${apps.total_platform_revenue} + ${baseCostDifference}`,
              updated_at: new Date(),
            })
            .where(eq(apps.id, appId));
        }
      }

      logger.info("[AppCredits] Reconciliation: Charged additional to org balance", {
        appId,
        userId,
        organizationId,
        estimatedBaseCost,
        actualBaseCost,
        additionalCharge,
        newBalance: orgDeduct.newBalance,
      });

      await markReservationSettled("charge");

      return {
        reconciled: true,
        difference: baseCostDifference,
        action: "charge",
        adjustedAmount: additionalCharge,
        newBalance: orgDeduct.newBalance,
      };
    }

    // Insufficient balance — request already completed, platform absorbs the loss.
    // Logged so we can monitor and recover via debt tracking later.
    logger.warn(
      "[AppCredits] Reconciliation: Insufficient org balance for additional charge (platform absorbing loss)",
      {
        appId,
        userId,
        organizationId,
        additionalCharge,
        currentBalance: orgDeduct.newBalance,
        lossAmount: additionalCharge,
      },
    );

    await markReservationSettled("uncollected_overage");

    return {
      reconciled: false,
      difference: baseCostDifference,
      action: "charge",
      adjustedAmount: 0,
      newBalance: orgDeduct.newBalance,
    };
  }

  /**
   * Read the cached markup config for an app, or fetch + cache it.
   *
   * Caches only the monetization fields (not the per-call computed cost — that
   * depends on `baseCost`). Negative-cached for short TTL when the app is missing.
   *
   * Invalidate via `appsService.invalidateCache()` (which clears `costMarkup`).
   */
  private async getCostMarkupConfig(appId: string): Promise<CostMarkupConfig | null> {
    const cacheKey = CacheKeys.app.costMarkup(appId);

    const cached = await cache.get<CostMarkupConfig | NoneMarker>(cacheKey);
    if (cached) {
      if ((cached as NoneMarker).__none) return null;
      return cached as CostMarkupConfig;
    }

    const app = await appsRepository.findById(appId);

    if (!app) {
      await cache.set(cacheKey, { __none: true } satisfies NoneMarker, CacheTTL.app.none);
      return null;
    }

    const config: CostMarkupConfig = {
      monetizationEnabled: app.monetization_enabled,
      inferenceMarkupPercentage: Number(app.inference_markup_percentage),
    };

    await cache.set(cacheKey, config, CacheTTL.app.costMarkup);
    return config;
  }

  async calculateCostWithMarkup(
    appId: string,
    baseCost: number,
  ): Promise<{
    baseCost: number;
    creatorMarkup: number;
    totalCost: number;
    markupPercentage: number;
  }> {
    const config = await this.getCostMarkupConfig(appId);

    if (!config) {
      return {
        baseCost,
        creatorMarkup: 0,
        totalCost: baseCost,
        markupPercentage: 0,
      };
    }

    // Only apply markup if monetization is enabled
    const markupPercentage = config.monetizationEnabled ? config.inferenceMarkupPercentage : 0;
    const creatorMarkup = baseCost * (markupPercentage / 100);
    const totalCost = baseCost + creatorMarkup;

    return {
      baseCost,
      creatorMarkup,
      totalCost,
      markupPercentage,
    };
  }

  async checkBalance(
    appId: string,
    userId: string,
    requiredAmount: number,
  ): Promise<{
    sufficient: boolean;
    balance: number;
    required: number;
  }> {
    // Read against the user's organization-level credit balance instead of a
    // per-app pool. The product flow is: the user signs in to Eliza Cloud
    // once, tops up their cloud balance once, and that balance funds every
    // monetized app they use. The app dev still earns the markup % via
    // `deductCredits()` -> `recordCreatorEarnings()` below.
    const user = await usersRepository.findById(userId);
    if (!user?.organization_id) {
      return { sufficient: false, balance: 0, required: requiredAmount };
    }
    const org = await organizationsRepository.findById(user.organization_id);
    const balance = org ? Number.parseFloat(String(org.credit_balance)) : 0;
    return {
      sufficient: balance >= requiredAmount,
      balance,
      required: requiredAmount,
    };
  }

  private async recordCreatorEarnings(
    appId: string,
    userId: string,
    type: "inference_markup" | "purchase_share",
    amount: number,
    leg: CreatorEarningsLeg,
    metadata: Record<string, unknown>,
    providedApp?: AppCreditAccountingApp,
  ): Promise<{ deduplicated: boolean }> {
    // CRITICAL: Credit the app creator's redeemable_earnings balance FIRST — it
    // is the idempotency gate. #10423: a settlement retry (a re-run of the
    // chat/message `onFinish` for the SAME request, or a webhook retry) must not
    // double-credit. Key on a stable per-charge id — the request idempotency key
    // (inference) or the Stripe payment intent (purchase) — never on `appId`,
    // which repeats across every charge. Fall back to the (non-idempotent)
    // app-scoped id only when no per-charge key is present, preserving prior
    // behavior for callers without one.
    const app: AppCreditAccountingApp | undefined =
      providedApp ?? (await appsRepository.findById(appId));
    const chargeKey =
      (typeof metadata.idempotencyKey === "string" && metadata.idempotencyKey) ||
      (typeof metadata.stripePaymentIntentId === "string" && metadata.stripePaymentIntentId) ||
      getRequestIdempotencyKey() ||
      null;

    let deduplicated = false;
    if (app?.created_by_user_id) {
      // Dedupe key scheme (uniform across recordCreatorEarnings and
      // reverseCreatorEarnings): `${chargeKey}:${type}:${leg}`.
      // - `chargeKey`: stable per-charge id (explicit metadata.idempotencyKey,
      //   Stripe payment intent, or the per-request ALS key).
      // - `type`: what kind of earning ("inference_markup" | "purchase_share").
      // - `leg`: WHICH movement within the request (deduct vs reconcile_charge
      //   vs purchase; reversals use reconcile_refund vs compensation_reversal).
      // A true retry of one movement reuses all three parts and dedupes; two
      // different movements in the same request differ in `leg` and never
      // collide (#10847 follow-up).
      const sourceId = chargeKey ? `${chargeKey}:${type}:${leg}` : appId;
      const result = await redeemableEarningsService.addEarnings({
        userId: app.created_by_user_id,
        amount,
        source: "miniapp", // Database enum value - "miniapp" refers to apps
        sourceId,
        dedupeBySourceId: chargeKey !== null,
        description:
          type === "inference_markup"
            ? `Inference markup from app: ${app.name || appId}`
            : `Purchase share from app: ${app.name || appId}`,
        metadata: {
          appId,
          earningsType: type,
          transactionUserId: userId, // User who triggered this earning
          ...metadata,
        },
      });
      deduplicated = result.deduplicated === true;

      if (deduplicated) {
        logger.info("[AppCredits] Creator earning already recorded — skipping duplicate", {
          appId,
          creatorId: app.created_by_user_id,
          amount,
          sourceId,
        });
      } else if (!result.success) {
        logger.error("[AppCredits] Failed to credit redeemable earnings", {
          appId,
          creatorId: app.created_by_user_id,
          amount,
          error: result.error,
        });
      } else {
        logger.info("[AppCredits] Credited redeemable earnings to creator", {
          appId,
          creatorId: app.created_by_user_id,
          amount,
          newBalance: result.newBalance,
        });
      }
    }

    // A dedup retry already recorded everything on the first pass — skip the
    // shadow app_earnings + audit-transaction writes so they don't double-count
    // the withdrawable ceiling (#10423). Synthetic stale-sweep app facts for a
    // deleted app also skip app-scoped rows because the FK target is gone; the
    // creator redeemable ledger above remains the settlement source of truth.
    if (deduplicated || app?.persistAppEarnings === false) {
      return { deduplicated };
    }

    // Shadow app-level earnings tracking (analytics / withdrawable ceiling).
    if (type === "inference_markup") {
      await appEarningsRepository.addInferenceEarnings(appId, amount);
    } else {
      await appEarningsRepository.addPurchaseEarnings(appId, amount);
    }

    // Create transaction record
    await appEarningsRepository.createTransaction({
      app_id: appId,
      user_id: userId,
      type,
      amount: String(amount),
      description:
        type === "inference_markup" ? "Inference markup earnings" : "Credit purchase share",
      metadata,
    });

    return { deduplicated: false };
  }

  /**
   * Reverse creator earnings during reconciliation refunds.
   *
   * When actual cost is less than estimated, users get a refund.
   * This method reduces the creator's earnings proportionally.
   */
  private async reverseCreatorEarnings(
    appId: string,
    userId: string,
    amount: number,
    leg: CreatorEarningsReversalLeg,
    metadata: Record<string, unknown>,
    providedApp?: AppCreditAccountingApp,
  ): Promise<{ deduplicated: boolean }> {
    // #10423 (symmetry with recordCreatorEarnings): the reversal must also be
    // idempotent, or a retried reconciliation would double-DEBIT the creator.
    // Key the reduce on the SAME per-charge id + the reversal leg (see the
    // scheme comment in recordCreatorEarnings) so a retry of the same refund
    // reuses the prior ledger entry instead of reducing twice, while two
    // DIFFERENT reversals in one request (reconcile refund vs #10910
    // compensation reversal) never collide. reduceEarnings is the gate; skip
    // the shadow writes on a dedup retry.
    const app: AppCreditAccountingApp | undefined =
      providedApp ?? (await appsRepository.findById(appId));
    const chargeKey =
      (typeof metadata.idempotencyKey === "string" && metadata.idempotencyKey) ||
      (typeof metadata.stripePaymentIntentId === "string" && metadata.stripePaymentIntentId) ||
      getRequestIdempotencyKey() ||
      null;

    let deduplicated = false;
    if (app?.created_by_user_id) {
      const result = await redeemableEarningsService.reduceEarnings({
        userId: app.created_by_user_id,
        amount,
        source: "miniapp",
        sourceId: chargeKey ? `${chargeKey}:inference_markup:${leg}` : appId,
        dedupeBySourceId: chargeKey !== null,
        description: `Reconciliation adjustment for app: ${app.name || appId}`,
        metadata: {
          appId,
          earningsType: "inference_markup",
          transactionUserId: userId,
          ...metadata,
        },
      });
      deduplicated = result.deduplicated === true;

      if (deduplicated) {
        logger.info("[AppCredits] Creator earning reversal already applied — skipping duplicate", {
          appId,
          creatorId: app.created_by_user_id,
          amount,
        });
      } else if (!result.success) {
        logger.error("[AppCredits] Failed to reduce redeemable earnings", {
          appId,
          creatorId: app.created_by_user_id,
          amount,
          error: result.error,
        });
      } else {
        logger.info("[AppCredits] Reduced redeemable earnings for creator", {
          appId,
          creatorId: app.created_by_user_id,
          amount,
          newBalance: result.newBalance,
        });
      }
    }

    if (deduplicated || app?.persistAppEarnings === false) {
      return { deduplicated };
    }

    // Shadow app-level reduction (use negative value) + audit trail.
    await appEarningsRepository.addInferenceEarnings(appId, -amount);
    await appEarningsRepository.createTransaction({
      app_id: appId,
      user_id: userId,
      type: "inference_markup",
      amount: String(-amount), // Negative to indicate reduction
      description: "Reconciliation adjustment (refund)",
      metadata: {
        ...metadata,
        type: "reconciliation_refund",
      },
    });

    return { deduplicated: false };
  }

  /**
   * Track app user activity - creates or updates app_users record
   * This tracks individual users per app for analytics and monetization
   */
  private async trackAppUserActivity(
    app: App,
    userId: string,
    creditsUsed: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await appsRepository.trackAppUserActivity(app.id, userId, creditsUsed, metadata);
  }

  async getMonetizationSettings(appId: string): Promise<{
    monetizationEnabled: boolean;
    inferenceMarkupPercentage: number;
    purchaseSharePercentage: number;
    platformOffsetAmount: number;
    totalCreatorEarnings: number;
  } | null> {
    const app = await appsRepository.findById(appId);
    if (!app) return null;

    return {
      monetizationEnabled: app.monetization_enabled,
      inferenceMarkupPercentage: Number(app.inference_markup_percentage),
      purchaseSharePercentage: Number(app.purchase_share_percentage),
      platformOffsetAmount: Number(app.platform_offset_amount),
      totalCreatorEarnings: Number(app.total_creator_earnings),
    };
  }

  async updateMonetizationSettings(
    appId: string,
    settings: {
      monetizationEnabled?: boolean;
      inferenceMarkupPercentage?: number;
      purchaseSharePercentage?: number;
    },
  ): Promise<void> {
    if (
      settings.inferenceMarkupPercentage !== undefined &&
      (settings.inferenceMarkupPercentage < 0 || settings.inferenceMarkupPercentage > 1000)
    ) {
      throw new Error("Inference markup must be between 0% and 1000%");
    }

    if (
      settings.purchaseSharePercentage !== undefined &&
      (settings.purchaseSharePercentage < 0 || settings.purchaseSharePercentage > 100)
    ) {
      throw new Error("Purchase share must be between 0% and 100%");
    }

    // Read existing slug before update so we can evict the bySlug cache entry too.
    const existing = await appsRepository.findById(appId);

    await appsRepository.update(appId, {
      ...(settings.monetizationEnabled !== undefined && {
        monetization_enabled: settings.monetizationEnabled,
      }),
      ...(settings.inferenceMarkupPercentage !== undefined && {
        inference_markup_percentage: settings.inferenceMarkupPercentage,
      }),
      ...(settings.purchaseSharePercentage !== undefined && {
        purchase_share_percentage: settings.purchaseSharePercentage,
      }),
    });

    // Critical: monetization config is read by /v1/messages and /v1/chat/* on
    // every inference via calculateCostWithMarkup(). Evict the cached app row
    // and the markup-config cache so the toggle takes effect immediately.
    await invalidateAppCacheKeys(appId, existing?.slug ?? undefined);

    // When enabling monetization, ensure earnings record exists
    // This prevents null state when viewing earnings dashboard
    if (settings.monetizationEnabled === true) {
      await appEarningsRepository.getOrCreate(appId);
      logger.info("[AppCredits] Initialized earnings record for app", {
        appId,
      });
    }

    logger.info("[AppCredits] Updated monetization settings", {
      appId,
      settings,
    });
  }
}

// Export singleton instance
export const appCreditsService = new AppCreditsService();
