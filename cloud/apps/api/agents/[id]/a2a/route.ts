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

import { gateway } from "@ai-sdk/gateway";
import { streamText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { UserCharacter } from "@/db/repositories/characters";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS } from "@/lib/cors-constants";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { calculateCost, estimateRequestCost, getProviderFromModel } from "@/lib/pricing";
import {
  type AnthropicCotEnv,
  mergeAnthropicCotProviderOptions,
  parseThinkingBudgetFromCharacterSettings,
  resolveAnthropicThinkingBudgetTokens,
} from "@/lib/providers/anthropic-thinking";
import { agentMonetizationService } from "@/lib/services/agent-monetization";
import { charactersService } from "@/lib/services/characters/characters";
import type { CreditReservation } from "@/lib/services/credits";
import { creditsService, InsufficientCreditsError } from "@/lib/services/credits";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  id: z.union([z.string(), z.number()]),
});

function generateAgentCard(character: UserCharacter, baseUrl: string) {
  const bioText = Array.isArray(character.bio) ? character.bio.join("\n") : character.bio;
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
    contact: {
      creatorId: character.user_id,
      organizationId: character.organization_id,
    },
  };
}

const app = new Hono<AppEnv>();

function getAnthropicCotEnv(env: AppEnv["Bindings"]): AnthropicCotEnv {
  return {
    ANTHROPIC_COT_BUDGET:
      typeof env.ANTHROPIC_COT_BUDGET === "string" ? env.ANTHROPIC_COT_BUDGET : undefined,
    ANTHROPIC_COT_BUDGET_MAX:
      typeof env.ANTHROPIC_COT_BUDGET_MAX === "string" ? env.ANTHROPIC_COT_BUDGET_MAX : undefined,
  };
}

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing id" }, 400);

  const character = await charactersService.getById(id);
  if (!character) return c.json({ error: "Agent not found" }, 404);
  if (!character.is_public) return c.json({ error: "Agent is not public" }, 403);
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
  const { model = "gpt-5-mini", messages } = params as {
    model?: string;
    messages: Array<{ role: string; content: string }>;
  };

  if (!messages?.length) {
    return c.json({
      jsonrpc: "2.0",
      error: { code: -32602, message: "messages required" },
      id: rpcId,
    });
  }

  const bioText = Array.isArray(character.bio) ? character.bio.join("\n") : character.bio;
  const systemPrompt = character.system || `You are ${character.name}. ${bioText}`;

  const fullMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    })),
  ];

  const provider = getProviderFromModel(model);
  const agentThinkingBudget = parseThinkingBudgetFromCharacterSettings(character.settings);
  const envForThinking = getAnthropicCotEnv(c.env);
  const effectiveThinkingBudget = resolveAnthropicThinkingBudgetTokens(
    model,
    envForThinking,
    agentThinkingBudget,
  );
  const maxOutputTokens =
    effectiveThinkingBudget != null ? 500 + effectiveThinkingBudget : undefined;
  const baseCost = await estimateRequestCost(model, fullMessages, maxOutputTokens);

  const markupPct = Number(character.inference_markup_percentage || 0);
  const creatorMarkup = character.monetization_enabled ? baseCost * (markupPct / 100) : 0;
  const totalCost = baseCost + creatorMarkup;

  let reservation: CreditReservation;
  try {
    reservation = await creditsService.reserve({
      organizationId: authUser.organization_id,
      amount: totalCost,
      userId: authUser.id,
      description: `Agent: ${character.name} (${model})`,
    });
  } catch (error) {
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
      model: gateway.languageModel(model),
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

    const usage = await result.usage;
    const { totalCost: actualBaseCost } = await calculateCost(
      model,
      provider,
      usage?.inputTokens || 0,
      usage?.outputTokens || 0,
    );
    const actualCreatorMarkup = character.monetization_enabled
      ? actualBaseCost * (markupPct / 100)
      : 0;
    const actualTotal = actualBaseCost + actualCreatorMarkup;

    if (character.monetization_enabled && actualCreatorMarkup > 0) {
      await agentMonetizationService.recordCreatorEarnings({
        agentId: character.id,
        agentName: character.name,
        ownerId: character.user_id,
        earnings: actualCreatorMarkup,
        consumerOrgId: authUser.organization_id,
        model,
        tokens: usage?.totalTokens,
        protocol: "a2a",
      });
      logger.info("[Agent A2A] Creator earnings credited to redeemable balance", {
        agentId: character.id,
        ownerId: character.user_id,
        earnings: actualCreatorMarkup,
      });
    }

    await reservation.reconcile(actualTotal);

    return c.json({
      jsonrpc: "2.0",
      result: {
        content: fullText,
        model,
        usage: {
          prompt_tokens: usage?.inputTokens || 0,
          completion_tokens: usage?.outputTokens || 0,
          total_tokens: usage?.totalTokens || 0,
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
    await reservation.reconcile(0);
    logger.error("[Agent A2A] Error generating response", {
      error: error instanceof Error ? error.message : "Unknown error",
      agentId: character.id,
    });
    return c.json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Internal error",
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
