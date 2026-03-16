// app/api/v1/chat/completions/route.ts
/**
 * OpenAI-compatible chat completions endpoint.
 *
 * Uses Vercel AI SDK with AI Gateway for all LLM calls.
 * Real-time usage data from SDK responses for accurate billing.
 * Includes 20% platform markup on all costs.
 *
 * IMPORTANT: Do NOT call provider APIs directly. Always use AI SDK.
 */

import {
  streamText,
  generateText,
  type UIMessage,
  convertToModelMessages,
} from "ai";
import { gateway } from "@ai-sdk/gateway";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { contentModerationService } from "@/lib/services/content-moderation";
import { appsService } from "@/lib/services/apps";
import { appCreditsService } from "@/lib/services/app-credits";
import {
  reserveCredits,
  billUsage,
  recordUsageAnalytics,
  estimateInputTokens,
  InsufficientCreditsError,
} from "@/lib/services/ai-billing";
import { creditsService, type CreditReservation } from "@/lib/services/credits";
import {
  calculateCost,
  getProviderFromModel,
  normalizeModelName,
} from "@/lib/pricing";
import { logger } from "@/lib/utils/logger";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { createPreflightResponse } from "@/lib/middleware/cors-apps";
import type { NextRequest } from "next/server";

export const maxDuration = 60;

// ============================================================================
// Types
// ============================================================================

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } };
}

// ============================================================================
// CORS
// ============================================================================

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  return createPreflightResponse(origin, ["POST", "OPTIONS"]);
}

function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, X-App-Id, X-Request-ID",
  );
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ============================================================================
// Message Conversion
// ============================================================================

function convertToUIMessages(messages: ChatMessage[]): UIMessage[] {
  return messages.map((msg) => {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content.map((part) => part.text || "").join("");

    return {
      id: crypto.randomUUID(),
      role: msg.role as "system" | "user" | "assistant",
      parts: [{ type: "text" as const, text: content }],
    };
  });
}

function getMessageContent(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content.map((p) => p.text || "").join("");
}

// ============================================================================
// Main Handler
// ============================================================================

async function handlePOST(req: NextRequest) {
  const startTime = Date.now();

  try {
    // 1. Authenticate
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(req);

    // 2. Check for app monetization
    const appId = req.headers.get("X-App-Id");
    let useAppCredits = false;
    let monetizedApp: Awaited<ReturnType<typeof appsService.getById>> | null =
      null;

    if (appId) {
      monetizedApp = await appsService.getById(appId);
      if (monetizedApp?.monetization_enabled) {
        useAppCredits = true;
      }
    }

    // 3. Parse request
    const request: ChatRequest = await req.json();

    // 4. Validate
    if (!request.model || !request.messages?.length) {
      return addCorsHeaders(
        Response.json(
          {
            error: {
              message: "Missing required fields: model and messages",
              type: "invalid_request_error",
              code: "missing_required_parameter",
            },
          },
          { status: 400 },
        ),
      );
    }

    const model = request.model;
    const provider = getProviderFromModel(model);
    const normalizedModel = normalizeModelName(model);

    // 5. Check content moderation
    if (await contentModerationService.shouldBlockUser(user.id)) {
      return addCorsHeaders(
        Response.json(
          {
            error: {
              message:
                "Your account has been suspended due to policy violations.",
              type: "account_suspended",
              code: "moderation_violation",
            },
          },
          { status: 403 },
        ),
      );
    }

    // Start async moderation in background
    const lastUserMessage = request.messages
      .filter((m) => m.role === "user")
      .pop();
    if (lastUserMessage) {
      const content = getMessageContent(lastUserMessage);
      if (content) {
        contentModerationService.moderateInBackground(
          content,
          user.id,
          undefined,
          (result) => {
            logger.warn(
              "[Chat Completions] Async moderation detected violation",
              {
                userId: user.id,
                categories: result.flaggedCategories,
              },
            );
          },
        );
      }
    }

    // 6. Estimate tokens and reserve credits
    const estimatedInputTokens = estimateInputTokens(
      request.messages.map((m) => ({ content: getMessageContent(m) })),
    );
    const estimatedOutputTokens = request.max_tokens || 500;

    let reservation: CreditReservation;
    let appCreditsInfo:
      | { appId: string; estimatedBaseCost: number; app: typeof monetizedApp }
      | undefined;

    if (useAppCredits && appId && monetizedApp) {
      // App credits path
      const { totalCost } = await calculateCost(
        normalizedModel,
        provider,
        estimatedInputTokens,
        estimatedOutputTokens,
      );
      const costWithMarkup = await appCreditsService.calculateCostWithMarkup(
        appId,
        totalCost,
      );

      const balanceCheck = await appCreditsService.checkBalance(
        appId,
        user.id,
        costWithMarkup.totalCost,
      );
      if (!balanceCheck.sufficient) {
        return addCorsHeaders(
          Response.json(
            {
              error: {
                message: `Insufficient app credits. Required: $${costWithMarkup.totalCost.toFixed(4)}`,
                type: "insufficient_quota",
                code: "insufficient_credits",
              },
            },
            { status: 402 },
          ),
        );
      }

      appCreditsInfo = {
        appId,
        estimatedBaseCost: totalCost,
        app: monetizedApp,
      };
      reservation = creditsService.createAnonymousReservation();
    } else {
      // Organization credits path
      try {
        reservation = await reserveCredits(
          {
            organizationId: user.organization_id!,
            userId: user.id,
            model,
            provider,
          },
          estimatedInputTokens,
          estimatedOutputTokens,
        );
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return addCorsHeaders(
            Response.json(
              {
                error: {
                  message: `Insufficient credits. Required: $${error.required.toFixed(4)}`,
                  type: "insufficient_quota",
                  code: "insufficient_credits",
                },
              },
              { status: 402 },
            ),
          );
        }
        throw error;
      }
    }

    // 7. Convert messages for AI SDK
    const systemMessage = request.messages.find((m) => m.role === "system");
    const systemPrompt = systemMessage
      ? getMessageContent(systemMessage)
      : undefined;
    const nonSystemMessages = request.messages.filter(
      (m) => m.role !== "system",
    );
    const uiMessages = convertToUIMessages(nonSystemMessages);

    logger.info("[Chat Completions] Request", {
      model,
      messageCount: request.messages.length,
      streaming: request.stream,
      estimatedInputTokens,
    });

    // 8. Handle streaming vs non-streaming
    if (request.stream) {
      return handleStreamingRequest(
        model,
        systemPrompt,
        uiMessages,
        request,
        user,
        apiKey ? { id: apiKey.id } : null,
        reservation,
        appCreditsInfo,
        startTime,
      );
    } else {
      return handleNonStreamingRequest(
        model,
        systemPrompt,
        uiMessages,
        request,
        user,
        apiKey ? { id: apiKey.id } : null,
        reservation,
        appCreditsInfo,
        startTime,
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Chat Completions] Error", { error: errorMessage });

    // Determine appropriate status code based on error
    let status = 500;
    let errorType = "api_error";

    if (
      errorMessage.includes("Unauthorized") ||
      errorMessage.includes("Authentication")
    ) {
      status = 401;
      errorType = "authentication_error";
    } else if (
      errorMessage.includes("Insufficient") ||
      errorMessage.includes("credits")
    ) {
      status = 402;
      errorType = "insufficient_quota";
    } else if (
      errorMessage.includes("Invalid") ||
      errorMessage.includes("validation")
    ) {
      status = 400;
      errorType = "invalid_request_error";
    }

    return addCorsHeaders(
      Response.json(
        {
          error: {
            message: errorMessage,
            type: errorType,
          },
        },
        { status },
      ),
    );
  }
}

// ============================================================================
// Streaming Handler
// ============================================================================

async function handleStreamingRequest(
  model: string,
  systemPrompt: string | undefined,
  messages: UIMessage[],
  request: ChatRequest,
  user: { id: string; organization_id: string },
  apiKey: { id: string } | null,
  reservation: CreditReservation,
  appCreditsInfo:
    | { appId: string; estimatedBaseCost: number; app: unknown }
    | undefined,
  startTime: number,
) {
  const provider = getProviderFromModel(model);

  const result = streamText({
    model: gateway.languageModel(model),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    temperature: request.temperature,
    topP: request.top_p,
    frequencyPenalty: request.frequency_penalty,
    presencePenalty: request.presence_penalty,
    stopSequences: request.stop
      ? Array.isArray(request.stop)
        ? request.stop
        : [request.stop]
      : undefined,
    ...(request.max_tokens && { maxOutputTokens: request.max_tokens }),
    onFinish: async ({ text, usage }) => {
      try {
        const billing = await billUsage(
          {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id,
            model,
            provider,
          },
          usage,
          reservation,
        );

        // Handle app credits reconciliation
        if (appCreditsInfo) {
          await appCreditsService.reconcileCredits({
            appId: appCreditsInfo.appId,
            userId: user.id,
            estimatedBaseCost: appCreditsInfo.estimatedBaseCost,
            actualBaseCost: billing.totalCost,
            description: `Chat reconciliation: ${model}`,
            metadata: { model, provider, streaming: true },
          });
        }

        await recordUsageAnalytics(
          {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id,
            model,
            provider,
          },
          billing,
          { type: "chat", content: text },
        );

        logger.info("[Chat Completions] Streaming complete", {
          durationMs: Date.now() - startTime,
          inputTokens: billing.inputTokens,
          outputTokens: billing.outputTokens,
          totalCost: billing.totalCost,
        });
      } catch (error) {
        logger.error("[Chat Completions] onFinish error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  // Convert to OpenAI-compatible SSE stream
  const stream = result.textStream;
  const encoder = new TextEncoder();

  const openAIStream = new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();
      let fullContent = "";
      const responseId = `chatcmpl-${Date.now()}`;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          fullContent += value;

          // Send OpenAI-format SSE chunk
          const chunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { content: value },
                finish_reason: null,
              },
            ],
          };

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
          );
        }

        // Send final chunk with finish_reason
        const finalChunk = {
          id: responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return addCorsHeaders(
    new Response(openAIStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }),
  );
}

// ============================================================================
// Non-Streaming Handler
// ============================================================================

async function handleNonStreamingRequest(
  model: string,
  systemPrompt: string | undefined,
  messages: UIMessage[],
  request: ChatRequest,
  user: { id: string; organization_id: string },
  apiKey: { id: string } | null,
  reservation: CreditReservation,
  appCreditsInfo:
    | { appId: string; estimatedBaseCost: number; app: unknown }
    | undefined,
  startTime: number,
) {
  const provider = getProviderFromModel(model);

  const result = await generateText({
    model: gateway.languageModel(model),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    temperature: request.temperature,
    topP: request.top_p,
    frequencyPenalty: request.frequency_penalty,
    presencePenalty: request.presence_penalty,
    stopSequences: request.stop
      ? Array.isArray(request.stop)
        ? request.stop
        : [request.stop]
      : undefined,
    ...(request.max_tokens && { maxOutputTokens: request.max_tokens }),
  });

  // Bill using actual usage from SDK response
  const billing = await billUsage(
    {
      organizationId: user.organization_id,
      userId: user.id,
      apiKeyId: apiKey?.id,
      model,
      provider,
    },
    result.usage,
    reservation,
  );

  // Handle app credits
  if (appCreditsInfo) {
    await appCreditsService.reconcileCredits({
      appId: appCreditsInfo.appId,
      userId: user.id,
      estimatedBaseCost: appCreditsInfo.estimatedBaseCost,
      actualBaseCost: billing.totalCost,
      description: `Chat: ${model}`,
      metadata: { model, provider, streaming: false },
    });
  }

  await recordUsageAnalytics(
    {
      organizationId: user.organization_id,
      userId: user.id,
      apiKeyId: apiKey?.id,
      model,
      provider,
    },
    billing,
    { type: "chat", content: result.text },
  );

  logger.info("[Chat Completions] Non-streaming complete", {
    durationMs: Date.now() - startTime,
    inputTokens: billing.inputTokens,
    outputTokens: billing.outputTokens,
    totalCost: billing.totalCost,
  });

  // Return OpenAI-compatible response
  return addCorsHeaders(
    Response.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.text,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: billing.inputTokens,
        completion_tokens: billing.outputTokens,
        total_tokens: billing.totalTokens,
      },
    }),
  );
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.STRICT);
