// app/api/v1/embeddings/route.ts
/**
 * OpenAI-compatible embeddings endpoint.
 *
 * Uses Vercel AI SDK with AI Gateway for embedding generation.
 * Real-time usage data from SDK responses for accurate billing.
 * Includes 20% platform markup on all costs.
 *
 * IMPORTANT: Do NOT call provider APIs directly. Always use AI SDK.
 */

import { embed, embedMany } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { usageService } from "@/lib/services/usage";
import {
  reserveCredits,
  billUsage,
  InsufficientCreditsError,
} from "@/lib/services/ai-billing";
import { creditsService } from "@/lib/services/credits";
import {
  estimateTokens,
  getProviderFromModel,
  normalizeModelName,
} from "@/lib/pricing";
import { logger } from "@/lib/utils/logger";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import type { NextRequest } from "next/server";

export const maxDuration = 60;

interface EmbeddingsRequest {
  input: string | string[];
  model: string;
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

/**
 * POST /api/v1/embeddings
 * OpenAI-compatible embeddings endpoint.
 * Generates vector embeddings for text input with credit deduction.
 */
async function handlePOST(req: NextRequest) {
  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(req);
    const request: EmbeddingsRequest = await req.json();

    // Validate input
    if (!request.model || !request.input) {
      return Response.json(
        {
          error: {
            message: "Missing required fields: model and input",
            type: "invalid_request_error",
            param: !request.model ? "model" : "input",
            code: "missing_required_parameter",
          },
        },
        { status: 400 },
      );
    }

    // Validate input is not empty
    if (Array.isArray(request.input) && request.input.length === 0) {
      return Response.json(
        {
          error: {
            message: "input array cannot be empty",
            type: "invalid_request_error",
            param: "input",
            code: "invalid_value",
          },
        },
        { status: 400 },
      );
    }

    if (
      typeof request.input === "string" &&
      request.input.trim().length === 0
    ) {
      return Response.json(
        {
          error: {
            message: "input string cannot be empty",
            type: "invalid_request_error",
            param: "input",
            code: "invalid_value",
          },
        },
        { status: 400 },
      );
    }

    const model = request.model;
    const provider = getProviderFromModel(model);
    const normalizedModel = normalizeModelName(model);

    // Estimate tokens for reservation
    const inputText = Array.isArray(request.input)
      ? request.input.join(" ")
      : request.input;
    const estimatedInputTokens = estimateTokens(inputText);

    // Reserve credits BEFORE making API call
    let reservation;
    try {
      reservation = await reserveCredits(
        {
          organizationId: user.organization_id!,
          userId: user.id,
          model,
          provider,
        },
        estimatedInputTokens,
        0, // embeddings don't have output tokens
      );
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return Response.json(
          {
            error: {
              message: `Insufficient credits. Required: $${error.required.toFixed(4)}`,
              type: "insufficient_quota",
              code: "insufficient_balance",
            },
          },
          { status: 402 },
        );
      }
      throw error;
    }

    logger.info("[Embeddings] Request", {
      model,
      inputCount: Array.isArray(request.input) ? request.input.length : 1,
      estimatedTokens: estimatedInputTokens,
    });

    // Generate embeddings using AI SDK
    let embeddings: number[][];
    let actualTokens = 0;

    if (Array.isArray(request.input)) {
      // Multiple inputs - use embedMany
      const result = await embedMany({
        model: gateway.textEmbeddingModel(model),
        values: request.input,
      });
      embeddings = result.embeddings;
      // AI SDK embedMany returns usage per embedding
      actualTokens = result.usage?.tokens || estimatedInputTokens;
    } else {
      // Single input - use embed
      const result = await embed({
        model: gateway.textEmbeddingModel(model),
        value: request.input,
      });
      embeddings = [result.embedding];
      actualTokens = result.usage?.tokens || estimatedInputTokens;
    }

    // Bill using actual usage from SDK response
    const billing = await billUsage(
      {
        organizationId: user.organization_id!,
        userId: user.id,
        apiKeyId: apiKey?.id,
        model,
        provider,
      },
      { inputTokens: actualTokens, outputTokens: 0 },
      reservation,
    );

    logger.info("[Embeddings] Complete", {
      model,
      actualTokens,
      totalCost: billing.totalCost,
    });

    // Record usage (non-blocking)
    usageService
      .create({
        organization_id: user.organization_id!,
        user_id: user.id,
        api_key_id: apiKey?.id || null,
        type: "embeddings",
        model: normalizedModel,
        provider,
        input_tokens: actualTokens,
        output_tokens: 0,
        input_cost: String(billing.inputCost),
        output_cost: String(0),
        is_successful: true,
      })
      .catch((err) => {
        logger.error("[Embeddings] Failed to record usage", {
          error: err.message,
        });
      });

    // Return OpenAI-compatible response
    return Response.json({
      object: "list",
      data: embeddings.map((embedding, index) => ({
        object: "embedding",
        embedding,
        index,
      })),
      model,
      usage: {
        prompt_tokens: actualTokens,
        total_tokens: actualTokens,
      },
    });
  } catch (error) {
    logger.error("[Embeddings] Error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        error: {
          message:
            error instanceof Error ? error.message : "Internal server error",
          type: "api_error",
        },
      },
      { status: 500 },
    );
  }
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.STANDARD);
