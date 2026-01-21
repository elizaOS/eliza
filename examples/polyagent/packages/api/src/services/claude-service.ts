/**
 * Direct Claude (Anthropic) LLM calls
 *
 * For moderation and evaluation tasks that require Claude's superior reasoning
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "@polyagent/shared";

export async function callClaudeDirect(params: {
  prompt: string;
  system?: string;
  model?: "claude-sonnet-4-5" | "claude-haiku-4-5" | "claude-opus-4-1";
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const model = params.model || "claude-sonnet-4-5";

  const startTime = Date.now();

  const message = await anthropic.messages.create({
    model,
    max_tokens: params.maxTokens || 8192,
    temperature: params.temperature ?? 0.3,
    system: params.system,
    messages: [
      {
        role: "user",
        content: params.prompt,
      },
    ],
  });

  const latencyMs = Date.now() - startTime;

  const firstContent = message.content[0];
  if (!firstContent || firstContent.type !== "text") {
    throw new Error("Unexpected response format from Claude");
  }

  logger.debug(
    "Claude API call completed",
    {
      model,
      latencyMs,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
    "ClaudeDirect",
  );

  return firstContent.text;
}
