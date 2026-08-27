/**
 * /api/agents/:id/a2a — Per-agent A2A endpoint.
 *
 * GET → returns the A2A Agent Card (cached 1h).
 * POST → JSON-RPC dispatch (`chat`, `getAgentInfo`). Bills the caller's org;
 * if `monetization_enabled`, credits the creator's redeemable earnings.
 *
 * Per the realtime audit: A2A is JSON-RPC sync, not streaming — chat collects
 * the full text before responding rather than streaming back.
 */

import { calculateCreditMarkup } from "@elizaos/cloud-shared/billing";
import { assertModelOutputComplete } from "@elizaos/core/edge";
import { streamText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import {
  getGenerativeExecutionContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { UntrustedA2AChatMessagesSchema } from "@/lib/api/a2a/chat-messages";
import {
  A2AJsonRpcRequestSchema,
  type JsonRpcId,
  jsonRpcIdFromUnknown,
} from "@/lib/api/a2a/request-validation";
import {
  ApiError,
  safeUnknownErrorMessage,
} from "@/lib/api/cloud-worker-errors";
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS } from "@/lib/cors-constants";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  calculateCost,
  estimateRequestCost,
  getProviderFromModel,
} from "@/lib/pricing";
import {
  type AnthropicCotEnv,
  mergeAnthropicCotProviderOptions,
  parseThinkingBudgetFromCharacterSettings,
  resolveAnthropicThinkingBudgetTokens,
} from "@/lib/providers/anthropic-thinking";
import {
  getLanguageModel,
  resolveAiProviderSource,
} from "@/lib/providers/language-model";
import { agentMonetizationService } from "@/lib/services/agent-monetization";
import {
  charactersService,
  type UserCharacter,
} from "@/lib/services/characters/characters";
import { InsufficientCreditsError } from "@/lib/services/credits";
import type { InferenceAdmissionSnapshot } from "@/lib/services/inference-auth-cache";
import { admitOrganizationInference } from "@/lib/services/organization-inference-admission";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const A2A_BILLING_OUTPUT_ESTIMATE_TOKENS = 500;

const ProviderUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

const A2AChatParamsSchema = z.object({
  model: z.string().trim().min(1).default("gpt-5-mini"),
  // The public caller is an input principal, never a policy author. This shared
  // DTO is also consumed by the platform A2A chat-completion skill, preventing
  // either production ingress from accepting unsigned `system` policy.
  messages: UntrustedA2AChatMessagesSchema,
});

export function generateAgentCard(character: UserCharacter, baseUrl: string) {
  const bioText = Array.isArray(character.bio)
    ? character.bio.join("\n")
    : character.bio;
  const markupPct = Number(character.inference_markup_percentage || 0);
  const hasMonetization = character.monetization_enabled && markupPct > 0;

  return {
    name: character.name,
    description: bioText,
    image: character.avatar_url || `${baseUrl}/default-avatar.png`,
    version: "1.0.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: [
        {
          scheme: "bearer",
          description: "API Key authentication via Authorization header",
        },
      ],
    },
    skills: [
      {
        id: "chat",
        name: "Chat",
        description: `Chat with ${character.name}`,
        pricing: {
          type: "token-based" as const,
          inputCostPer1k: 0.005,
          outputCostPer1k: 0.015,
          ...(hasMonetization && { markupPercentage: markupPct }),
        },
      },
      {
        id: "generate_image",
        name: "Image Generation",
        description: `Generate images as ${character.name}`,
        pricing: {
          type: "fixed" as const,
          amount: 0.05,
          ...(hasMonetization && { markupPercentage: markupPct }),
        },
      },
    ],
    pricing: {
      currency: "USD",
      paymentMethods: ["api_key_credits"],
      minimumPayment: 0.001,
    },
    // SECURITY: this card is served UNAUTHENTICATED (public /api/agents prefix)
    // with CORS *. Do NOT expose the creator's internal user_id/organization_id
    // here (deanonymization/correlation of which org owns which agents). The MCP
    // card omits these too — keep parity.
  };
}

const app = new Hono<AppEnv>();

function getAnthropicCotEnv(env: AppEnv["Bindings"]): AnthropicCotEnv {
  return {
    ANTHROPIC_COT_BUDGET:
      typeof env.ANTHROPIC_COT_BUDGET === "string"
        ? env.ANTHROPIC_COT_BUDGET
        : undefined,
    ANTHROPIC_COT_BUDGET_MAX:
      typeof env.ANTHROPIC_COT_BUDGET_MAX === "string"
        ? env.ANTHROPIC_COT_BUDGET_MAX
        : undefined,
  };
}

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const character = await charactersService.getById(id);
  if (!character) return c.json({ error: "Agent not found" }, 404);
  if (!character.is_public)
    return c.json({ error: "Agent is not public" }, 403);
  if (!character.a2a_enabled) {
    return c.json({ error: "A2A not enabled for this agent" }, 403);
  }

  const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";
  const agentCard = generateAgentCard(character, baseUrl);

  return c.json(agentCard, 200, {
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
  });
});

app.post("/", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const executionCtx = getGenerativeExecutionContext(c);
  const characterResolution = executionCtx
    ? await charactersService.getByIdCacheOnly(id, { executionCtx })
    : {
        kind: "ready" as const,
        character: (await charactersService.getById(id)) ?? null,
      };
  if (characterResolution.kind !== "ready") {
    // A cache-only miss cannot distinguish a real agent from an unknown id.
    // Confirm only the negative case authoritatively; an existing cold agent
    // still gets the retryable response and never joins Postgres to dispatch.
    if (!(await charactersService.getById(id))) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Agent not found" },
          id: null,
        },
        404,
      );
    }
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32004,
          message: "Agent cache is warming; retry shortly",
        },
        id: null,
      },
      503,
    );
  }
  const character = characterResolution.character;
  if (!character) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Agent not found" },
        id: null,
      },
      404,
    );
  }
  if (!character.is_public || !character.a2a_enabled) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Agent not accessible" },
        id: null,
      },
      403,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // error-policy:J1 the JSON-RPC transport boundary distinguishes invalid
    // JSON syntax from a syntactically valid but malformed request envelope.
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      },
      400,
    );
  }
  const validation = A2AJsonRpcRequestSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request" },
        id: jsonRpcIdFromUnknown(body),
      },
      400,
    );
  }

  const { method, params, id: rpcId } = validation.data;

  let caller: Awaited<ReturnType<typeof requireGenerativeRouteCaller>>;
  try {
    caller = await requireGenerativeRouteCaller(c, {
      compatibility: "hono",
      rateLimitEndpoint: "standard",
    });
  } catch (error) {
    // error-policy:J1 the public JSON-RPC boundary preserves retryable
    // admission failures while translating credential failures without
    // exposing session or API-key internals.
    if (error instanceof ApiError && error.status === 429) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32005, message: "Rate limit exceeded" },
          id: rpcId,
        },
        429,
      );
    }
    if (error instanceof ApiError && error.status === 503) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32004,
            message: "Authorization cache unavailable; retry shortly",
          },
          id: rpcId,
        },
        503,
      );
    }
    if (
      !(error instanceof ApiError) ||
      (error.status !== 401 && error.status !== 403)
    ) {
      throw error;
    }
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32002, message: "Authentication required" },
        id: rpcId,
      },
      error.status,
    );
  }

  if (method === "chat") {
    return handleChat(c, character, params ?? {}, rpcId, {
      id: caller.user.id,
      organization_id: caller.user.organization_id,
      apiKeyId: caller.apiKeyId,
      admissionSnapshot: caller.admissionSnapshot,
      executionCtx,
    });
  }

  if (method === "getAgentInfo") {
    return c.json({
      jsonrpc: "2.0",
      result: {
        name: character.name,
        bio: character.bio,
        category: character.category,
        tags: character.tags,
        monetizationEnabled: character.monetization_enabled,
        markupPercentage: character.inference_markup_percentage,
      },
      id: rpcId,
    });
  }

  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found" },
      id: rpcId,
    },
    400,
  );
});

async function handleChat(
  c: AppContext,
  character: {
    id: string;
    name: string;
    user_id: string;
    organization_id: string;
    monetization_enabled: boolean;
    inference_markup_percentage: string | null;
    system: string | null;
    bio: string | string[];
    settings: Record<string, unknown>;
  },
  params: Record<string, unknown>,
  rpcId: JsonRpcId,
  authUser: {
    id: string;
    organization_id: string;
    apiKeyId: string | null;
    admissionSnapshot?: InferenceAdmissionSnapshot;
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  },
): Promise<Response> {
  const parsedParams = A2AChatParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32602, message: "valid messages are required" },
        id: rpcId,
      },
      400,
    );
  }
  const { model, messages } = parsedParams.data;

  const bioText = Array.isArray(character.bio)
    ? character.bio.join("\n")
    : character.bio;
  const systemPrompt =
    character.system || `You are ${character.name}. ${bioText}`;

  const fullMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages,
  ];

  const provider = getProviderFromModel(model);
  const agentThinkingBudget = parseThinkingBudgetFromCharacterSettings(
    character.settings,
  );
  const envForThinking = getAnthropicCotEnv(c.env);
  const effectiveThinkingBudget = resolveAnthropicThinkingBudgetTokens(
    model,
    envForThinking,
    agentThinkingBudget,
  );
  const estimatedOutputTokens =
    A2A_BILLING_OUTPUT_ESTIMATE_TOKENS + (effectiveThinkingBudget ?? 0);
  const baseCost = await estimateRequestCost(
    model,
    fullMessages,
    estimatedOutputTokens,
  );

  const markupPct = Number(character.inference_markup_percentage || 0);
  const { totalCredits: totalCost } = calculateCreditMarkup({
    baseCredits: baseCost,
    markupPercent: character.monetization_enabled ? markupPct : 0,
  });

  const requestId = `agent-a2a:${character.id}:${crypto.randomUUID()}`;
  let admission: Awaited<ReturnType<typeof admitOrganizationInference>>;
  try {
    admission = await admitOrganizationInference({
      context: {
        organizationId: authUser.organization_id,
        userId: authUser.id,
        apiKeyId: authUser.apiKeyId,
        model,
        provider,
        billingSource: resolveAiProviderSource(model) ?? "gateway",
        requestId,
        description: `Agent: ${character.name} (${model})`,
      },
      apiKeyId: authUser.apiKeyId,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      flatCost: {
        baseTotalCost: baseCost,
        platformMarkup: totalCost - baseCost,
        totalCost,
      },
      executionCtx: authUser.executionCtx,
      admissionSnapshot: authUser.admissionSnapshot,
    });
  } catch (error) {
    // error-policy:J1 the route boundary translates the expected credit
    // refusal and lets unexpected reservation failures reach the owner path.
    if (error instanceof InsufficientCreditsError) {
      return c.json({
        jsonrpc: "2.0",
        error: {
          code: -32003,
          message: `Insufficient credits. Required: $${error.required.toFixed(4)}`,
        },
        id: rpcId,
      });
    }
    throw error;
  }

  try {
    await admission.markProviderDispatched?.();
    const result = await streamText({
      model: getLanguageModel(model),
      messages: fullMessages,
      ...mergeAnthropicCotProviderOptions(
        model,
        envForThinking,
        effectiveThinkingBudget ?? undefined,
      ),
    });

    let fullText = "";
    for await (const delta of result.textStream) {
      fullText += delta;
    }
    assertModelOutputComplete({
      finishReason: await result.finishReason,
      provider,
      model,
    });

    const usage = ProviderUsageSchema.parse(await result.usage);
    const { totalCost: actualBaseCost } = await calculateCost(
      model,
      provider,
      usage.inputTokens,
      usage.outputTokens,
    );
    const { markupCredits: actualCreatorMarkup, totalCredits: actualTotal } =
      calculateCreditMarkup({
        baseCredits: actualBaseCost,
        markupPercent: character.monetization_enabled ? markupPct : 0,
      });

    const settlementTask = (async () => {
      const reconciliation = await admission.settle(actualTotal);
      if (reconciliation?.adjustmentType === "uncollected_overage") {
        logger.error("[Agent A2A] Final usage overage was not collected", {
          agentId: character.id,
          ownerId: character.user_id,
          consumerOrgId: authUser.organization_id,
          reserved: reconciliation.reservedAmount,
          actual: reconciliation.actualCost,
        });
        return;
      }
      if (character.monetization_enabled && actualCreatorMarkup > 0) {
        await agentMonetizationService.recordCreatorEarnings({
          agentId: character.id,
          agentName: character.name,
          ownerId: character.user_id,
          earnings: actualCreatorMarkup,
          consumerOrgId: authUser.organization_id,
          model,
          tokens: usage.totalTokens,
          protocol: "a2a",
        });
        logger.info(
          "[Agent A2A] Creator earnings credited to redeemable balance",
          {
            agentId: character.id,
            ownerId: character.user_id,
            earnings: actualCreatorMarkup,
          },
        );
      }
    })().catch((settlementError) => {
      // error-policy:J7 the response is already complete; durable admission
      // recovery retains the lease while operators receive the accounting error.
      logger.error("[Agent A2A] Deferred settlement failed", {
        agentId: character.id,
        error:
          settlementError instanceof Error
            ? settlementError.message
            : String(settlementError),
      });
    });
    if (authUser.executionCtx) authUser.executionCtx.waitUntil(settlementTask);
    else await settlementTask;

    return c.json({
      jsonrpc: "2.0",
      result: {
        content: fullText,
        model,
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
        },
        cost: {
          base: actualBaseCost,
          markup: actualCreatorMarkup,
          total: actualTotal,
        },
      },
      id: rpcId,
    });
  } catch (error) {
    // error-policy:J1 the JSON-RPC boundary refunds a failed generation and
    // returns a redacted structured failure instead of partial model output.
    const release = admission.settle(0);
    if (authUser.executionCtx) authUser.executionCtx.waitUntil(release);
    else await release;
    logger.error("[Agent A2A] Error generating response", {
      error: error instanceof Error ? error.message : "Unknown error",
      agentId: character.id,
    });
    return c.json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        // Redact infra/DB/5xx internals from the A2A caller (full error is
        // logged above); deliberate 4xx messages still pass through.
        message: safeUnknownErrorMessage(error),
      },
      id: rpcId,
    });
  }
}

app.options("/", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
  }),
);

export default app;
