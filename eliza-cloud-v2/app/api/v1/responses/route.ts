// app/api/v1/responses/route.ts
/**
 * AI SDK v2.0+ compatibility endpoint
 *
 * The Vercel AI SDK (@ai-sdk/openai) v2.0+ sends requests to /responses instead of /chat/completions
 * This endpoint transforms the AI SDK request format to standard OpenAI format and forwards to our gateway
 *
 * AI SDK Request Format:
 *   - input: messages array
 *   - max_output_tokens: token limit
 *
 * OpenAI Format:
 *   - messages: messages array
 *   - max_tokens: token limit
 */

import { requireAuthOrApiKey } from "@/lib/auth";
import {
  getAnonymousUser,
  getOrCreateAnonymousUser,
} from "@/lib/auth-anonymous";
import { getProvider } from "@/lib/providers";
import { creditsService } from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { generationsService } from "@/lib/services/generations";
import { organizationsService } from "@/lib/services/organizations";
import { contentModerationService } from "@/lib/services/content-moderation";
import {
  calculateCost,
  getProviderFromModel,
  normalizeModelName,
  estimateRequestCost,
  estimateTokens,
} from "@/lib/pricing";
import { logger } from "@/lib/utils/logger";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import type { NextRequest } from "next/server";
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
} from "@/lib/providers/types";
import type { UserWithOrganization } from "@/lib/types";

export const maxDuration = 60;

// AI SDK request format (different from OpenAI)
interface AISdkRequest {
  model: string;
  input: Array<{
    role: "user" | "system" | "assistant" | "tool";
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          image_url?: { url: string };
        }>;
    name?: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: {
        name: string;
        arguments: string;
      };
    }>;
    tool_call_id?: string;
    function_call?: {
      name: string;
      arguments: string;
    };
  }>;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
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
  stream?: boolean;
  // ... other AI SDK specific fields
}

/**
 * Transforms AI SDK request format to OpenAI format.
 *
 * @param aiSdkRequest - AI SDK format request.
 * @returns OpenAI format request.
 */
function transformAISdkToOpenAI(aiSdkRequest: AISdkRequest): OpenAIChatRequest {
  const {
    model,
    input, // 🔑 AI SDK uses 'input'
    max_output_tokens, // 🔑 AI SDK uses 'max_output_tokens'
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
    stop,
    user,
    tools,
    tool_choice,
    stream,
  } = aiSdkRequest;

  // Transform messages: fix content types for multimodal
  const transformedMessages = input.map((msg, msgIndex) => {
    // If content is an array (multimodal), transform types and filter empty text blocks
    if (Array.isArray(msg.content)) {
      const originalLength = msg.content.length;
      const transformedContent = msg.content
        .map((part) => {
          // AI SDK uses "input_text" but OpenAI expects "text"
          if (typeof part === "object" && "type" in part) {
            if (part.type === "input_text") {
              return { ...part, type: "text" };
            }
            // Also handle "input_image" -> "image_url" if needed
            if (
              part.type === "input_image" &&
              "image" in part &&
              typeof part.image === "string"
            ) {
              return {
                type: "image_url",
                image_url: { url: part.image },
              };
            }
          }
          return part;
        })
        // Filter out empty text content blocks (Anthropic API requires non-empty text)
        .filter((part) => {
          if (typeof part === "object" && part !== null && "type" in part) {
            const typedPart = part as { type: string; text?: string };
            // Keep text blocks only if they have non-empty text
            if (typedPart.type === "text" || typedPart.type === "input_text") {
              const hasNonEmptyText =
                typeof typedPart.text === "string" &&
                typedPart.text.trim() !== "";
              if (!hasNonEmptyText) {
                logger.debug(
                  "[Responses API] Filtering out empty text content block",
                  {
                    messageIndex: msgIndex,
                    role: msg.role,
                    textValue: typedPart.text,
                  },
                );
              }
              return hasNonEmptyText;
            }
          }
          // Keep non-text parts (images, etc.)
          return true;
        });

      // Log if we filtered out content
      if (transformedContent.length < originalLength) {
        logger.info(
          "[Responses API] Filtered empty text blocks from content array",
          {
            messageIndex: msgIndex,
            role: msg.role,
            originalParts: originalLength,
            remainingParts: transformedContent.length,
          },
        );
      }

      // If content array is now empty or has only empty parts, convert to empty string
      // This will be caught by validation later
      if (transformedContent.length === 0) {
        logger.warn(
          "[Responses API] Content array became empty after filtering",
          {
            messageIndex: msgIndex,
            role: msg.role,
          },
        );
        return { ...msg, content: "" };
      }

      return { ...msg, content: transformedContent };
    }
    return msg;
  });

  // Transform to OpenAI format
  const openAIRequest: OpenAIChatRequest = {
    model,
    messages: transformedMessages, // 🔑 OpenAI uses 'messages' with transformed content
    max_tokens: max_output_tokens, // 🔑 OpenAI uses 'max_tokens'
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
    stop,
    user,
    tools,
    tool_choice,
    stream,
  };

  // Remove undefined fields
  Object.keys(openAIRequest).forEach((key) => {
    if (openAIRequest[key as keyof OpenAIChatRequest] === undefined) {
      delete openAIRequest[key as keyof OpenAIChatRequest];
    }
  });

  return openAIRequest;
}

/**
 * Transform OpenAI response format to AI SDK format
 *
 * AI SDK v5+ expects a specific response schema with required fields.
 * This function transforms OpenAI chat completion responses to match.
 */
function transformOpenAIToAISdk(openAIResponse: OpenAIChatResponse): object {
  // Get the first choice's finish reason to determine status
  const firstChoice = openAIResponse.choices[0];
  const finishReason = firstChoice?.finish_reason || "stop";

  // Map OpenAI finish_reason to AI SDK status
  // "length" = max tokens reached, "content_filter" = blocked, "stop" = normal completion
  let status: "completed" | "incomplete" | "failed";
  let incompleteReason: string | null = null;

  switch (finishReason) {
    case "length":
      status = "incomplete";
      incompleteReason = "max_output_tokens";
      break;
    case "content_filter":
      status = "failed";
      break;
    case "stop":
    default:
      status = "completed";
      break;
  }

  return {
    id: openAIResponse.id,
    object: "response", // AI SDK expects "response" not "chat.completion"
    created_at: openAIResponse.created,
    model: openAIResponse.model,
    status, // AI SDK requires status field
    // Required: incomplete_details must be object or null
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    output: openAIResponse.choices.map((choice) => {
      // Flatten the message object and transform content
      const message = choice.message;
      const messageContent = message.content;
      let content;

      if (typeof messageContent === "string") {
        // Simple string content
        content = [
          { type: "output_text", text: messageContent, annotations: [] },
        ];
      } else if (Array.isArray(messageContent)) {
        // Already array (multimodal)
        content = (messageContent as Array<unknown>).map((part: unknown) => {
          if (typeof part === "string") {
            return { type: "output_text", text: part, annotations: [] };
          }
          if (
            typeof part === "object" &&
            part !== null &&
            "text" in part &&
            typeof (part as { text: unknown }).text === "string"
          ) {
            return {
              type: "output_text",
              text: (part as { text: string }).text,
              annotations: [],
            };
          }
          return { type: "output_text", text: "", annotations: [] };
        });
      } else {
        // null or other type
        content = [
          {
            type: "output_text",
            text: String(messageContent || ""),
            annotations: [],
          },
        ];
      }

      return {
        type: "message", // AI SDK requires "type": "message"
        index: choice.index,
        id: openAIResponse.id, // Use generation id
        role: message.role, // Flatten: message.role -> role
        content, // Transformed content
        status: choice.finish_reason === "length" ? "incomplete" : "completed",
        // Include tool calls if present
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        // Include function call if present
        ...("function_call" in message && message.function_call
          ? { function_call: message.function_call }
          : {}),
      };
    }), // OpenAI: "choices" -> AI SDK: "output" with flattened structure
    usage: openAIResponse.usage
      ? {
          input_tokens: openAIResponse.usage.prompt_tokens,
          output_tokens: openAIResponse.usage.completion_tokens,
          total_tokens: openAIResponse.usage.total_tokens,
        }
      : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    // Additional AI SDK expected fields
    error: null,
    // Preserve any provider metadata
    ...("provider_metadata" in openAIResponse &&
    openAIResponse.provider_metadata
      ? { provider_metadata: openAIResponse.provider_metadata }
      : {}),
  };
}

/**
 * POST /api/v1/responses
 * AI SDK v2.0+ compatibility endpoint for chat completions.
 * Transforms AI SDK request format to OpenAI format and forwards to the gateway.
 * Supports both authenticated and anonymous users.
 *
 * @param req - AI SDK format request with input messages and max_output_tokens.
 * @returns Streaming or non-streaming chat completion response in AI SDK format.
 */
async function handlePOST(req: NextRequest) {
  const startTime = Date.now();

  try {
    // 1. Authenticate - Support both authenticated and anonymous users
    let user: UserWithOrganization;
    let apiKey;
    let isAnonymous = false;

    try {
      const authResult = await requireAuthOrApiKey(req);
      user = authResult.user;
      apiKey = authResult.apiKey;
    } catch (authError) {
      // Fallback to anonymous user
      logger.info("[Responses API] Privy auth failed, trying anonymous...");

      const anonData = await getAnonymousUser();
      if (anonData) {
        user = anonData.user;
        isAnonymous = true;
        logger.info("[Responses API] Anonymous user authenticated:", user.id);
      } else {
        // Create new anonymous session if none exists
        logger.info("[Responses API] Creating new anonymous session...");
        const newAnonData = await getOrCreateAnonymousUser();
        user = newAnonData.user;
        isAnonymous = true;
        logger.info("[Responses API] Created anonymous user:", user.id);
      }
    }

    // 2. Parse AI SDK request
    const aiSdkRequest: AISdkRequest = await req.json();

    // 3. Transform to OpenAI format
    const request = transformAISdkToOpenAI(aiSdkRequest);

    // 4. Validate input
    if (!request.model || !request.messages) {
      return Response.json(
        {
          error: {
            message: "Missing required fields: model and input/messages",
            type: "invalid_request_error",
            param: !request.model ? "model" : "input",
            code: "missing_required_parameter",
          },
        },
        { status: 400 },
      );
    }

    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      return Response.json(
        {
          error: {
            message: "input/messages must be a non-empty array",
            type: "invalid_request_error",
            param: "input",
            code: "invalid_value",
          },
        },
        { status: 400 },
      );
    }

    // Validate and clean message content
    // Filter out empty system messages (characters may not have system prompts configured)
    request.messages = request.messages.filter((msg, i) => {
      if (
        msg.role === "system" &&
        (!msg.content ||
          (typeof msg.content === "string" && msg.content.trim() === ""))
      ) {
        logger.debug("[Responses API] Filtering out empty system message", {
          messageIndex: i,
        });
        return false;
      }
      return true;
    });

    for (let i = 0; i < request.messages.length; i++) {
      const msg = request.messages[i];

      if (!msg.role) {
        return Response.json(
          {
            error: {
              message: "Each message must have a role",
              type: "invalid_request_error",
              param: `messages.${i}.role`,
              code: "invalid_value",
            },
          },
          { status: 400 },
        );
      }

      // Content is optional for tool/function call messages
      const hasToolCalls = "tool_calls" in msg && msg.tool_calls;
      const hasToolCallId = "tool_call_id" in msg && msg.tool_call_id;
      const hasFunctionCall = "function_call" in msg && msg.function_call;

      // If content is null, undefined, or empty string, but we need content
      if (!msg.content && !hasToolCalls && !hasToolCallId && !hasFunctionCall) {
        logger.error("[Responses API] Invalid message content", {
          messageIndex: i,
          role: msg.role,
          hasContent: !!msg.content,
          contentType: typeof msg.content,
          contentValue: msg.content,
        });

        return Response.json(
          {
            error: {
              message:
                "Each message must have content, tool_calls, tool_call_id, or function_call",
              type: "invalid_request_error",
              param: `messages.${i}.content`,
              code: "invalid_value",
            },
          },
          { status: 400 },
        );
      }

      // Ensure content is a string or proper array for multimodal
      if (msg.content !== undefined && msg.content !== null) {
        if (typeof msg.content !== "string" && !Array.isArray(msg.content)) {
          logger.error("[Responses API] Invalid content type", {
            messageIndex: i,
            contentType: typeof msg.content,
            content: msg.content,
          });

          return Response.json(
            {
              error: {
                message: "Message content must be a string or array",
                type: "invalid_request_error",
                param: `messages.${i}.content`,
                code: "invalid_value",
              },
            },
            { status: 400 },
          );
        }

        // Validate array content has non-empty text blocks (Anthropic API requirement)
        if (Array.isArray(msg.content)) {
          const hasValidTextContent = msg.content.some((part) => {
            if (typeof part === "object" && part !== null && "type" in part) {
              const typedPart = part as { type: string; text?: string };
              if (
                typedPart.type === "text" ||
                typedPart.type === "input_text"
              ) {
                return (
                  typeof typedPart.text === "string" &&
                  typedPart.text.trim() !== ""
                );
              }
              // Non-text parts (images) are valid
              return true;
            }
            return false;
          });

          // If we have a content array but no valid content, and no tool calls, reject
          if (
            !hasValidTextContent &&
            !hasToolCalls &&
            !hasToolCallId &&
            !hasFunctionCall
          ) {
            logger.warn(
              "[Responses API] Content array has no valid text content",
              {
                messageIndex: i,
                role: msg.role,
                contentLength: msg.content.length,
              },
            );

            return Response.json(
              {
                error: {
                  message:
                    "Message content array must contain at least one non-empty text block",
                  type: "invalid_request_error",
                  param: `messages.${i}.content`,
                  code: "invalid_value",
                },
              },
              { status: 400 },
            );
          }
        }
      }
    }

    // Check if user is blocked due to moderation violations
    if (await contentModerationService.shouldBlockUser(user.id)) {
      logger.warn("[Responses API] User blocked due to moderation violations", {
        userId: user.id,
      });
      return Response.json(
        {
          error: {
            message:
              "Your account has been suspended due to policy violations. Please contact support.",
            type: "account_suspended",
            code: "moderation_violation",
          },
        },
        { status: 403 },
      );
    }

    // Start async content moderation (runs in background, doesn't block)
    const lastUserMessage = [...request.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMessage?.content) {
      const messageText =
        typeof lastUserMessage.content === "string"
          ? lastUserMessage.content
          : lastUserMessage.content.find((c) => c.type === "text")?.text || "";

      if (messageText) {
        contentModerationService.moderateInBackground(
          messageText,
          user.id,
          undefined,
          (result) => {
            logger.warn("[Responses API] Async moderation detected violation", {
              userId: user.id,
              categories: result.flaggedCategories,
              action: result.action,
            });
          },
        );
      }
    }

    const model = request.model;
    const provider = getProviderFromModel(model);
    const normalizedModel = normalizeModelName(model);
    const isStreaming = request.stream ?? false;

    // 5. DEDUCT credits BEFORE making API call (prevents TOCTOU race condition)
    // Skip for anonymous users - they use message limits instead
    const estimatedCost = await estimateRequestCost(model, request.messages);
    let org = null;
    let reservedAmount = 0;

    if (isAnonymous) {
      logger.info("[Responses API] Anonymous user - skipping credit check", {
        userId: user.id,
        estimatedCost,
      });
    } else {
      // Check if user has an organization
      if (!user.organization_id) {
        return Response.json(
          {
            error: {
              message: "User is not associated with an organization",
              type: "invalid_request_error",
              code: "no_organization",
            },
          },
          { status: 400 },
        );
      }

      // Add 50% buffer to estimated cost to account for longer responses
      const COST_BUFFER = 1.5;
      reservedAmount = estimatedCost * COST_BUFFER;

      // Atomically deduct credits BEFORE calling the API
      // This prevents race conditions where multiple requests pass the check
      const reservationResult = await creditsService.reserveAndDeductCredits({
        organizationId: user.organization_id,
        amount: reservedAmount,
        description: `Responses API (reserved): ${model}`,
        metadata: { user_id: user.id, type: "reservation", estimated: true },
      });

      if (!reservationResult.success) {
        logger.warn("[Responses API] Insufficient credits", {
          organizationId: user.organization_id,
          required: reservedAmount,
          reason: reservationResult.reason,
        });

        return Response.json(
          {
            error: {
              message: `Insufficient balance. Required: $${reservedAmount.toFixed(2)}`,
              type: "insufficient_quota",
              code: "insufficient_balance",
            },
          },
          { status: 402 },
        );
      }
    } // End of non-anonymous credit deduction block

    // Log for anonymous users
    if (isAnonymous) {
      logger.info("[Responses API] Anonymous chat completion request", {
        userId: user.id,
        model,
        normalizedModel,
        provider,
        streaming: isStreaming,
        messageCount: request.messages.length,
        estimatedCost,
      });
    }

    // 6. Forward to Vercel AI Gateway with Groq as preferred provider
    const providerInstance = getProvider();
    const requestWithProvider = {
      ...request,
      providerOptions: {
        gateway: {
          order: ["groq"], // Use Groq as preferred provider
        },
      },
    };
    const providerResponse =
      await providerInstance.chatCompletions(requestWithProvider);

    // 7. Handle streaming vs non-streaming
    if (isStreaming) {
      return handleStreamingResponse(
        providerResponse,
        user,
        apiKey ?? null,
        normalizedModel,
        provider,
        startTime,
        request.messages,
        reservedAmount,
      );
    } else {
      return handleNonStreamingResponse(
        providerResponse,
        user,
        apiKey ?? null,
        normalizedModel,
        provider,
        startTime,
        reservedAmount,
      );
    }
  } catch (error) {
    logger.error("[Responses API] Error:", error);

    // Check if it's an authentication error
    if (
      error instanceof Error &&
      (error.message.includes("Unauthorized") ||
        error.message.includes("Invalid or expired API key") ||
        error.message.includes("API key"))
    ) {
      return Response.json(
        {
          error: {
            message: error.message,
            type: "authentication_error",
            code: "unauthorized",
          },
        },
        { status: 401 },
      );
    }

    // Check if error is a structured gateway error
    interface GatewayError {
      status: number;
      error: { message: string; type?: string; code?: string };
    }

    if (
      error &&
      typeof error === "object" &&
      "error" in error &&
      "status" in error
    ) {
      const status = (error as { status: unknown }).status;
      if (typeof status === "number") {
        const gatewayError = error as GatewayError;
        return Response.json(
          { error: gatewayError.error },
          { status: gatewayError.status },
        );
      }
    }

    // Fallback to generic error
    return Response.json(
      {
        error: {
          message:
            error instanceof Error ? error.message : "Internal server error",
          type: "api_error",
          code: "internal_server_error",
        },
      },
      { status: 500 },
    );
  }
}

// Handle non-streaming response
async function handleNonStreamingResponse(
  providerResponse: Response,
  user: { organization_id: string | null; id: string },
  apiKey: { id: string } | null,
  model: string,
  provider: string,
  startTime: number,
  reservedAmount?: number,
) {
  // Parse response
  const data: OpenAIChatResponse = await providerResponse.json();

  // Extract usage
  const usage = data.usage;
  const content = data.choices[0]?.message?.content || "";

  // Reconcile credits: refund difference if actual < reserved
  if (usage && user.organization_id && reservedAmount) {
    const organizationId = user.organization_id;
    const { inputCost, outputCost, totalCost } = await calculateCost(
      model,
      provider,
      usage.prompt_tokens,
      usage.completion_tokens,
    );

    await creditsService.reconcile({
      organizationId,
      reservedAmount,
      actualCost: totalCost,
      description: `Responses API: ${model}`,
      metadata: { user_id: user.id },
    });

    // Background analytics (usage records, generation records)
    (async () => {
      try {
        const usageRecord = await usageService.create({
          organization_id: organizationId,
          user_id: user.id,
          api_key_id: apiKey?.id || null,
          type: "chat",
          model,
          provider: "vercel-gateway",
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          input_cost: String(inputCost),
          output_cost: String(outputCost),
          is_successful: true,
        });

        if (apiKey) {
          await generationsService.create({
            organization_id: organizationId,
            user_id: user.id,
            api_key_id: apiKey.id,
            type: "chat",
            model,
            provider: "vercel-gateway",
            prompt: JSON.stringify(data.choices[0]?.message),
            status: "completed",
            content,
            tokens: usage.total_tokens,
            cost: String(totalCost),
            credits: String(totalCost),
            usage_record_id: usageRecord.id,
            completed_at: new Date(),
            result: {
              text: content,
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            },
          });
        }

        logger.info("[Responses API] Chat completion completed", {
          durationMs: Date.now() - startTime,
          tokens: usage.total_tokens,
          cost: String(totalCost),
        });
      } catch (error) {
        logger.error("[Responses API] Analytics error:", error);
      }
    })().catch((err) => {
      logger.error("[Responses API] Background analytics failed:", err);
    });
  }

  // Transform OpenAI response to AI SDK format before returning
  const aiSdkResponse = transformOpenAIToAISdk(data);

  return Response.json(aiSdkResponse);
}

// Handle streaming response - transforms OpenAI SSE to AI SDK streaming protocol
function handleStreamingResponse(
  providerResponse: Response,
  user: { organization_id: string | null; id: string },
  apiKey: { id: string } | null,
  model: string,
  provider: string,
  startTime: number,
  messages: Array<{ role: string; content: string | object }>,
  reservedAmount?: number,
) {
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let fullContent = "";

  // Create transform stream to convert OpenAI format to AI SDK streaming protocol
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Helper to write AI SDK streaming events with backpressure handling
  // AI SDK expects just "data:" lines with type in the JSON payload, NOT "event:" lines
  const writeEvent = async (data: object) => {
    await writer.ready;
    const dataLine = `data: ${JSON.stringify(data)}\n\n`;
    await writer.write(encoder.encode(dataLine));
  };

  // Process stream in background
  (async () => {
    try {
      const reader = providerResponse.body?.getReader();
      if (!reader) throw new Error("No response body");

      let responseId = "";
      let responseModel = model;
      let createdAt = Math.floor(Date.now() / 1000);
      let sentCreated = false;
      let sentOutputItemAdded = false;
      const itemId = `msg_${Date.now()}`;
      let outputIndex = 0;

      // Buffer for handling partial chunks that split across network boundaries
      let lineBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Append to buffer using streaming mode to handle multi-byte chars properly
        lineBuffer += decoder.decode(value, { stream: true });

        // Split into lines, keeping last potentially incomplete line in buffer
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") {
              // Send response.output_item.done event
              await writeEvent({
                type: "response.output_item.done",
                output_index: outputIndex,
                item: {
                  type: "message",
                  id: itemId,
                  role: "assistant",
                  content: [
                    { type: "output_text", text: fullContent, annotations: [] },
                  ],
                  status: "completed",
                },
              });

              // Send response.completed event
              await writeEvent({
                type: "response.completed",
                response: {
                  id: responseId,
                  object: "response",
                  created_at: createdAt,
                  model: responseModel,
                  status: "completed",
                  incomplete_details: null,
                  output: [
                    {
                      type: "message",
                      id: itemId,
                      role: "assistant",
                      content: [
                        {
                          type: "output_text",
                          text: fullContent,
                          annotations: [],
                        },
                      ],
                      status: "completed",
                    },
                  ],
                  usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    total_tokens: totalTokens,
                  },
                  error: null,
                },
              });
              continue;
            }
            if (!data.trim()) continue;

            try {
              const parsed = JSON.parse(data);

              // Extract metadata from first chunk
              if (!responseId && parsed.id) {
                responseId = parsed.id;
                responseModel = parsed.model || model;
                createdAt = parsed.created || Math.floor(Date.now() / 1000);
              }

              // Send response.created event on first chunk
              if (!sentCreated) {
                sentCreated = true;
                await writeEvent({
                  type: "response.created",
                  response: {
                    id: responseId,
                    object: "response",
                    created_at: createdAt,
                    model: responseModel,
                    status: "in_progress",
                    incomplete_details: null,
                    output: [],
                    usage: null,
                    error: null,
                  },
                });
              }

              // Send response.output_item.added on first content chunk
              if (!sentOutputItemAdded) {
                sentOutputItemAdded = true;
                await writeEvent({
                  type: "response.output_item.added",
                  output_index: outputIndex,
                  item: {
                    type: "message",
                    id: itemId,
                    role: "assistant",
                    content: [],
                    status: "in_progress",
                  },
                });
              }

              // Extract and emit text deltas
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                fullContent += content;
                await writeEvent({
                  type: "response.output_text.delta",
                  item_id: itemId,
                  output_index: outputIndex,
                  content_index: 0,
                  delta: content,
                });
              }

              // Extract usage from final chunk (if available)
              if (parsed.usage) {
                inputTokens = parsed.usage.prompt_tokens || 0;
                outputTokens = parsed.usage.completion_tokens || 0;
                totalTokens = parsed.usage.total_tokens || 0;
              }
            } catch (parseError) {
              // Log parsing failures as warnings - silent failures are hard to debug
              logger.warn("[Responses API] Failed to parse streaming chunk", {
                line: line.substring(0, 200), // Truncate to avoid log spam
                error:
                  parseError instanceof Error
                    ? parseError.message
                    : String(parseError),
              });
            }
          }
        }
      }

      // Flush decoder and process any remaining buffered content
      const finalChunk = decoder.decode();
      if (finalChunk) {
        lineBuffer += finalChunk;
      }

      // Process any remaining complete line in buffer
      if (lineBuffer.trim() && lineBuffer.startsWith("data: ")) {
        const data = lineBuffer.slice(6);
        if (data !== "[DONE]" && data.trim()) {
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullContent += content;
              await writeEvent({
                type: "response.output_text.delta",
                item_id: itemId,
                output_index: outputIndex,
                content_index: 0,
                delta: content,
              });
            }
            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens || 0;
              outputTokens = parsed.usage.completion_tokens || 0;
              totalTokens = parsed.usage.total_tokens || 0;
            }
          } catch {
            // Final buffer wasn't a complete JSON - this is expected if the stream ended cleanly
          }
        }
      }

      writer.close();

      // After stream completes, record analytics
      if (totalTokens === 0) {
        logger.warn(
          "[Responses API] No usage data in stream, estimating tokens",
          {
            model,
            contentLength: fullContent.length,
          },
        );

        // Estimate tokens from content
        const messageText = messages
          .map((m) =>
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content),
          )
          .join(" ");
        inputTokens = estimateTokens(messageText);
        outputTokens = estimateTokens(fullContent);
        totalTokens = inputTokens + outputTokens;
      }

      if (totalTokens > 0) {
        const { inputCost, outputCost, totalCost } = await calculateCost(
          model,
          provider,
          inputTokens,
          outputTokens,
        );

        // Reconcile credits: refund difference if actual < reserved
        if (user.organization_id && reservedAmount) {
          await creditsService.reconcile({
            organizationId: user.organization_id,
            reservedAmount,
            actualCost: totalCost,
            description: `Responses API: ${model}`,
            metadata: { user_id: user.id },
          });

          const usageRecord = await usageService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            api_key_id: apiKey?.id || null,
            type: "chat",
            model,
            provider: "vercel-gateway",
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            input_cost: String(inputCost),
            output_cost: String(outputCost),
            is_successful: true,
          });

          if (apiKey) {
            await generationsService.create({
              organization_id: user.organization_id,
              user_id: user.id,
              api_key_id: apiKey.id,
              type: "chat",
              model,
              provider: "vercel-gateway",
              prompt: JSON.stringify(messages),
              status: "completed",
              content: fullContent,
              tokens: totalTokens,
              cost: String(totalCost),
              credits: String(totalCost),
              usage_record_id: usageRecord.id,
              completed_at: new Date(),
              result: {
                text: fullContent,
                inputTokens,
                outputTokens,
                totalTokens,
              },
            });
          }

          logger.info("[Responses API] Streaming chat completed", {
            durationMs: Date.now() - startTime,
            tokens: totalTokens,
            cost: String(totalCost),
          });
        } else {
          // Anonymous user - just log completion without billing
          logger.info("[Responses API] Anonymous streaming chat completed", {
            durationMs: Date.now() - startTime,
            tokens: totalTokens,
            userId: user.id,
          });
        }
      }
    } catch (error) {
      logger.error("[Responses API] Streaming error:", error);
      writer.abort();
    }
  })();

  // Return streaming response immediately
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.STRICT);
