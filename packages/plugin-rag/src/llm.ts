import { generateText, embed, GenerateTextResult, EmbedResult } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import dotenv from 'dotenv';

dotenv.config();

const OPENAI_EMBEDDING_MODEL_HARDCODED = 'text-embedding-3-small';

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
  system?: string
): Promise<GenerateTextResult<any, any>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const modelName = process.env.ANTHROPIC_SMALL_MODEL ?? 'claude-3-haiku-20240307';

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
  }

  const anthropic = createAnthropic({ apiKey });
  const modelInstance = anthropic(modelName);

  try {
    const result = await generateText({
      model: modelInstance,
      prompt: prompt,
      system: system,
      temperature: 0.7,
      maxTokens: 1024,
    });
    console.log(
      `[LLM Service - Anthropic Small Text] Text generated. Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
    );
    return result;
  } catch (error) {
    console.error('[LLM Service - Anthropic Small Text] Error generating text:', error);
    throw error;
  }
}

export async function generateLargeText(
  prompt: string,
  system?: string
): Promise<GenerateTextResult<any, any>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const modelName = process.env.ANTHROPIC_LARGE_MODEL ?? 'claude-3-5-sonnet-latest';

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
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
      `[LLM Service - Anthropic Large Text] Text generated. Usage: ${result.usage.promptTokens} prompt tokens, ${result.usage.completionTokens} completion tokens.`
    );
    return result;
  } catch (error) {
    console.error('[LLM Service - Anthropic Large Text] Error generating text:', error);
    throw error;
  }
}
