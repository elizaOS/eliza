/**
 * POST /api/v1/messages — Anthropic Messages API-compatible endpoint.
 *
 * Streaming via Pattern B (hand-built SSE over `ReadableStream`). Returns a
 * `Response` with a streaming body — Hono passes it through unchanged.
 *
 * WHY: Claude Code and Anthropic SDK clients speak POST /v1/messages.
 * This route lets them use elizaOS Cloud credits/auth without a custom proxy.
 */

import {
  type AssistantModelMessage,
  generateText,
  type ImagePart,
  type JSONValue,
  jsonSchema,
  type ModelMessage,
  streamText,
  type TextPart,
  type ToolCallPart,
  type ToolContent,
  type ToolResultPart,
  type UserModelMessage,
} from "ai";
import { Hono } from "hono";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  calculateCost,
  getProviderFromModel,
  getSafeModelParams,
  normalizeModelName,
} from "@/lib/pricing";
import {
  mergeAnthropicCotProviderOptions,
  resolveAnthropicThinkingBudgetTokens,
} from "@/lib/providers/anthropic-thinking";
import { getLanguageModel, resolveAiProviderSource } from "@/lib/providers/language-model";
import {
  billUsage,
  estimateInputTokens,
  InsufficientCreditsError,
  recordUsageAnalytics,
  reserveCredits,
} from "@/lib/services/ai-billing";
import type { PricingBillingSource } from "@/lib/services/ai-pricing-definitions";
import { appCreditsService } from "@/lib/services/app-credits";
import { appsService } from "@/lib/services/apps";
import { contentModerationService } from "@/lib/services/content-moderation";
import { type CreditReservation, creditsService } from "@/lib/services/credits";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import { logger } from "@/lib/utils/logger";
import { getRouteTimeoutMs } from "@/lib/utils/request-timeout";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const ROUTE_MAX_DURATION = 800;

type AnthropicTextBlock = { type: "text"; text: string };

type AnthropicImageBlock = {
  type: "image";
  source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string };
};

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicResponseBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicSystemParam = string | Array<{ type: "text"; text: string; cache_control?: unknown }>;

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: AnthropicSystemParam;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
}

type AnthropicStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";

type ToolNameMap = Map<string, string>;
type AppCreditsInfo = {
  appId: string;
  estimatedBaseCost: number;
};

function normalizeModelId(model: string): string {
  if (model.includes("/")) return model;
  if (model.startsWith("claude-")) return `anthropic/${model}`;
  return model;
}

function inferImageMediaType(urlOrType: string): string {
  const lower = urlOrType.toLowerCase().trim();

  if (lower === "image/png") return "image/png";
  if (lower === "image/gif") return "image/gif";
  if (lower === "image/webp") return "image/webp";
  if (lower === "image/svg+xml") return "image/svg+xml";

  if (lower.startsWith("data:image/")) {
    const match = lower.match(/^data:(image\/[a-z0-9.+-]+)[;,]/);
    if (match) {
      return match[1];
    }
  }

  let pathOrUrl = lower;
  try {
    pathOrUrl = new URL(urlOrType).pathname.toLowerCase();
  } catch {
    // Keep original string when it is not a URL.
  }

  if (pathOrUrl.endsWith(".png")) return "image/png";
  if (pathOrUrl.endsWith(".gif")) return "image/gif";
  if (pathOrUrl.endsWith(".webp")) return "image/webp";
  if (pathOrUrl.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function normalizeSystemPrompt(system: AnthropicSystemParam | undefined): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

function mapToolChoice(
  toolChoice: AnthropicToolChoice | undefined,
): "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool") {
    return { type: "tool", toolName: toolChoice.name };
  }
  return undefined;
}

function convertTools(tools: AnthropicTool[] | undefined):
  | Record<
      string,
      {
        description?: string;
        inputSchema: ReturnType<typeof jsonSchema>;
        outputSchema: ReturnType<typeof jsonSchema>;
      }
    >
  | undefined {
  if (!tools?.length) return undefined;

  const result: Record<
    string,
    {
      description?: string;
      inputSchema: ReturnType<typeof jsonSchema>;
      outputSchema: ReturnType<typeof jsonSchema>;
    }
  > = {};

  for (const tool of tools) {
    result[tool.name] = {
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: jsonSchema(tool.input_schema),
      outputSchema: jsonSchema({
        type: "object",
        additionalProperties: true,
      }),
    };
  }

  return result;
}

function toImageData(urlOrData: string): string | URL {
  if (urlOrData.startsWith("data:")) return urlOrData;

  try {
    return new URL(urlOrData);
  } catch {
    return urlOrData;
  }
}

function serializeToolResultContent(
  content: string | AnthropicContentBlock[],
): string | Record<string, unknown> | AnthropicContentBlock[] {
  if (typeof content === "string") return content;

  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }

  return content;
}

function toToolResultOutput(content: string | AnthropicContentBlock[]): ToolResultPart["output"] {
  const serialized = serializeToolResultContent(content);

  if (typeof serialized === "string") {
    return { type: "text" as const, value: serialized };
  }

  return {
    type: "json" as const,
    value: JSON.parse(JSON.stringify(serialized)) as JSONValue,
  };
}

function trackToolNames(content: string | AnthropicContentBlock[], toolNames: ToolNameMap): void {
  if (typeof content === "string") return;

  for (const block of content) {
    if (block.type === "tool_use") {
      toolNames.set(block.id, block.name);
    }
  }
}

function anthropicMessagesToModelMessages(messages: AnthropicMessageParam[]): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    trackToolNames(message.content, toolNames);
  }

  for (const message of messages) {
    if (message.role === "user") {
      const userParts: Array<TextPart | ImagePart> = [];
      const toolResults: ToolContent = [];

      if (typeof message.content === "string") {
        userParts.push({ type: "text", text: message.content });
      } else {
        for (const block of message.content) {
          if (block.type === "text") {
            userParts.push({ type: "text", text: block.text });
            continue;
          }

          if (block.type === "image" && block.source.type === "url") {
            userParts.push({
              type: "image",
              image: toImageData(block.source.url),
              mediaType: inferImageMediaType(block.source.url),
            });
            continue;
          }

          if (block.type === "image" && block.source.type === "base64") {
            const mediaType = inferImageMediaType(block.source.media_type);
            userParts.push({
              type: "image",
              image: `data:${mediaType};base64,${block.source.data}`,
              mediaType,
            });
            continue;
          }

          if (block.type === "tool_result") {
            toolResults.push({
              type: "tool-result",
              toolCallId: block.tool_use_id,
              toolName: toolNames.get(block.tool_use_id) ?? "unknown_tool",
              output: toToolResultOutput(block.content),
            });
          }
        }
      }

      if (userParts.length > 0) {
        const userMessage: UserModelMessage = {
          role: "user",
          content: userParts,
        };
        modelMessages.push(userMessage);
      }

      if (toolResults.length > 0) {
        const toolMessage = {
          role: "tool",
          content: toolResults,
        } satisfies { role: "tool"; content: ToolContent };
        modelMessages.push(toolMessage);
      }

      continue;
    }

    const assistantParts: Array<TextPart | ToolCallPart | ToolResultPart> = [];

    if (typeof message.content === "string") {
      assistantParts.push({ type: "text", text: message.content });
    } else {
      for (const block of message.content) {
        if (block.type === "text") {
          assistantParts.push({ type: "text", text: block.text });
          continue;
        }

        if (block.type === "tool_use") {
          assistantParts.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          });
          continue;
        }

        if (block.type === "tool_result") {
          assistantParts.push({
            type: "tool-result",
            toolCallId: block.tool_use_id,
            toolName: toolNames.get(block.tool_use_id) ?? "unknown_tool",
            output: toToolResultOutput(block.content),
          });
        }
      }
    }

    const assistantMessage: AssistantModelMessage = {
      role: "assistant",
      content: assistantParts.length > 0 ? assistantParts : [{ type: "text", text: "" }],
    };
    modelMessages.push(assistantMessage);
  }

  return modelMessages;
}

function getMessageContentForEstimate(message: AnthropicMessageParam): string {
  if (typeof message.content === "string") return message.content;

  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return JSON.stringify(block.input);
      if (block.type === "tool_result") {
        const serialized = serializeToolResultContent(block.content);
        return typeof serialized === "string" ? serialized : JSON.stringify(serialized);
      }
      return "";
    })
    .join(" ");
}

function mapFinishReason(
  finishReason: string,
  rawFinishReason: string | undefined,
  hasToolCalls: boolean,
): AnthropicStopReason {
  if (hasToolCalls || finishReason === "tool-calls") return "tool_use";
  if (rawFinishReason?.includes("stop_sequence")) return "stop_sequence";
  if (finishReason === "length" || rawFinishReason === "max_tokens") {
    return "max_tokens";
  }
  return "end_turn";
}

function resolveStopSequence(
  stopReason: AnthropicStopReason,
  rawFinishReason: string | undefined,
  requestedStopSequences: string[] | undefined,
): string | null {
  if (stopReason !== "stop_sequence") return null;

  if (
    rawFinishReason &&
    rawFinishReason !== "stop_sequence" &&
    requestedStopSequences?.includes(rawFinishReason)
  ) {
    return rawFinishReason;
  }

  if (requestedStopSequences?.length === 1) {
    return requestedStopSequences[0];
  }

  return null;
}

function anthropicError(type: string, message: string, status: number): Response {
  return Response.json({ type: "error", error: { type, message } }, { status: status as 400 });
}

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.RELAXED));

app.post("/", async (c) => {
  const startTime = Date.now();
  const routeTimeoutMs = getRouteTimeoutMs(ROUTE_MAX_DURATION);
  let settleReservation: ((actualCost: number) => Promise<void>) | null = null;

  let user: { id: string; organization_id: string };
  let apiKey: { id: string } | null = null;
  try {
    const auth = await requireUserOrApiKeyWithOrg(c);
    user = { id: auth.id, organization_id: auth.organization_id };
    // Workers auth shim does not surface the apiKey row; attribution by
    // apiKey id requires a separate lookup.
    apiKey = await getRequestApiKeyId(c);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return anthropicError("authentication_error", message, 401);
  }

  const appId = c.req.header("X-App-Id");
  let useAppCredits = false;
  let monetizedApp: NonNullable<Awaited<ReturnType<typeof appsService.getById>>> | null = null;
  if (appId) {
    monetizedApp = (await appsService.getById(appId)) ?? null;
    useAppCredits = Boolean(monetizedApp?.monetization_enabled);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return anthropicError("invalid_request_error", "Invalid JSON body", 400);
  }

  if (!body || typeof body !== "object") {
    return anthropicError("invalid_request_error", "Invalid JSON body", 400);
  }

  const request = body as AnthropicMessagesRequest;
  if (!request.model || request.max_tokens == null || !request.messages?.length) {
    return anthropicError(
      "invalid_request_error",
      "Missing required fields: model, max_tokens, messages",
      400,
    );
  }

  const model = normalizeModelId(request.model);
  const provider = getProviderFromModel(model);
  const normalizedModel = normalizeModelName(model);
  const systemPrompt = normalizeSystemPrompt(request.system);

  if (await contentModerationService.shouldBlockUser(user.id)) {
    return anthropicError(
      "permission_error",
      "Your account has been suspended due to policy violations.",
      403,
    );
  }

  const lastUserMessage = request.messages.filter((message) => message.role === "user").pop();
  if (lastUserMessage) {
    const content = getMessageContentForEstimate(lastUserMessage);
    if (content) {
      contentModerationService.moderateInBackground(content, user.id, undefined, (result) => {
        logger.warn("[Messages API] Async moderation detected violation", {
          userId: user.id,
          categories: result.flaggedCategories,
        });
      });
    }
  }

  const estimateMessages: Array<{ content: string | undefined }> = [];
  if (systemPrompt) {
    estimateMessages.push({ content: systemPrompt });
  }
  for (const message of request.messages) {
    estimateMessages.push({ content: getMessageContentForEstimate(message) });
  }

  const estimatedInputTokens = estimateInputTokens(estimateMessages);
  const estimatedOutputTokens = request.max_tokens;
  const affiliateCode = c.req.header("X-Affiliate-Code") ?? null;
  const billingSource: PricingBillingSource = resolveAiProviderSource(model) ?? "openrouter";

  let reservation: CreditReservation;
  let appCreditsInfo: AppCreditsInfo | undefined;

  if (useAppCredits && appId && monetizedApp) {
    const { totalCost } = await calculateCost(
      normalizedModel,
      provider,
      estimatedInputTokens,
      estimatedOutputTokens,
      billingSource,
    );
    const costWithMarkup = await appCreditsService.calculateCostWithMarkup(appId, totalCost);
    const balanceCheck = await appCreditsService.checkBalance(
      appId,
      user.id,
      costWithMarkup.totalCost,
    );

    if (!balanceCheck.sufficient) {
      return anthropicError(
        "rate_limit_error",
        `Insufficient app credits. Required: $${costWithMarkup.totalCost.toFixed(4)}`,
        429,
      );
    }

    appCreditsInfo = {
      appId,
      estimatedBaseCost: 0,
    };
    reservation = creditsService.createAnonymousReservation();
  } else {
    try {
      reservation = await reserveCredits(
        {
          organizationId: user.organization_id,
          userId: user.id,
          model,
          provider,
          billingSource,
          affiliateCode,
        },
        estimatedInputTokens,
        estimatedOutputTokens,
      );
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return anthropicError(
          "rate_limit_error",
          `Insufficient credits. Required: $${error.required.toFixed(4)}`,
          429,
        );
      }

      throw error;
    }
  }

  settleReservation = createCreditReservationSettler(reservation);

  const messages = anthropicMessagesToModelMessages(request.messages);
  const tools = convertTools(request.tools);
  const toolChoice = mapToolChoice(request.tool_choice);
  const safeParams = getSafeModelParams(model, {
    temperature: request.temperature,
    topP: request.top_p,
    topK: request.top_k,
    stopSequences: request.stop_sequences,
  });

  try {
    if (request.stream) {
      return await handleStream(
        model,
        systemPrompt,
        messages,
        request,
        user,
        apiKey,
        appCreditsInfo,
        affiliateCode,
        startTime,
        estimatedInputTokens,
        safeParams,
        tools,
        toolChoice,
        c.req.raw.signal,
        routeTimeoutMs,
        settleReservation,
        billingSource,
      );
    }

    return await handleNonStream(
      model,
      systemPrompt,
      messages,
      request,
      user,
      apiKey,
      appCreditsInfo,
      affiliateCode,
      startTime,
      safeParams,
      tools,
      toolChoice,
      c.req.raw.signal,
      routeTimeoutMs,
      settleReservation,
      billingSource,
    );
  } catch (error) {
    await settleReservation?.(0);
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[Messages API] Error", { error: message });
    return anthropicError("api_error", message, 500);
  }
});

/**
 * Workers auth shim doesn't expose the validated apiKey row; repeat the
 * lookup so usage attribution stays in parity with the Next-era handler.
 */
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

async function handleNonStream(
  model: string,
  systemPrompt: string | undefined,
  messages: ModelMessage[],
  request: AnthropicMessagesRequest,
  user: { id: string; organization_id: string },
  apiKey: { id: string } | null,
  appCreditsInfo: AppCreditsInfo | undefined,
  affiliateCode: string | null,
  startTime: number,
  safeParams: ReturnType<typeof getSafeModelParams>,
  tools: ReturnType<typeof convertTools>,
  toolChoice: "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  settleReservation: (actualCost: number) => Promise<void>,
  billingSource: PricingBillingSource,
) {
  const provider = getProviderFromModel(model);

  const cotBudget = resolveAnthropicThinkingBudgetTokens(model, process.env);
  const cotOptions =
    cotBudget != null ? mergeAnthropicCotProviderOptions(model, process.env, cotBudget) : {};
  const MIN_RESPONSE_BUFFER = 4096;
  const effectiveMaxTokens =
    cotBudget != null
      ? Math.max(request.max_tokens ?? MIN_RESPONSE_BUFFER, cotBudget + MIN_RESPONSE_BUFFER)
      : request.max_tokens;

  try {
    const result = await generateText({
      model: getLanguageModel(model),
      system: systemPrompt,
      messages,
      maxOutputTokens: effectiveMaxTokens,
      abortSignal,
      timeout: timeoutMs,
      ...safeParams,
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...cotOptions,
    });

    const billing = await billUsage(
      {
        organizationId: user.organization_id,
        userId: user.id,
        apiKeyId: apiKey?.id,
        model,
        provider,
        billingSource,
        affiliateCode,
      },
      result.usage,
    );
    await settleReservation(billing.totalCost);

    if (appCreditsInfo) {
      await appCreditsService.reconcileCredits({
        appId: appCreditsInfo.appId,
        userId: user.id,
        estimatedBaseCost: appCreditsInfo.estimatedBaseCost,
        actualBaseCost: billing.totalCost,
        description: `Messages API: ${model}`,
        metadata: { model, provider, billingSource, streaming: false },
      });
    }

    await recordUsageAnalytics(
      {
        organizationId: user.organization_id,
        userId: user.id,
        apiKeyId: apiKey?.id,
        model,
        provider,
        billingSource,
      },
      billing,
      { type: "chat", content: result.text },
    );

    logger.info("[Messages API] Non-streaming complete", {
      durationMs: Date.now() - startTime,
      inputTokens: billing.inputTokens,
      outputTokens: billing.outputTokens,
    });

    const responseContent: AnthropicResponseBlock[] = [];
    if (result.text) {
      responseContent.push({ type: "text", text: result.text });
    }

    if (result.toolCalls?.length) {
      for (const toolCall of result.toolCalls) {
        responseContent.push({
          type: "tool_use",
          id: toolCall.toolCallId,
          name: toolCall.toolName,
          input: toolCall.input as Record<string, unknown>,
        });
      }
    }

    if (responseContent.length === 0) {
      responseContent.push({ type: "text", text: "" });
    }

    const hasToolCalls = Boolean(result.toolCalls?.length);
    const stopReason = mapFinishReason(result.finishReason, result.rawFinishReason, hasToolCalls);
    const stopSequence = resolveStopSequence(
      stopReason,
      result.rawFinishReason,
      request.stop_sequences,
    );

    return Response.json({
      id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "message",
      role: "assistant",
      content: responseContent,
      model: request.model,
      stop_reason: stopReason,
      stop_sequence: stopSequence,
      usage: {
        input_tokens: billing.inputTokens,
        output_tokens: billing.outputTokens,
      },
    });
  } catch (error) {
    await settleReservation(0);
    throw error;
  }
}

async function handleStream(
  model: string,
  systemPrompt: string | undefined,
  messages: ModelMessage[],
  request: AnthropicMessagesRequest,
  user: { id: string; organization_id: string },
  apiKey: { id: string } | null,
  appCreditsInfo: AppCreditsInfo | undefined,
  affiliateCode: string | null,
  startTime: number,
  estimatedInputTokens: number,
  safeParams: ReturnType<typeof getSafeModelParams>,
  tools: ReturnType<typeof convertTools>,
  toolChoice: "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  settleReservation: (actualCost: number) => Promise<void>,
  billingSource: PricingBillingSource,
) {
  const provider = getProviderFromModel(model);
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  const cotBudget = resolveAnthropicThinkingBudgetTokens(model, process.env);
  const cotOptions =
    cotBudget != null ? mergeAnthropicCotProviderOptions(model, process.env, cotBudget) : {};
  const MIN_RESPONSE_BUFFER = 4096;
  const effectiveMaxTokens =
    cotBudget != null
      ? Math.max(request.max_tokens ?? MIN_RESPONSE_BUFFER, cotBudget + MIN_RESPONSE_BUFFER)
      : request.max_tokens;

  const result = streamText({
    model: getLanguageModel(model),
    system: systemPrompt,
    messages,
    maxOutputTokens: effectiveMaxTokens,
    abortSignal,
    timeout: timeoutMs,
    ...safeParams,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...cotOptions,
    onFinish: async ({ text, totalUsage }) => {
      try {
        const billing = await billUsage(
          {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id,
            model,
            provider,
            billingSource,
            affiliateCode,
          },
          totalUsage,
        );
        await settleReservation(billing.totalCost);

        if (appCreditsInfo) {
          await appCreditsService.reconcileCredits({
            appId: appCreditsInfo.appId,
            userId: user.id,
            estimatedBaseCost: appCreditsInfo.estimatedBaseCost,
            actualBaseCost: billing.totalCost,
            description: `Messages API stream: ${model}`,
            metadata: { model, provider, billingSource, streaming: true },
          });
        }

        await recordUsageAnalytics(
          {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id,
            model,
            provider,
            billingSource,
          },
          billing,
          { type: "chat", content: text },
        );

        logger.info("[Messages API] Streaming complete", {
          durationMs: Date.now() - startTime,
          inputTokens: billing.inputTokens,
          outputTokens: billing.outputTokens,
        });
      } catch (error) {
        await settleReservation(0);
        logger.error("[Messages API] onFinish billing error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    onAbort: async () => {
      await settleReservation(0);
      logger.info("[Messages API] Stream aborted before completion", {
        model,
        estimatedInputTokens,
      });
    },
  });

  const encoder = new TextEncoder();

  function sse(event: string, data: Record<string, unknown>): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const blockState = new Map<
        string,
        {
          index: number;
          type: "text" | "tool";
          sawInputDelta: boolean;
          stopped: boolean;
        }
      >();
      let nextIndex = 0;
      let sawToolCalls = false;
      let finishReason = "stop";
      let rawFinishReason: string | undefined;
      let totalUsage:
        | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
        | undefined;

      const ensureTextBlock = (id: string) => {
        const existing = blockState.get(id);
        if (existing) return existing.index;

        const index = nextIndex++;
        blockState.set(id, {
          index,
          type: "text",
          sawInputDelta: false,
          stopped: false,
        });
        controller.enqueue(
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }),
        );
        return index;
      };

      const ensureToolBlock = (id: string, toolName: string) => {
        const existing = blockState.get(id);
        if (existing) return existing.index;

        const index = nextIndex++;
        blockState.set(id, {
          index,
          type: "tool",
          sawInputDelta: false,
          stopped: false,
        });
        controller.enqueue(
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id,
              name: toolName,
              input: {},
            },
          }),
        );
        return index;
      };

      const stopBlock = (id: string) => {
        const state = blockState.get(id);
        if (!state || state.stopped) return;

        controller.enqueue(
          sse("content_block_stop", {
            type: "content_block_stop",
            index: state.index,
          }),
        );
        state.stopped = true;
      };

      try {
        controller.enqueue(
          sse("message_start", {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              content: [],
              model: request.model,
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: estimatedInputTokens,
                output_tokens: 0,
              },
            },
          }),
        );

        controller.enqueue(sse("ping", { type: "ping" }));

        for await (const part of result.fullStream as AsyncIterable<any>) {
          switch (part.type) {
            case "text-start": {
              ensureTextBlock(part.id);
              break;
            }

            case "text-delta": {
              const index = ensureTextBlock(part.id);
              controller.enqueue(
                sse("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "text_delta", text: part.text },
                }),
              );
              break;
            }

            case "text-end": {
              stopBlock(part.id);
              break;
            }

            case "tool-input-start": {
              sawToolCalls = true;
              ensureToolBlock(part.id, part.toolName);
              break;
            }

            case "tool-input-delta": {
              const state = blockState.get(part.id);
              if (state) {
                state.sawInputDelta = true;
                controller.enqueue(
                  sse("content_block_delta", {
                    type: "content_block_delta",
                    index: state.index,
                    delta: {
                      type: "input_json_delta",
                      partial_json: part.delta,
                    },
                  }),
                );
              }
              break;
            }

            case "tool-input-end": {
              stopBlock(part.id);
              break;
            }

            case "tool-call": {
              sawToolCalls = true;
              const index = ensureToolBlock(part.toolCallId, part.toolName);
              const state = blockState.get(part.toolCallId);

              if (state && !state.sawInputDelta) {
                controller.enqueue(
                  sse("content_block_delta", {
                    type: "content_block_delta",
                    index,
                    delta: {
                      type: "input_json_delta",
                      partial_json: JSON.stringify(part.input ?? {}),
                    },
                  }),
                );
                state.sawInputDelta = true;
              }

              stopBlock(part.toolCallId);
              break;
            }

            case "finish": {
              finishReason = part.finishReason;
              rawFinishReason = part.rawFinishReason;
              totalUsage = part.totalUsage;
              break;
            }

            case "error": {
              throw part.error;
            }
          }
        }

        for (const [id, state] of blockState.entries()) {
          if (!state.stopped) {
            stopBlock(id);
          }
        }

        const stopReason = mapFinishReason(finishReason, rawFinishReason, sawToolCalls);
        const stopSequence = resolveStopSequence(
          stopReason,
          rawFinishReason,
          request.stop_sequences,
        );

        controller.enqueue(
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: stopSequence },
            usage: {
              output_tokens: totalUsage?.outputTokens ?? 0,
            },
          }),
        );

        controller.enqueue(sse("message_stop", { type: "message_stop" }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Messages API] Stream error", { error: message });
        controller.enqueue(
          sse("error", {
            type: "error",
            error: { type: "api_error", message },
          }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}

export default app;
