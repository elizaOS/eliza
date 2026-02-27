import type {
  GenerateTextParams,
  IAgentRuntime,
  JsonValue,
  ObjectGenerationParams,
  Plugin,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";

const DEFAULT_SMALL_MODEL = "deepseek/deepseek-v3.2";
const DEFAULT_LARGE_MODEL = "moonshotai/kimi-k2.5";
const DEFAULT_BASE_URL = "https://api.avian.io/v1";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionChoice {
  index: number;
  message: {
    role: string;
    content: string;
  };
  finish_reason: string;
}

interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

interface ChatCompletionStreamDelta {
  role?: string;
  content?: string;
}

interface ChatCompletionStreamChoice {
  index: number;
  delta: ChatCompletionStreamDelta;
  finish_reason: string | null;
}

interface ChatCompletionStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionStreamChoice[];
  usage?: ChatCompletionUsage;
}

interface TextStreamResult {
  textStream: AsyncIterable<string>;
  text: Promise<string>;
  usage: Promise<
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }
    | undefined
  >;
  finishReason: Promise<string | undefined>;
}

function getBaseURL(runtime: IAgentRuntime): string {
  const url = runtime.getSetting("AVIAN_BASE_URL");
  return typeof url === "string" && url.length > 0 ? url : DEFAULT_BASE_URL;
}

function getApiKey(runtime: IAgentRuntime): string {
  const key = runtime.getSetting("AVIAN_API_KEY");
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("AVIAN_API_KEY is required");
  }
  return key;
}

function getSmallModel(runtime: IAgentRuntime): string {
  const setting =
    runtime.getSetting("AVIAN_SMALL_MODEL") || runtime.getSetting("SMALL_MODEL");
  return typeof setting === "string" && setting.length > 0 ? setting : DEFAULT_SMALL_MODEL;
}

function getLargeModel(runtime: IAgentRuntime): string {
  const setting =
    runtime.getSetting("AVIAN_LARGE_MODEL") || runtime.getSetting("LARGE_MODEL");
  return typeof setting === "string" && setting.length > 0 ? setting : DEFAULT_LARGE_MODEL;
}

async function chatCompletion(
  runtime: IAgentRuntime,
  model: string,
  params: {
    prompt: string;
    system?: string;
    temperature?: number;
    maxTokens?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
    stream?: boolean;
    responseFormat?: { type: string };
  }
): Promise<string | TextStreamResult> {
  const baseURL = getBaseURL(runtime);
  const apiKey = getApiKey(runtime);

  const messages: ChatMessage[] = [];
  if (params.system) {
    messages.push({ role: "system", content: params.system });
  }
  messages.push({ role: "user", content: params.prompt });

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: params.temperature ?? 0.7,
    max_tokens: params.maxTokens ?? 8192,
  };

  if (params.frequencyPenalty !== undefined) {
    body.frequency_penalty = params.frequencyPenalty;
  }
  if (params.presencePenalty !== undefined) {
    body.presence_penalty = params.presencePenalty;
  }
  if (params.stopSequences && params.stopSequences.length > 0) {
    body.stop = params.stopSequences;
  }
  if (params.responseFormat) {
    body.response_format = params.responseFormat;
  }

  if (params.stream) {
    body.stream = true;

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Avian API error: ${response.status} ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body for streaming");
    }

    let fullText = "";
    let finalUsage: ChatCompletionUsage | undefined;
    let finalFinishReason: string | undefined;
    let resolveText: (value: string) => void;
    let resolveUsage: (
      value:
        | { promptTokens: number; completionTokens: number; totalTokens: number }
        | undefined
    ) => void;
    let resolveFinishReason: (value: string | undefined) => void;

    const textPromise = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const usagePromise = new Promise<
      { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
    >((resolve) => {
      resolveUsage = resolve;
    });
    const finishReasonPromise = new Promise<string | undefined>((resolve) => {
      resolveFinishReason = resolve;
    });

    const decoder = new TextDecoder();

    const textStream: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data: ")) continue;
              const data = trimmed.slice(6);
              if (data === "[DONE]") continue;

              try {
                const chunk = JSON.parse(data) as ChatCompletionStreamChunk;
                const content = chunk.choices?.[0]?.delta?.content;
                if (content) {
                  fullText += content;
                  yield content;
                }
                const finishReason = chunk.choices?.[0]?.finish_reason;
                if (finishReason) {
                  finalFinishReason = finishReason;
                }
                if (chunk.usage) {
                  finalUsage = chunk.usage;
                }
              } catch {
                // Skip malformed chunks
              }
            }
          }
        } finally {
          resolveText(fullText);
          resolveUsage(
            finalUsage
              ? {
                  promptTokens: finalUsage.prompt_tokens,
                  completionTokens: finalUsage.completion_tokens,
                  totalTokens: finalUsage.total_tokens,
                }
              : undefined
          );
          resolveFinishReason(finalFinishReason);
        }
      },
    };

    return {
      textStream,
      text: textPromise,
      usage: usagePromise,
      finishReason: finishReasonPromise,
    };
  }

  // Non-streaming
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Avian API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  return data.choices[0]?.message?.content ?? "";
}

export const avianPlugin: Plugin = {
  name: "avian",
  description: "Avian AI model provider - affordable inference for DeepSeek, Kimi, GLM, and MiniMax models",

  config: {
    AVIAN_API_KEY: process.env.AVIAN_API_KEY ?? null,
    AVIAN_BASE_URL: process.env.AVIAN_BASE_URL ?? null,
    AVIAN_SMALL_MODEL: process.env.AVIAN_SMALL_MODEL ?? null,
    AVIAN_LARGE_MODEL: process.env.AVIAN_LARGE_MODEL ?? null,
  },

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    const apiKey = runtime.getSetting("AVIAN_API_KEY");
    if (!apiKey) {
      throw new Error("AVIAN_API_KEY is required. Get your key at https://avian.io");
    }
  },

  models: {
    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      const model = getSmallModel(runtime);
      logger.debug(`[Avian] Using TEXT_SMALL model: ${model}`);

      return chatCompletion(runtime, model, {
        prompt: params.prompt,
        system: runtime.character.system,
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        frequencyPenalty: params.frequencyPenalty ?? 0.0,
        presencePenalty: params.presencePenalty ?? 0.0,
        stopSequences: params.stopSequences,
        stream: params.stream,
      });
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      const model = getLargeModel(runtime);
      logger.debug(`[Avian] Using TEXT_LARGE model: ${model}`);

      return chatCompletion(runtime, model, {
        prompt: params.prompt,
        system: runtime.character.system,
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        frequencyPenalty: params.frequencyPenalty ?? 0.0,
        presencePenalty: params.presencePenalty ?? 0.0,
        stopSequences: params.stopSequences,
        stream: params.stream,
      });
    },

    [ModelType.OBJECT_SMALL]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams
    ): Promise<Record<string, JsonValue>> => {
      const model = getSmallModel(runtime);
      logger.debug(`[Avian] Using OBJECT_SMALL model: ${model}`);

      const result = await chatCompletion(runtime, model, {
        prompt: params.prompt,
        temperature: params.temperature ?? 0.7,
        responseFormat: { type: "json_object" },
      });

      if (typeof result !== "string") {
        throw new Error("Unexpected stream result for object generation");
      }

      try {
        return JSON.parse(result) as Record<string, JsonValue>;
      } catch {
        logger.warn("[Avian] Failed to parse JSON response, attempting extraction");
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]) as Record<string, JsonValue>;
        }
        throw new Error("Failed to parse object response from Avian API");
      }
    },

    [ModelType.OBJECT_LARGE]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams
    ): Promise<Record<string, JsonValue>> => {
      const model = getLargeModel(runtime);
      logger.debug(`[Avian] Using OBJECT_LARGE model: ${model}`);

      const result = await chatCompletion(runtime, model, {
        prompt: params.prompt,
        temperature: params.temperature ?? 0.7,
        responseFormat: { type: "json_object" },
      });

      if (typeof result !== "string") {
        throw new Error("Unexpected stream result for object generation");
      }

      try {
        return JSON.parse(result) as Record<string, JsonValue>;
      } catch {
        logger.warn("[Avian] Failed to parse JSON response, attempting extraction");
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]) as Record<string, JsonValue>;
        }
        throw new Error("Failed to parse object response from Avian API");
      }
    },
  },

  tests: [
    {
      name: "avian_plugin_tests",
      tests: [
        {
          name: "validate_api_key",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const baseURL = getBaseURL(runtime);
            const apiKey = getApiKey(runtime);
            const response = await fetch(`${baseURL}/models`, {
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
            });
            if (!response.ok) {
              throw new Error(`API key validation failed: ${response.statusText}`);
            }
            const data = (await response.json()) as {
              data: Array<{ id: string }>;
            };
            logger.info(`Avian API validated, ${data.data.length} models available`);
          },
        },
        {
          name: "text_small",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "Say hello in exactly 3 words.",
            });
            if (!text || text.length === 0) {
              throw new Error("Empty response from TEXT_SMALL");
            }
            logger.info(`[Avian Test] TEXT_SMALL: ${text}`);
          },
        },
        {
          name: "text_large",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "What is 2+2? Answer with just the number.",
            });
            if (!text || text.length === 0) {
              throw new Error("Empty response from TEXT_LARGE");
            }
            logger.info(`[Avian Test] TEXT_LARGE: ${text}`);
          },
        },
        {
          name: "object_generation",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const obj = await runtime.useModel(ModelType.OBJECT_SMALL, {
              prompt: 'Return a JSON object with name="test" and value=42',
              temperature: 0.5,
            });
            if (!obj || typeof obj !== "object") {
              throw new Error("Object generation should return an object");
            }
            logger.info(`[Avian Test] OBJECT_SMALL: ${JSON.stringify(obj)}`);
          },
        },
      ],
    },
  ],
};

export default avianPlugin;
