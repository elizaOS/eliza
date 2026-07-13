/**
 * /api/agents/:id/mcp — Per-agent MCP (Model Context Protocol) endpoint.
 *
 * GET → MCP server metadata + tool catalog.
 * POST → JSON-RPC dispatch (`initialize`, `tools/list`, `tools/call`, `ping`).
 *
 * The `chat` tool reserves credits, resolves the configured model provider,
 * then reconciles actual usage. Returns plain JSON, not SSE.
 */

import { calculateCreditMarkup } from "@elizaos/cloud-shared/billing";
import { streamText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
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

const DEFAULT_MIN_OUTPUT_TOKENS = 4096;

const MCPRequestSchema = z.object({
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

const ToolCallParamsSchema = z.object({
  name: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const ChatArgumentsSchema = z.object({
  message: z.string().trim().min(1),
  model: z.string().trim().min(1).default("gpt-5-mini"),
});

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
  if (!character.is_public || !character.mcp_enabled) {
    return c.json({ error: "MCP not accessible for this agent" }, 403);
  }

  const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
  const bioText = Array.isArray(character.bio)
    ? character.bio.join("\n")
    : character.bio;
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
              enum: ["gpt-5-mini", "gemma-4-31b", "claude-sonnet-5"],
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

export async function handleToolCall(
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
  const parsedParams = ToolCallParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32602, message: "valid tool call params are required" },
        id: rpcId,
      },
      400,
    );
  }
  const { name, arguments: args } = parsedParams.data;

  if (name === "get_info") {
    const bioText = Array.isArray(character.bio)
      ? character.bio.join("\n")
      : character.bio;
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
    const parsedArguments = ChatArgumentsSchema.safeParse(args);
    if (!parsedArguments.success) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32602, message: "valid chat arguments are required" },
          id: rpcId,
        },
        400,
      );
    }
    const { message, model } = parsedArguments.data;

    const bioText = Array.isArray(character.bio)
      ? character.bio.join("\n")
      : character.bio;
    const systemPrompt =
      character.system || `You are ${character.name}. ${bioText}`;
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: message },
    ];

    const provider = getProviderFromModel(model);
    const markupPct = Number(character.inference_markup_percentage || 0);
    const envForThinking = getAnthropicCotEnv(c.env);
    const agentThinkingBudget = parseThinkingBudgetFromCharacterSettings(
      character.settings,
    );
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
    const estimatedBaseCost = await estimateRequestCost(
      model,
      messages,
      estimatedOutputTokens,
    );
    const { totalCredits: estimatedTotalCost } = calculateCreditMarkup({
      baseCredits: estimatedBaseCost,
      markupPercent: character.monetization_enabled ? markupPct : 0,
    });

    let reservation: CreditReservation;
    try {
      reservation = await creditsService.reserve({
        organizationId: authUser.organization_id,
        amount: estimatedTotalCost,
        userId: authUser.id,
        description: `Agent MCP: ${character.name} (${model})`,
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
      logger.info("[Agent MCP] Invoking configured provider", {
        agentId: character.id,
        model,
        maxOutputTokens: estimatedOutputTokens,
        thinkingBudgetTokens: effectiveThinkingBudget,
      });
      const result = await streamText({
        model: getLanguageModel(model),
        messages,
        // Cap the provider at the EXACT ceiling billing reserved above
        // (`estimatedOutputTokens`), not a second, larger formula (#16148).
        // Always sent — including the no-thinking 4096 floor — so final usage
        // cannot outrun the admitted reservation.
        maxOutputTokens: estimatedOutputTokens,
        ...mergeAnthropicCotProviderOptions(
          model,
          envForThinking,
          // Feed the already-resolved effective budget, not the raw character
          // setting. Idempotent: a positive budget re-resolves to itself and
          // `0` re-resolves to off, so the provider's thinking policy is exactly
          // what was priced — never a recomputed, divergent value (#16148).
          effectiveThinkingBudget ?? 0,
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
        logger.error("[Agent MCP] Final usage overage was not collected", {
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
        // Settlement is non-idempotent: a secondary accounting failure cannot
        // reach the outer refund boundary after reconcile(actualTotal), because
        // reconcile(0) would issue a second adjustment. The warning below keeps
        // that degraded outcome visible without corrupting consumer billing.
        try {
          await agentMonetizationService.recordCreatorEarnings({
            agentId: character.id,
            agentName: character.name,
            ownerId: character.user_id,
            earnings: actualCreatorMarkup,
            consumerOrgId: authUser.organization_id,
            model,
            tokens: usage.totalTokens,
            protocol: "mcp",
          });
          logger.info(
            "[Agent MCP] Creator earnings credited to redeemable balance",
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
            "[Agent MCP] Failed to record creator earnings (settlement already applied — not rolling back)",
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
          content: [{ type: "text", text: fullText }],
          _meta: {
            admittedOutputTokens: estimatedOutputTokens,
            cost: {
              base: actualBaseCost,
              markup: actualCreatorMarkup,
              total: actualTotal,
            },
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            },
            ...(creatorEarningsWarning
              ? { warnings: [creatorEarningsWarning] }
              : {}),
          },
        },
        id: rpcId,
      });
    } catch (error) {
      // error-policy:J1 the JSON-RPC boundary refunds a failed generation and
      // returns a structured failure instead of partial model output.
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
