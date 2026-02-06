/**
 * AI Billing Service
 *
 * Centralized billing utilities for AI SDK usage.
 * Uses real-time usage data from Vercel AI Gateway responses.
 *
 * Rules:
 * - Always use AI SDK (streamText, generateText) - never call providers directly
 * - Get actual token counts from SDK `usage` object
 * - Apply 20% platform markup via calculateCost()
 * - Support streaming and non-streaming responses
 */

import {
  calculateCost,
  getProviderFromModel,
  normalizeModelName,
  estimateTokens,
  PLATFORM_MARKUP_MULTIPLIER,
} from "@/lib/pricing";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { generationsService } from "@/lib/services/generations";
import { logger } from "@/lib/utils/logger";

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
}

export interface BillingContext {
  organizationId: string;
  userId: string;
  apiKeyId?: string | null;
  model: string;
  provider?: string;
  description?: string;
}

export interface BillingResult {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Includes 20% platform markup */
  markupApplied: boolean;
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
      if (m.content && typeof m.content === "object")
        return JSON.stringify(m.content);
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
  const { inputCost, outputCost, totalCost } = await calculateCost(
    normalizedModel,
    provider,
    inputTokens,
    outputTokens,
  );

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
    inputTokens,
    outputTokens,
    totalTokens,
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
  } = {},
): Promise<void> {
  const {
    type = "chat",
    isSuccessful = true,
    errorMessage,
    content,
    prompt,
  } = options;
  const provider = context.provider ?? getProviderFromModel(context.model);

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
      is_successful: isSuccessful,
      error_message: errorMessage,
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
        },
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

export { InsufficientCreditsError };
export { PLATFORM_MARKUP_MULTIPLIER };
