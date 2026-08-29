/**
 * POST /api/v1/generate-prompts
 *
 * Streaming agent-concept generator (Pattern A: AI SDK
 * `toTextStreamResponse()`). Returns a `ReadableStream` Response —
 * Hono passes it through unchanged.
 */

import { openai } from "@ai-sdk/openai";
import { assertModelOutputComplete } from "@elizaos/core";
import { streamText } from "ai";
import { Hono } from "hono";
import {
  asGenerativeCacheApiError,
  getGenerativeExecutionContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { estimateTokens } from "@/lib/pricing";
import { billUsage } from "@/lib/services/ai-billing";
import { admitOrganizationInference } from "@/lib/services/organization-inference-admission";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  let admission:
    | Awaited<ReturnType<typeof admitOrganizationInference>>
    | undefined;
  let providerDispatchStarted = false;
  try {
    const caller = await requireGenerativeRouteCaller(c, {
      rateLimitEndpoint: "strict",
    });

    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as {
      seed?: string | number;
    };
    const promptSeed =
      typeof body.seed === "string" || typeof body.seed === "number"
        ? String(body.seed)
        : String(Date.now());
    const systemPrompt = `Generate 4 SHORT, USEFUL agent concepts (max 8 words each) that are DIVERSE and practical for real-world utility.

CRITICAL: Focus on UTILITY-BASED agents that help with real tasks. Mix different domains:
- Business & productivity (sales, support, analytics, scheduling)
- Creative & content (writing, design, research, editing)
- Technical & development (coding, debugging, documentation, DevOps)
- Personal & lifestyle (fitness, finance, learning, wellness)
- Communication & social (community management, translation, moderation)

Keep concepts:
- SHORT (5-8 words maximum)
- PRACTICAL (real utility, not fantasy)
- SPECIFIC (clear use case)
- VARIED (different industries/domains)

Examples of GOOD prompts:
- "Technical documentation writer with dry humor"
- "Personal finance advisor for freelancers"
- "Code reviewer focused on security best practices"
- "Social media content strategist for startups"
- "Customer support specialist with endless patience"
- "Data analyst explaining insights in simple terms"
- "Meeting notes summarizer with action items"
- "Fitness coach for busy professionals"

BAD prompts (too long, too fantasy):
- "Renaissance alchemist trapped in simulation..."
- "Time-traveling wizard from the year..."

Return ONLY a JSON array of exactly 4 strings, nothing else. No markdown, no explanation.

Random seed: ${promptSeed}`;
    const userPrompt =
      "Generate 4 short, practical agent concepts for real-world utility. Keep each under 8 words. Make them diverse across different domains.";
    const executionCtx = getGenerativeExecutionContext(c);
    const requestId = `generate-prompts:${crypto.randomUUID()}`;
    admission = await admitOrganizationInference({
      context: {
        organizationId: caller.user.organization_id,
        userId: caller.user.id,
        apiKeyId: caller.apiKeyId,
        model: "gpt-4o",
        provider: "openai",
        billingSource: "openai",
        requestId,
        description: "generate-prompts agent-concept suggestions",
      },
      apiKeyId: caller.apiKeyId,
      estimatedInputTokens: estimateTokens(`${systemPrompt}\n${userPrompt}`),
      estimatedOutputTokens: 128,
      executionCtx,
      admissionSnapshot: caller.admissionSnapshot,
    });
    await admission.markProviderDispatched?.();
    providerDispatchStarted = true;

    const result = streamText({
      model: openai("gpt-4o"),
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 1.5,
      topP: 0.95,
      onFinish: ({ finishReason }) => {
        assertModelOutputComplete({
          finishReason,
          provider: "openai",
          model: "gpt-4o",
        });
      },
    });

    // Bill actual gpt-4o token usage once the stream settles. This route
    // previously served inference UNBILLED (audit finding: the platform paid
    // OpenAI for every call); `result.usage` resolves after the stream
    // finishes, and waitUntil settles the charge without delaying the
    // streamed response.
    const settlement = (async () => {
      try {
        const usage = await result.usage;
        const billing = await billUsage(
          {
            organizationId: caller.user.organization_id,
            userId: caller.user.id,
            apiKeyId: caller.apiKeyId,
            model: "gpt-4o",
            provider: "openai",
            billingSource: "openai",
            requestId,
            description: "generate-prompts agent-concept suggestions",
          },
          usage,
          admission.reservation,
        );
        await admission.settle(billing.totalCost);
      } catch (error) {
        await admission.settleUnknown();
        // error-policy:J7 billing settlement runs post-response; a failure
        // must be loud in logs (revenue) but cannot affect the stream.
        logger.error("[generate-prompts] usage billing failed", {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    if (executionCtx) executionCtx.waitUntil(settlement);
    else await settlement;

    return result.toTextStreamResponse();
  } catch (error) {
    if (admission) {
      const terminal = providerDispatchStarted
        ? admission.settleUnknown()
        : admission.settle(0);
      const executionCtx = getGenerativeExecutionContext(c);
      const observed = terminal.catch((settlementError) => {
        logger.error("[generate-prompts] admission release failed", {
          error:
            settlementError instanceof Error
              ? settlementError.message
              : String(settlementError),
        });
      });
      if (executionCtx) executionCtx.waitUntil(observed);
      else await observed;
    }
    logger.error("[Generate Prompts] Error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});

export default app;
