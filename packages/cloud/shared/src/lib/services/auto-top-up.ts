/**
 * Coordinates durable, tenant-scoped automatic credit top-ups. A database
 * attempt is claimed and fully snapshotted before Stripe is called; provider
 * retries reuse that attempt's stable idempotency key and fenced lease.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core/edge";
import Decimal from "decimal.js";
import type Stripe from "stripe";
import type {
  AutoTopUpAttempt,
  AutoTopUpNotEligibleReason,
  Organization,
} from "../../db/repositories";
import {
  affiliatesRepository,
  autoTopUpAttemptsRepository,
  organizationsRepository,
  usersRepository,
} from "../../db/repositories";
import type {
  AutoTopUpAttemptStatus,
  AutoTopUpControlMode,
  AutoTopUpTriggerSource,
} from "../../db/schemas";
import { CacheInvalidation } from "../cache/invalidation";
import { invalidateOrganizationCache } from "../cache/organizations-cache";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { logger } from "../utils/logger";
import {
  organizationLifecycleAllowsNewWork,
  readOrganizationLifecycleAuthority,
} from "./account-lifecycle-authority";
import { emailService } from "./email";
import { invalidateOrgTierCache } from "./org-rate-limits";
import { acquireProviderAdmission, releaseProviderAdmission } from "./provider-admission";
import {
  type StripeCustomerAuthorityService,
  stripeCustomerAuthorityService,
} from "./stripe-customer-authority";

export const AUTO_TOP_UP_LIMITS = {
  MIN_AMOUNT: 1,
  MAX_AMOUNT: 1000,
  MIN_THRESHOLD: 0,
  MAX_THRESHOLD: 1000,
} as const;

const AUTO_TOP_UP_LEASE_MS = 2 * 60 * 1000;
const AUTO_TOP_UP_UNKNOWN_PI_RECOVERY_MS = 23 * 60 * 60 * 1000;
const AUTO_TOP_UP_RETRY_BASE_MS = 60 * 1000;
const AUTO_TOP_UP_RETRY_MAX_MS = 15 * 60 * 1000;
const AUTO_TOP_UP_CRON_MAX = 100;
const AUTO_TOP_UP_ROLLOUT_PAUSED_MESSAGE =
  "Durable auto top-up activation is paused during the safe rollout window";
const AUTO_TOP_UP_CONTROL_PAUSED_MESSAGE =
  "Auto top-up charging is paused until durable cutover is activated";
const AUTO_TOP_UP_LEGACY_RECONCILIATION_MESSAGE =
  "An earlier card payment requires reconciliation before auto top-up can continue";
const AFFILIATE_PLATFORM_PERCENT = new Decimal(20);
const AFFILIATE_MAX_PERCENT = new Decimal(1000);
const CLAIM_DISABLED_REASONS = new Set<AutoTopUpNotEligibleReason>([
  "invalid_balance",
  "invalid_threshold",
  "invalid_amount",
  "missing_customer",
  "missing_payment_method",
]);

export type AutoTopUpResultStatus = AutoTopUpAttemptStatus | "not_needed" | "unavailable";

export interface AutoTopUpResult {
  organizationId: string;
  success: boolean;
  amount?: number;
  previousBalance?: number;
  newBalance?: number;
  message?: string;
  error?: string;
  attemptId?: string;
  status: AutoTopUpResultStatus;
  recovered: boolean;
}

export interface AutoTopUpCheckResult {
  timestamp: Date;
  rolloutPaused: boolean;
  cutoverPaused: boolean;
  controlMode: AutoTopUpControlMode;
  organizationsChecked: number;
  organizationsProcessed: number;
  successful: number;
  failed: number;
  recovered: number;
  claimed: number;
  skipped: number;
  results: AutoTopUpResult[];
}

export interface AutoTopUpReconciliationResult {
  disposition: "settled" | "validated_deferred" | "rejected";
  result: AutoTopUpResult;
}

interface ExecuteAutoTopUpOptions {
  source: AutoTopUpTriggerSource;
}

interface CheckAutoTopUpOptions {
  source?: AutoTopUpTriggerSource;
  limit?: number;
}

interface AutoTopUpServiceDependencies {
  repository: typeof autoTopUpAttemptsRepository;
  stripe: typeof requireStripe;
  now: () => Date;
  randomUUID: () => string;
  rolloutEnabled: () => boolean;
  customerAuthority: Pick<StripeCustomerAuthorityService, "ensure">;
  lifecycleAuthority: typeof readOrganizationLifecycleAuthority;
  acquireProviderAdmission: typeof acquireProviderAdmission;
  releaseProviderAdmission: typeof releaseProviderAdmission;
}

interface DurableRequestSnapshot {
  chargeAmountCents: number;
  metadata: Record<string, string>;
}

/** A persisted NUMERIC value was not a finite, canonical business number. */
export class CorruptAutoTopUpNumberError extends Error {
  constructor(
    readonly field: string,
    readonly rawValue: unknown,
  ) {
    super(`Auto top-up ${field} is not a finite number: ${String(rawValue)}`);
    this.name = "CorruptAutoTopUpNumberError";
  }
}

/** Safe domain error for settings input that must be repaired explicitly. */
export class AutoTopUpSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoTopUpSettingsValidationError";
  }
}

/**
 * Retained as the strict settings/affiliate boundary used by callers and
 * regression tests. Provider money itself is represented as integer cents.
 */
export function parseAutoTopUpNumber(field: string, raw: unknown): number {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    throw new CorruptAutoTopUpNumberError(field, raw);
  }
  let value: Decimal;
  try {
    value = new Decimal(raw as Decimal.Value);
  } catch {
    // error-policy:J3 Invalid persisted/user numeric input becomes the typed
    // corrupt-number failure; it is never replaced with a valid-looking value.
    throw new CorruptAutoTopUpNumberError(field, raw);
  }
  if (!value.isFinite()) {
    throw new CorruptAutoTopUpNumberError(field, raw);
  }
  const number = value.toNumber();
  if (!Number.isFinite(number)) {
    throw new CorruptAutoTopUpNumberError(field, raw);
  }
  return number;
}

function parseAutoTopUpNumberForSettingsRead(field: string, raw: unknown): number | null {
  // SQL NULL is the established unconfigured state exposed as 0 by this API.
  // Non-null malformed values are different: surface them honestly as null so
  // callers cannot mistake corruption for a configured monetary value.
  if (raw === null || raw === undefined) return 0;
  try {
    return parseAutoTopUpNumber(field, raw);
  } catch (error) {
    // error-policy:J3 Settings reads expose only the typed corrupt-number case
    // as an explicit null; unexpected failures still propagate.
    if (error instanceof CorruptAutoTopUpNumberError) return null;
    throw error;
  }
}

function centsToUsd(cents: number): string {
  return new Decimal(cents).div(100).toFixed(2);
}

function centsToNumber(cents: number): number {
  return new Decimal(cents).div(100).toNumber();
}

function exactUsdCents(raw: string | undefined): number | null {
  if (!raw || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(raw)) return null;
  const [whole, fraction] = raw.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function canonicalBalanceNumber(raw: string): number {
  const value = new Decimal(raw);
  if (!value.isFinite()) throw new Error("Auto top-up settlement returned an invalid balance");
  return value.toNumber();
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 4));
  return Math.min(AUTO_TOP_UP_RETRY_BASE_MS * 2 ** exponent, AUTO_TOP_UP_RETRY_MAX_MS);
}

function providerEntityId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "object" && value !== null) {
    const id = Reflect.get(value, "id");
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function paymentIntentFromError(error: unknown): Stripe.PaymentIntent | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = Reflect.get(error, "payment_intent");
  if (typeof candidate !== "object" || candidate === null) return null;
  const id = Reflect.get(candidate, "id");
  const status = Reflect.get(candidate, "status");
  const amount = Reflect.get(candidate, "amount");
  const amountReceived = Reflect.get(candidate, "amount_received");
  const currency = Reflect.get(candidate, "currency");
  const metadata = Reflect.get(candidate, "metadata");
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof status !== "string" ||
    status.length === 0 ||
    !Number.isSafeInteger(amount) ||
    Number(amount) < 0 ||
    !Number.isSafeInteger(amountReceived) ||
    Number(amountReceived) < 0 ||
    typeof currency !== "string" ||
    currency.length === 0 ||
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    Object.values(metadata).some((value) => typeof value !== "string")
  ) {
    return null;
  }
  return candidate as Stripe.PaymentIntent;
}

function stripeErrorType(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const type = Reflect.get(error, "type");
  return typeof type === "string" ? type : null;
}

function stripeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown provider error";
  return truncateWellFormed(toWellFormedUnicode(message.replaceAll(/\s+/g, " ")), 500);
}

function curatedProviderResult(paymentIntent: Stripe.PaymentIntent): Record<string, unknown> {
  return {
    id: paymentIntent.id,
    status: paymentIntent.status,
    amount: paymentIntent.amount,
    amountReceived: paymentIntent.amount_received,
    currency: paymentIntent.currency,
    customerId: providerEntityId(paymentIntent.customer),
    paymentMethodId: providerEntityId(paymentIntent.payment_method),
    livemode: paymentIntent.livemode,
  };
}

function resultFromAttempt(
  attempt: AutoTopUpAttempt,
  recovered: boolean,
  error?: string,
): AutoTopUpResult {
  return {
    organizationId: attempt.organizationId,
    success: attempt.status === "credited",
    amount: centsToNumber(attempt.creditAmountCents),
    attemptId: attempt.id,
    status: attempt.status,
    recovered,
    ...(error ? { error } : {}),
  };
}

function validatePaymentIntent(
  paymentIntent: Stripe.PaymentIntent,
  attempt: AutoTopUpAttempt,
): string | null {
  if (attempt.stripePaymentIntentId && paymentIntent.id !== attempt.stripePaymentIntentId) {
    return "Provider payment intent does not match the durable attempt";
  }
  if (paymentIntent.amount !== attempt.chargeAmountCents) {
    return "Provider payment amount does not match the durable attempt";
  }
  if (paymentIntent.currency.toLowerCase() !== attempt.currency) {
    return "Provider payment currency does not match the durable attempt";
  }
  if (providerEntityId(paymentIntent.customer) !== attempt.stripeCustomerId) {
    return "Provider customer does not match the durable attempt";
  }
  if (providerEntityId(paymentIntent.payment_method) !== attempt.stripePaymentMethodId) {
    return "Provider payment method does not match the durable attempt";
  }
  const expectedMetadata = validatedPersistedStripeMetadata(attempt);
  const metadata = paymentIntent.metadata;
  if (
    !expectedMetadata ||
    Object.keys(metadata).length !== Object.keys(expectedMetadata).length ||
    Object.entries(expectedMetadata).some(([key, value]) => metadata[key] !== value)
  ) {
    return "Provider payment metadata does not match the durable attempt";
  }
  if (
    paymentIntent.status === "succeeded" &&
    paymentIntent.amount_received !== attempt.chargeAmountCents
  ) {
    return "Provider received amount does not match the durable attempt";
  }
  return null;
}

function validatedPersistedStripeMetadata(
  attempt: AutoTopUpAttempt,
): Record<string, string> | null {
  const entries = Object.entries(attempt.requestMetadata);
  if (entries.some(([, value]) => typeof value !== "string")) return null;
  const metadata = Object.fromEntries(entries) as Record<string, string>;
  if (
    attempt.currency !== "usd" ||
    metadata.type !== "auto_top_up" ||
    metadata.organization_id !== attempt.organizationId ||
    metadata.auto_top_up_attempt_id !== attempt.id ||
    metadata.credits !== centsToUsd(attempt.creditAmountCents) ||
    metadata.base_amount !== centsToUsd(attempt.creditAmountCents) ||
    metadata.total_charged !== centsToUsd(attempt.chargeAmountCents) ||
    metadata.fees_included !== "true"
  ) {
    return null;
  }

  const platformFeeCents = exactUsdCents(metadata.platform_fee_amount);
  const hasAffiliateFeeField = typeof metadata.affiliate_fee_amount === "string";
  const affiliateFeeCents = hasAffiliateFeeField ? exactUsdCents(metadata.affiliate_fee_amount) : 0;
  if (
    platformFeeCents === null ||
    affiliateFeeCents === null ||
    platformFeeCents + affiliateFeeCents !== attempt.chargeAmountCents - attempt.creditAmountCents
  ) {
    return null;
  }

  const hasAffiliateOwner =
    typeof metadata.affiliate_owner_id === "string" &&
    metadata.affiliate_owner_id.trim() === metadata.affiliate_owner_id &&
    metadata.affiliate_owner_id.length > 0;
  const hasAffiliateCode =
    typeof metadata.affiliate_code_id === "string" &&
    metadata.affiliate_code_id.trim() === metadata.affiliate_code_id &&
    metadata.affiliate_code_id.length > 0;
  const hasAffiliateTuple = hasAffiliateOwner && hasAffiliateCode && hasAffiliateFeeField;
  if (
    hasAffiliateOwner !== hasAffiliateCode ||
    hasAffiliateFeeField !== (hasAffiliateOwner && hasAffiliateCode)
  ) {
    return null;
  }

  const expectedPlatformFeeCents = new Decimal(attempt.creditAmountCents)
    .mul(AFFILIATE_PLATFORM_PERCENT)
    .div(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  const maxAffiliateFeeCents = new Decimal(attempt.creditAmountCents)
    .mul(AFFILIATE_MAX_PERCENT)
    .div(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  if (
    hasAffiliateTuple
      ? platformFeeCents !== expectedPlatformFeeCents || affiliateFeeCents > maxAffiliateFeeCents
      : platformFeeCents !== 0 || affiliateFeeCents !== 0
  ) {
    return null;
  }
  return metadata;
}

export class AutoTopUpService {
  private readonly repository: typeof autoTopUpAttemptsRepository;
  private readonly stripe: typeof requireStripe;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly rolloutEnabled: () => boolean;
  private readonly customerAuthority: Pick<StripeCustomerAuthorityService, "ensure">;
  private readonly lifecycleAuthority: typeof readOrganizationLifecycleAuthority;
  private readonly acquireProviderAdmission: typeof acquireProviderAdmission;
  private readonly releaseProviderAdmission: typeof releaseProviderAdmission;

  constructor(dependencies: Partial<AutoTopUpServiceDependencies> = {}) {
    this.repository = dependencies.repository ?? autoTopUpAttemptsRepository;
    this.stripe = dependencies.stripe ?? requireStripe;
    this.now = dependencies.now ?? (() => new Date());
    this.randomUUID = dependencies.randomUUID ?? (() => globalThis.crypto.randomUUID());
    this.rolloutEnabled =
      dependencies.rolloutEnabled ??
      (() => getCloudAwareEnv().AUTO_TOP_UP_DURABLE_ENABLED === "true");
    this.customerAuthority = dependencies.customerAuthority ?? stripeCustomerAuthorityService;
    this.lifecycleAuthority = dependencies.lifecycleAuthority ?? readOrganizationLifecycleAuthority;
    this.acquireProviderAdmission =
      dependencies.acquireProviderAdmission ?? acquireProviderAdmission;
    this.releaseProviderAdmission =
      dependencies.releaseProviderAdmission ?? releaseProviderAdmission;
  }

  validateSettings(amount: number, threshold: number): void {
    if (!Number.isFinite(amount) || !Number.isFinite(threshold)) {
      throw new Error("Auto top-up settings must be valid numbers");
    }
    if (amount < AUTO_TOP_UP_LIMITS.MIN_AMOUNT) {
      throw new Error(`Auto top-up amount must be at least $${AUTO_TOP_UP_LIMITS.MIN_AMOUNT}`);
    }
    if (amount > AUTO_TOP_UP_LIMITS.MAX_AMOUNT) {
      throw new Error(`Auto top-up amount cannot exceed $${AUTO_TOP_UP_LIMITS.MAX_AMOUNT}`);
    }
    if (threshold < AUTO_TOP_UP_LIMITS.MIN_THRESHOLD) {
      throw new Error(
        `Auto top-up threshold must be at least $${AUTO_TOP_UP_LIMITS.MIN_THRESHOLD}`,
      );
    }
    if (threshold > AUTO_TOP_UP_LIMITS.MAX_THRESHOLD) {
      throw new Error(`Auto top-up threshold cannot exceed $${AUTO_TOP_UP_LIMITS.MAX_THRESHOLD}`);
    }
  }

  async executeAutoTopUpForOrganization(
    organizationId: string,
    options: ExecuteAutoTopUpOptions = { source: "manual" },
  ): Promise<AutoTopUpResult> {
    // Recovery authority is the durable row, not the rollout switches. Reuse
    // existing work before consulting gates so disabling new claims can never
    // strand a provider payment that already crossed a durable boundary.
    const blocking = await this.repository.findBlockingByOrganization(organizationId);
    if (blocking) {
      logger.info("[AutoTopUp] Durable attempt selected", {
        organizationId,
        attemptId: blocking.id,
        source: options.source,
        claimOutcome: "reused",
        status: blocking.status,
      });
      if (blocking.status === "manual_review" || blocking.status === "credited") {
        return resultFromAttempt(blocking, true, blocking.lastError ?? undefined);
      }
      return this.processAttempt(blocking, true);
    }

    if (!this.rolloutEnabled()) {
      logger.warn("[AutoTopUp] Durable rollout gate is closed", {
        organizationId,
        source: options.source,
      });
      return {
        organizationId,
        success: false,
        error: AUTO_TOP_UP_ROLLOUT_PAUSED_MESSAGE,
        status: "unavailable",
        recovered: false,
      };
    }

    if (await this.repository.customerReconciliationMayBeNeeded(organizationId)) {
      try {
        await this.customerAuthority.ensure({
          organizationId,
          callerIntent: "auto_top_up",
        });
      } catch (error) {
        // error-policy:J4 Customer reconciliation failure becomes an explicit
        // unavailable state before any auto-top-up attempt or provider charge exists.
        logger.warn("[AutoTopUp] Stripe Customer authority is unavailable", {
          organizationId,
          source: options.source,
          error: safeErrorMessage(error),
        });
        return {
          organizationId,
          success: false,
          error: "Stripe Customer requires reconciliation before auto top-up can continue",
          status: "unavailable",
          recovered: false,
        };
      }
    }

    const now = this.now();
    const attemptId = this.randomUUID();
    const claim = await this.repository.claimEligibleAttempt({
      organizationId,
      triggerSource: options.source,
      attemptId,
      idempotencyKey: `auto_top_up:v1:${attemptId}`,
      now,
    });

    if (claim.outcome === "not_eligible") {
      if (claim.reason === "cutover_paused") {
        return {
          organizationId,
          success: false,
          error: AUTO_TOP_UP_CONTROL_PAUSED_MESSAGE,
          status: "unavailable",
          recovered: false,
        };
      }
      if (claim.reason === "legacy_payment_unresolved") {
        return {
          organizationId,
          success: false,
          error: AUTO_TOP_UP_LEGACY_RECONCILIATION_MESSAGE,
          status: "manual_review",
          recovered: false,
        };
      }
      if (
        claim.reason === "balance_at_or_above_threshold" ||
        claim.reason === "balance_not_rearmed"
      ) {
        return {
          organizationId,
          success: false,
          status: "not_needed",
          recovered: false,
          message:
            claim.reason === "balance_not_rearmed"
              ? "The current balance decrease was already covered by an auto top-up"
              : "Balance is above the auto top-up threshold",
        };
      }
      const errors: Record<AutoTopUpNotEligibleReason, string> = {
        cutover_paused: AUTO_TOP_UP_CONTROL_PAUSED_MESSAGE,
        legacy_payment_unresolved: AUTO_TOP_UP_LEGACY_RECONCILIATION_MESSAGE,
        not_found: "Organization not found",
        disabled: "Auto top-up is not enabled",
        balance_at_or_above_threshold: "Auto top-up not needed",
        balance_not_rearmed: "Auto top-up is waiting for a new balance decrease",
        missing_customer: "Missing Stripe customer",
        unverified_customer_authority: "Stripe Customer authority is not verified",
        missing_payment_method: "Missing default payment method",
        invalid_balance: "Invalid credit balance",
        invalid_threshold: "Invalid auto top-up threshold",
        invalid_amount: "Invalid auto top-up amount",
      };
      const error = errors[claim.reason];
      if (CLAIM_DISABLED_REASONS.has(claim.reason)) {
        await this.publishDisabledState(organizationId, error);
      }
      return {
        organizationId,
        success: false,
        error,
        status: "canceled",
        recovered: false,
      };
    }

    const recovered = claim.outcome === "reused";
    logger.info("[AutoTopUp] Durable attempt selected", {
      organizationId,
      attemptId: claim.attempt.id,
      source: options.source,
      claimOutcome: claim.outcome,
      status: claim.attempt.status,
    });
    if (claim.attempt.status === "manual_review" || claim.attempt.status === "credited") {
      return resultFromAttempt(claim.attempt, recovered, claim.attempt.lastError ?? undefined);
    }
    return this.processAttempt(claim.attempt, recovered);
  }

  /**
   * Validate a signed provider success against its durable request before the
   * webhook performs any financial side effect. An active owner keeps its
   * lease; the cron will converge the already-validated observation.
   */
  async reconcileSucceededPaymentIntent(
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<AutoTopUpReconciliationResult> {
    const attemptId = paymentIntent.metadata?.auto_top_up_attempt_id;
    if (!attemptId || paymentIntent.status !== "succeeded") {
      throw new Error("Invalid durable auto top-up payment intent");
    }

    let candidate = await this.repository.findById(attemptId);
    if (!candidate) throw new Error("Auto top-up attempt not found");

    const validationError = validatePaymentIntent(paymentIntent, candidate);
    if (validationError) {
      const rejected = await this.tryRejectObservedPayment(candidate, validationError, {
        provider: curatedProviderResult(paymentIntent),
      });
      return { disposition: "rejected", result: rejected };
    }
    if (candidate.status === "manual_review") {
      const reopened = await this.repository.reopenManualReviewForSucceededPayment({
        attemptId: candidate.id,
        paymentIntentId: paymentIntent.id,
        result: curatedProviderResult(paymentIntent),
        now: this.now(),
      });
      if (!reopened) {
        const latest = await this.resultAfterFenceMiss(
          candidate,
          true,
          "Late provider success could not be safely reopened",
        );
        return {
          disposition: "rejected",
          result: latest,
        };
      }
      candidate = reopened;
    }
    if (candidate.status === "credited") {
      return { disposition: "settled", result: resultFromAttempt(candidate, true) };
    }
    if (candidate.status === "canceled") {
      return {
        disposition: "rejected",
        result: resultFromAttempt(candidate, true, candidate.lastError ?? undefined),
      };
    }

    const leaseNow = this.now();
    const leaseToken = this.randomUUID();
    const leased = await this.repository.claimDueLease({
      attemptId: candidate.id,
      leaseToken,
      now: leaseNow,
      leaseExpiresAt: new Date(leaseNow.getTime() + AUTO_TOP_UP_LEASE_MS),
    });
    if (!leased) {
      let latest: AutoTopUpAttempt | null;
      try {
        latest = await this.repository.findById(candidate.id);
      } catch (error) {
        // error-policy:J4 A validated signed receipt remains visibly deferred
        // when the primary durable state cannot be re-read.
        logger.error("[AutoTopUp] Fenced webhook state re-read failed", {
          organizationId: candidate.organizationId,
          attemptId: candidate.id,
          error: safeErrorMessage(error),
        });
        return {
          disposition: "validated_deferred",
          result: {
            organizationId: candidate.organizationId,
            success: false,
            error: "Auto top-up state is unavailable",
            attemptId: candidate.id,
            status: "unavailable",
            recovered: true,
          },
        };
      }
      if (!latest) {
        return {
          disposition: "validated_deferred",
          result: {
            organizationId: candidate.organizationId,
            success: false,
            error: "Auto top-up state is unavailable",
            attemptId: candidate.id,
            status: "unavailable",
            recovered: true,
          },
        };
      }
      const latestValidationError = validatePaymentIntent(paymentIntent, latest);
      if (
        latestValidationError ||
        latest.status === "canceled" ||
        latest.status === "manual_review"
      ) {
        return {
          disposition: "rejected",
          result: resultFromAttempt(
            latest,
            true,
            latestValidationError ?? latest.lastError ?? undefined,
          ),
        };
      }
      return {
        disposition: latest.status === "credited" ? "settled" : "validated_deferred",
        result: resultFromAttempt(latest, true),
      };
    }

    const result = await this.handlePaymentIntent(leased, leaseToken, true, paymentIntent);
    return {
      disposition:
        result.status === "credited"
          ? "settled"
          : result.status === "canceled" || result.status === "manual_review"
            ? "rejected"
            : "validated_deferred",
      result,
    };
  }

  /** Compatibility boundary; production callers must pass only a tenant id. */
  async executeAutoTopUp(org: Organization): Promise<AutoTopUpResult> {
    return this.executeAutoTopUpForOrganization(org.id, { source: "manual" });
  }

  async checkAndExecuteAutoTopUps(
    options: CheckAutoTopUpOptions = {},
  ): Promise<AutoTopUpCheckResult> {
    const timestamp = this.now();
    const source = options.source ?? "cron";
    const limit = options.limit ?? AUTO_TOP_UP_CRON_MAX;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUTO_TOP_UP_CRON_MAX) {
      throw new Error(`Auto top-up sweep limit must be between 1 and ${AUTO_TOP_UP_CRON_MAX}`);
    }

    const control = await this.repository.getControl();
    const cutoverPaused = control.mode !== "durable";
    const rolloutPaused = !this.rolloutEnabled() || cutoverPaused;
    if (rolloutPaused) {
      logger.warn("[AutoTopUp] Durable rollout gate is closed to new claims", {
        source,
        limit,
        controlMode: control.mode,
      });
    }

    const results: AutoTopUpResult[] = [];
    // Reserve capacity for new low-balance organizations so a persistent
    // recovery backlog cannot starve fresh claims forever.
    const recoveryLimit = limit >= 2 ? Math.max(1, Math.floor(limit * 0.75)) : 1;
    const due = await this.repository.listDueAttempts({ now: timestamp, limit: recoveryLimit });
    for (const attempt of due) {
      try {
        results.push(await this.processAttempt(attempt, true));
      } catch (error) {
        // error-policy:J4 Re-read the durable state because processing may have
        // crossed a provider or settlement boundary before it threw.
        logger.error("[AutoTopUp] Recovery attempt failed", {
          organizationId: attempt.organizationId,
          attemptId: attempt.id,
          error: safeErrorMessage(error),
        });
        let durable: AutoTopUpAttempt | null = null;
        try {
          durable = await this.repository.findById(attempt.id);
        } catch (lookupError) {
          // error-policy:J4 The sweep reports an explicit unavailable state
          // when its authoritative recovery read fails.
          logger.error("[AutoTopUp] Durable recovery state lookup failed", {
            organizationId: attempt.organizationId,
            attemptId: attempt.id,
            error: safeErrorMessage(lookupError),
          });
        }
        results.push(
          durable
            ? resultFromAttempt(durable, true, "Auto top-up recovery is pending")
            : {
                organizationId: attempt.organizationId,
                success: false,
                error: "Auto top-up state is unavailable",
                attemptId: attempt.id,
                status: "unavailable",
                recovered: true,
              },
        );
      }
    }

    const remaining = limit - results.length;
    if (!rolloutPaused && remaining > 0) {
      const organizationIds = await this.repository.listEligibleOrganizationIds({
        limit: remaining,
      });
      for (const organizationId of organizationIds) {
        try {
          results.push(await this.executeAutoTopUpForOrganization(organizationId, { source }));
        } catch (error) {
          // error-policy:J4 A durable row, when present, is the only truthful
          // state; otherwise expose an explicit unavailable result.
          logger.error("[AutoTopUp] New eligible organization failed", {
            organizationId,
            error: safeErrorMessage(error),
          });
          let durable: AutoTopUpAttempt | null = null;
          try {
            durable = await this.repository.findBlockingByOrganization(organizationId);
          } catch (lookupError) {
            // error-policy:J4 The sweep reports an explicit unavailable state
            // when no authoritative durable failure state can be read.
            logger.error("[AutoTopUp] Durable failure state lookup failed", {
              organizationId,
              error: safeErrorMessage(lookupError),
            });
          }
          results.push(
            durable
              ? resultFromAttempt(durable, true, "Auto top-up recovery is pending")
              : {
                  organizationId,
                  success: false,
                  error: "Auto top-up state is unavailable",
                  status: "unavailable",
                  recovered: false,
                },
          );
        }
      }
    }

    const inProgress = new Set<AutoTopUpResultStatus>([
      "claimed",
      "payment_pending",
      "payment_succeeded",
      "not_needed",
    ]);
    return {
      timestamp,
      rolloutPaused,
      cutoverPaused,
      controlMode: control.mode,
      organizationsChecked: results.length,
      organizationsProcessed: results.filter((result) => result.attemptId !== undefined).length,
      successful: results.filter((result) => result.success).length,
      failed: results.filter((result) => !result.success && !inProgress.has(result.status)).length,
      recovered: results.filter((result) => result.recovered).length,
      claimed: results.filter((result) => result.attemptId !== undefined && !result.recovered)
        .length,
      skipped: results.filter((result) => !result.success && inProgress.has(result.status)).length,
      results,
    };
  }

  /**
   * A null fenced mutation means another owner may have advanced the attempt.
   * Never project the caller's stale snapshot across that concurrency boundary.
   */
  private async resultAfterFenceMiss(
    candidate: AutoTopUpAttempt,
    recovered: boolean,
    fallbackError?: string,
  ): Promise<AutoTopUpResult> {
    try {
      const latest = await this.repository.findById(candidate.id);
      if (latest) {
        const error =
          latest.status === "credited" ? undefined : (latest.lastError ?? fallbackError);
        return resultFromAttempt(latest, recovered, error);
      }
    } catch (error) {
      // error-policy:J4 A failed fenced-state re-read becomes a distinct
      // unavailable result; no stale attempt is presented as authoritative.
      logger.error("[AutoTopUp] Fenced attempt state re-read failed", {
        organizationId: candidate.organizationId,
        attemptId: candidate.id,
        error: safeErrorMessage(error),
      });
    }
    return {
      organizationId: candidate.organizationId,
      success: false,
      error: "Auto top-up state is unavailable",
      attemptId: candidate.id,
      status: "unavailable",
      recovered,
    };
  }

  private async processAttempt(
    candidate: AutoTopUpAttempt,
    recovered: boolean,
  ): Promise<AutoTopUpResult> {
    if (candidate.status === "manual_review" || candidate.status === "credited") {
      return resultFromAttempt(candidate, recovered, candidate.lastError ?? undefined);
    }

    const leaseNow = this.now();
    const leaseToken = this.randomUUID();
    const leased = await this.repository.claimDueLease({
      attemptId: candidate.id,
      leaseToken,
      now: leaseNow,
      leaseExpiresAt: new Date(leaseNow.getTime() + AUTO_TOP_UP_LEASE_MS),
    });
    if (!leased) {
      return this.resultAfterFenceMiss(candidate, recovered);
    }
    logger.info("[AutoTopUp] Attempt lease acquired", {
      organizationId: leased.organizationId,
      attemptId: leased.id,
      attemptCount: leased.attemptCount,
      recovered,
      status: leased.status,
    });

    let attempt = leased;
    if (attempt.status === "claimed") {
      const snapshot = await this.buildRequestSnapshot(attempt);
      const finalized = await this.repository.finalizeRequest({
        attemptId: attempt.id,
        leaseToken,
        chargeAmountCents: snapshot.chargeAmountCents,
        requestMetadata: snapshot.metadata,
        now: this.now(),
      });
      if (!finalized) return this.resultAfterFenceMiss(attempt, recovered);
      attempt = finalized;
    }

    const stripeMetadata = validatedPersistedStripeMetadata(attempt);
    if (!stripeMetadata) {
      return this.moveToManualReview(
        attempt,
        leaseToken,
        recovered,
        "Durable provider metadata is invalid",
      );
    }
    if (attempt.status === "payment_succeeded") {
      return this.finishSucceededAttempt(attempt, leaseToken, recovered);
    }

    const preAuthorizationLifecycle = await this.lifecycleAuthority(attempt.organizationId);
    if (!organizationLifecycleAllowsNewWork(preAuthorizationLifecycle)) {
      return this.cancelAttempt(
        attempt,
        leaseToken,
        recovered,
        "Account lifecycle fenced auto top-up before provider authorization",
      );
    }

    const providerStart = this.now();
    const authorization = await this.repository.authorizeProviderRequest({
      attemptId: attempt.id,
      leaseToken,
      now: providerStart,
      recoveryDeadlineAt: new Date(providerStart.getTime() + AUTO_TOP_UP_UNKNOWN_PI_RECOVERY_MS),
    });
    if (authorization.outcome === "fence_lost") {
      return this.resultAfterFenceMiss(attempt, recovered);
    }
    if (authorization.outcome === "rejected") {
      return resultFromAttempt(
        authorization.attempt,
        recovered,
        authorization.attempt.lastError ?? "Stripe Customer authority is not verified",
      );
    }
    const wasProviderStarted = attempt.providerRequestStartedAt !== null;
    attempt = authorization.attempt;
    if (!wasProviderStarted) {
      logger.info("[AutoTopUp] Provider request durably started", {
        organizationId: attempt.organizationId,
        attemptId: attempt.id,
        attemptCount: attempt.attemptCount,
      });
    } else if (
      !attempt.stripePaymentIntentId &&
      attempt.recoveryDeadlineAt &&
      attempt.recoveryDeadlineAt.getTime() <= this.now().getTime()
    ) {
      return this.moveToManualReview(
        attempt,
        leaseToken,
        recovered,
        "Provider response stayed unknown past the safe idempotency window",
      );
    }

    const providerAdmission = {
      organizationId: attempt.organizationId,
      operationKind: "auto_top_up" as const,
      operationId: attempt.id,
    };
    if (!(await this.acquireProviderAdmission(providerAdmission, this.now()))) {
      return this.cancelAttempt(
        attempt,
        leaseToken,
        recovered,
        "Account lifecycle fenced auto top-up provider admission",
      );
    }

    try {
      const finalLifecycle = await this.lifecycleAuthority(attempt.organizationId);
      if (
        !organizationLifecycleAllowsNewWork(finalLifecycle) ||
        finalLifecycle.revision !== preAuthorizationLifecycle.revision
      ) {
        return this.moveToManualReview(
          attempt,
          leaseToken,
          recovered,
          "Account lifecycle changed after provider authorization; no payment request was sent",
        );
      }
      logger.info("[AutoTopUp] Resolving provider payment intent", {
        organizationId: attempt.organizationId,
        attemptId: attempt.id,
        mode: attempt.stripePaymentIntentId ? "retrieve" : "create",
        paymentIntentId: attempt.stripePaymentIntentId ?? undefined,
      });
      const paymentIntent = attempt.stripePaymentIntentId
        ? await this.stripe().paymentIntents.retrieve(attempt.stripePaymentIntentId)
        : await this.stripe().paymentIntents.create(
            {
              amount: attempt.chargeAmountCents,
              currency: attempt.currency,
              customer: attempt.stripeCustomerId,
              payment_method: attempt.stripePaymentMethodId,
              confirm: true,
              off_session: true,
              metadata: stripeMetadata,
              description: `Auto top-up - $${centsToUsd(attempt.chargeAmountCents)}`,
            },
            { idempotencyKey: attempt.idempotencyKey },
          );
      // Keep the provider admission until the payment outcome and any
      // cancellation/reconciliation receipt are durably settled.
      return await this.handlePaymentIntent(attempt, leaseToken, recovered, paymentIntent);
    } catch (error) {
      // error-policy:J4 Provider failures are mapped to retry, cancellation, or
      // manual-review states in the durable ledger; none become fake success.
      const paymentIntent = paymentIntentFromError(error);
      if (paymentIntent) {
        return await this.handlePaymentIntent(attempt, leaseToken, recovered, paymentIntent);
      }
      const type = stripeErrorType(error);
      const code = stripeErrorCode(error);
      if (type === "StripeCardError") {
        return this.moveToManualReview(
          attempt,
          leaseToken,
          recovered,
          "Payment method was declined without a confirmed provider cancellation",
          { providerErrorType: type },
        );
      }
      if (
        type === "StripeInvalidRequestError" ||
        (type === "StripeIdempotencyError" && code !== "idempotency_key_in_use") ||
        type === "StripeAuthenticationError" ||
        type === "StripePermissionError"
      ) {
        return this.moveToManualReview(
          attempt,
          leaseToken,
          recovered,
          "Provider request requires operator review",
          { providerErrorType: type, ...(code ? { providerErrorCode: code } : {}) },
        );
      }
      const failureNow = this.now();
      const failed = await this.repository.recordFailure({
        attemptId: attempt.id,
        leaseToken,
        error: safeErrorMessage(error),
        result:
          type || code
            ? {
                ...(type ? { providerErrorType: type } : {}),
                ...(code ? { providerErrorCode: code } : {}),
              }
            : undefined,
        nextAttemptAt: new Date(failureNow.getTime() + retryDelayMs(attempt.attemptCount)),
        now: failureNow,
      });
      if (!failed) {
        return this.resultAfterFenceMiss(attempt, recovered, "Provider request will be retried");
      }
      return resultFromAttempt(failed, recovered, "Provider request will be retried");
    } finally {
      await this.releaseProviderAdmission(providerAdmission, this.now());
    }
  }

  private async buildRequestSnapshot(attempt: AutoTopUpAttempt): Promise<DurableRequestSnapshot> {
    let userId: string | null = null;
    let affiliateFeeCents = 0;
    let platformFeeCents = 0;
    let affiliateOwnerId: string | null = null;
    let affiliateCodeId: string | null = null;
    try {
      const attribution = await affiliatesRepository.getBillingAttributionForOrganization(
        attempt.organizationId,
      );
      userId = attribution.userId;
      const referrer = attribution.affiliateCode;
      if (referrer) {
        const percent = new Decimal(referrer.markup_percent);
        if (!percent.isFinite() || percent.isNegative() || percent.gt(AFFILIATE_MAX_PERCENT)) {
          throw new CorruptAutoTopUpNumberError("markup_percent", referrer.markup_percent);
        }
        affiliateFeeCents = new Decimal(attempt.creditAmountCents)
          .mul(percent)
          .div(100)
          .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
          .toNumber();
        platformFeeCents = new Decimal(attempt.creditAmountCents)
          .mul(AFFILIATE_PLATFORM_PERCENT)
          .div(100)
          .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
          .toNumber();
        affiliateOwnerId = referrer.user_id;
        affiliateCodeId = referrer.id;
      }
    } catch (error) {
      // error-policy:J4 A primary attribution outage or corrupt markup drops
      // the optional surcharge; cached/replica data must never set card money.
      logger.error("[AutoTopUp] Affiliate attribution was dropped", {
        organizationId: attempt.organizationId,
        attemptId: attempt.id,
        error: safeErrorMessage(error),
      });
      userId = null;
      affiliateFeeCents = 0;
      platformFeeCents = 0;
      affiliateOwnerId = null;
      affiliateCodeId = null;
    }

    const chargeAmountCents = attempt.creditAmountCents + affiliateFeeCents + platformFeeCents;
    const metadata: Record<string, string> = {
      organization_id: attempt.organizationId,
      credits: centsToUsd(attempt.creditAmountCents),
      type: "auto_top_up",
      auto_top_up_attempt_id: attempt.id,
      base_amount: centsToUsd(attempt.creditAmountCents),
      total_charged: centsToUsd(chargeAmountCents),
      platform_fee_amount: centsToUsd(platformFeeCents),
      fees_included: "true",
    };
    if (userId) metadata.user_id = userId;
    if (affiliateOwnerId && affiliateCodeId) {
      metadata.affiliate_fee_amount = centsToUsd(affiliateFeeCents);
      metadata.affiliate_owner_id = affiliateOwnerId;
      metadata.affiliate_code_id = affiliateCodeId;
    }
    return { chargeAmountCents, metadata };
  }

  private async handlePaymentIntent(
    attempt: AutoTopUpAttempt,
    leaseToken: string,
    recovered: boolean,
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<AutoTopUpResult> {
    const validationError = validatePaymentIntent(paymentIntent, attempt);
    if (validationError) {
      return this.moveToManualReview(attempt, leaseToken, recovered, validationError, {
        provider: curatedProviderResult(paymentIntent),
      });
    }

    const recorded = await this.repository.recordPaymentIntent({
      attemptId: attempt.id,
      leaseToken,
      paymentIntentId: paymentIntent.id,
      providerStatus: paymentIntent.status,
      result: curatedProviderResult(paymentIntent),
      now: this.now(),
    });
    if (!recorded) return this.resultAfterFenceMiss(attempt, recovered);
    logger.info("[AutoTopUp] Provider state recorded", {
      organizationId: recorded.organizationId,
      attemptId: recorded.id,
      paymentIntentId: paymentIntent.id,
      providerStatus: paymentIntent.status,
    });

    switch (paymentIntent.status) {
      case "succeeded":
        return this.finishSucceededAttempt(recorded, leaseToken, recovered);
      case "requires_action":
      case "requires_confirmation":
      case "requires_payment_method":
        return this.cancelProviderPaymentIntent(recorded, leaseToken, recovered, paymentIntent);
      case "canceled":
        return this.cancelAttempt(
          recorded,
          leaseToken,
          recovered,
          `Payment ${paymentIntent.status}`,
          { provider: curatedProviderResult(paymentIntent) },
        );
      case "processing": {
        const failureNow = this.now();
        const failed = await this.repository.recordFailure({
          attemptId: recorded.id,
          leaseToken,
          error: `Payment ${paymentIntent.status}`,
          result: curatedProviderResult(paymentIntent),
          nextAttemptAt: new Date(failureNow.getTime() + retryDelayMs(recorded.attemptCount)),
          now: failureNow,
        });
        if (!failed) {
          return this.resultAfterFenceMiss(recorded, recovered, `Payment ${paymentIntent.status}`);
        }
        return resultFromAttempt(failed, recovered, `Payment ${paymentIntent.status}`);
      }
      case "requires_capture":
      default:
        return this.moveToManualReview(
          recorded,
          leaseToken,
          recovered,
          `Unexpected provider state ${paymentIntent.status}`,
          { provider: curatedProviderResult(paymentIntent) },
        );
    }
  }

  private async cancelProviderPaymentIntent(
    attempt: AutoTopUpAttempt,
    leaseToken: string,
    recovered: boolean,
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<AutoTopUpResult> {
    try {
      const canceled = await this.stripe().paymentIntents.cancel(paymentIntent.id);
      if (canceled.status !== "canceled") {
        return this.moveToManualReview(
          attempt,
          leaseToken,
          recovered,
          "Provider cancellation did not reach a terminal state",
          { provider: curatedProviderResult(canceled) },
        );
      }
      return this.cancelAttempt(attempt, leaseToken, recovered, `Payment ${paymentIntent.status}`, {
        provider: curatedProviderResult(canceled),
      });
    } catch (error) {
      // error-policy:J4 An ambiguous provider cancellation must block new
      // charges until an operator or signed success event reconciles it.
      return this.moveToManualReview(
        attempt,
        leaseToken,
        recovered,
        "Provider payment could not be safely canceled",
        { cancellationError: safeErrorMessage(error) },
      );
    }
  }

  private async finishSucceededAttempt(
    attempt: AutoTopUpAttempt,
    leaseToken: string,
    recovered: boolean,
  ): Promise<AutoTopUpResult> {
    const settled = await this.repository.settleSucceededAttempt({
      attemptId: attempt.id,
      leaseToken,
      now: this.now(),
    });
    if (!settled) return this.resultAfterFenceMiss(attempt, recovered);
    if (settled.outcome === "manual_review") {
      const error = settled.attempt.lastError ?? "Settlement requires manual review";
      await this.publishDisabledState(settled.attempt.organizationId, error, settled.attempt.id);
      logger.info("[AutoTopUp] Attempt terminalized", {
        organizationId: settled.attempt.organizationId,
        attemptId: settled.attempt.id,
        paymentIntentId: settled.attempt.stripePaymentIntentId,
        status: settled.attempt.status,
        reason: error,
      });
      return resultFromAttempt(settled.attempt, recovered, error);
    }
    logger.info("[AutoTopUp] Credit settlement observed", {
      organizationId: settled.attempt.organizationId,
      attemptId: settled.attempt.id,
      paymentIntentId: settled.attempt.stripePaymentIntentId,
      creditTransactionId: settled.creditTransactionId,
      settlementOutcome: settled.outcome,
    });

    try {
      await Promise.all([
        CacheInvalidation.onCreditMutation(attempt.organizationId),
        invalidateOrganizationCache(attempt.organizationId),
        invalidateOrgTierCache(attempt.organizationId),
      ]);
    } catch (error) {
      // error-policy:J4 The attempt deliberately remains payment_succeeded and
      // due; recovery observes the existing PI credit and retries all caches.
      logger.error("[AutoTopUp] Credit applied but cache invalidation failed", {
        organizationId: attempt.organizationId,
        attemptId: attempt.id,
        error: safeErrorMessage(error),
      });
      return resultFromAttempt(
        settled.attempt,
        recovered,
        "Credit applied; cache synchronization will be retried",
      );
    }

    const credited = await this.repository.markCredited({
      attemptId: attempt.id,
      leaseToken,
      now: this.now(),
    });
    if (!credited) {
      return this.resultAfterFenceMiss(
        settled.attempt,
        recovered,
        "Credit applied; finalization will be retried",
      );
    }
    logger.info("[AutoTopUp] Attempt terminalized", {
      organizationId: credited.organizationId,
      attemptId: credited.id,
      paymentIntentId: credited.stripePaymentIntentId,
      status: credited.status,
    });

    const newBalance = canonicalBalanceNumber(settled.newBalance);
    const amount = centsToNumber(credited.creditAmountCents);
    if (settled.outcome === "applied") {
      const previousBalance = new Decimal(settled.newBalance)
        .minus(new Decimal(credited.creditAmountCents).div(100))
        .toNumber();
      try {
        await this.queueAutoTopUpSuccessEmail(credited, amount, previousBalance, newBalance);
      } catch (error) {
        // error-policy:J5 A committed credit must not be retried because email failed.
        logger.error("[AutoTopUp] Success email failed", {
          organizationId: credited.organizationId,
          attemptId: credited.id,
          error: safeErrorMessage(error),
        });
      }
      return {
        organizationId: credited.organizationId,
        success: true,
        amount,
        previousBalance,
        newBalance,
        attemptId: credited.id,
        status: "credited",
        recovered,
      };
    }
    return {
      organizationId: credited.organizationId,
      success: true,
      amount,
      newBalance,
      attemptId: credited.id,
      status: "credited",
      recovered,
    };
  }

  private async moveToManualReview(
    attempt: AutoTopUpAttempt,
    leaseToken: string,
    recovered: boolean,
    error: string,
    result?: Record<string, unknown>,
  ): Promise<AutoTopUpResult> {
    const reviewed = await this.repository.markManualReview({
      attemptId: attempt.id,
      leaseToken,
      error,
      result,
      now: this.now(),
    });
    if (!reviewed) return this.resultAfterFenceMiss(attempt, recovered, error);
    await this.publishDisabledState(reviewed.organizationId, error, reviewed.id);
    logger.info("[AutoTopUp] Attempt terminalized", {
      organizationId: reviewed.organizationId,
      attemptId: reviewed.id,
      status: reviewed.status,
      reason: error,
    });
    return resultFromAttempt(reviewed, recovered, error);
  }

  private async tryRejectObservedPayment(
    attempt: AutoTopUpAttempt,
    error: string,
    result?: Record<string, unknown>,
  ): Promise<AutoTopUpResult> {
    if (attempt.status === "credited" || attempt.status === "canceled") {
      return resultFromAttempt(attempt, true, error);
    }
    const leaseNow = this.now();
    const leaseToken = this.randomUUID();
    const leased = await this.repository.claimDueLease({
      attemptId: attempt.id,
      leaseToken,
      now: leaseNow,
      leaseExpiresAt: new Date(leaseNow.getTime() + AUTO_TOP_UP_LEASE_MS),
    });
    if (!leased) return this.resultAfterFenceMiss(attempt, true, error);
    return this.moveToManualReview(leased, leaseToken, true, error, result);
  }

  private async cancelAttempt(
    attempt: AutoTopUpAttempt,
    leaseToken: string,
    recovered: boolean,
    error: string,
    result?: Record<string, unknown>,
  ): Promise<AutoTopUpResult> {
    const canceled = await this.repository.markCanceled({
      attemptId: attempt.id,
      leaseToken,
      error,
      result,
      now: this.now(),
    });
    if (!canceled) return this.resultAfterFenceMiss(attempt, recovered, error);

    await this.publishDisabledState(canceled.organizationId, error, canceled.id);
    logger.info("[AutoTopUp] Attempt terminalized", {
      organizationId: canceled.organizationId,
      attemptId: canceled.id,
      status: canceled.status,
      reason: error,
    });
    return resultFromAttempt(canceled, recovered, error);
  }

  private async publishDisabledState(
    organizationId: string,
    reason: string,
    attemptId?: string,
  ): Promise<void> {
    try {
      await Promise.all([
        invalidateOrganizationCache(organizationId),
        CacheInvalidation.onOrganizationUpdated(organizationId),
      ]);
    } catch (cacheError) {
      // error-policy:J4 The database cancellation is authoritative and blocks
      // new charges even if a short-lived read cache cannot be evicted.
      logger.error("[AutoTopUp] Disabled-setting cache invalidation failed", {
        organizationId,
        attemptId,
        error: safeErrorMessage(cacheError),
      });
    }
    try {
      await this.queueAutoTopUpDisabledEmail(organizationId, reason);
    } catch (emailError) {
      // error-policy:J5 Notification failure cannot reopen a canceled charge.
      logger.error("[AutoTopUp] Disabled email failed", {
        organizationId,
        attemptId,
        error: safeErrorMessage(emailError),
      });
    }
  }

  private async queueAutoTopUpSuccessEmail(
    attempt: AutoTopUpAttempt,
    amount: number,
    previousBalance: number,
    newBalance: number,
  ): Promise<void> {
    const org = await organizationsRepository.findById(attempt.organizationId);
    if (!org) return;
    const recipientEmail = await this.getUserEmail(org.id);
    if (!recipientEmail) return;

    let paymentMethodDisplay = "Card on file";
    const paymentMethod = await this.stripe().paymentMethods.retrieve(
      attempt.stripePaymentMethodId,
    );
    if (paymentMethod.card) {
      paymentMethodDisplay = `${paymentMethod.card.brand} ••••${paymentMethod.card.last4}`;
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";
    await emailService.sendAutoTopUpSuccessEmail({
      email: recipientEmail,
      organizationName: org.name,
      amount,
      previousBalance,
      newBalance,
      paymentMethod: paymentMethodDisplay,
      invoiceUrl: `${appUrl}/cloud/invoices/${attempt.stripePaymentIntentId}`,
      billingUrl: `${appUrl}/cloud/settings`,
    });
  }

  private async queueAutoTopUpDisabledEmail(organizationId: string, reason: string): Promise<void> {
    const org = await organizationsRepository.findById(organizationId);
    if (!org) return;
    const recipientEmail = await this.getUserEmail(org.id);
    if (!recipientEmail) return;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";
    await emailService.sendAutoTopUpDisabledEmail({
      email: recipientEmail,
      organizationName: org.name,
      reason,
      currentBalance: parseAutoTopUpNumber("credit_balance", org.credit_balance),
      settingsUrl: `${appUrl}/cloud/settings`,
    });
  }

  private async getUserEmail(organizationId: string): Promise<string | null> {
    const users = await usersRepository.listByOrganization(organizationId);
    return users.find((user) => user.email)?.email ?? null;
  }

  async getSettings(organizationId: string): Promise<{
    enabled: boolean;
    amount: number | null;
    threshold: number | null;
    hasPaymentMethod: boolean;
  }> {
    const organization = await organizationsRepository.findById(organizationId);
    if (!organization) {
      throw new Error("Organization not found");
    }

    return {
      enabled: organization.auto_top_up_enabled === true,
      amount: parseAutoTopUpNumberForSettingsRead(
        "auto_top_up_amount",
        organization.auto_top_up_amount,
      ),
      threshold: parseAutoTopUpNumberForSettingsRead(
        "auto_top_up_threshold",
        organization.auto_top_up_threshold,
      ),
      hasPaymentMethod: Boolean(organization.stripe_default_payment_method),
    };
  }

  async updateSettings(
    organizationId: string,
    settings: {
      enabled?: boolean;
      amount?: number;
      threshold?: number;
    },
  ): Promise<void> {
    const organization = await organizationsRepository.findById(organizationId);
    if (!organization) {
      throw new Error("Organization not found");
    }

    if (settings.enabled === true && !organization.stripe_default_payment_method) {
      throw new Error(
        "Cannot enable auto top-up without a default payment method. Please add a payment method first.",
      );
    }
    if (settings.enabled === true) {
      const [blockingAttempt, blockingLegacyPayment] = await Promise.all([
        autoTopUpAttemptsRepository.findBlockingByOrganization(organizationId),
        autoTopUpAttemptsRepository.findBlockingLegacyPaymentByOrganization(organizationId),
      ]);
      if (blockingAttempt || blockingLegacyPayment) {
        throw new Error(
          "Cannot enable auto top-up while an earlier card payment requires reconciliation.",
        );
      }
    }
    const mustValidateAmounts =
      settings.enabled === true ||
      settings.amount !== undefined ||
      settings.threshold !== undefined;
    if (mustValidateAmounts) {
      const persistedAmount = parseAutoTopUpNumberForSettingsRead(
        "auto_top_up_amount",
        organization.auto_top_up_amount,
      );
      const persistedThreshold = parseAutoTopUpNumberForSettingsRead(
        "auto_top_up_threshold",
        organization.auto_top_up_threshold,
      );
      if (
        (persistedAmount === null && settings.amount === undefined) ||
        (persistedThreshold === null && settings.threshold === undefined)
      ) {
        throw new AutoTopUpSettingsValidationError(
          "Valid auto top-up values are required to replace corrupt settings.",
        );
      }
      const amount = settings.amount ?? persistedAmount;
      const threshold = settings.threshold ?? persistedThreshold;
      if (amount === null || threshold === null) {
        throw new AutoTopUpSettingsValidationError(
          "Valid auto top-up values are required to replace corrupt settings.",
        );
      }
      this.validateSettings(amount, threshold);
    }

    const updates: Partial<Organization> = { updated_at: new Date() };
    if (settings.enabled !== undefined) updates.auto_top_up_enabled = settings.enabled;
    if (settings.amount !== undefined) updates.auto_top_up_amount = settings.amount.toFixed(2);
    if (settings.threshold !== undefined) {
      updates.auto_top_up_threshold = settings.threshold.toFixed(2);
    }
    if (
      settings.enabled === true &&
      settings.threshold === undefined &&
      (organization.auto_top_up_threshold === null ||
        organization.auto_top_up_threshold === undefined)
    ) {
      // Settings reads preserve the historical SQL NULL -> 0 contract. Persist
      // that normalized value when enabling so durable discovery and the locked
      // claim observe the same threshold instead of treating NULL as invalid.
      updates.auto_top_up_threshold = "0.00";
    }

    await organizationsRepository.update(organizationId, updates);
    await Promise.all([
      invalidateOrganizationCache(organizationId),
      CacheInvalidation.onOrganizationUpdated(organizationId),
    ]);
    logger.info("[AutoTopUp] Updated settings", {
      organizationId,
      enabled: settings.enabled,
      amount: settings.amount,
      threshold: settings.threshold,
    });
  }
}

export const autoTopUpService = new AutoTopUpService();
