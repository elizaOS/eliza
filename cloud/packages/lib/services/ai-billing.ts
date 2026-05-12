/**
 * AI Billing Service
 *
 * Centralized billing utilities for AI SDK usage.
 * Uses real-time usage data from OpenRouter responses.
 *
 * Rules:
 * - Always use AI SDK (streamText, generateText) - never call providers directly
 * - Get actual token counts from SDK `usage` object
 * - Apply 20% platform markup via calculateCost()
 * - Support streaming and non-streaming responses
 */

import { affiliatesRepository } from "@/db/repositories/affiliates";
import {
  calculateCost,
  estimateTokens,
  getProviderFromModel,
  normalizeModelName,
  PLATFORM_MARKUP_MULTIPLIER,
} from "@/lib/pricing";
import {
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import type { PricingBillingSource } from "./ai-pricing-definitions";

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
} {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  // AI SDK v4+ uses inputTokens/outputTokens
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

  return { inputTokens, outputTokens, totalTokens };
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
): Promise<CreditReservation> {
  const provider = context.provider ?? getProviderFromModel(context.model);
  const normalizedModel = normalizeModelName(context.model);

  return await creditsService.reserve({
    organizationId: context.organizationId,
    model: normalizedModel,
    provider,
    billingSource: context.billingSource,
    estimatedInputTokens,
    estimatedOutputTokens,
    userId: context.userId,
    description: context.description ?? `AI request: ${context.model}`,
  });
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
  const { inputTokens, outputTokens, totalTokens } = normalizeUsage(usage);
  const provider = context.provider ?? getProviderFromModel(context.model);
  const normalizedModel = normalizeModelName(context.model);

  // Calculate cost with 20% platform markup (built into calculateCost)
  let { inputCost, outputCost, totalCost } = await calculateCost(
    normalizedModel,
    provider,
    inputTokens,
    outputTokens,
    context.billingSource,
  );
  let baseInputCost = inputCost / PLATFORM_MARKUP_MULTIPLIER;
  let baseOutputCost = outputCost / PLATFORM_MARKUP_MULTIPLIER;
  let baseTotalCost = totalCost / PLATFORM_MARKUP_MULTIPLIER;
  let platformMarkup = totalCost - baseTotalCost;

  // Apply affiliate markup if present
  let _appliedAffiliateMarkup = false;
  if (context.affiliateCode) {
    const affiliate = await affiliatesRepository.getAffiliateCodeByCode(context.affiliateCode);
    if (affiliate && affiliate.is_active) {
      const markupPercent = Number(affiliate.markup_percent) / 100;

      // Calculate affiliate markup based on total cost (after platform markup)
      const affiliateMarkupBaseCost = totalCost;
      const affiliateEarnings = affiliateMarkupBaseCost * markupPercent;

      // Update total costs charged to the user
      inputCost += inputCost * markupPercent;
      outputCost += outputCost * markupPercent;
      totalCost += affiliateEarnings;
      _appliedAffiliateMarkup = true;

      // Credit the affiliate owner
      if (affiliateEarnings > 0) {
        // Prevent double booking on identical reservations easily,
        // using the transaction ID or random ID if none present.
        const sourceId = `legacy_${crypto.randomUUID()}`;

        await redeemableEarningsService
          .addEarnings({
            userId: affiliate.user_id,
            amount: affiliateEarnings,
            source: "affiliate",
            sourceId,
            description: `Affiliate markup earnings from model: ${context.model}`,
            metadata: {
              appId: null, // this isn't from a specific miniapp, but from an affiliate SKU
              model: context.model,
              tokens: totalTokens,
            },
            dedupeBySourceId: true,
          })
          .catch((err) => {
            logger.error("[AI Billing] Failed to add affiliate earnings", {
              error: err instanceof Error ? err.message : String(err),
              affiliateId: affiliate.id,
              amount: affiliateEarnings,
            });
          });
      }
    }
  }

  // Reconcile reservation (refund excess or charge overage)
  if (reservation) {
    await reservation.reconcile(totalCost);
    logger.info("[AI Billing] Credits reconciled", {
      model: context.model,
      reserved: reservation.reservedAmount,
      actual: totalCost,
      inputTokens,
      outputTokens,
    });
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
  const provider = context.provider ?? getProviderFromModel(context.model);

  if (context.affiliateCode) {
    const affiliate = await affiliatesRepository.getAffiliateCodeByCode(context.affiliateCode);
    if (affiliate && affiliate.is_active) {
      const markupPercent = Number(affiliate.markup_percent) / 100;
      const affiliateEarnings = totalCost * markupPercent;
      totalCost += affiliateEarnings;
      inputCost = totalCost;

      if (affiliateEarnings > 0) {
        const sourceId = `legacy_${crypto.randomUUID()}`;

        await redeemableEarningsService
          .addEarnings({
            userId: affiliate.user_id,
            amount: affiliateEarnings,
            source: "affiliate",
            sourceId,
            description: `Affiliate markup earnings from model: ${context.model}`,
            metadata: {
              appId: null,
              model: context.model,
              provider,
              flatOperation: true,
            },
            dedupeBySourceId: true,
          })
          .catch((err) => {
            logger.error("[AI Billing] Failed to add flat-operation affiliate earnings", {
              error: err instanceof Error ? err.message : String(err),
              affiliateId: affiliate.id,
              amount: affiliateEarnings,
            });
          });
      }
    }
  }

  if (reservation) {
    await reservation.reconcile(totalCost);
    logger.info("[AI Billing] Flat credits reconciled", {
      model: context.model,
      reserved: reservation.reservedAmount,
      actual: totalCost,
    });
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
): Promise<void> {
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
  } catch (error) {
    logger.error("[AI Billing] Failed to record usage analytics", {
      error: error instanceof Error ? error.message : String(error),
    });
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
