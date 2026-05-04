/**
 * POST /api/v1/embeddings
 *
 * OpenAI-compatible embeddings endpoint. Routes through the AI SDK + AI
 * Gateway with credit reservation/bill-and-record on the SDK's reported
 * usage.
 */

import { APICallError, embed, embedMany, RetryError } from "ai";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { enforceOrgRateLimit } from "@/lib/middleware/rate-limit";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { estimateTokens, getProviderFromModel, normalizeModelName } from "@/lib/pricing";
import {
  getAiProviderConfigurationError,
  getTextEmbeddingModel,
  hasTextEmbeddingProviderConfigured,
  resolveEmbeddingProviderSource,
} from "@/lib/providers/language-model";
import { billUsage, InsufficientCreditsError, reserveCredits } from "@/lib/services/ai-billing";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

interface EmbeddingsRequest {
  input: string | string[];
  model: string;
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

async function getRequestApiKeyId(c: AppContext): Promise<{ id: string } | null> {
  const apiKeyHeader = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const auth = c.req.header("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const elizaBearer = bearer && bearer.startsWith("eliza_") ? bearer : null;
  const apiKey = apiKeyHeader || elizaBearer;
  if (!apiKey) return null;
  const { apiKeysService } = await import("@/lib/services/api-keys");
  const validated = await apiKeysService.validateApiKey(apiKey);
  return validated ? { id: validated.id } : null;
}

const app = new Hono<AppEnv>();

// Embeddings use RELAXED to match chat completions and responses — embeddings
// are typically issued in batches for RAG ingestion.
app.use("*", rateLimit(RateLimitPresets.RELAXED));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const apiKey = await getRequestApiKeyId(c);

    if (user.organization_id) {
      const orgRateLimited = await enforceOrgRateLimit(user.organization_id, "embeddings");
      if (orgRateLimited) return orgRateLimited;
    }

    const request = (await c.req.json()) as EmbeddingsRequest;

    if (!request.model || !request.input) {
      return c.json(
        {
          error: {
            message: "Missing required fields: model and input",
            type: "invalid_request_error",
            param: !request.model ? "model" : "input",
            code: "missing_required_parameter",
          },
        },
        400,
      );
    }

    if (Array.isArray(request.input) && request.input.length === 0) {
      return c.json(
        {
          error: {
            message: "input array cannot be empty",
            type: "invalid_request_error",
            param: "input",
            code: "invalid_value",
          },
        },
        400,
      );
    }

    if (typeof request.input === "string" && request.input.trim().length === 0) {
      return c.json(
        {
          error: {
            message: "input string cannot be empty",
            type: "invalid_request_error",
            param: "input",
            code: "invalid_value",
          },
        },
        400,
      );
    }

    const model = request.model;
    const provider = getProviderFromModel(model);
    const normalizedModel = normalizeModelName(model);
    const billingSource = resolveEmbeddingProviderSource() ?? undefined;

    if (!hasTextEmbeddingProviderConfigured()) {
      return c.json(
        {
          error: {
            message: getAiProviderConfigurationError(),
            type: "service_unavailable",
            code: "ai_not_configured",
          },
        },
        503,
      );
    }

    const inputText = Array.isArray(request.input) ? request.input.join(" ") : request.input;
    const estimatedInputTokens = estimateTokens(inputText);

    let reservation;
    try {
      reservation = await reserveCredits(
        {
          organizationId: user.organization_id,
          userId: user.id,
          model,
          provider,
          billingSource,
        },
        estimatedInputTokens,
        0,
      );
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return c.json(
          {
            error: {
              message: `Insufficient credits. Required: $${error.required.toFixed(4)}`,
              type: "insufficient_quota",
              code: "insufficient_balance",
            },
          },
          402,
        );
      }
      throw error;
    }

    logger.info("[Embeddings] Request", {
      model,
      inputCount: Array.isArray(request.input) ? request.input.length : 1,
      estimatedTokens: estimatedInputTokens,
    });

    let embeddings: number[][];
    let actualTokens = 0;

    if (Array.isArray(request.input)) {
      const result = await embedMany({
        model: getTextEmbeddingModel(model),
        values: request.input,
      });
      embeddings = result.embeddings;
      actualTokens = result.usage?.tokens || estimatedInputTokens;
    } else {
      const result = await embed({
        model: getTextEmbeddingModel(model),
        value: request.input,
      });
      embeddings = [result.embedding];
      actualTokens = result.usage?.tokens || estimatedInputTokens;
    }

    const billing = await billUsage(
      {
        organizationId: user.organization_id,
        userId: user.id,
        apiKeyId: apiKey?.id,
        model,
        provider,
        billingSource,
      },
      { inputTokens: actualTokens, outputTokens: 0 },
      reservation,
    );

    logger.info("[Embeddings] Complete", {
      model,
      actualTokens,
      totalCost: billing.totalCost,
    });

    void usageService
      .create({
        organization_id: user.organization_id,
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
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return c.json({
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

    // Upstream provider failures (invalid provider key, provider 5xx) must not
    // surface as 401/403 to the caller — the user authenticated to us fine.
    const providerError = RetryError.isInstance(error) ? error.lastError : error;
    if (APICallError.isInstance(providerError)) {
      const status =
        providerError.statusCode === 429 ? 429 : providerError.statusCode === 402 ? 402 : 503;
      return c.json(
        {
          error: {
            message: providerError.message || "Upstream provider error",
            type: status === 429 ? "rate_limit_error" : "service_unavailable",
            code: status === 429 ? "rate_limit_exceeded" : "provider_error",
          },
        },
        status,
      );
    }

    return failureResponse(c, error);
  }
});

export default app;
