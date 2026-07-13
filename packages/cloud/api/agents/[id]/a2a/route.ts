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
import { streamText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { UserCharacter } from "@/db/repositories/characters";
import { safeUnknownErrorMessage } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
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
import { getLanguageModel } from "@/lib/providers/language-model";
import { agentMonetizationService } from "@/lib/services/agent-monetization";
import { charactersService } from "@/lib/services/characters/characters";
import type { CreditReservation } from "@/lib/services/credits";
import {
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const A2A_TEXT_OUTPUT_TOKENS = 500;

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  id: z.union([z.string(), z.number()]),
});

const ProviderUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

const A2AChatParamsSchema = z.object({
  model: z.string().trim().min(1).default("gpt-5-mini"),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
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

  const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
  const agentCard = generateAgentCard(character, baseUrl);

  return c.json(agentCard, 200, {
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
  });
});

app.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const character = await charactersService.getById(id);
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

  const body = await c.req.json();
  const validation = JsonRpcRequestSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      },
      400,
    );
  }

  const { method, params, id: rpcId } = validation.data;

  let user: Awaited<ReturnType<typeof requireUserOrApiKeyWithOrg>>;
  try {
    user = await requireUserOrApiKeyWithOrg(c);
  } catch {
    // error-policy:J1 the public JSON-RPC boundary translates authentication
    // failures without exposing session or API-key internals.
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32002, message: "Authentication required" },
        id: rpcId,
      },
      401,
    );
  }

  if (method === "chat") {
    return handleChat(c, character, params ?? {}, rpcId, user);
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
  rpcId: string | number,
  authUser: { id: string; organization_id: string },
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
  const maxOutputTokens =
    A2A_TEXT_OUTPUT_TOKENS + (effectiveThinkingBudget ?? 0);
  const baseCost = await estimateRequestCost(
    model,
    fullMessages,
    maxOutputTokens,
  );

  const markupPct = Number(character.inference_markup_percentage || 0);
  const { totalCredits: totalCost } = calculateCreditMarkup({
    baseCredits: baseCost,
    markupPercent: character.monetization_enabled ? markupPct : 0,
  });

  let reservation: CreditReservation;
  try {
    reservation = await creditsService.reserve({
      organizationId: authUser.organization_id,
      amount: totalCost,
      userId: authUser.id,
      description: `Agent: ${character.name} (${model})`,
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
    const result = await streamText({
      model: getLanguageModel(model),
      messages: fullMessages,
      // Cap the provider at the exact ceiling billing reserved above, so final
      // usage cannot outrun the admitted reservation (#16147). Omitting it let
      // the provider bill more output than was priced upfront.
      maxOutputTokens,
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

    const reconciliation = await reservation.reconcile(actualTotal);
    if (reconciliation?.adjustmentType === "uncollected_overage") {
      logger.error("[Agent A2A] Final usage overage was not collected", {
        agentId: character.id,
        ownerId: character.user_id,
        consumerOrgId: authUser.organization_id,
        reserved: reconciliation.reservedAmount,
        actual: reconciliation.actualCost,
      });
      return c.json({
        jsonrpc: "2.0",
        error: {
          code: -32003,
          message: "Insufficient credits for final usage cost",
        },
        id: rpcId,
      });
    }

    let creatorEarningsWarning:
      | { code: "CREATOR_EARNINGS_UNAVAILABLE"; message: string }
      | undefined;
    if (character.monetization_enabled && actualCreatorMarkup > 0) {
      // Earnings recording is a NON-CRITICAL post-settlement step. The consumer
      // was already settled above (reconcile(actualTotal)); if this throws it
      // must NOT propagate to the outer catch, whose reconcile(0) is
      // non-idempotent and would refund the WHOLE reservation a second time →
      // free inference + a net credit grant. Log and swallow.
      try {
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
      } catch (earningsError) {
        // error-policy:J4 inference is already purchased and settled, so the
        // response degrades explicitly with a machine-readable warning while
        // the structured error log raises the accounting failure to operators.
        logger.error(
          "[Agent A2A] Failed to record creator earnings (settlement already applied — not rolling back)",
          {
            agentId: character.id,
            ownerId: character.user_id,
            error:
              earningsError instanceof Error
                ? earningsError.message
                : String(earningsError),
          },
        );
        creatorEarningsWarning = {
          code: "CREATOR_EARNINGS_UNAVAILABLE",
          message: "Creator earnings could not be recorded",
        };
      }
    }

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
        ...(creatorEarningsWarning
          ? { warnings: [creatorEarningsWarning] }
          : {}),
      },
      id: rpcId,
    });
  } catch (error) {
    // error-policy:J1 the JSON-RPC boundary refunds a failed generation and
    // returns a redacted structured failure instead of partial model output.
    await reservation.reconcile(0);
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
