import { createGroq } from "@ai-sdk/groq";
import type { IAgentRuntime, ObjectGenerationParams, Plugin } from "@elizaos/core";
import { type GenerateTextParams, logger, ModelType } from "@elizaos/core";
import { generateObject, generateText } from "ai";

const _globalThis = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean };
_globalThis.AI_SDK_LOG_WARNINGS ??= false;
const DEFAULT_SMALL_MODEL = "llama-3.1-8b-instant";
const DEFAULT_LARGE_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_TTS_MODEL = "playai-tts";
const DEFAULT_TTS_VOICE = "Chip-PlayAI";
const DEFAULT_TRANSCRIPTION_MODEL = "distil-whisper-large-v3-en";
const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

function getBaseURL(runtime: IAgentRuntime): string {
  const url = runtime.getSetting("GROQ_BASE_URL");
  return typeof url === "string" ? url : DEFAULT_BASE_URL;
}

function getSmallModel(runtime: IAgentRuntime): string {
  const setting = runtime.getSetting("GROQ_SMALL_MODEL") || runtime.getSetting("SMALL_MODEL");
  return typeof setting === "string" ? setting : DEFAULT_SMALL_MODEL;
}

function getLargeModel(runtime: IAgentRuntime): string {
  const setting = runtime.getSetting("GROQ_LARGE_MODEL") || runtime.getSetting("LARGE_MODEL");
  return typeof setting === "string" ? setting : DEFAULT_LARGE_MODEL;
}

function createGroqClient(runtime: IAgentRuntime) {
  // In browsers, default to *not* sending secrets.
  // Use a server-side proxy and configure GROQ_BASE_URL (or explicitly opt-in).
  const allowBrowserKey =
    !isBrowser() ||
    String(runtime.getSetting("GROQ_ALLOW_BROWSER_API_KEY") ?? "").toLowerCase() === "true";
  const apiKey = allowBrowserKey ? runtime.getSetting("GROQ_API_KEY") : undefined;
  return createGroq({
    apiKey: typeof apiKey === "string" ? apiKey : undefined,
    fetch: runtime.fetch ?? undefined,
    baseURL: getBaseURL(runtime),
  });
}

function extractRetryDelay(message: string): number {
  const match = message.match(/try again in (\d+\.?\d*)s/i);
  if (match?.[1]) {
    return Math.ceil(Number.parseFloat(match[1]) * 1000) + 1000;
  }
  return 10000;
}

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
  const generate = () =>
    generateText({
      model: groq.languageModel(model),
      prompt: params.prompt,
      system: params.system,
      temperature: params.temperature,
      maxRetries: 3,
      frequencyPenalty: params.frequencyPenalty,
      presencePenalty: params.presencePenalty,
      stopSequences: params.stopSequences,
    });

  try {
    const { text } = await generate();
    return text;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Rate limit reached")) {
      const delay = extractRetryDelay(error.message);
      logger.warn(`Groq rate limit hit, retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      const { text } = await generate();
      return text;
    }
    throw error;
  }
}

export const groqPlugin: Plugin = {
  name: "groq",
  description: "Groq LLM provider - fast inference with Llama and other models",

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    const apiKey = runtime.getSetting("GROQ_API_KEY");
    if (!apiKey && !isBrowser()) {
      throw new Error("GROQ_API_KEY is required");
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
        output: "no-schema",
        prompt: params.prompt,
        temperature: params.temperature,
      });
      return object as Record<
        string,
        string | number | boolean | null | Record<string, string | number | boolean | null>
      >;
    },

    [ModelType.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
      const groq = createGroqClient(runtime);
      const model = getLargeModel(runtime);

      const { object } = await generateObject({
        model: groq.languageModel(model),
        output: "no-schema",
        prompt: params.prompt,
        temperature: params.temperature,
      });
      return object as Record<
        string,
        string | number | boolean | null | Record<string, string | number | boolean | null>
      >;
    },

    [ModelType.TRANSCRIPTION]: async (runtime, params) => {
      type AudioDataShape = { audioData: Uint8Array };

      function hasAudioData(obj: object): obj is AudioDataShape {
        return "audioData" in obj && (obj as AudioDataShape).audioData instanceof Uint8Array;
      }

      if (isBrowser()) {
        throw new Error(
          "Groq TRANSCRIPTION is not supported directly in browsers. Use a server proxy or submit a Blob/ArrayBuffer to a server."
        );
      }

      const hasBuffer =
        typeof Buffer !== "undefined" &&
        typeof (Buffer as unknown as { isBuffer: (v: unknown) => boolean }).isBuffer === "function";

      const audioBuffer: Buffer =
        typeof params === "string"
          ? Buffer.from(params, "base64")
          : hasBuffer &&
              (Buffer as unknown as { isBuffer: (v: unknown) => boolean }).isBuffer(params)
            ? (params as Buffer)
            : typeof params === "object" && params !== null && hasAudioData(params)
              ? Buffer.from((params as AudioDataShape).audioData)
              : Buffer.alloc(0);
      const baseURL = getBaseURL(runtime);
      const formData = new FormData();
      formData.append(
        "file",
        new File([audioBuffer as BlobPart], "audio.mp3", { type: "audio/mp3" })
      );
      formData.append("model", DEFAULT_TRANSCRIPTION_MODEL);

      const apiKey = runtime.getSetting("GROQ_API_KEY");
      const response = await fetch(`${baseURL}/audio/transcriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${typeof apiKey === "string" ? apiKey : ""}`,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Transcription failed: ${response.status} ${await response.text()}`);
      }

      const data = (await response.json()) as { text: string };
      return data.text;
    },

    [ModelType.TEXT_TO_SPEECH]: async (runtime: IAgentRuntime, params) => {
      if (isBrowser()) {
        throw new Error(
          "Groq TEXT_TO_SPEECH is not supported directly in browsers. Use a server proxy."
        );
      }
      const text = typeof params === "string" ? params : (params as { text: string }).text;
      const baseURL = getBaseURL(runtime);
      const modelSetting = runtime.getSetting("GROQ_TTS_MODEL");
      const voiceSetting = runtime.getSetting("GROQ_TTS_VOICE");
      const model = typeof modelSetting === "string" ? modelSetting : DEFAULT_TTS_MODEL;
      const voice = typeof voiceSetting === "string" ? voiceSetting : DEFAULT_TTS_VOICE;

      const apiKey = runtime.getSetting("GROQ_API_KEY");
      const response = await fetch(`${baseURL}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${typeof apiKey === "string" ? apiKey : ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, voice, input: text }),
      });

      if (!response.ok) {
        throw new Error(`TTS failed: ${response.status} ${await response.text()}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    },
  },

  tests: [
    {
      name: "groq_plugin_tests",
      tests: [
        {
          name: "validate_api_key",
          fn: async (runtime) => {
            const baseURL = getBaseURL(runtime);
            const response = await fetch(`${baseURL}/models`, {
              headers: {
                Authorization: `Bearer ${runtime.getSetting("GROQ_API_KEY")}`,
              },
            });
            if (!response.ok) {
              throw new Error(`API key validation failed: ${response.statusText}`);
            }
            const data = (await response.json()) as {
              data: Array<{ id: string; owned_by: string }>;
            };
            logger.info(`Groq API validated, ${data.data.length} models available`);
          },
        },
        {
          name: "text_small",
          fn: async (runtime) => {
            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "Say hello in exactly 3 words.",
            });
            if (!text || text.length === 0) {
              throw new Error("Empty response from TEXT_SMALL");
            }
            logger.info("TEXT_SMALL:", text);
          },
        },
        {
          name: "text_large",
          fn: async (runtime) => {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "What is 2+2? Answer with just the number.",
            });
            if (!text || text.length === 0) {
              throw new Error("Empty response from TEXT_LARGE");
            }
            logger.info("TEXT_LARGE:", text);
          },
        },
        {
          name: "object_generation",
          fn: async (runtime) => {
            const obj = await runtime.useModel(ModelType.OBJECT_SMALL, {
              prompt: 'Return a JSON object with name="test" and value=42',
              temperature: 0.5,
            });
            logger.info("OBJECT_SMALL:", JSON.stringify(obj));
          },
        },
      ],
    },
  ],
};

export default groqPlugin;
