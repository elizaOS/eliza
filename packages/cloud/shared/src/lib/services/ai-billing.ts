/**
 * AI Billing Service
 *
 * Centralized billing utilities for AI SDK usage.
 * Uses real-time usage data from BitRouter responses.
 *
 * Rules:
 * - Always use AI SDK (streamText, generateText) - never call providers directly
 * - Get actual token counts from SDK `usage` object
 * - Apply 20% platform markup via calculateCost()
 * - Support streaming and non-streaming responses
 */

import Decimal from "decimal.js";
import { affiliatesRepository } from "../../db/repositories/affiliates";
import { subscriptionEntitlementsRepository } from "../../db/repositories/subscription-entitlements";
import type { UsageRecord } from "../../db/repositories/usage-records";
import {
  calculateCost,
  estimateTokens,
  getProviderFromModel,
  normalizeModelName,
  PLATFORM_MARKUP_MULTIPLIER,
} from "../pricing";
import { logger } from "../utils/logger";
import {
  type AffiliateBillingAttribution,
  isAffiliateBillingAttribution,
} from "./affiliate-billing-attribution";
import { AFFILIATE_PAYOUT_CONTRACT_VERSION } from "./affiliate-payout-outbox";
import type { PricingBillingSource } from "./ai-pricing-definitions";
import {
  COST_BUFFER,
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
  MIN_RESERVATION,
  RESERVATION_SWEEP_GRACE_MS,
} from "./credits";
import { generationsService } from "./generations";
import { subscriptionFundingService } from "./subscription-funding";
import { usageService } from "./usage";

// ============================================================================
// Types
// ============================================================================

export interface AIUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  // AI SDK v4+ format
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface BillingContext {
  organizationId: string;
  userId: string;
  apiKeyId?: string | null;
  model: string;
  provider?: string;
  billingSource?: PricingBillingSource;
  requestId?: string | null;
  providerRequestId?: string | null;
  providerInstanceId?: string | null;
  providerEndpoint?: string | null;
  pricingSnapshotId?: string | null;
  metadata?: Record<string, unknown>;
  description?: string;
  affiliateCode?: string | null;
  /**
   * Immutable affiliate policy captured from cache before provider dispatch.
   * Explicit null means the admission decision found no billable affiliate.
   */
  affiliateAttribution?: AffiliateBillingAttribution | null;
}

export interface BillingResult {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  baseInputCost: number;
  baseOutputCost: number;
  baseTotalCost: number;
  platformMarkup: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Includes 20% platform markup */
  markupApplied: boolean;
}

export interface FlatBillingCost {
  totalCost: number;
  baseTotalCost: number;
  platformMarkup: number;
}

interface SubscriptionFundingSelection {
  /** Admission already resolved subscriber authority and can avoid a duplicate read. */
  subscriptionFunded?: boolean;
}

/** Paid-plan organizations must use allowance-aware inference funding. */
export async function isSubscriptionFundedOrganization(organizationId: string): Promise<boolean> {
  if (organizationId === "anonymous") return false;
  const entitlement = await subscriptionEntitlementsRepository.find(organizationId);
  return entitlement !== undefined && entitlement.plan_key !== "free";
}

function inferenceFundingLogicalOperationId(
  context: BillingContext,
  logicalOperationKey?: string,
): string {
  const requestId = logicalOperationKey || context.requestId || crypto.randomUUID();
  return `inference-gate:${requestId}`;
}

function canonicalFundingAmount(value: number): string {
  const amount = new Decimal(value).toDecimalPlaces(6);
  if (!amount.isFinite() || amount.isNegative()) {
    throw new Error("AI billing funding amount must be finite and non-negative");
  }
  return amount.toFixed(6);
}

async function reserveSubscriptionFunding(params: {
  context: BillingContext;
  reservedAmount: number;
  affiliate: BillableAffiliate | null;
  affiliatePayoutSourceId: string | null;
  metadata?: Record<string, unknown>;
  logicalOperationKey?: string;
}): Promise<CreditReservation> {
  const { context, affiliate, affiliatePayoutSourceId } = params;
  const logicalOperationId = inferenceFundingLogicalOperationId(
    context,
    params.logicalOperationKey,
  );
  const reserveResult = await subscriptionFundingService.reserve({
    organizationId: context.organizationId,
    logicalOperationId,
    operation: "ai_inference",
    amount: canonicalFundingAmount(params.reservedAmount),
    description: context.description ?? `AI request: ${context.model}`,
    reservationTtlMs: RESERVATION_SWEEP_GRACE_MS,
    metadata: {
      ...(params.metadata ?? {}),
      ...(context.requestId && { requestId: context.requestId }),
      userId: context.userId,
      model: normalizeModelName(context.model),
      provider: context.provider ?? getProviderFromModel(context.model),
      billingSource: context.billingSource ?? null,
    },
  });
  const reservedAmount = Number(reserveResult.reservation.requested_amount);
  const settlementOccurredAt = reserveResult.reservation.created_at;
  return {
    reservedAmount,
    reservationTransactionId: reserveResult.reservation.id,
    affiliateAttribution: affiliate?.attribution ?? null,
    affiliatePayoutSourceId,
    reconcile: async (actualCost) => {
      const canonicalActual = canonicalFundingAmount(actualCost);
      const settlement = await subscriptionFundingService.settle({
        organizationId: context.organizationId,
        logicalOperationId,
        operation: "ai_inference",
        actualAmount: canonicalActual,
        occurredAt: settlementOccurredAt,
        metadata: params.metadata,
      });
      const actual = Number(canonicalActual);
      const collected = Number(settlement.collectedAmount);
      const uncollectedOverage = Number(settlement.uncollectedOverageAmount);
      return {
        reservedAmount,
        actualCost,
        collectedAmount: collected,
        reservationTransactionId: reserveResult.reservation.id,
        settlementTransactionIds: [settlement.reservation.id],
        adjustmentType:
          uncollectedOverage > 0
            ? "uncollected_overage"
            : actual < reservedAmount
              ? "refund"
              : "none",
      };
    },
  };
}

export function getAffiliatePayoutSourceId(context: BillingContext): string {
  const requestId = context.requestId?.trim();
  if (requestId) {
    return `ai_billing:affiliate:${requestId}`;
  }
  return `ai_billing:affiliate:${crypto.randomUUID()}`;
}

interface BillableAffiliate {
  attribution: AffiliateBillingAttribution;
  markupPercent: number;
}

function affiliatePayoutMetadata(
  context: BillingContext,
  affiliate: BillableAffiliate | null,
  sourceId: string | null,
): Record<string, unknown> | undefined {
  const metadata = context.metadata ?? {};
  if (!affiliate || !sourceId) {
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }
  return {
    ...metadata,
    affiliatePayout: {
      version: AFFILIATE_PAYOUT_CONTRACT_VERSION,
      sourceId,
      attribution: affiliate.attribution,
      model: context.model,
    },
  };
}

export class AffiliateBillingAttributionError extends Error {
  constructor(message: string) {
    super(`Invalid affiliate billing attribution: ${message}`);
    this.name = "AffiliateBillingAttributionError";
  }
}

function validatePinnedAffiliate(
  context: BillingContext,
  attribution: AffiliateBillingAttribution,
): BillableAffiliate {
  if (!isAffiliateBillingAttribution(attribution)) {
    throw new AffiliateBillingAttributionError("required fields are malformed");
  }
  if (context.organizationId === "anonymous") {
    throw new AffiliateBillingAttributionError("anonymous work cannot carry a cashable payout");
  }
  if (attribution.affiliateUserId === context.userId) {
    throw new AffiliateBillingAttributionError("self-referral reached the billing contract");
  }
  return { attribution, markupPercent: attribution.markupPercent };
}

async function resolveBillableAffiliate(
  context: BillingContext,
): Promise<BillableAffiliate | null> {
  if (Object.hasOwn(context, "affiliateAttribution")) {
    return context.affiliateAttribution
      ? validatePinnedAffiliate(context, context.affiliateAttribution)
      : null;
  }
  if (!context.affiliateCode || context.organizationId === "anonymous") return null;
  const affiliate = await affiliatesRepository.getAffiliateCodeByCode(context.affiliateCode);
  if (!affiliate?.is_active) return null;
  if (affiliate.user_id === context.userId) return null;
  const markupPercent = Number(affiliate.markup_percent) / 100;
  if (!Number.isFinite(markupPercent) || markupPercent <= 0) return null;
  return validatePinnedAffiliate(context, {
    affiliateCodeId: affiliate.id,
    affiliateUserId: affiliate.user_id,
    affiliateCode: context.affiliateCode,
    markupPercent,
  });
}

function collectedTotalCost(
  totalCost: number,
  reservation: CreditReservation | undefined,
  reconciliation: CreditReconciliationResult | void | undefined,
): number {
  if (!reservation || !reconciliation) return totalCost;
  if (reconciliation.adjustmentType === "uncollected_overage") {
    return Math.min(totalCost, reconciliation.reservedAmount);
  }
  return totalCost;
}

function collectedAffiliateEarnings(params: {
  nominalEarnings: number;
  preAffiliateTotalCost: number;
  totalCost: number;
  reservation?: CreditReservation;
  reconciliation?: CreditReconciliationResult | void;
}): number {
  const collected = collectedTotalCost(params.totalCost, params.reservation, params.reconciliation);
  const collectedMarkup = Math.max(0, collected - params.preAffiliateTotalCost);
  return Math.min(params.nominalEarnings, collectedMarkup);
}

function isRedeemableAffiliateAmount(amount: number): boolean {
  const decimal = new Decimal(amount);
  if (!decimal.isFinite() || decimal.isNegative()) {
    throw new AffiliateBillingAttributionError("computed payout amount is malformed");
  }
  return decimal.toDecimalPlaces(4).gt(0);
}

export class AffiliateBillingReservationRequiredError extends Error {
  constructor() {
    super("Affiliate billing requires a payout-aware credit reservation");
    this.name = "AffiliateBillingReservationRequiredError";
  }
}

function contextWithReservationAffiliate(
  context: BillingContext,
  reservation: CreditReservation | undefined,
): BillingContext {
  if (reservation && Object.hasOwn(reservation, "affiliateAttribution")) {
    return {
      ...context,
      affiliateAttribution: reservation.affiliateAttribution ?? null,
    };
  }
  return context;
}

function requireAffiliatePayoutSource(
  affiliate: BillableAffiliate,
  reservation: CreditReservation | undefined,
): string {
  const sourceId = reservation?.affiliatePayoutSourceId?.trim();
  const pinned = reservation?.affiliateAttribution;
  if (
    !sourceId ||
    !pinned ||
    pinned.affiliateCodeId !== affiliate.attribution.affiliateCodeId ||
    pinned.affiliateUserId !== affiliate.attribution.affiliateUserId ||
    pinned.affiliateCode !== affiliate.attribution.affiliateCode ||
    pinned.markupPercent !== affiliate.attribution.markupPercent
  ) {
    throw new AffiliateBillingReservationRequiredError();
  }
  return sourceId;
}

// ============================================================================
// Usage Normalization
// ============================================================================

/**
 * Normalize usage data from different AI SDK versions and providers.
 * Handles both old format (promptTokens/completionTokens) and new format (inputTokens/outputTokens).
 */
export function normalizeUsage(usage: AIUsage | undefined | null): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
} {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
  }

  // AI SDK v4+ uses inputTokens/outputTokens
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? usage.cacheCreationInputTokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
  };
}

function billableInputTokensForProvider(
  provider: string,
  inputTokens: number,
  cacheReadInputTokens: number,
  cacheWriteInputTokens: number,
): number {
  if (provider === "cerebras") {
    return Math.max(0, inputTokens - cacheReadInputTokens - cacheWriteInputTokens);
  }

  return inputTokens;
}

// ============================================================================
// Pre-request Credit Reservation
// ============================================================================

/**
 * Reserve credits before making an AI request.
 * Uses estimated tokens with safety buffer.
 *
 * @param context - Billing context (org, user, model)
 * @param estimatedInputTokens - Estimated input token count
 * @param estimatedOutputTokens - Estimated output token count (default 500)
 * @returns Credit reservation that must be reconciled after request
 */
export async function reserveCredits(
  context: BillingContext,
  estimatedInputTokens: number,
  estimatedOutputTokens: number = 500,
  selection?: SubscriptionFundingSelection,
): Promise<CreditReservation> {
  const provider = context.provider ?? getProviderFromModel(context.model);
  const normalizedModel = normalizeModelName(context.model);
  const affiliate = await resolveBillableAffiliate(context);
  const affiliatePayoutSourceId = affiliate ? getAffiliatePayoutSourceId(context) : null;
  const metadata = affiliatePayoutMetadata(context, affiliate, affiliatePayoutSourceId);
  const subscriptionFunded =
    selection?.subscriptionFunded ??
    (await isSubscriptionFundedOrganization(context.organizationId));
  if (subscriptionFunded) {
    const { totalCost } = await calculateCost(
      normalizedModel,
      provider,
      estimatedInputTokens,
      estimatedOutputTokens,
      context.billingSource,
    );
    const affiliateMultiplier = affiliate ? 1 + affiliate.markupPercent : 1;
    const reservedAmount = Math.max(totalCost * affiliateMultiplier * COST_BUFFER, MIN_RESERVATION);
    return await reserveSubscriptionFunding({
      context,
      reservedAmount,
      affiliate,
      affiliatePayoutSourceId,
      metadata,
    });
  }
  const reservation = await creditsService.reserve({
    organizationId: context.organizationId,
    model: normalizedModel,
    provider,
    billingSource: context.billingSource,
    estimatedInputTokens,
    estimatedOutputTokens,
    ...(affiliate && { estimatedCostMultiplier: 1 + affiliate.markupPercent }),
    metadata: {
      ...(metadata ?? {}),
      ...(context.requestId && { requestId: context.requestId }),
    },
    ...(context.requestId && {
      idempotencyKey: `inference-gate:${context.requestId}`,
    }),
    userId: context.userId,
    description: context.description ?? `AI request: ${context.model}`,
  });
  return {
    ...reservation,
    affiliateAttribution: affiliate?.attribution ?? null,
    affiliatePayoutSourceId,
  };
}

/**
 * Reserve a provider-priced flat operation with the same pinned affiliate
 * contract used by token-priced inference. The fixed amount is pre-affiliate.
 */
export async function reserveFlatUsageCredits(
  context: BillingContext,
  cost: FlatBillingCost,
  options?: { idempotencyKey?: string; subscriptionFunded?: boolean },
): Promise<CreditReservation> {
  const preAffiliateCost = new Decimal(cost.totalCost);
  if (!preAffiliateCost.isFinite() || !preAffiliateCost.gt(0)) {
    throw new Error("Flat billing reservation cost must be positive and finite");
  }
  const affiliate = await resolveBillableAffiliate(context);
  const affiliatePayoutSourceId = affiliate ? getAffiliatePayoutSourceId(context) : null;
  const reservedAmount = preAffiliateCost
    .times(affiliate ? new Decimal(affiliate.markupPercent).plus(1) : 1)
    .toNumber();
  const metadata = affiliatePayoutMetadata(context, affiliate, affiliatePayoutSourceId);
  const subscriptionFunded =
    options?.subscriptionFunded ?? (await isSubscriptionFundedOrganization(context.organizationId));
  if (subscriptionFunded) {
    return await reserveSubscriptionFunding({
      context,
      reservedAmount,
      affiliate,
      affiliatePayoutSourceId,
      metadata,
      logicalOperationKey: options?.idempotencyKey,
    });
  }
  const reservation = await creditsService.reserve({
    organizationId: context.organizationId,
    userId: context.userId,
    description: context.description ?? `AI request: ${context.model}`,
    amount: reservedAmount,
    model: normalizeModelName(context.model),
    provider: context.provider ?? getProviderFromModel(context.model),
    billingSource: context.billingSource,
    ...(metadata && { metadata }),
    ...(options?.idempotencyKey && { idempotencyKey: options.idempotencyKey }),
  });
  return {
    ...reservation,
    affiliateAttribution: affiliate?.attribution ?? null,
    affiliatePayoutSourceId,
  };
}

/**
 * Estimate input tokens from message content.
 * Uses ~4 chars per token approximation.
 */
export function estimateInputTokens(
  messages: Array<{ content?: string | object; role?: string }>,
): number {
  const messageText = messages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (m.content && typeof m.content === "object") return JSON.stringify(m.content);
      return "";
    })
    .join(" ");

  return estimateTokens(messageText);
}

// ============================================================================
// Post-request Billing
// ============================================================================

/**
 * Calculate and record billing after AI request completes.
 * Uses actual usage data from AI SDK response.
 * Applies 20% platform markup.
 *
 * @param context - Billing context
 * @param usage - Actual usage from AI SDK response
 * @param reservation - Credit reservation to reconcile
 * @returns Billing result with costs
 */
export async function billUsage(
  context: BillingContext,
  usage: AIUsage | undefined | null,
  reservation?: CreditReservation,
): Promise<BillingResult> {
  const { inputTokens, outputTokens, totalTokens, cacheReadInputTokens, cacheWriteInputTokens } =
    normalizeUsage(usage);
  const provider = context.provider ?? getProviderFromModel(context.model);
  const normalizedModel = normalizeModelName(context.model);
  const billableInputTokens = billableInputTokensForProvider(
    provider,
    inputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
  );

  // Calculate cost with 20% platform markup (built into calculateCost)
  let { inputCost, outputCost, totalCost } = await calculateCost(
    normalizedModel,
    provider,
    billableInputTokens,
    outputTokens,
    context.billingSource,
  );
  let baseInputCost = inputCost / PLATFORM_MARKUP_MULTIPLIER;
  let baseOutputCost = outputCost / PLATFORM_MARKUP_MULTIPLIER;
  let baseTotalCost = totalCost / PLATFORM_MARKUP_MULTIPLIER;
  let platformMarkup = totalCost - baseTotalCost;

  const preAffiliateTotalCost = totalCost;
  const affiliate = await resolveBillableAffiliate(
    contextWithReservationAffiliate(context, reservation),
  );
  const affiliateMarkupPercent = affiliate?.markupPercent ?? 0;
  const affiliateEarnings = preAffiliateTotalCost * affiliateMarkupPercent;

  if (affiliateEarnings > 0) {
    inputCost += inputCost * affiliateMarkupPercent;
    outputCost += outputCost * affiliateMarkupPercent;
    totalCost += affiliateEarnings;
  }

  // Reconcile reservation (refund excess or charge overage) before crediting any
  // cashable affiliate earnings, so uncollectable overage cannot mint payouts.
  let reconciliation: CreditReconciliationResult | void | undefined;
  if (reservation) {
    reconciliation = await reservation.reconcile(totalCost);
    logger.info("[AI Billing] Credits reconciled", {
      model: context.model,
      reserved: reservation.reservedAmount,
      actual: totalCost,
      inputTokens,
      billableInputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
      outputTokens,
    });
  }

  if (affiliate && affiliateEarnings > 0) {
    const payableEarnings = collectedAffiliateEarnings({
      nominalEarnings: affiliateEarnings,
      preAffiliateTotalCost,
      totalCost,
      reservation,
      reconciliation,
    });

    if (isRedeemableAffiliateAmount(payableEarnings)) {
      requireAffiliatePayoutSource(affiliate, reservation);
    }
  }

  return {
    inputCost,
    outputCost,
    totalCost,
    baseInputCost,
    baseOutputCost,
    baseTotalCost,
    platformMarkup,
    inputTokens,
    outputTokens,
    totalTokens,
    markupApplied: true,
  };
}

export async function billFlatUsage(
  context: BillingContext,
  cost: FlatBillingCost,
  reservation?: CreditReservation,
): Promise<BillingResult> {
  let totalCost = cost.totalCost;
  const baseTotalCost = cost.baseTotalCost;
  const platformMarkup = cost.platformMarkup;
  let inputCost = totalCost;
  const outputCost = 0;
  const preAffiliateTotalCost = totalCost;
  const affiliate = await resolveBillableAffiliate(
    contextWithReservationAffiliate(context, reservation),
  );
  const affiliateEarnings = affiliate ? preAffiliateTotalCost * affiliate.markupPercent : 0;

  if (affiliateEarnings > 0) {
    totalCost += affiliateEarnings;
    inputCost = totalCost;
  }

  let reconciliation: CreditReconciliationResult | void | undefined;
  if (reservation) {
    reconciliation = await reservation.reconcile(totalCost);
    logger.info("[AI Billing] Flat credits reconciled", {
      model: context.model,
      reserved: reservation.reservedAmount,
      actual: totalCost,
    });
  }

  if (affiliate && affiliateEarnings > 0) {
    const payableEarnings = collectedAffiliateEarnings({
      nominalEarnings: affiliateEarnings,
      preAffiliateTotalCost,
      totalCost,
      reservation,
      reconciliation,
    });

    if (isRedeemableAffiliateAmount(payableEarnings)) {
      requireAffiliatePayoutSource(affiliate, reservation);
    }
  }

  return {
    inputCost,
    outputCost,
    totalCost,
    baseInputCost: baseTotalCost,
    baseOutputCost: 0,
    baseTotalCost,
    platformMarkup,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    markupApplied: true,
  };
}

/**
 * Record usage analytics (non-blocking).
 * Called after billing to track usage metrics.
 */
export async function recordUsageAnalytics(
  context: BillingContext,
  billing: BillingResult,
  options: {
    type?: "chat" | "embeddings" | "image" | "video" | "tts" | "stt";
    isSuccessful?: boolean;
    errorMessage?: string;
    content?: string;
    prompt?: string;
    /** System prompt for trajectory logging */
    systemPrompt?: string;
    /** Purpose/step for trajectory logging (e.g., "should_respond", "planner") */
    purpose?: string;
    /** Latency in ms for trajectory logging */
    latencyMs?: number;
  } = {},
): Promise<UsageRecord | null> {
  const { type = "chat", isSuccessful = true, errorMessage, content, prompt } = options;
  const provider = context.provider ?? getProviderFromModel(context.model);
  const reconciliationMetadata = {
    ...(context.metadata ?? {}),
    billingSource: context.billingSource ?? null,
    providerRequestId: context.providerRequestId ?? null,
    providerInstanceId: context.providerInstanceId ?? null,
    providerEndpoint: context.providerEndpoint ?? null,
    pricingSnapshotId: context.pricingSnapshotId ?? null,
    baseInputCost: billing.baseInputCost,
    baseOutputCost: billing.baseOutputCost,
    baseTotalCost: billing.baseTotalCost,
  };

  try {
    const usageRecord = await usageService.create({
      organization_id: context.organizationId,
      user_id: context.userId,
      api_key_id: context.apiKeyId || null,
      type,
      model: normalizeModelName(context.model),
      provider,
      input_tokens: billing.inputTokens,
      output_tokens: billing.outputTokens,
      input_cost: String(billing.inputCost),
      output_cost: String(billing.outputCost),
      markup: String(billing.platformMarkup),
      request_id: context.requestId ?? context.providerRequestId ?? null,
      is_successful: isSuccessful,
      error_message: errorMessage,
      metadata: reconciliationMetadata,
    });

    // Create generation record if API key is used
    if (context.apiKeyId && content !== undefined) {
      await generationsService.create({
        organization_id: context.organizationId,
        user_id: context.userId,
        api_key_id: context.apiKeyId,
        type,
        model: normalizeModelName(context.model),
        provider,
        prompt: prompt || "",
        status: isSuccessful ? "completed" : "failed",
        content,
        tokens: billing.totalTokens,
        cost: String(billing.totalCost),
        credits: String(billing.totalCost),
        usage_record_id: usageRecord.id,
        completed_at: new Date(),
        error: errorMessage,
        result: {
          inputTokens: billing.inputTokens,
          outputTokens: billing.outputTokens,
          totalTokens: billing.totalTokens,
          billingSource: context.billingSource ?? null,
          baseTotalCost: billing.baseTotalCost,
          platformMarkup: billing.platformMarkup,
        },
      });
    }

    // Log LLM call trajectory for training data collection
    try {
      const { llmTrajectoryService } = await import("./llm-trajectory");
      await llmTrajectoryService.logCall({
        organizationId: context.organizationId,
        userId: context.userId,
        apiKeyId: context.apiKeyId,
        model: normalizeModelName(context.model),
        provider,
        purpose: options.purpose ?? type,
        systemPrompt: options.systemPrompt,
        userPrompt: prompt,
        responseText: content,
        inputTokens: billing.inputTokens,
        outputTokens: billing.outputTokens,
        inputCost: billing.inputCost,
        outputCost: billing.outputCost,
        latencyMs: options.latencyMs,
        isSuccessful,
        errorMessage,
      });
    } catch (trajError) {
      // Trajectory logging is non-critical — never block the request
      logger.warn("[AI Billing] Failed to log trajectory", {
        error: trajError instanceof Error ? trajError.message : String(trajError),
      });
    }
    return usageRecord;
  } catch (error) {
    logger.error("[AI Billing] Failed to record usage analytics", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ============================================================================
// Streaming Helpers
// ============================================================================

/**
 * Create an onFinish callback for AI SDK streamText.
 * Handles billing, reconciliation, and analytics.
 */
export function createOnFinishHandler(
  context: BillingContext,
  reservation: CreditReservation,
  options: {
    prompt?: string;
    onComplete?: (billing: BillingResult) => void | Promise<void>;
  } = {},
) {
  return async ({ text, usage }: { text: string; usage?: AIUsage }) => {
    try {
      const billing = await billUsage(context, usage, reservation);

      await recordUsageAnalytics(context, billing, {
        type: "chat",
        isSuccessful: true,
        content: text,
        prompt: options.prompt,
      });

      if (options.onComplete) {
        await options.onComplete(billing);
      }
    } catch (error) {
      logger.error("[AI Billing] onFinish error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

// ============================================================================
// Export convenience functions
// ============================================================================

export { InsufficientCreditsError, PLATFORM_MARKUP_MULTIPLIER };
