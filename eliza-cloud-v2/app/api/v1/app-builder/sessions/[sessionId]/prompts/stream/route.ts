/**
 * Stream API Route - AI SDK v6 Based Streaming with Full Tool Execution
 *
 * This route provides streaming responses using Vercel's AI SDK v6
 * with full tool execution support (file writes, build checks, etc.).
 * Uses AI Gateway for model flexibility.
 *
 * IMPORTANT: Exposes BOTH regular text AND reasoning/thinking tokens:
 * - "thinking" events: Regular text output from the model
 * - "reasoning" events: Chain-of-thought / deep thinking tokens
 *
 * Reasoning tokens are the internal thought process that models like
 * Claude 3.5, o1, and DeepSeek use for complex problem solving.
 */

import type { NextRequest } from "next/server";

// Max duration for AI-powered code generation with tool execution
// Fluid compute limits: Hobby 300s, Pro/Enterprise 800s
export const maxDuration = 800;
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appBuilderAISDK } from "@/lib/services/app-builder-ai-sdk";
import { aiAppBuilder } from "@/lib/services/ai-app-builder";
import { sandboxService } from "@/lib/services/sandbox";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";
import { checkRateLimitAsync } from "@/lib/middleware/rate-limit";
import { getErrorStatusCode, getSafeErrorMessage } from "@/lib/api/errors";
import { createStreamWriter, SSE_HEADERS } from "@/lib/api/stream-utils";

const PROMPT_RATE_LIMIT = {
  windowMs: 60000,
  maxRequests: process.env.NODE_ENV === "production" ? 20 : 100,
};

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

/** Image attachment in base64 format */
const ImageSchema = z.object({
  base64: z.string(),
  mimeType: z.string(),
});

const SendPromptSchema = z.object({
  prompt: z.string().min(1).max(10000),
  model: z.string().optional(), // Optional model selection
  images: z.array(ImageSchema).max(5).optional(), // Up to 5 images
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;

    await aiAppBuilder.verifySessionOwnership(sessionId, user.id);

    const rateLimitResult = await checkRateLimitAsync(
      request,
      PROMPT_RATE_LIMIT,
    );
    if (!rateLimitResult.allowed) {
      const maxRequests = PROMPT_RATE_LIMIT.maxRequests;
      const windowSeconds = PROMPT_RATE_LIMIT.windowMs / 1000;
      return new Response(
        JSON.stringify({
          success: false,
          error: `Rate limit exceeded. Maximum ${maxRequests} prompts per ${windowSeconds}s.`,
          retryAfter: rateLimitResult.retryAfter,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": rateLimitResult.retryAfter?.toString() || "60",
          },
        },
      );
    }

    const body = await request.json();
    const validationResult = SendPromptSchema.safeParse(body);

    if (!validationResult.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const { prompt, model, images } = validationResult.data;

    const stream = new TransformStream();
    const rawWriter = stream.writable.getWriter();
    const streamWriter = createStreamWriter(rawWriter);

    const abortController = new AbortController();

    request.signal?.addEventListener("abort", () => {
      logger.info("Client aborted request", { sessionId });
      abortController.abort();
    });

    (async () => {
      streamWriter.startHeartbeat(15000);

      try {
        // Get session and sandbox instance
        const session = await aiAppBuilder.getSession(sessionId, user.id);
        if (!session) {
          throw new Error("Session not found");
        }

        // Get the actual sandbox instance from sandboxService
        const sandbox = session.sandboxId
          ? sandboxService.getSandboxInstance(session.sandboxId)
          : undefined;

        // Buffer for batching thinking text chunks
        let thinkingBuffer = "";
        let thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const THINKING_FLUSH_INTERVAL_MS = 50; // Batch thinking chunks every 50ms for faster feedback
        const THINKING_MIN_CHUNK_SIZE = 5; // Low threshold for faster first paint

        // Buffer for batching reasoning/CoT tokens (deep thinking)
        let reasoningBuffer = "";
        let reasoningFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const REASONING_FLUSH_INTERVAL_MS = 30; // Faster flush for reasoning - users want to see thought process
        const REASONING_MIN_CHUNK_SIZE = 3; // Even lower threshold for immediate feedback

        const flushThinkingBuffer = async () => {
          if (thinkingBuffer && streamWriter.isConnected()) {
            await streamWriter.sendEvent("thinking", {
              text: thinkingBuffer, // Full text - no truncation!
            });
            thinkingBuffer = "";
          }
          thinkingFlushTimer = null;
        };

        const flushReasoningBuffer = async () => {
          if (reasoningBuffer && streamWriter.isConnected()) {
            await streamWriter.sendEvent("reasoning", {
              text: reasoningBuffer, // Full text - no truncation!
            });
            reasoningBuffer = "";
          }
          reasoningFlushTimer = null;
        };

        const scheduleThinkingFlush = () => {
          if (!thinkingFlushTimer) {
            thinkingFlushTimer = setTimeout(
              flushThinkingBuffer,
              THINKING_FLUSH_INTERVAL_MS,
            );
          }
        };

        const scheduleReasoningFlush = () => {
          if (!reasoningFlushTimer) {
            reasoningFlushTimer = setTimeout(
              flushReasoningBuffer,
              REASONING_FLUSH_INTERVAL_MS,
            );
          }
        };

        // Execute with AI SDK streaming and full tool execution
        for await (const event of appBuilderAISDK.executeStream(prompt, {
          sandbox,
          sandboxId: session.sandboxId,
          appId: session.appId,
          model,
          images,
          abortSignal: abortController.signal,
        })) {
          // Check for abort
          if (abortController.signal.aborted) {
            logger.info("Stream aborted by client", { sessionId });
            break;
          }

          // Handle different event types
          switch (event.type) {
            case "thinking":
              // Buffer thinking text to batch small chunks together
              thinkingBuffer += event.text;
              if (thinkingBuffer.length >= THINKING_MIN_CHUNK_SIZE) {
                await flushThinkingBuffer();
              } else {
                scheduleThinkingFlush();
              }
              break;

            case "reasoning":
              // Chain-of-thought / deep reasoning tokens
              // These are the model's internal thought process (CoT)
              reasoningBuffer += event.text;
              if (reasoningBuffer.length >= REASONING_MIN_CHUNK_SIZE) {
                await flushReasoningBuffer();
              } else {
                scheduleReasoningFlush();
              }
              break;

            case "tool_call":
              // Flush any pending thinking/reasoning before tool calls
              if (thinkingBuffer) {
                await flushThinkingBuffer();
              }
              if (reasoningBuffer) {
                await flushReasoningBuffer();
              }
              // Send tool_start event for instant UI feedback WITH reasoning context
              if (streamWriter.isConnected()) {
                await streamWriter.sendEvent("tool_start", {
                  tool: event.toolName,
                  input: event.args,
                  reasoningContext: event.reasoningContext, // Reasoning that led to this tool call
                });
              }
              break;

            case "tool_result":
              // Send tool_use event when tool completes - no truncation!
              if (streamWriter.isConnected()) {
                await streamWriter.sendEvent("tool_use", {
                  tool: event.toolName,
                  input: event.args,
                  result:
                    typeof event.result === "string"
                      ? event.result
                      : JSON.stringify(event.result),
                });
              }
              break;

            case "complete":
              // Flush any remaining thinking/reasoning text
              if (thinkingBuffer) {
                await flushThinkingBuffer();
              }
              if (reasoningBuffer) {
                await flushReasoningBuffer();
              }
              if (thinkingFlushTimer) {
                clearTimeout(thinkingFlushTimer);
              }
              if (reasoningFlushTimer) {
                clearTimeout(reasoningFlushTimer);
              }
              if (streamWriter.isConnected()) {
                await streamWriter.sendEvent("complete", {
                  success: event.result.success,
                  output: event.result.output,
                  reasoning: event.result.reasoning, // Pass reasoning for collapsible display
                  filesAffected: event.result.filesAffected,
                  error: event.result.error,
                  toolCallCount: event.result.toolCallCount,
                });
              }
              break;

            case "error":
              // Flush any remaining thinking/reasoning text
              if (thinkingBuffer) {
                await flushThinkingBuffer();
              }
              if (reasoningBuffer) {
                await flushReasoningBuffer();
              }
              if (thinkingFlushTimer) {
                clearTimeout(thinkingFlushTimer);
              }
              if (reasoningFlushTimer) {
                clearTimeout(reasoningFlushTimer);
              }
              if (streamWriter.isConnected()) {
                await streamWriter.sendEvent("error", {
                  success: false,
                  error: event.error,
                });
              }
              break;
          }
        }

        // Ensure any remaining buffers are flushed
        if (thinkingFlushTimer) {
          clearTimeout(thinkingFlushTimer);
        }
        if (reasoningFlushTimer) {
          clearTimeout(reasoningFlushTimer);
        }
        if (thinkingBuffer) {
          await flushThinkingBuffer();
        }
        if (reasoningBuffer) {
          await flushReasoningBuffer();
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to send prompt";

        if (
          errorMessage.includes("aborted") ||
          errorMessage.includes("cancelled")
        ) {
          logger.info("Prompt operation cancelled", { sessionId });
          if (streamWriter.isConnected()) {
            await streamWriter.sendEvent("cancelled", {
              success: false,
              error: "Operation cancelled",
            });
          }
        } else {
          logger.error("Failed to send prompt via stream", {
            error: errorMessage,
            sessionId,
          });
          if (streamWriter.isConnected()) {
            await streamWriter.sendEvent("error", {
              success: false,
              error: errorMessage,
            });
          }
        }
      } finally {
        await streamWriter.close();
      }
    })();

    return new Response(stream.readable, { headers: SSE_HEADERS });
  } catch (error) {
    logger.error("Auth or ownership verification failed for prompt stream", {
      error,
    });
    const status = getErrorStatusCode(error);
    const message = getSafeErrorMessage(error);

    return new Response(JSON.stringify({ success: false, error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * GET endpoint to list available models for the app builder
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;

    await aiAppBuilder.verifySessionOwnership(sessionId, user.id);

    const models = appBuilderAISDK.getAvailableModels();

    return new Response(
      JSON.stringify({
        success: true,
        models,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    logger.error("Failed to get models for stream", { error });
    const status = getErrorStatusCode(error);
    const message = getSafeErrorMessage(error);

    return new Response(JSON.stringify({ success: false, error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
