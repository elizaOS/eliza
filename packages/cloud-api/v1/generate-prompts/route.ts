/**
 * POST /api/v1/generate-prompts
 *
 * Streaming agent-concept generator (Pattern A: AI SDK
 * `toTextStreamResponse()`). Returns a `ReadableStream` Response —
 * Hono passes it through unchanged.
 */

import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUser } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    await requireUser(c);

    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as {
      seed?: string | number;
    };
    const promptSeed =
      typeof body.seed === "string" || typeof body.seed === "number"
        ? String(body.seed)
        : String(Date.now());

    const result = streamText({
      model: openai("gpt-4o"),
      messages: [
        {
          role: "system",
          content: `You are a practical AI agent concept generator. Generate 4 SHORT, USEFUL agent concepts (max 8 words each) that are DIVERSE and practical for real-world utility.

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

Random seed: ${promptSeed}`,
        },
        {
          role: "user",
          content:
            "Generate 4 short, practical agent concepts for real-world utility. Keep each under 8 words. Make them diverse across different domains.",
        },
      ],
      temperature: 1.5,
      maxOutputTokens: 500,
      topP: 0.95,
    });

    return result.toTextStreamResponse();
  } catch (error) {
    logger.error("[Generate Prompts] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
