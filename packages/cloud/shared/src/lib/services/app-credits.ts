/**
 * Service for managing app-specific credit balances and purchases.
 */

import Decimal from "decimal.js";
import { appEarningsRepository } from "../../db/repositories/app-earnings";
import { type App, appsRepository } from "../../db/repositories/apps";
import { organizationsRepository } from "../../db/repositories/organizations";
import { usersRepository } from "../../db/repositories/users";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { getRequestIdempotencyKey } from "../runtime/request-context";
import { logger } from "../utils/logger";
import {
  computeInferenceCharge,
  computePurchaseSplit,
  computeReconciliation,
  isAppMonetizationActive,
  parseAppMonetizationNumber,
} from "./app-credit-math";
import { APP_USAGE_PROJECTION_VERSION } from "./app-usage-projections";
import {
  APP_CHAT_RESERVATION_SETTLEMENT_MARKER,
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

export interface AppCreditAccountingApp {
  name?: string | null;
  created_by_user_id?: string | null;
  monetization_enabled: boolean;
  /**
   * Compliance review disposition mirror. `rejected` revokes earnings even if
   * `monetization_enabled` is still true (see `isAppMonetizationActive`).
   * Optional because synthetic accounting apps (stale-sweep facts) don't carry
   * it — absent means "not rejected".
   */
  review_status?: string | null;
  platform_offset_amount?: number | string | null;
  purchase_share_percentage?: number | string | null;
  inference_markup_percentage?: number | string | null;
  persistAppEarnings?: boolean;
}

export interface AppCreditReservationAccountingApp extends AppCreditAccountingApp {
  id: string;
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

function parseOrgCreditBalance(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    throw new Error("Unable to read organization credit_balance");
  }
  if (typeof value === "string" && !/^[+-]?(?:\d+|\d*\.\d+)$/.test(value.trim())) {
    throw new Error("Unable to read organization credit_balance");
  }
  const balance = Number(value);
  if (!Number.isFinite(balance)) {
    throw new Error("Unable to read organization credit_balance");
  }
  return balance;
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

interface CreatorEarningsCommitState {
  redeemable: "absent" | "recorded" | "unknown";
  shadowBalanceRecorded: boolean;
  shadowTransactionRecorded: boolean;
}

class CreatorEarningsAccountingError extends Error {
  constructor(
    readonly commitState: CreatorEarningsCommitState,
    cause: unknown,
  ) {
    super(
      `Creator earnings accounting did not complete: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "CreatorEarningsAccountingError";
  }
}

function creatorEarningsIdentity(
  appId: string,
  type: "inference_markup" | "purchase_share",
  leg: CreatorEarningsLeg,
  metadata: Record<string, unknown>,
): { sourceId: string; dedupeBySourceId: boolean } {
  const chargeKey =
    (typeof metadata.creatorAccountingKey === "string" && metadata.creatorAccountingKey) ||
    (typeof metadata.chargeTransactionId === "string" &&
      `app-charge:${metadata.chargeTransactionId}`) ||
    (typeof metadata.idempotencyKey === "string" && metadata.idempotencyKey) ||
    (typeof metadata.stripePaymentIntentId === "string" && metadata.stripePaymentIntentId) ||
    getRequestIdempotencyKey() ||
    null;
  return {
    sourceId: chargeKey ? `${chargeKey}:${type}:${leg}` : appId,
    dedupeBySourceId: chargeKey !== null,
  };
}

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
  actualTotalCost: number,
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
    actualCost: actualTotalCost,
    collectedAmount:
      adjustmentType === "refund" || adjustmentType === "overage"
        ? actualTotalCost
        : reservedAmount,
    reservationTransactionId,
    settlementTransactionIds: [],
    adjustmentType,
  };
}

function totalInferenceChargeForApp(app: AppCreditAccountingApp, baseCost: number): number {
  return computeInferenceCharge(baseCost, {
    monetizationEnabled: isAppMonetizationActive(app),
    platformOffsetAmount: app.platform_offset_amount,
    purchaseSharePercentage: app.purchase_share_percentage,
    inferenceMarkupPercentage: app.inference_markup_percentage,
  }).totalCost;
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
  /**
   * Server-authoritative payer captured at admission. When present, debit and
   * compensation remain bound to this tenant even if the user moves orgs
   * before the deferred reservation runs.
   */
  organizationId?: string;
  baseCost: number;
  description: string;
  metadata?: Record<string, unknown>;
  /** Stable logical-operation key for the organization debit. */
  idempotencyKey?: string;
  /**
   * Deferred inference already delivered model work before this accounting
   * runs. Retain a committed consumer debit when later creator/shadow writes
   * fail so a keyed retry can finish them without creating an unbacked payout.
   */
  retainChargeOnPostDebitFailure?: boolean;
  /** Optional: pass pre-fetched app to avoid N+1 query */
  app?: AppCreditReservationAccountingApp;
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
  /**
   * Immutable economics recovered from the committed debit. Reservation
   * reconciliation must use this contract instead of mutable app settings.
   */
  chargeContract?: {
    creatorUserId: string | null;
    markupPercentage: number;
    monetizationActive: boolean;
    appName: string | null;
  };
  message?: string;
}

/**
 * Parameters for atomically reserving app inference credits before model work.
 */
export interface AppCreditInferenceReservationParams {
  appId: string;
  userId: string;
  /** Server-authoritative payer captured before model dispatch. */
  organizationId?: string;
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
  /** Keep a committed debit as backing when deferred post-debit accounting fails. */
  retainChargeOnPostDebitFailure?: boolean;
  /** Optional: pass pre-fetched app to avoid N+1 query */
  app?: AppCreditReservationAccountingApp;
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
    // error-policy:J6 missing org preserves the existing no-credit result path; a present
    // org with corrupt money data must fail closed.
    return org ? parseOrgCreditBalance(org.credit_balance) : 0;
  }

  async processPurchase(params: AppCreditPurchaseParams): Promise<AppCreditPurchaseResult> {
    const { appId, userId, organizationId, purchaseAmount, stripePaymentIntentId } = params;

    const app = await appsRepository.findById(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }

    if (stripePaymentIntentId) {
      const existingTransaction = await appEarningsRepository.findTransactionByPaymentIntent(
        appId,
        stripePaymentIntentId,
      );
      if (existingTransaction) {
        const existingMetadata =
          existingTransaction.metadata && typeof existingTransaction.metadata === "object"
            ? existingTransaction.metadata
            : {};
        if (
          existingTransaction.app_id !== appId ||
          existingTransaction.user_id !== userId ||
          existingMetadata.organizationId !== organizationId ||
          existingMetadata.purchaseAmount !== purchaseAmount ||
          existingMetadata.stripePaymentIntentId !== stripePaymentIntentId
        ) {
          throw new Error(`App purchase projection replay mismatch for ${stripePaymentIntentId}`);
        }
        return {
          success: true,
          creditsAdded: 0,
          platformOffset: 0,
          creatorEarnings: 0,
          newBalance: await this.readOrgBalance(organizationId),
        };
      }
    }

    // Only apply platform offset and creator share if monetization is active
    // (enabled AND not review-rejected — a ban revokes earnings); users always
    // get full credits for their purchase. Math in app-credit-math.ts.
    const monetizationActive = isAppMonetizationActive(app);
    const quotedSplit = computePurchaseSplit(purchaseAmount, {
      monetizationEnabled: monetizationActive,
      platformOffsetAmount: app.platform_offset_amount,
      purchaseSharePercentage: app.purchase_share_percentage,
      inferenceMarkupPercentage: app.inference_markup_percentage,
    });
    const quotedCreatorSharePercentage = monetizationActive
      ? parseAppMonetizationNumber("purchase_share_percentage", app.purchase_share_percentage, {
          min: 0,
          max: 100,
        })
      : 0;

    logger.info("[AppCredits] Processing purchase", {
      appId,
      userId,
      purchaseAmount,
      platformOffset: quotedSplit.platformOffset,
      creatorEarnings: quotedSplit.creatorEarnings,
      creditsToAdd: quotedSplit.creditsToAdd,
    });

    // Credit the purchasing user's ORG balance — the same ledger
    // `deductCredits()` debits — so purchased credits are spendable on app
    // inference (#8253: previously this funded the per-app
    // `app_credit_balances` pool, which the spend path no longer reads, so
    // purchased credits were stranded).
    const { transaction: purchaseCredit, newBalance } = await creditsService.addCredits({
      organizationId,
      amount: quotedSplit.creditsToAdd,
      description: `App credit purchase (${app.name ?? appId})`,
      metadata: {
        appId,
        userId,
        organizationId,
        purchaseAmount,
        creditsToAdd: quotedSplit.creditsToAdd,
        platformOffset: quotedSplit.platformOffset,
        creatorEarnings: quotedSplit.creatorEarnings,
        creatorSharePercentage: quotedCreatorSharePercentage,
        creatorUserId: app.created_by_user_id,
        type: "app_credit_purchase",
      },
      ...(stripePaymentIntentId && { stripePaymentIntentId }),
    });

    const persistedPurchaseMetadata =
      purchaseCredit.metadata && typeof purchaseCredit.metadata === "object"
        ? purchaseCredit.metadata
        : {};
    const persistedPurchaseAmount = new Decimal(purchaseCredit.amount);
    const creditsToAdd = parseAppMonetizationNumber(
      "purchase_credit_transaction.creditsToAdd",
      persistedPurchaseMetadata.creditsToAdd,
      { min: 0 },
    );
    const platformOffset = parseAppMonetizationNumber(
      "purchase_credit_transaction.platformOffset",
      persistedPurchaseMetadata.platformOffset,
      { min: 0 },
    );
    const creatorEarnings = parseAppMonetizationNumber(
      "purchase_credit_transaction.creatorEarnings",
      persistedPurchaseMetadata.creatorEarnings,
      { min: 0 },
    );
    const creatorSharePercentage = parseAppMonetizationNumber(
      "purchase_credit_transaction.creatorSharePercentage",
      persistedPurchaseMetadata.creatorSharePercentage,
      { min: 0, max: 100 },
    );
    const pinnedCreatorUserId =
      typeof persistedPurchaseMetadata.creatorUserId === "string"
        ? persistedPurchaseMetadata.creatorUserId
        : null;
    if (
      purchaseCredit.organization_id !== organizationId ||
      purchaseCredit.type !== "credit" ||
      !persistedPurchaseAmount.isFinite() ||
      !persistedPurchaseAmount.equals(new Decimal(purchaseAmount).toDecimalPlaces(6)) ||
      persistedPurchaseMetadata.appId !== appId ||
      persistedPurchaseMetadata.userId !== userId ||
      persistedPurchaseMetadata.organizationId !== organizationId ||
      !new Decimal(creditsToAdd).equals(new Decimal(purchaseAmount)) ||
      new Decimal(platformOffset).greaterThan(persistedPurchaseAmount) ||
      new Decimal(creatorEarnings).greaterThan(persistedPurchaseAmount.minus(platformOffset)) ||
      !new Decimal(creatorEarnings)
        .toDecimalPlaces(6)
        .equals(
          persistedPurchaseAmount
            .minus(platformOffset)
            .mul(creatorSharePercentage)
            .div(100)
            .toDecimalPlaces(6),
        ) ||
      (stripePaymentIntentId &&
        purchaseCredit.stripe_payment_intent_id !== stripePaymentIntentId) ||
      (creatorEarnings > 0 && !pinnedCreatorUserId)
    ) {
      throw new Error(
        `App purchase credit replay mismatch for ${stripePaymentIntentId ?? purchaseCredit.id}`,
      );
    }
    const chargeTimeApp: AppCreditAccountingApp = {
      ...app,
      created_by_user_id: pinnedCreatorUserId,
    };

    // Track app user activity for purchase (this will create app_users record if new user)
    await this.trackAppUserActivity(app, userId, "0.00", {
      type: "purchase",
      purchaseAmount,
      creditsAdded: creditsToAdd,
      ...(stripePaymentIntentId && { stripePaymentIntentId }),
    });

    // CRITICAL: Always create a transaction record for deduplication purposes
    // Even when monetization is disabled, we need to track the purchase
    if (creatorEarnings > 0) {
      await this.recordCreatorEarnings(
        appId,
        userId,
        "purchase_share",
        creatorEarnings,
        platformOffset,
        "purchase",
        {
          purchaseAmount,
          organizationId,
          platformOffset,
          creatorSharePercentage,
          chargeTransactionId: purchaseCredit.id,
          ...(stripePaymentIntentId && { stripePaymentIntentId }),
        },
        chargeTimeApp,
      );
    } else if (stripePaymentIntentId) {
      // Monetization disabled but still need transaction record for deduplication
      await appEarningsRepository.createTransaction({
        app_id: appId,
        user_id: userId,
        type: "credit_purchase",
        amount: "0", // No earnings when monetization disabled
        description: "Credit purchase (monetization disabled)",
        metadata: {
          organizationId,
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
    const {
      appId,
      userId,
      organizationId,
      estimatedBaseCost,
      description,
      metadata,
      idempotencyKey,
      retainChargeOnPostDebitFailure,
      app,
    } = params;
    const accountingApp = app ?? (await appsRepository.findById(appId));

    // A $0 estimate (free/unpriced model) must still open a valid hold:
    // reserveAndDeductCredits throws on amount <= 0, which surfaced as a 500 on
    // /v1/chat/completions and /v1/messages for monetized apps. Floor the hold
    // at MIN_RESERVATION — the same floor the org-credits reservation path
    // applies — and reconcile trues it up to actual cost (refunding the floor
    // when actual stays $0).
    const flooredEstimate = Math.max(estimatedBaseCost, MIN_RESERVATION);
    const reservationMetadata = {
      ...metadata,
      type: "app_chat_reservation",
      settlement_marker: APP_CHAT_RESERVATION_SETTLEMENT_MARKER,
      reserved_amount: flooredEstimate,
      estimated_cost: estimatedBaseCost,
    };

    const deduction = await this.deductCredits({
      appId,
      userId,
      organizationId,
      baseCost: flooredEstimate,
      description,
      metadata: withChargeIdempotencyKey(reservationMetadata, idempotencyKey),
      idempotencyKey,
      retainChargeOnPostDebitFailure,
      app: accountingApp ?? undefined,
    });

    if (!deduction.success) {
      throw new InsufficientCreditsError(
        deduction.totalCost,
        deduction.newBalance,
        "insufficient_balance",
      );
    }

    if (!accountingApp) {
      throw new Error(`App reservation succeeded without an app row: ${appId}`);
    }

    const reservationTransactionId = deduction.transactionId ?? null;
    const chargeContract = deduction.chargeContract;
    if (!chargeContract) {
      throw new Error(`App reservation succeeded without a charge contract: ${appId}`);
    }
    const reservationAccountingApp: AppCreditAccountingApp = {
      ...accountingApp,
      name: chargeContract.appName,
      created_by_user_id: chargeContract.creatorUserId,
      monetization_enabled: chargeContract.monetizationActive,
      review_status: chargeContract.monetizationActive ? "approved" : "rejected",
      inference_markup_percentage: chargeContract.markupPercentage,
    };

    return {
      reservedAmount: deduction.totalCost,
      reservationTransactionId,
      reconcile: async (actualBaseCost: number) => {
        const reconciliation = await this.reconcileCredits({
          appId,
          userId,
          organizationId,
          // Reconcile against the FLOORED estimate — that is what was actually
          // debited; using the raw $0 estimate would skip refunding the floor.
          estimatedBaseCost: flooredEstimate,
          actualBaseCost,
          description,
          metadata: withChargeIdempotencyKey(reservationMetadata, idempotencyKey),
          app: reservationAccountingApp,
          // Server-generated key for the reconcile legs' idempotent ledger
          // writes (#11512) — the deduct row's own transaction id, never the
          // client idempotencyKey (globally-unique index ⇒ a client key would
          // collide across orgs).
          reservationTransactionId,
        });

        return mapAppReconciliationToCreditResult(
          reconciliation,
          deduction.totalCost,
          totalInferenceChargeForApp(reservationAccountingApp, actualBaseCost),
          reservationTransactionId,
        );
      },
    };
  }

  async deductCredits(params: AppCreditDeductionParams): Promise<AppCreditDeductionResult> {
    const {
      appId,
      userId,
      organizationId: providedOrganizationId,
      baseCost,
      description,
      metadata: rawMetadata,
      idempotencyKey,
      retainChargeOnPostDebitFailure,
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

    // Only apply markup if monetization is active (enabled AND not
    // review-rejected — a ban revokes markup earnings immediately); otherwise
    // users pay base cost only and the creator earns nothing. Math in
    // app-credit-math.ts.
    const monetizationActive = isAppMonetizationActive(app);
    const quotedCharge = computeInferenceCharge(baseCost, {
      monetizationEnabled: monetizationActive,
      platformOffsetAmount: app.platform_offset_amount,
      purchaseSharePercentage: app.purchase_share_percentage,
      inferenceMarkupPercentage: app.inference_markup_percentage,
    });

    // Debit from the user's organization credit balance. Atomic via row-lock.
    // Switched from `app_credit_balances` (per-app pre-purchased pool) to the
    // org balance so any signed-in user with cloud credits can use any
    // monetized app without a separate top-up. App dev still earns the
    // markup via `recordCreatorEarnings()` below.
    let organizationId = providedOrganizationId ?? null;
    if (!organizationId) {
      const user = await usersRepository.findById(userId);
      organizationId = user?.organization_id ?? null;
    }
    if (!organizationId) {
      return {
        success: false,
        baseCost,
        creatorMarkup: quotedCharge.creatorMarkup,
        totalCost: quotedCharge.totalCost,
        creatorEarnings: 0,
        newBalance: 0,
        message: `User has no organization: ${userId}`,
      };
    }
    const orgDeduct = await creditsService.reserveAndDeductCredits({
      organizationId,
      amount: quotedCharge.totalCost,
      description: description ?? `App inference (${app.name ?? appId})`,
      ...(idempotencyKey && {
        stripePaymentIntentId: `app-inference:${organizationId}:${appId}:${idempotencyKey}`,
      }),
      metadata: {
        ...metadata,
        // The every-minute projection sweep consumes this immutable debit
        // marker. Usage writes never join monetary settlement or DO release.
        appUsageProjectionVersion: APP_USAGE_PROJECTION_VERSION,
        appId,
        userId,
        baseCost,
        creatorMarkup: quotedCharge.creatorMarkup,
        totalCost: quotedCharge.totalCost,
        markupPercentage: quotedCharge.markupPercentage,
        monetizationActive,
        creatorUserId: app.created_by_user_id,
        appName: app.name,
      },
    });

    if (!orgDeduct.success) {
      return {
        success: false,
        baseCost,
        creatorMarkup: quotedCharge.creatorMarkup,
        totalCost: quotedCharge.totalCost,
        creatorEarnings: 0,
        newBalance: orgDeduct.newBalance,
        message: `Insufficient cloud credits. Required: $${quotedCharge.totalCost.toFixed(2)}, Available: $${orgDeduct.newBalance.toFixed(2)}`,
      };
    }
    const persistedDebit = orgDeduct.transaction;
    const persistedAmount = persistedDebit ? Math.abs(Number(persistedDebit.amount)) : Number.NaN;
    const persistedMetadata =
      persistedDebit?.metadata && typeof persistedDebit.metadata === "object"
        ? persistedDebit.metadata
        : {};
    const persistedBaseCost = parseAppMonetizationNumber(
      "app_inference_debit.baseCost",
      persistedMetadata.baseCost,
      { min: 0 },
    );
    const creatorMarkup = parseAppMonetizationNumber(
      "app_inference_debit.creatorMarkup",
      persistedMetadata.creatorMarkup,
      { min: 0 },
    );
    const totalCost = parseAppMonetizationNumber(
      "app_inference_debit.totalCost",
      persistedMetadata.totalCost,
      { min: 0 },
    );
    const markupPercentage = parseAppMonetizationNumber(
      "app_inference_debit.markupPercentage",
      persistedMetadata.markupPercentage,
      { min: 0, max: 1000 },
    );
    const persistedMonetizationActive = persistedMetadata.monetizationActive;
    const pinnedCreatorUserId =
      typeof persistedMetadata.creatorUserId === "string" ? persistedMetadata.creatorUserId : null;
    const persistedAppName =
      typeof persistedMetadata.appName === "string" || persistedMetadata.appName === null
        ? persistedMetadata.appName
        : null;
    const roundedTotalCost = new Decimal(totalCost).toDecimalPlaces(6);
    const expectedTotalCost = new Decimal(persistedBaseCost).plus(creatorMarkup).toDecimalPlaces(6);
    const expectedCreatorMarkup = new Decimal(persistedBaseCost)
      .mul(markupPercentage)
      .div(100)
      .toDecimalPlaces(6);
    if (
      !persistedDebit ||
      persistedDebit.organization_id !== organizationId ||
      persistedDebit.type !== "debit" ||
      persistedMetadata.appId !== appId ||
      persistedMetadata.userId !== userId ||
      !Number.isFinite(persistedAmount) ||
      Math.abs(persistedAmount - totalCost) > RECONCILIATION_THRESHOLD ||
      Math.abs(persistedBaseCost - baseCost) > RECONCILIATION_THRESHOLD ||
      typeof persistedMonetizationActive !== "boolean" ||
      !roundedTotalCost.equals(expectedTotalCost) ||
      !new Decimal(creatorMarkup).toDecimalPlaces(6).equals(expectedCreatorMarkup) ||
      (!persistedMonetizationActive && (markupPercentage !== 0 || creatorMarkup !== 0)) ||
      (creatorMarkup > 0 && !pinnedCreatorUserId)
    ) {
      throw new Error(
        `App inference debit replay mismatch for ${appId}; refusing ambiguous accounting`,
      );
    }
    const chargeTimeApp: AppCreditAccountingApp = {
      ...app,
      name: persistedAppName,
      created_by_user_id: pinnedCreatorUserId,
      monetization_enabled: persistedMonetizationActive as boolean,
      review_status: persistedMonetizationActive ? "approved" : "rejected",
      inference_markup_percentage: markupPercentage,
    };

    let creatorCommitState: CreatorEarningsCommitState = {
      redeemable: "absent",
      shadowBalanceRecorded: false,
      shadowTransactionRecorded: false,
    };
    try {
      if (creatorMarkup > 0) {
        let recorded: Awaited<ReturnType<AppCreditsService["recordCreatorEarnings"]>>;
        try {
          recorded = await this.recordCreatorEarnings(
            appId,
            userId,
            "inference_markup",
            creatorMarkup,
            persistedBaseCost,
            "deduct",
            {
              baseCost: persistedBaseCost,
              markupPercentage,
              totalCost,
              description,
              ...metadata,
              chargeTransactionId: orgDeduct.transaction?.id,
              ...(idempotencyKey &&
                orgDeduct.transaction?.id && {
                  creatorAccountingKey: `app-charge:${orgDeduct.transaction.id}`,
                }),
            },
            chargeTimeApp,
          );
          creatorCommitState = recorded.commitState;
        } catch (error) {
          // error-policy:J2 preserve the payout commit state before rethrowing.
          if (error instanceof CreatorEarningsAccountingError) {
            creatorCommitState = error.commitState;
          }
          throw error;
        }
      }
    } catch (postDebitError) {
      // error-policy:J2 compensate a known-safe partial write, then rethrow the
      // original accounting failure with its backing-money state preserved.
      logger.error("[AppCredits] Post-debit accounting failed", {
        appId,
        userId,
        baseCost,
        creatorMarkup,
        totalCost,
        chargeTransactionId: orgDeduct.transaction?.id,
        error: postDebitError instanceof Error ? postDebitError.message : String(postDebitError),
      });
      if (retainChargeOnPostDebitFailure) {
        logger.error(
          "[AppCredits] Retaining committed debit so deferred accounting can retry safely",
          {
            appId,
            userId,
            organizationId,
            chargeTransactionId: orgDeduct.transaction?.id,
          },
        );
        throw postDebitError;
      }
      if (creatorCommitState.redeemable === "unknown") {
        // An unknown payout state must remain backed by the consumer debit.
        // Refunding here could mint redeemable creator money nobody paid for.
        logger.error("[AppCredits] Creator earnings state is unknown; retaining backing charge", {
          appId,
          userId,
          creatorMarkup,
          chargeTransactionId: orgDeduct.transaction?.id,
        });
        throw postDebitError;
      }
      if (creatorCommitState.redeemable === "recorded") {
        try {
          await this.reverseCreatorEarnings(
            appId,
            userId,
            creatorMarkup,
            persistedBaseCost,
            "compensation_reversal",
            {
              type: "compensation_reversal",
              baseCost: persistedBaseCost,
              markupPercentage,
              totalCost,
              description,
              ...metadata,
              chargeTransactionId: orgDeduct.transaction?.id,
              ...(idempotencyKey &&
                orgDeduct.transaction?.id && {
                  creatorAccountingKey: `app-charge:${orgDeduct.transaction.id}`,
                }),
              reason: "post_debit_accounting_failed",
            },
            chargeTimeApp,
          );
        } catch (reversalError) {
          // error-policy:J2 both failures determine whether the backing charge
          // can be released, so surface them together.
          logger.error(
            "[AppCredits] Failed to reverse creator earnings; retaining backing charge",
            {
              appId,
              userId,
              creatorMarkup,
              chargeTransactionId: orgDeduct.transaction?.id,
              error: reversalError instanceof Error ? reversalError.message : String(reversalError),
            },
          );
          throw new AggregateError(
            [postDebitError, reversalError],
            "Post-debit accounting and creator reversal both failed",
          );
        }
      }
      await creditsService.addCredits({
        organizationId,
        amount: totalCost,
        description: `Compensation refund for failed app inference (${app.name ?? appId})`,
        ...(orgDeduct.transaction?.id && {
          stripePaymentIntentId: `app-inference-compensation:${orgDeduct.transaction.id}`,
        }),
        metadata: {
          appId,
          userId,
          baseCost: persistedBaseCost,
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
      baseCost: persistedBaseCost,
      creatorMarkup,
      totalCost,
      creatorEarnings: creatorMarkup,
      newBalance: orgDeduct.newBalance,
      transactionId: orgDeduct.transaction?.id,
      chargeContract: {
        creatorUserId: pinnedCreatorUserId,
        markupPercentage,
        monetizationActive: persistedMonetizationActive as boolean,
        appName: persistedAppName,
      },
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

    const markReservationSettled = async (): Promise<void> => {
      if (!reservationTransactionId) return;
      await creditsService.markReservationSettled({
        organizationId,
        reservationTransactionId,
      });
    };

    // Skip reconciliation for negligible differences
    if (Math.abs(baseCostDifference) < RECONCILIATION_THRESHOLD) {
      await markReservationSettled();
      return {
        reconciled: false,
        difference: 0,
        action: "none",
        adjustedAmount: 0,
        newBalance: await this.readOrgBalance(organizationId),
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
        newBalance: await this.readOrgBalance(organizationId),
      };
    }

    // Calculate the total cost difference including markup. Math in
    // app-credit-math.ts. Uses the same effective flag as deductCredits so a
    // review-rejected app's reconcile never mints/reverses markup its deduct
    // leg didn't charge.
    const monetizationActive = isAppMonetizationActive(app);
    const { markupPercentage, totalCostDifference, creatorMarkupDifference } =
      computeReconciliation(baseCostDifference, {
        monetizationEnabled: monetizationActive,
        platformOffsetAmount: app.platform_offset_amount,
        purchaseSharePercentage: app.purchase_share_percentage,
        inferenceMarkupPercentage: app.inference_markup_percentage,
      });

    if (baseCostDifference < 0) {
      // A creator withdrawal can race settlement. Reverse the cashable creator
      // amount in full before refunding the consumer; otherwise a failed or
      // partial clawback would leave both parties holding the same money.
      const refundAmount = Math.abs(totalCostDifference);
      const creatorEarningsReduction = Math.abs(creatorMarkupDifference);

      if (monetizationActive && creatorEarningsReduction > 0) {
        try {
          await this.reverseCreatorEarnings(
            appId,
            userId,
            creatorEarningsReduction,
            Math.abs(baseCostDifference),
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
          // error-policy:J2 a failed clawback must retain the consumer charge;
          // log the money context and rethrow.
          logger.error(
            "[AppCredits] Creator-earnings reversal failed; retaining the consumer charge",
            {
              appId,
              userId,
              organizationId,
              refundAmount,
              creatorEarningsReduction,
              error: reversalError instanceof Error ? reversalError.message : String(reversalError),
            },
          );
          throw reversalError;
        }
      }

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

      await markReservationSettled();

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
      const overageDebit = orgDeduct.transaction;
      const overageMetadata =
        overageDebit?.metadata && typeof overageDebit.metadata === "object"
          ? overageDebit.metadata
          : {};
      const overageAmount = overageDebit ? Math.abs(Number(overageDebit.amount)) : Number.NaN;
      if (
        !overageDebit ||
        overageDebit.organization_id !== organizationId ||
        overageDebit.type !== "debit" ||
        overageMetadata.appId !== appId ||
        overageMetadata.userId !== userId ||
        !Number.isFinite(overageAmount) ||
        Math.abs(overageAmount - additionalCharge) > RECONCILIATION_THRESHOLD
      ) {
        throw new Error(
          `App reconciliation debit replay mismatch for ${appId}; refusing ambiguous accounting`,
        );
      }
      if (monetizationActive && creatorMarkupDifference > 0) {
        await this.recordCreatorEarnings(
          appId,
          userId,
          "inference_markup",
          creatorMarkupDifference,
          baseCostDifference,
          "reconcile_charge",
          earningsLegMetadata({
            type: "reconciliation_adjustment",
            baseCostDifference,
            description,
            chargeTransactionId: orgDeduct.transaction?.id,
          }),
          app,
        );
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

      await markReservationSettled();

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

    await markReservationSettled();

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

    const monetizationEnabled = isAppMonetizationActive(app);
    const config: CostMarkupConfig = {
      // Effective flag (enabled AND not review-rejected) so quote/markup reads
      // on the LLM hot path match what deductCredits will actually charge.
      // runAppReview invalidates this key on every decision.
      monetizationEnabled,
      inferenceMarkupPercentage: monetizationEnabled
        ? parseAppMonetizationNumber(
            "inference_markup_percentage",
            app.inference_markup_percentage,
            { min: 0, max: 1000 },
          )
        : 0,
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

    const { markupPercentage, creatorMarkup, totalCost } = computeInferenceCharge(baseCost, {
      monetizationEnabled: config.monetizationEnabled,
      platformOffsetAmount: 0,
      purchaseSharePercentage: 0,
      inferenceMarkupPercentage: config.inferenceMarkupPercentage,
    });

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
    // error-policy:J6 missing org keeps the existing insufficient-credit result; corrupt
    // present money data is not a zero balance.
    const balance = org ? parseOrgCreditBalance(org.credit_balance) : 0;
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
    platformRevenueAmount: number,
    leg: CreatorEarningsLeg,
    metadata: Record<string, unknown>,
    providedApp?: AppCreditAccountingApp,
  ): Promise<{ deduplicated: boolean; commitState: CreatorEarningsCommitState }> {
    const app: AppCreditAccountingApp | undefined =
      providedApp ?? (await appsRepository.findById(appId));
    const identity = creatorEarningsIdentity(appId, type, leg, metadata);
    const commitState: CreatorEarningsCommitState = {
      redeemable: "absent",
      shadowBalanceRecorded: false,
      shadowTransactionRecorded: false,
    };

    if (!app?.created_by_user_id) {
      throw new CreatorEarningsAccountingError(
        commitState,
        new Error(`App ${appId} has no creator for monetized earnings`),
      );
    }

    let result: Awaited<ReturnType<typeof redeemableEarningsService.addEarnings>>;
    try {
      result = await redeemableEarningsService.addEarnings({
        userId: app.created_by_user_id,
        amount,
        source: "miniapp",
        sourceId: identity.sourceId,
        dedupeBySourceId: identity.dedupeBySourceId,
        description:
          type === "inference_markup"
            ? `Inference markup from app: ${app.name || appId}`
            : `Purchase share from app: ${app.name || appId}`,
        metadata: {
          ...metadata,
          appId,
          earningsType: type,
          transactionUserId: userId,
          appCreatorShadowVersion: 1,
          appPlatformRevenueDelta: new Decimal(platformRevenueAmount).toFixed(6),
        },
      });
    } catch (cause) {
      // error-policy:J2 attach explicit commit state so the caller can decide
      // whether compensating the backing debit is safe.
      if (!identity.dedupeBySourceId) {
        commitState.redeemable = "unknown";
        throw new CreatorEarningsAccountingError(commitState, cause);
      }
      try {
        const committed = await redeemableEarningsService.hasEarningBySourceId({
          userId: app.created_by_user_id,
          source: "miniapp",
          sourceId: identity.sourceId,
        });
        // A verified commit without its immutable ledger UUID cannot safely
        // project or compensate. Retain the backing debit; the keyed retry
        // will recover the existing UUID and complete the atomic projection.
        commitState.redeemable = committed ? "unknown" : "absent";
      } catch (verificationError) {
        // error-policy:J2 neither failure alone describes the commit state.
        commitState.redeemable = "unknown";
        throw new CreatorEarningsAccountingError(
          commitState,
          new AggregateError(
            [cause, verificationError],
            "Creator earnings commit and verification both failed",
          ),
        );
      }
      throw new CreatorEarningsAccountingError(commitState, cause);
    }

    const redeemableDeduplicated = result.deduplicated === true;
    if (!result.success) {
      throw new CreatorEarningsAccountingError(
        commitState,
        new Error(
          `[AppCredits] Failed to credit redeemable earnings for ${identity.sourceId}: ${result.error ?? "unknown error"}`,
        ),
      );
    }
    if (!result.ledgerEntryId) {
      commitState.redeemable = "unknown";
      throw new CreatorEarningsAccountingError(
        commitState,
        new Error("Creator earning succeeded without an immutable ledger entry"),
      );
    }
    commitState.redeemable = "recorded";

    logger.info(
      redeemableDeduplicated
        ? "[AppCredits] Creator earning already recorded — verifying app projection"
        : "[AppCredits] Credited redeemable earnings to creator",
      {
        appId,
        creatorId: app.created_by_user_id,
        amount,
        sourceId: identity.sourceId,
        newBalance: result.newBalance,
      },
    );

    // Synthetic stale-sweep facts can outlive the app FK target. Their
    // redeemable entry remains the authoritative payout record.
    if (app.persistAppEarnings === false) {
      return { deduplicated: redeemableDeduplicated, commitState };
    }

    try {
      const projection = await appEarningsRepository.applyCreatorMovement({
        appId,
        userId,
        type,
        creatorAmount: amount,
        platformRevenueAmount,
        description:
          type === "inference_markup" ? "Inference markup earnings" : "Credit purchase share",
        metadata,
        redeemableLedgerEntryId: result.ledgerEntryId,
        redeemableDeduplicated,
      });
      commitState.shadowBalanceRecorded = true;
      commitState.shadowTransactionRecorded = true;
      return { deduplicated: projection.deduplicated, commitState };
    } catch (cause) {
      // error-policy:J2 projection acknowledgement ambiguity must retain the
      // redeemable ledger identity and backing charge for keyed retry.
      // A commit acknowledgement can be lost after the atomic projection
      // commits. Retain the backing charge and retry by immutable ledger UUID.
      commitState.redeemable = "unknown";
      throw new CreatorEarningsAccountingError(commitState, cause);
    }
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
    platformRevenueAmount: number,
    leg: CreatorEarningsReversalLeg,
    metadata: Record<string, unknown>,
    providedApp?: AppCreditAccountingApp,
  ): Promise<{ deduplicated: boolean }> {
    const app: AppCreditAccountingApp | undefined =
      providedApp ?? (await appsRepository.findById(appId));
    const chargeKey =
      (typeof metadata.creatorAccountingKey === "string" && metadata.creatorAccountingKey) ||
      (typeof metadata.chargeTransactionId === "string" &&
        `app-charge:${metadata.chargeTransactionId}`) ||
      (typeof metadata.idempotencyKey === "string" && metadata.idempotencyKey) ||
      (typeof metadata.stripePaymentIntentId === "string" && metadata.stripePaymentIntentId) ||
      getRequestIdempotencyKey() ||
      null;

    if (!app?.created_by_user_id) {
      throw new Error(`App ${appId} has no creator for monetized earnings reversal`);
    }

    const result = await redeemableEarningsService.reduceEarnings({
      userId: app.created_by_user_id,
      amount,
      source: "miniapp",
      sourceId: chargeKey ? `${chargeKey}:inference_markup:${leg}` : appId,
      dedupeBySourceId: chargeKey !== null,
      requireSufficientBalance: true,
      description: `Reconciliation adjustment for app: ${app.name || appId}`,
      metadata: {
        ...metadata,
        appId,
        earningsType: "inference_markup",
        transactionUserId: userId,
        appCreatorShadowVersion: 1,
        appPlatformRevenueDelta: new Decimal(-platformRevenueAmount).toFixed(6),
      },
    });
    const redeemableDeduplicated = result.deduplicated === true;
    if (!result.success) {
      throw new Error(
        `[AppCredits] Failed to reduce redeemable earnings for ${appId}: ${result.error ?? "unknown error"}`,
      );
    }
    if (!result.ledgerEntryId) {
      throw new Error(`Creator earnings reversal for ${appId} has no immutable ledger entry`);
    }

    logger.info(
      redeemableDeduplicated
        ? "[AppCredits] Creator earning reversal already applied — verifying app projection"
        : "[AppCredits] Reduced redeemable earnings for creator",
      {
        appId,
        creatorId: app.created_by_user_id,
        amount,
        newBalance: result.newBalance,
      },
    );

    if (app.persistAppEarnings === false) {
      return { deduplicated: redeemableDeduplicated };
    }

    const projection = await appEarningsRepository.applyCreatorMovement({
      appId,
      userId,
      type: "inference_markup",
      creatorAmount: -amount,
      platformRevenueAmount: -platformRevenueAmount,
      description: "Reconciliation adjustment (refund)",
      metadata: {
        ...metadata,
        type: "reconciliation_refund",
      },
      redeemableLedgerEntryId: result.ledgerEntryId,
      redeemableDeduplicated,
    });
    return { deduplicated: projection.deduplicated };
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
      inferenceMarkupPercentage: parseAppMonetizationNumber(
        "inference_markup_percentage",
        app.inference_markup_percentage,
        { min: 0, max: 1000 },
      ),
      purchaseSharePercentage: parseAppMonetizationNumber(
        "purchase_share_percentage",
        app.purchase_share_percentage,
        { min: 0, max: 100 },
      ),
      platformOffsetAmount: parseAppMonetizationNumber(
        "platform_offset_amount",
        app.platform_offset_amount,
        { min: 0 },
      ),
      totalCreatorEarnings: parseAppMonetizationNumber(
        "total_creator_earnings",
        app.total_creator_earnings,
        { min: 0 },
      ),
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
