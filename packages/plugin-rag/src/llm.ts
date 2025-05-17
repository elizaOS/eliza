import { generateText, embed, GenerateTextResult } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import dotenv from 'dotenv';

dotenv.config();

const OPENAI_EMBEDDING_MODEL_HARDCODED = 'text-embedding-3-small';
const OPENROUTER_DEFAULT_SMALL_MODEL = 'google/gemini-flash';
const OPENROUTER_DEFAULT_LARGE_MODEL = 'google/gemini-pro';
const ANTHROPIC_DEFAULT_SMALL_MODEL = 'claude-3-haiku-20240307';
const ANTHROPIC_DEFAULT_LARGE_MODEL = 'claude-3-5-sonnet-latest';

export async function generateTextEmbedding(text: string): Promise<{ embedding: number[] }> {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL; // Optional

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set.');
  }

  const openai = createOpenAI({ apiKey, baseURL });

  try {
    const modelInstance = openai.embedding(OPENAI_EMBEDDING_MODEL_HARDCODED);

    const { embedding, usage } = await embed({
      model: modelInstance,
      value: text,
    });

    const totalTokens = (usage as { totalTokens?: number })?.totalTokens;
    const usageMessage = totalTokens ? `${totalTokens} total tokens` : 'Usage details N/A';
    console.log(`[LLM Service - OpenAI Embedding] Embedding generated. Usage: ${usageMessage}.`);
    return { embedding };
  } catch (error) {
    console.error('[LLM Service - OpenAI Embedding] Error generating embedding:', error);
    throw error;
  }
}

export async function generateSmallText(
  prompt: string,
  system?: string,
  config?: { provider?: 'anthropic' | 'openrouter'; modelName?: string }
): Promise<GenerateTextResult<any, any>> {
  const provider = config?.provider || 'anthropic';

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const modelName =
      config?.modelName || process.env.ANTHROPIC_SMALL_MODEL || ANTHROPIC_DEFAULT_SMALL_MODEL;
    const maxTokens = parseInt(process.env.ANTHROPIC_SMALL_MAX_TOKENS || '1024', 10);

    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set for Anthropic provider.');
    }

    const anthropic = createAnthropic({ apiKey });
    const modelInstance = anthropic(modelName);

    try {
      const result = await generateText({
        model: modelInstance,
        prompt: prompt,
        system: system,
        temperature: 0.7,
        maxTokens: maxTokens,
      });
      console.log(
        `[LLM Service - Anthropic Small Text] Text generated with ${modelName}. Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
      );
      return result;
    } catch (error) {
      console.error(
        `[LLM Service - Anthropic Small Text] Error generating text with ${modelName}:`,
        error
      );
      throw error;
    }
  } else if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const baseURL = process.env.OPENROUTER_BASE_URL;
    const modelName =
      config?.modelName || process.env.OPENROUTER_SMALL_MODEL || OPENROUTER_DEFAULT_SMALL_MODEL;
    const maxTokens = parseInt(process.env.OPENROUTER_SMALL_MAX_TOKENS || '1024', 10);

    if (!apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY environment variable is not set for OpenRouter provider.'
      );
    }

    const openrouter = createOpenRouter({ apiKey, baseURL });
    const modelInstance = openrouter.chat(modelName);

    try {
      const result = await generateText({
        model: modelInstance,
        prompt: prompt,
        system: system,
        temperature: 0.7,
        maxTokens: maxTokens,
      });
      console.log(
        `[LLM Service - OpenRouter Small Text] Text generated with ${modelName}. Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
      );
      return result;
    } catch (error) {
      console.error(
        `[LLM Service - OpenRouter Small Text] Error generating text with ${modelName}:`,
        error
      );
      throw error;
    }
  } else {
    throw new Error(`Unsupported small text provider: ${provider}`);
  }
}

export async function generateLargeText(
  prompt: string,
  system?: string,
  config?: { provider?: 'anthropic' | 'openrouter'; modelName?: string }
): Promise<GenerateTextResult<any, any>> {
  const provider = config?.provider || 'anthropic';

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const modelName =
      config?.modelName || process.env.ANTHROPIC_LARGE_MODEL || ANTHROPIC_DEFAULT_LARGE_MODEL;

    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set for Anthropic provider.');
    }

    const anthropic = createAnthropic({ apiKey });
    const modelInstance = anthropic(modelName);

    try {
      const result = await generateText({
        model: modelInstance,
        prompt: prompt,
        system: system,
        temperature: 0.7,
        maxTokens: 4096,
      });
      console.log(
        `[LLM Service - Anthropic Large Text] Text generated with ${modelName}. Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
      );
      return result;
    } catch (error) {
      console.error(
        `[LLM Service - Anthropic Large Text] Error generating text with ${modelName}:`,
        error
      );
      throw error;
    }
  } else if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const baseURL = process.env.OPENROUTER_BASE_URL;
    const modelName =
      config?.modelName || process.env.OPENROUTER_LARGE_MODEL || OPENROUTER_DEFAULT_LARGE_MODEL;

    if (!apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY environment variable is not set for OpenRouter provider.'
      );
    }

    const openrouter = createOpenRouter({ apiKey, baseURL });
    const modelInstance = openrouter.chat(modelName);

    try {
      const result = await generateText({
        model: modelInstance,
        prompt: prompt,
        system: system,
        temperature: 0.7,
        maxTokens: 4096,
      });
      console.log(
        `[LLM Service - OpenRouter Large Text] Text generated with ${modelName}. Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
      );
      return result;
    } catch (error) {
      console.error(
        `[LLM Service - OpenRouter Large Text] Error generating text with ${modelName}:`,
        error
      );
      throw error;
    }
  } else {
    throw new Error(`Unsupported large text provider: ${provider}`);
  }
}
