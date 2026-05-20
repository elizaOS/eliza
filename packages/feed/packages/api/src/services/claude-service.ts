/**
 * Direct Claude (Anthropic) LLM calls
 *
 * For moderation and evaluation tasks that require Claude's superior reasoning
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@babylon/shared';

export async function callClaudeDirect(params: {
  prompt: string;
  system?: string;
  model?: 'claude-sonnet-4-5' | 'claude-haiku-4-5' | 'claude-opus-4-1';
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const elizacloudKey = process.env.ELIZACLOUD_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!elizacloudKey && !anthropicKey) {
    throw new Error(
      'No API key configured for Claude — set ELIZACLOUD_API_KEY or ANTHROPIC_API_KEY'
    );
  }

  let anthropic: Anthropic;
  if (elizacloudKey) {
    const base = (
      process.env.ELIZACLOUD_API_URL || 'https://api.elizacloud.com'
    ).replace(/\/$/, '');
    anthropic = new Anthropic({
      apiKey: elizacloudKey,
      baseURL: `${base}/anthropic/v1`,
    });
  } else {
    anthropic = new Anthropic({
      apiKey: anthropicKey!,
    });
  }

  const model = params.model || 'claude-sonnet-4-5';

  const startTime = Date.now();

  const message = await anthropic.messages.create({
    model,
    max_tokens: params.maxTokens || 8192,
    temperature: params.temperature ?? 0.3,
    system: params.system,
    messages: [
      {
        role: 'user',
        content: params.prompt,
      },
    ],
  });

  const latencyMs = Date.now() - startTime;

  const firstContent = message.content[0];
  if (!firstContent || firstContent.type !== 'text') {
    throw new Error('Unexpected response format from Claude');
  }

  logger.debug(
    'Claude API call completed',
    {
      model,
      latencyMs,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
    'ClaudeDirect'
  );

  return firstContent.text;
}
