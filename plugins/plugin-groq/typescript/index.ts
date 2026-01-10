import { createGroq } from '@ai-sdk/groq';
import type { IAgentRuntime, Plugin, ObjectGenerationParams } from '@elizaos/core';
import { type GenerateTextParams, ModelType, logger } from '@elizaos/core';
import { generateObject, generateText } from 'ai';

// Default models
const DEFAULT_SMALL_MODEL = 'llama-3.1-8b-instant';
const DEFAULT_LARGE_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TTS_MODEL = 'playai-tts';
const DEFAULT_TTS_VOICE = 'Chip-PlayAI';
const DEFAULT_TRANSCRIPTION_MODEL = 'distil-whisper-large-v3-en';
const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

function getBaseURL(runtime: IAgentRuntime): string {
  return runtime.getSetting('GROQ_BASE_URL') || DEFAULT_BASE_URL;
}

function getSmallModel(runtime: IAgentRuntime): string {
  return runtime.getSetting('GROQ_SMALL_MODEL') || runtime.getSetting('SMALL_MODEL') || DEFAULT_SMALL_MODEL;
}

function getLargeModel(runtime: IAgentRuntime): string {
  return runtime.getSetting('GROQ_LARGE_MODEL') || runtime.getSetting('LARGE_MODEL') || DEFAULT_LARGE_MODEL;
}

function createGroqClient(runtime: IAgentRuntime) {
  return createGroq({
    apiKey: runtime.getSetting('GROQ_API_KEY'),
    fetch: runtime.fetch,
    baseURL: getBaseURL(runtime),
  });
}

/**
 * Extract retry delay from Groq rate limit error message
 */
function extractRetryDelay(message: string): number {
  const match = message.match(/try again in (\d+\.?\d*)s/i);
  if (match?.[1]) {
    return Math.ceil(Number.parseFloat(match[1]) * 1000) + 1000;
  }
  return 10000; // Default 10 seconds
}

/**
 * Generate text with automatic rate limit retry
 */
async function generateWithRetry(
  groq: ReturnType<typeof createGroq>,
  model: string,
  params: {
    prompt: string;
    system?: string;
    temperature: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stopSequences: string[];
  }
): Promise<string> {
  const generate = () => generateText({
    model: groq.languageModel(model),
    prompt: params.prompt,
    system: params.system,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    frequencyPenalty: params.frequencyPenalty,
    presencePenalty: params.presencePenalty,
    stopSequences: params.stopSequences,
  });

  try {
    const { text } = await generate();
    return text;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Rate limit reached')) {
      const delay = extractRetryDelay(error.message);
      logger.warn(`Groq rate limit hit, retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      const { text } = await generate();
      return text;
    }
    throw error;
  }
}

export const groqPlugin: Plugin = {
  name: 'groq',
  description: 'Groq LLM provider - fast inference with Llama and other models',

  init(_config: Record<string, string>, runtime: IAgentRuntime) {
    const apiKey = runtime.getSetting('GROQ_API_KEY');
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is required');
    }
  },

  models: {
    [ModelType.TEXT_SMALL]: async (runtime, params: GenerateTextParams) => {
      const groq = createGroqClient(runtime);
      const model = getSmallModel(runtime);

      return generateWithRetry(groq, model, {
        prompt: params.prompt,
        system: runtime.character.system,
        temperature: 0.7,
        maxTokens: 8000,
        frequencyPenalty: 0.7,
        presencePenalty: 0.7,
        stopSequences: params.stopSequences || [],
      });
    },

    [ModelType.TEXT_LARGE]: async (runtime, params: GenerateTextParams) => {
      const groq = createGroqClient(runtime);
      const model = getLargeModel(runtime);

      return generateWithRetry(groq, model, {
        prompt: params.prompt,
        system: runtime.character.system,
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        frequencyPenalty: params.frequencyPenalty ?? 0.7,
        presencePenalty: params.presencePenalty ?? 0.7,
        stopSequences: params.stopSequences || [],
      });
    },

    [ModelType.OBJECT_SMALL]: async (runtime, params: ObjectGenerationParams) => {
      const groq = createGroqClient(runtime);
      const model = getSmallModel(runtime);

      const { object } = await generateObject({
        model: groq.languageModel(model),
        output: 'no-schema',
        prompt: params.prompt,
        temperature: params.temperature,
      });
      return object;
    },

    [ModelType.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
      const groq = createGroqClient(runtime);
      const model = getLargeModel(runtime);

      const { object } = await generateObject({
        model: groq.languageModel(model),
        output: 'no-schema',
        prompt: params.prompt,
        temperature: params.temperature,
      });
      return object;
    },

    [ModelType.TRANSCRIPTION]: async (runtime, audioBuffer: Buffer) => {
      const baseURL = getBaseURL(runtime);
      const formData = new FormData();
      formData.append('file', new File([audioBuffer], 'audio.mp3', { type: 'audio/mp3' }));
      formData.append('model', DEFAULT_TRANSCRIPTION_MODEL);

      const response = await fetch(`${baseURL}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${runtime.getSetting('GROQ_API_KEY')}` },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Transcription failed: ${response.status} ${await response.text()}`);
      }

      const data = await response.json() as { text: string };
      return data.text;
    },

    [ModelType.TEXT_TO_SPEECH]: async (runtime: IAgentRuntime, text: string) => {
      const baseURL = getBaseURL(runtime);
      const model = runtime.getSetting('GROQ_TTS_MODEL') || DEFAULT_TTS_MODEL;
      const voice = runtime.getSetting('GROQ_TTS_VOICE') || DEFAULT_TTS_VOICE;

      const response = await fetch(`${baseURL}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${runtime.getSetting('GROQ_API_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, voice, input: text }),
      });

      if (!response.ok) {
        throw new Error(`TTS failed: ${response.status} ${await response.text()}`);
      }

      return response.body;
    },
  },

  tests: [
    {
      name: 'groq_plugin_tests',
      tests: [
        {
          name: 'validate_api_key',
          fn: async (runtime) => {
            const baseURL = getBaseURL(runtime);
            const response = await fetch(`${baseURL}/models`, {
              headers: { Authorization: `Bearer ${runtime.getSetting('GROQ_API_KEY')}` },
            });
            if (!response.ok) {
              throw new Error(`API key validation failed: ${response.statusText}`);
            }
            const data = await response.json() as { data: unknown[] };
            logger.info(`Groq API validated, ${data.data.length} models available`);
          },
        },
        {
          name: 'text_small',
          fn: async (runtime) => {
            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: 'Say hello in exactly 3 words.',
            });
            if (!text || text.length === 0) {
              throw new Error('Empty response from TEXT_SMALL');
            }
            logger.info('TEXT_SMALL:', text);
          },
        },
        {
          name: 'text_large',
          fn: async (runtime) => {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: 'What is 2+2? Answer with just the number.',
            });
            if (!text || text.length === 0) {
              throw new Error('Empty response from TEXT_LARGE');
            }
            logger.info('TEXT_LARGE:', text);
          },
        },
        {
          name: 'object_generation',
          fn: async (runtime) => {
            const obj = await runtime.useModel(ModelType.OBJECT_SMALL, {
              prompt: 'Return a JSON object with name="test" and value=42',
              temperature: 0.5,
            });
            logger.info('OBJECT_SMALL:', JSON.stringify(obj));
          },
        },
      ],
    },
  ],
};

export default groqPlugin;
