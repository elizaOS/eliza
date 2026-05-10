/**
 * /api/agents/:id/mcp — Per-agent MCP (Model Context Protocol) endpoint.
 *
 * GET → MCP server metadata + tool catalog.
 * POST → JSON-RPC dispatch (`initialize`, `tools/list`, `tools/call`, `ping`).
 *
 * The `chat` tool reserves credits, calls the model via the configured
 * provider (OpenRouter), then reconciles. Returns plain JSON, not SSE.
 */

import { gateway } from "@ai-sdk/gateway";
import { streamText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS } from "@/lib/cors-constants";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { calculateCost, estimateTokens, getProviderFromModel } from "@/lib/pricing";
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

const DEFAULT_MIN_OUTPUT_TOKENS = 4096;

const MCPRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  id: z.union([z.string(), z.number()]),
});

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
  if (!character.is_public || !character.mcp_enabled) {
    return c.json({ error: "MCP not accessible for this agent" }, 403);
  }

  const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
  const bioText = Array.isArray(character.bio) ? character.bio.join("\n") : character.bio;
  const markupPct = Number(character.inference_markup_percentage || 0);

  return c.json({
    name: character.name,
    description: bioText,
    version: "1.0.0",
    protocol: "2024-11-05",
    capabilities: { tools: {}, resources: {}, prompts: {} },
    pricing: character.monetization_enabled
      ? {
          type: "credits",
          markupPercentage: markupPct,
          description: `Base inference cost + ${markupPct}% creator markup`,
        }
      : { type: "credits", description: "Standard inference costs" },
    endpoints: {
      mcp: `${baseUrl}/api/agents/${id}/mcp`,
      a2a: `${baseUrl}/api/agents/${id}/a2a`,
    },
    tools: [
      {
        name: "chat",
        description: `Send a message to ${character.name} and get a response`,
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "The message to send" },
            model: {
              type: "string",
              description: "Model to use (default: gpt-5-mini)",
              enum: ["gpt-5-mini", "gpt-4o", "claude-sonnet-4-6"],
            },
          },
          required: ["message"],
        },
      },
      {
        name: "get_info",
        description: `Get information about ${character.name}`,
        inputSchema: { type: "object", properties: {} },
      },
    ],
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
  if (!character.is_public || !character.mcp_enabled) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32001, message: "MCP not accessible" },
        id: null,
      },
      403,
    );
  }

  const body = await c.req.json();
  const validation = MCPRequestSchema.safeParse(body);
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

  switch (method) {
    case "initialize":
      return c.json({
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: character.name, version: "1.0.0" },
          capabilities: { tools: {} },
        },
        id: rpcId,
      });

    case "tools/list":
      return c.json({
        jsonrpc: "2.0",
        result: {
          tools: [
            {
              name: "chat",
              description: `Send a message to ${character.name}`,
              inputSchema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  model: { type: "string" },
                },
                required: ["message"],
              },
            },
            {
              name: "get_info",
              description: `Get information about ${character.name}`,
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
        id: rpcId,
      });

    case "tools/call":
      return handleToolCall(c, character, params ?? {}, rpcId, user);

    case "ping":
      return c.json({ jsonrpc: "2.0", result: {}, id: rpcId });

    default:
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32601, message: "Method not found" },
          id: rpcId,
        },
        400,
      );
  }
});

async function handleToolCall(
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
  const { name, arguments: args } = params as {
    name: string;
    arguments: Record<string, unknown>;
  };

  if (name === "get_info") {
    const bioText = Array.isArray(character.bio) ? character.bio.join("\n") : character.bio;
    return c.json({
      jsonrpc: "2.0",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              name: character.name,
              bio: bioText,
              monetization: character.monetization_enabled,
              markup: character.inference_markup_percentage,
            }),
          },
        ],
      },
      id: rpcId,
    });
  }

  if (name === "chat") {
    const { message, model = "gpt-5-mini" } = args as {
      message: string;
      model?: string;
    };
    if (!message) {
      return c.json({
        jsonrpc: "2.0",
        error: { code: -32602, message: "message required" },
        id: rpcId,
      });
    }

    const bioText = Array.isArray(character.bio) ? character.bio.join("\n") : character.bio;
    const systemPrompt = character.system || `You are ${character.name}. ${bioText}`;
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: message },
    ];

    const provider = getProviderFromModel(model);
    const markupPct = Number(character.inference_markup_percentage || 0);
    const envForThinking = getAnthropicCotEnv(c.env);
    const agentThinkingBudget = parseThinkingBudgetFromCharacterSettings(character.settings);
    const effectiveThinkingBudget = resolveAnthropicThinkingBudgetTokens(
      model,
      envForThinking,
      agentThinkingBudget,
    );
    const baseOutputTokens = DEFAULT_MIN_OUTPUT_TOKENS;
    const estimatedOutputTokens =
      effectiveThinkingBudget != null
        ? baseOutputTokens + effectiveThinkingBudget
        : baseOutputTokens;

    let reservation: CreditReservation;
    try {
      reservation = await creditsService.reserve({
        organizationId: authUser.organization_id,
        model,
        provider,
        estimatedInputTokens: estimateTokens(systemPrompt + message),
        estimatedOutputTokens,
        userId: authUser.id,
        description: `Agent MCP: ${character.name}`,
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

    const maxOutputTokens = effectiveThinkingBudget
      ? Math.max(DEFAULT_MIN_OUTPUT_TOKENS, effectiveThinkingBudget) + DEFAULT_MIN_OUTPUT_TOKENS
      : undefined;

    try {
      const result = await streamText({
        model: gateway.languageModel(model),
        messages,
        ...(maxOutputTokens && { maxOutputTokens }),
        ...mergeAnthropicCotProviderOptions(model, envForThinking, agentThinkingBudget),
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
          tokens: (usage?.inputTokens || 0) + (usage?.outputTokens || 0),
          protocol: "mcp",
        });
        logger.info("[Agent MCP] Creator earnings credited to redeemable balance", {
          agentId: character.id,
          ownerId: character.user_id,
          earnings: actualCreatorMarkup,
        });
      }

      await reservation.reconcile(actualTotal);

      return c.json({
        jsonrpc: "2.0",
        result: {
          content: [{ type: "text", text: fullText }],
          _meta: {
            cost: {
              base: actualBaseCost,
              markup: actualCreatorMarkup,
              total: actualTotal,
            },
            usage: {
              inputTokens: usage?.inputTokens || 0,
              outputTokens: usage?.outputTokens || 0,
            },
          },
        },
        id: rpcId,
      });
    } catch (error) {
      await reservation.reconcile(0);
      logger.error("[Agent MCP] Error generating response", {
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

  return c.json({
    jsonrpc: "2.0",
    error: { code: -32601, message: `Unknown tool: ${name}` },
    id: rpcId,
  });
}

app.options("/", (c) =>
  c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
  }),
);

export default app;
