/**
 * App-specific chat completions endpoint.
 * Uses app credits and applies creator markup for monetization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  nextStyleParams,
  type RouteContext,
} from "@/lib/api/hono-next-style-params";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import {
  addCorsHeaders,
  createPreflightResponse,
} from "@/lib/middleware/cors-apps";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  calculateCost,
  estimateTokens,
  getProviderFromModel,
  normalizeModelName,
} from "@/lib/pricing";
import {
  getProviderForModelWithFallback,
  withProviderFallback,
} from "@/lib/providers";
import {
  canonicalizeCerebrasModelId,
  getAiProviderConfigurationError,
  hasLanguageModelProviderConfigured,
  resolveAiProviderSource,
} from "@/lib/providers/language-model";
import type {
  OpenAIChatMessage,
  OpenAIChatRequest,
  ProviderHttpError,
} from "@/lib/providers/types";
import { appCreditsService } from "@/lib/services/app-credits";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import { getRouteTimeoutMs } from "@/lib/utils/request-timeout";
import type { AppEnv } from "@/types/cloud-worker-env";
import { reservationOutputTokens } from "./chat-reservation";
import { reconcileChatSettleError } from "./stream-refund";

const ROUTE_MAX_DURATION = 800;

// Safety multiplier for cost estimation to reduce undercharging risk
// We charge 1.5x estimated upfront, then reconcile to actual
const COST_SAFETY_MULTIPLIER = 1.5;
const APP_CHAT_RESERVATION_SETTLEMENT_MARKER = "app_chat_reservation_v1";

function isProviderHttpError(error: unknown): error is ProviderHttpError {
  return Boolean(
    error &&
      typeof error === "object" &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number" &&
      "error" in error,
  );
}

function providerFailureResponse(error: unknown) {
  if (isProviderHttpError(error)) {
    const status = error.status;
    return {
      status,
      body: {
        error: {
          message: error.error.message,
          type:
            error.error.type ??
            (status === 402
              ? "insufficient_quota"
              : status === 429
                ? "rate_limit_error"
                : "api_error"),
          code:
            error.error.code ??
            (status === 402
              ? "provider_insufficient_credits"
              : status === 429
                ? "provider_rate_limited"
                : "provider_error"),
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("insufficient funds") ||
    normalized.includes("insufficient credits") ||
    (normalized.includes("credits") && normalized.includes("top up"))
  ) {
    return {
      status: 402,
      body: {
        error: {
          message,
          type: "insufficient_quota",
          code: "provider_insufficient_credits",
        },
      },
    };
  }

  return {
    status: 503,
    body: {
      error: {
        message: "Service temporarily unavailable. Credits refunded.",
        type: "api_error",
        code: "provider_error",
      },
    },
  };
}

/**
 * OPTIONS /api/v1/apps/[id]/chat
 * CORS preflight handler for app chat endpoint.
 */
async function __next_OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return createPreflightResponse(origin, ["POST", "OPTIONS"]);
}

/**
 * POST /api/v1/apps/[id]/chat
 * App-specific chat completions endpoint using app credits.
 *
 * This endpoint:
 * 1. Uses app-specific credit balance (not organization credits)
 * 2. Applies creator markup if monetization is enabled
 * 3. Records creator earnings from inference
 *
 * Request body follows OpenAI chat completions format.
 *
 * @returns Streaming or non-streaming chat completion response.
 */
async function handlePOST(
  request: Request,
  context: RouteContext<{ id: string }>,
): Promise<Response> {
  const startTime = Date.now();
  const origin = request.headers.get("origin");
  const routeTimeoutMs = getRouteTimeoutMs(ROUTE_MAX_DURATION);

  // Use shared CORS helper for consistent headers
  const withCors = (response: Response): Response =>
    addCorsHeaders(response, origin, ["POST", "OPTIONS"]);

  try {
    if (!context?.params) {
      return withCors(
        Response.json(
          {
            error: {
              message: "Missing route parameters",
              type: "invalid_request_error",
            },
          },
          { status: 400 },
        ),
      );
    }

    const { id: appId } = await context.params;

    // Parallelize independent operations for better performance
    const [app, authResult, chatRequest] = await Promise.all([
      appsService.getById(appId),
      requireAuthOrApiKeyWithOrg(request),
      request.json() as Promise<OpenAIChatRequest>,
    ]);

    if (!app) {
      return withCors(
        Response.json(
          {
            error: {
              message: "App not found",
              type: "invalid_request_error",
              code: "app_not_found",
            },
          },
          { status: 404 },
        ),
      );
    }

    const { user } = authResult;
    if (await isAppKeyOutOfScope(authResult.apiKey?.id, appId)) {
      return withCors(
        Response.json(
          {
            error: {
              message: "Access denied to this app",
              type: "invalid_request_error",
              code: "access_denied",
            },
          },
          { status: 403 },
        ),
      );
    }

    // Access control: non-monetized apps are internal (same org only)
    // Monetized apps are public (anyone with credits can use)
    if (
      !app.monetization_enabled &&
      app.organization_id !== user.organization_id
    ) {
      return withCors(
        Response.json(
          {
            error: {
              message: "Access denied to this app",
              type: "invalid_request_error",
              code: "access_denied",
            },
          },
          { status: 403 },
        ),
      );
    }

    // Validate request
    if (!chatRequest.model || !chatRequest.messages) {
      return withCors(
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

    if (
      !Array.isArray(chatRequest.messages) ||
      chatRequest.messages.length === 0
    ) {
      return withCors(
        Response.json(
          {
            error: {
              message: "messages must be a non-empty array",
              type: "invalid_request_error",
              code: "invalid_value",
            },
          },
          { status: 400 },
        ),
      );
    }

    const model = canonicalizeCerebrasModelId(chatRequest.model);
    chatRequest.model = model;
    if (!hasLanguageModelProviderConfigured(model)) {
      return withCors(
        Response.json(
          {
            error: {
              message: getAiProviderConfigurationError(),
              type: "service_unavailable",
              code: "ai_provider_not_configured",
            },
          },
          { status: 503 },
        ),
      );
    }

    const provider = getProviderFromModel(model);
    const normalizedModel = normalizeModelName(model);
    const billingSource = resolveAiProviderSource(model) ?? "gateway";
    const isStreaming = chatRequest.stream ?? false;

    // Estimate cost
    const inputText = chatRequest.messages
      .map((m: OpenAIChatMessage) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
      .join(" ");

    const estimatedInputTokens = estimateTokens(inputText);
    // #10924: reserve for the caller's max_tokens ceiling (forwarded to the
    // provider), not a fixed estimate — otherwise a low-balance caller drains
    // inference the all-or-nothing reconcile can't recover.
    const estimatedOutputTokens = reservationOutputTokens(
      chatRequest.max_tokens,
    );
    const { totalCost: estimatedBaseCost } = await calculateCost(
      normalizedModel,
      provider,
      estimatedInputTokens,
      estimatedOutputTokens,
      billingSource,
    );

    // Apply safety buffer to reduce undercharging risk
    // We charge more upfront, then reconcile to actual cost
    const reservedBaseCost = estimatedBaseCost * COST_SAFETY_MULTIPLIER;

    // Check and deduct app credits with markup (using buffered amount)
    // Pass app to avoid N+1 query (app already fetched above)
    const deductionResult = await appCreditsService.deductCredits({
      appId,
      userId: user.id,
      baseCost: reservedBaseCost,
      description: `Chat: ${model}`,
      metadata: {
        type: "app_chat_reservation",
        settlement_marker: APP_CHAT_RESERVATION_SETTLEMENT_MARKER,
        model,
        provider,
        billingSource,
        estimatedInputTokens,
        estimatedOutputTokens,
        estimated_cost: estimatedBaseCost,
        reserved_amount: reservedBaseCost,
        safetyMultiplier: COST_SAFETY_MULTIPLIER,
        reservation_buffer: COST_SAFETY_MULTIPLIER,
      },
      app, // Pass pre-fetched app to avoid duplicate DB query
    });

    if (!deductionResult.success) {
      logger.warn("[App Chat] Insufficient cloud credits", {
        appId,
        userId: user.id,
        required: deductionResult.totalCost,
        message: deductionResult.message,
      });

      return withCors(
        Response.json(
          {
            error: {
              message:
                deductionResult.message ||
                `Insufficient cloud credits. Required: $${deductionResult.totalCost.toFixed(4)}`,
              type: "insufficient_quota",
              code: "insufficient_credits",
              required: deductionResult.totalCost,
              balance: deductionResult.newBalance,
            },
          },
          { status: 402 },
        ),
      );
    }
    const appChatReservationTransactionId =
      deductionResult.transactionId ?? null;

    logger.info("[App Chat] Credits deducted", {
      appId,
      userId: user.id,
      reservedBaseCost,
      baseCost: deductionResult.baseCost,
      creatorMarkup: deductionResult.creatorMarkup,
      totalCost: deductionResult.totalCost,
      creatorEarnings: deductionResult.creatorEarnings,
      newBalance: deductionResult.newBalance,
      monetizationEnabled: app.monetization_enabled,
    });

    // Forward to provider - wrap in try-catch to refund on failure
    const { primary: providerInstance, fallback: fallbackProvider } =
      getProviderForModelWithFallback(model);
    let providerResponse: Response;
    try {
      providerResponse = await withProviderFallback(
        () =>
          providerInstance.chatCompletions(chatRequest, {
            signal: request.signal,
            timeoutMs: routeTimeoutMs,
          }),
        fallbackProvider
          ? () =>
              fallbackProvider.chatCompletions(chatRequest, {
                signal: request.signal,
                timeoutMs: routeTimeoutMs,
              })
          : null,
      );
    } catch (providerError) {
      const failure = providerFailureResponse(providerError);

      // Provider call failed - refund the reserved credits
      logger.error("[App Chat] Provider call failed, refunding credits", {
        appId,
        userId: user.id,
        reservedBaseCost,
        status: failure.status,
        error: isProviderHttpError(providerError)
          ? providerError.error.message
          : providerError instanceof Error
            ? providerError.message
            : "Unknown error",
      });

      await appCreditsService.reconcileCredits({
        appId,
        userId: user.id,
        estimatedBaseCost: reservedBaseCost,
        actualBaseCost: 0, // Full refund
        description: "Refund due to provider error",
        metadata: { error: true, providerFailure: true },
        reservationTransactionId: appChatReservationTransactionId,
      });

      return withCors(Response.json(failure.body, { status: failure.status }));
    }

    if (isStreaming) {
      // For streaming: wrap response to capture usage and reconcile after completion
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const decoder = new TextDecoder();

      let inputTokens = 0;
      let outputTokens = 0;
      let fullContent = "";
      let writerClosed = false;
      // True once the client has received everything it will get and the
      // writer is closed — the full answer on success, or the refund error
      // event on the no-body path. Distinguishes "stream failed mid-delivery"
      // (refund) from "only post-delivery accounting threw" (do NOT refund —
      // money may already have moved).
      let streamCompleted = false;

      // Process stream in background with error handling
      (async () => {
        try {
          let lineBuffer = "";

          const reader = providerResponse.body?.getReader();
          if (!reader) {
            // No response body - refund credits and close stream
            logger.error(
              "[App Chat] No response body from provider, refunding credits",
              {
                appId,
                userId: user.id,
                reservedBaseCost,
              },
            );

            // Notify the client and close BEFORE the refund reconcile
            // (mirroring the settle path below: close writer, flip the flag,
            // then reconcile) so a reconcile throw can't strand the stream.
            const encoder = new TextEncoder();
            const errorEvent = `data: ${JSON.stringify({
              error: {
                message: "No response from provider. Credits refunded.",
                type: "api_error",
                code: "empty_response",
              },
            })}\n\ndata: [DONE]\n\n`;
            writer.write(encoder.encode(errorEvent));
            writerClosed = true;
            writer.close();
            // Fence BEFORE invoking the refund: reconcileCredits is not
            // transactional — its refund branch commits the org-balance
            // movement and can then throw from the earnings/counter writes.
            // With the flag flipped first, that throw reaches the catch as
            // "money may have moved" and reconcileStreamProcessingError does
            // NOT refund the full hold a second time (double-credit / mint).
            streamCompleted = true;

            await appCreditsService.reconcileCredits({
              appId,
              userId: user.id,
              estimatedBaseCost: reservedBaseCost,
              actualBaseCost: 0, // Full refund
              description: "Refund due to empty provider response",
              metadata: { error: true, noBody: true },
              reservationTransactionId: appChatReservationTransactionId,
              app,
            });
            return;
          }

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Forward chunk to client
            writer.write(value);

            // Parse chunk to extract usage info
            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() ?? "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]" || !data.trim()) continue;

                try {
                  const parsed = JSON.parse(data);

                  // Collect content for token estimation fallback
                  const content = parsed.choices?.[0]?.delta?.content;
                  if (content) {
                    fullContent += content;
                  }

                  // Extract usage from final chunk (if provider includes it)
                  if (parsed.usage) {
                    inputTokens = parsed.usage.prompt_tokens || 0;
                    outputTokens = parsed.usage.completion_tokens || 0;
                  }
                } catch {
                  // Skip malformed SSE data chunks - provider may send non-JSON lines
                  logger.debug("[App Chat] Skipping malformed SSE chunk", {
                    appId,
                    data: data.slice(0, 100),
                  });
                }
              }
            }
          }

          // Flush decoder
          const finalChunk = decoder.decode();
          if (finalChunk) {
            lineBuffer += finalChunk;
          }

          if (lineBuffer.trim() && lineBuffer.startsWith("data: ")) {
            const data = lineBuffer.slice(6);
            if (data !== "[DONE]" && data.trim()) {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) {
                  fullContent += content;
                }
                if (parsed.usage) {
                  inputTokens = parsed.usage.prompt_tokens || 0;
                  outputTokens = parsed.usage.completion_tokens || 0;
                }
              } catch {
                // Skip malformed final SSE chunk
                logger.debug("[App Chat] Skipping malformed final SSE chunk", {
                  appId,
                  data: data.slice(0, 100),
                });
              }
            }
          }

          writerClosed = true;
          writer.close();
          // The client has now received the complete answer. Anything that
          // throws below is post-delivery accounting only — must not refund.
          streamCompleted = true;

          // Fallback: estimate tokens if usage not provided
          if (inputTokens === 0 && outputTokens === 0) {
            const inputText = chatRequest.messages
              .map((m: OpenAIChatMessage) =>
                typeof m.content === "string"
                  ? m.content
                  : JSON.stringify(m.content),
              )
              .join(" ");
            inputTokens = estimateTokens(inputText);
            outputTokens = estimateTokens(fullContent);

            logger.warn("[App Chat] No usage data in stream, using estimates", {
              appId,
              inputTokens,
              outputTokens,
            });
          }

          // Calculate actual cost and reconcile
          const { totalCost: actualBaseCost } = await calculateCost(
            normalizedModel,
            provider,
            inputTokens,
            outputTokens,
            billingSource,
          );

          // Reconcile the difference between reserved and actual costs
          // Pass app to avoid N+1 query (app already fetched above)
          const reconciliation = await appCreditsService.reconcileCredits({
            appId,
            userId: user.id,
            estimatedBaseCost: reservedBaseCost,
            actualBaseCost,
            description: `Chat reconciliation: ${model}`,
            reservationTransactionId: appChatReservationTransactionId,
            metadata: {
              model,
              provider,
              billingSource,
              inputTokens,
              outputTokens,
              streaming: true,
            },
            app,
          });

          const duration = Date.now() - startTime;
          logger.info("[App Chat] Streaming request completed", {
            appId,
            userId: user.id,
            model,
            duration,
            inputTokens,
            outputTokens,
            reservedBaseCost,
            actualBaseCost,
            reconciliation: {
              action: reconciliation.action,
              amount: reconciliation.adjustedAmount,
            },
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";

          // Refund the reserved charge ONLY when the stream failed before the
          // client got the full answer. If it already completed and only the
          // post-stream accounting threw, keeping the charge avoids handing out
          // free inference. (See reconcileChatSettleError.)
          const { refunded } = await reconcileChatSettleError(
            {
              skipRefund: streamCompleted,
              skipRefundLog:
                "[App Chat] Post-stream accounting failed AFTER full delivery; keeping reserved charge (NOT refunding)",
              refundLog:
                "[App Chat] Stream processing failed before delivery, refunding reserved",
              refundDescription: "Refund due to stream error",
              refundMetadata: { error: true, streaming: true },
              appId,
              userId: user.id,
              reservedBaseCost,
              reservationTransactionId: appChatReservationTransactionId,
              errorMessage,
            },
            appCreditsService,
          );

          // Notify the client only when the stream failed mid-delivery (a
          // completed stream already closed the writer with the full answer).
          if (refunded && !writerClosed) {
            const errorEvent = `data: ${JSON.stringify({
              error: {
                message: "Stream interrupted. Credits refunded.",
                type: "api_error",
                code: "stream_error",
              },
            })}\n\ndata: [DONE]\n\n`;
            const encoder = new TextEncoder();
            writer.write(encoder.encode(errorEvent));
            writer.close();
          }
        }
      })();

      return withCors(
        new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
      );
    }

    // Non-streaming response. Everything below runs AFTER the upfront hold was
    // debited, so a throw here — a truncated body failing providerResponse.json(),
    // or calculateCost erroring — would strand the reserved hold (the streaming
    // branch is covered by the same settle-error refund; this one was not,
    // #11169). Full-refund on any failure BEFORE the settle completes; once
    // reconcileCredits has settled, a later throw must NOT refund (the charge is
    // real), mirroring the streaming branch's streamCompleted gating.
    let nonStreamingSettleStarted = false;
    try {
      const responseData = (await providerResponse.json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        choices?: Array<{ message?: { content?: string } }>;
      };

      // Calculate actual cost - use fallback estimation if provider doesn't return usage
      let actualInputTokens = responseData.usage?.prompt_tokens || 0;
      let actualOutputTokens = responseData.usage?.completion_tokens || 0;

      // Fallback: estimate tokens if usage not provided (matching streaming behavior)
      if (actualInputTokens === 0 && actualOutputTokens === 0) {
        const outputContent = responseData.choices?.[0]?.message?.content || "";
        actualInputTokens = estimatedInputTokens; // Use pre-calculated estimate
        actualOutputTokens = estimateTokens(outputContent);

        logger.warn("[App Chat] No usage data in response, using estimates", {
          appId,
          actualInputTokens,
          actualOutputTokens,
        });
      }

      const { totalCost: actualBaseCost } = await calculateCost(
        normalizedModel,
        provider,
        actualInputTokens,
        actualOutputTokens,
        billingSource,
      );

      // Reconcile the difference between reserved and actual costs
      // Pass app to avoid N+1 query (app already fetched above)
      // Flag the settle as STARTED *before* invoking reconcileCredits (not after
      // it returns): reconcileCredits commits its org-balance movement before its
      // non-transactional earnings/counter writes, so a throw mid-settle must not
      // let the catch refund the hold a second time (double-credit). (#11218)
      nonStreamingSettleStarted = true;
      const reconciliation = await appCreditsService.reconcileCredits({
        appId,
        userId: user.id,
        estimatedBaseCost: reservedBaseCost,
        actualBaseCost,
        description: `Chat reconciliation: ${model}`,
        reservationTransactionId: appChatReservationTransactionId,
        metadata: {
          model,
          provider,
          billingSource,
          inputTokens: actualInputTokens,
          outputTokens: actualOutputTokens,
          streaming: false,
        },
        app,
      });

      const duration = Date.now() - startTime;
      logger.info("[App Chat] Request completed", {
        appId,
        userId: user.id,
        model,
        duration,
        inputTokens: actualInputTokens,
        outputTokens: actualOutputTokens,
        reservedBaseCost,
        actualBaseCost,
        reconciliation: {
          action: reconciliation.action,
          amount: reconciliation.adjustedAmount,
        },
      });

      return withCors(Response.json(responseData));
    } catch (postProviderError) {
      const errorMessage =
        postProviderError instanceof Error
          ? postProviderError.message
          : String(postProviderError);
      // Refund the stranded hold ONLY if the settle never started. A throw
      // at/after the settle may have already moved money (reconcileCredits is
      // not transactional), so re-refunding would mint credits — the
      // stranded-reservation sweep recovers that rare window instead. `.catch`
      // so a refund failure can't mask the original error. (#11218)
      await reconcileChatSettleError(
        {
          skipRefund: nonStreamingSettleStarted,
          skipRefundLog:
            "[App Chat] Non-streaming throw at/after the settle reconcile; NOT refunding (movement may have committed — sweep recovers a stranded hold)",
          refundLog:
            "[App Chat] Non-streaming settle never started after debit; refunding reserved hold (#11169)",
          refundDescription: `Chat refund (non-streaming settle failed): ${model}`,
          refundMetadata: {
            error: true,
            streaming: false,
            model,
            provider,
            billingSource,
            refundReason: "non_streaming_settle_error",
          },
          appId,
          userId: user.id,
          reservedBaseCost,
          reservationTransactionId: appChatReservationTransactionId,
          errorMessage,
        },
        appCreditsService,
      ).catch((refundError) => {
        logger.error(
          "[App Chat] Non-streaming guard refund failed; surfacing original error",
          {
            appId,
            userId: user.id,
            refundError:
              refundError instanceof Error
                ? refundError.message
                : String(refundError),
          },
        );
      });
      throw postProviderError;
    }
  } catch (error) {
    logger.error("[App Chat] Error:", error);

    // Return proper error response with CORS headers
    return withCors(
      Response.json(
        {
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
            code: "internal_server_error",
          },
        },
        { status: 500 },
      ),
    );
  }
}

// Apply rate limiting to prevent abuse

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.options("/", async (c) => {
  try {
    return await __next_OPTIONS(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});
honoRouter.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handlePOST(c.req.raw, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
