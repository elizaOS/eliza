import type { Plugin } from '@elizaos/core';
import { type GenerateTextParams, type IAgentRuntime, ModelType, logger } from '@elizaos/core';
import { z } from 'zod';

// Define configuration schema with Livepeer-specific settings
const configSchema = z.object({
  LIVEPEER_GATEWAY_URL: z.string().optional(),
  LIVEPEER_API_KEY: z.string().optional(),
  LIVEPEER_MODEL: z.string().optional(),
  LIVEPEER_LARGE_MODEL: z.string().optional(),
  LIVEPEER_TEMPERATURE: z
    .string()
    .optional()
    .transform((val) => (val ? parseFloat(val) : undefined)),
  LIVEPEER_MAX_TOKENS: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : undefined)),
});

// ---------------------------------------------------------------------------
// Utility: call Livepeer Gateway LLM
// ---------------------------------------------------------------------------

async function callLivepeerLLM(
  runtime: IAgentRuntime,
  {
    prompt,
    maxTokens = process.env.LIVEPEER_MAX_TOKENS ? parseInt(process.env.LIVEPEER_MAX_TOKENS) : 2048,
    temperature = process.env.LIVEPEER_TEMPERATURE
      ? parseFloat(process.env.LIVEPEER_TEMPERATURE)
      : 0.6,
  }: Pick<GenerateTextParams, 'prompt' | 'maxTokens' | 'temperature'> & {
    model?: string;
  }
): Promise<string> {
  const endpoint = process.env.LIVEPEER_GATEWAY_URL || runtime.getSetting('LIVEPEER_GATEWAY_URL');

  if (!endpoint) {
    throw new Error('Livepeer Gateway URL is not defined (LIVEPEER_GATEWAY_URL)');
  }

  // Use specific model if set in environment, otherwise use configurable model with fallback
  const model =
    process.env.LIVEPEER_LARGE_MODEL ||
    process.env.LIVEPEER_MODEL ||
    'meta-llama/Meta-Llama-3.1-8B-Instruct';

  // Log request details for debugging
  logger.info('Livepeer LLM Request:', {
    endpoint,
    model,
    systemPrompt:
      runtime.character.system || 'You are a helpful assistant powered by Livepeer Gateway',
    userPrompt: prompt.substring(0, 100) + (prompt.length > 100 ? '...' : ''),
    maxTokens,
    temperature,
  });

  const requestBody = {
    model,
    messages: [
      {
        role: 'system',
        content:
          runtime.character.system || 'You are a helpful assistant powered by Livepeer Gateway',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    max_tokens: maxTokens,
    temperature,
    stream: false,
  } as Record<string, unknown>;

  // Log the full request body for comparison with curl
  logger.info('Livepeer request body:', JSON.stringify(requestBody, null, 2));

  const res = await runtime.fetch(`${endpoint.replace(/\/$/, '')}/llm`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization:
        'Bearer ' +
        (process.env.LIVEPEER_API_KEY ||
          runtime.getSetting('LIVEPEER_API_KEY') ||
          'ElizaV2-llm-default'),
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error('Livepeer request failed:', {
      status: res.status,
      statusText: res.statusText,
      responseText: text,
      requestBody: JSON.stringify(requestBody),
    });
    throw new Error(`Livepeer request failed (${res.status}): ${text}`);
  }

  const json: any = await res.json();
  logger.info('Livepeer response received:', {
    choices: json?.choices?.length,
    hasContent: !!json?.choices?.[0]?.message?.content,
  });

  const content = json?.choices?.[0]?.message?.content as string | undefined;
  if (!content) {
    throw new Error('Invalid response format from Livepeer');
  }

  // Some models prepend code block tags – strip if present
  return content.replace(/<\|start_header_id\|>assistant<\|end_header_id\|>\n\n/, '');
}

// Export the plugin definition with only necessary components
export const livepeerPlugin: Plugin = {
  name: 'plugin-livepeer',
  description: 'Livepeer Gateway LLM provider for elizaOS',
  config: {
    LIVEPEER_GATEWAY_URL: process.env.LIVEPEER_GATEWAY_URL,
    LIVEPEER_API_KEY: process.env.LIVEPEER_API_KEY,
    LIVEPEER_MODEL: process.env.LIVEPEER_MODEL,
    LIVEPEER_LARGE_MODEL: process.env.LIVEPEER_LARGE_MODEL,
    LIVEPEER_TEMPERATURE: process.env.LIVEPEER_TEMPERATURE,
    LIVEPEER_MAX_TOKENS: process.env.LIVEPEER_MAX_TOKENS,
  },
  async init(config: Record<string, string>) {
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value !== undefined) process.env[key] = String(value);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid Livepeer plugin configuration: ${error.errors.map((e) => e.message).join(', ')}`
        );
      }
      throw error;
    }
  },
  models: {
    [ModelType.TEXT_SMALL]: async (
      runtime,
      { prompt, maxTokens, temperature }: GenerateTextParams
    ) => {
      return await callLivepeerLLM(runtime, {
        prompt,
        maxTokens:
          maxTokens ||
          (process.env.LIVEPEER_MAX_TOKENS ? parseInt(process.env.LIVEPEER_MAX_TOKENS) : 512),
        temperature:
          temperature ||
          (process.env.LIVEPEER_TEMPERATURE ? parseFloat(process.env.LIVEPEER_TEMPERATURE) : 0.6),
      });
    },
    [ModelType.TEXT_LARGE]: async (
      runtime,
      { prompt, maxTokens, temperature }: GenerateTextParams
    ) => {
      return await callLivepeerLLM(runtime, {
        prompt,
        maxTokens:
          maxTokens ||
          (process.env.LIVEPEER_MAX_TOKENS ? parseInt(process.env.LIVEPEER_MAX_TOKENS) : 2048),
        temperature:
          temperature ||
          (process.env.LIVEPEER_TEMPERATURE ? parseFloat(process.env.LIVEPEER_TEMPERATURE) : 0.6),
      });
    },
    [ModelType.TEXT_EMBEDDING]: async (
      _runtime: IAgentRuntime,
      params: import('@elizaos/core').TextEmbeddingParams | string | null
    ) => {
      // Basic fallback embedding handler
      const DIMS = 384;

      // Handle null/undefined/empty input
      if (!params || (typeof params === 'object' && !('text' in params))) {
        return new Array(DIMS).fill(0);
      }

      // Extract raw text depending on invocation style
      const text = typeof params === 'string' ? params : (params.text ?? '');

      if (!text.trim()) {
        return new Array(DIMS).fill(0);
      }

      // Simple hashing mechanism to create a deterministic pseudo-embedding
      const vec = new Array(DIMS).fill(0);
      for (let i = 0; i < text.length; i++) {
        const idx = i % DIMS;
        vec[idx] += text.charCodeAt(i) / 65535; // normalise char codes
      }

      return vec;
    },
  },
};

export default livepeerPlugin;
