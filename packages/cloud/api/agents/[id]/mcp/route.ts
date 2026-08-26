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
import { assertModelOutputComplete } from "@elizaos/core/edge";
import { streamText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import {
  getGenerativeExecutionContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { ApiError } from "@/lib/api/cloud-worker-errors";
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
import { charactersService } from "@/lib/services/characters/characters";
import { InsufficientCreditsError } from "@/lib/services/credits";
import type { InferenceAdmissionSnapshot } from "@/lib/services/inference-auth-cache";
import { admitOrganizationInference } from "@/lib/services/organization-inference-admission";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_BILLING_OUTPUT_ESTIMATE_TOKENS = 4096;

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

  const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";
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
    // Confirm only the negative cold-cache case. Existing agents remain
    // fail-closed until their cached character is ready for inference.
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

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // error-policy:J1 the JSON-RPC boundary translates malformed JSON.
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      },
      400,
    );
  }
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
      return handleToolCall(c, character, params ?? {}, rpcId, {
        id: caller.user.id,
        organization_id: caller.user.organization_id,
        apiKeyId: caller.apiKeyId,
        admissionSnapshot: caller.admissionSnapshot,
        executionCtx,
      });

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
  authUser: {
    id: string;
    organization_id: string;
    apiKeyId?: string | null;
    admissionSnapshot?: InferenceAdmissionSnapshot;
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  },
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
    const baseOutputTokens = DEFAULT_BILLING_OUTPUT_ESTIMATE_TOKENS;
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

    const requestId = `agent-mcp:${character.id}:${crypto.randomUUID()}`;
    let admission: Awaited<ReturnType<typeof admitOrganizationInference>>;
    try {
      admission = await admitOrganizationInference({
        context: {
          organizationId: authUser.organization_id,
          userId: authUser.id,
          apiKeyId: authUser.apiKeyId ?? null,
          model,
          provider,
          billingSource: resolveAiProviderSource(model) ?? "gateway",
          requestId,
          description: `Agent MCP: ${character.name} (${model})`,
        },
        apiKeyId: authUser.apiKeyId ?? null,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        flatCost: {
          baseTotalCost: estimatedBaseCost,
          platformMarkup: estimatedTotalCost - estimatedBaseCost,
          totalCost: estimatedTotalCost,
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
      logger.info("[Agent MCP] Invoking configured provider", {
        agentId: character.id,
        model,
        thinkingBudgetTokens: effectiveThinkingBudget,
      });
      const result = await streamText({
        model: getLanguageModel(model),
        messages,
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
          logger.error("[Agent MCP] Final usage overage was not collected", {
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
        }
      })().catch((settlementError) => {
        // error-policy:J7 the response is already complete; durable admission
        // recovery retains the lease while operators receive the accounting error.
        logger.error("[Agent MCP] Deferred settlement failed", {
          agentId: character.id,
          error:
            settlementError instanceof Error
              ? settlementError.message
              : String(settlementError),
        });
      });
      if (authUser.executionCtx)
        authUser.executionCtx.waitUntil(settlementTask);
      else await settlementTask;

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
          },
        },
        id: rpcId,
      });
    } catch (error) {
      // error-policy:J1 the JSON-RPC boundary refunds a failed generation and
      // returns a structured failure instead of partial model output.
      const release = admission.settle(0);
      if (authUser.executionCtx) authUser.executionCtx.waitUntil(release);
      else await release;
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
