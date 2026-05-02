import {
  type GenerateTextParams,
  type IAgentRuntime,
  logger,
  type TextEmbeddingParams,
  type TextStreamResult,
} from "@elizaos/core";

const XAI_API_BASE = "https://api.x.ai/v1";

const DEFAULT_MODELS = {
  small: "grok-3-mini",
  large: "grok-3",
  embedding: "grok-embedding",
} as const;

interface GrokConfig {
  apiKey: string;
  baseUrl: string;
  smallModel: string;
  largeModel: string;
  embeddingModel: string;
}

function getConfig(runtime: IAgentRuntime): GrokConfig {
  const apiKey = runtime.getSetting("XAI_API_KEY");
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("XAI_API_KEY is required");
  }

  const baseUrl = runtime.getSetting("XAI_BASE_URL");
  const smallModel = runtime.getSetting("XAI_SMALL_MODEL");
  const largeModel = runtime.getSetting("XAI_MODEL") || runtime.getSetting("XAI_LARGE_MODEL");
  const embeddingModel = runtime.getSetting("XAI_EMBEDDING_MODEL");

  return {
    apiKey,
    baseUrl: typeof baseUrl === "string" ? baseUrl : XAI_API_BASE,
    smallModel: typeof smallModel === "string" ? smallModel : DEFAULT_MODELS.small,
    largeModel: typeof largeModel === "string" ? largeModel : DEFAULT_MODELS.large,
    embeddingModel: typeof embeddingModel === "string" ? embeddingModel : DEFAULT_MODELS.embedding,
  };
}

function getAuthHeader(config: GrokConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface EmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

async function generateText(
  config: GrokConfig,
  model: string,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const messages: ChatMessage[] = [];
  messages.push({ role: "user", content: params.prompt });

  const body: Record<string, unknown> = {
    model,
    messages,
  };

  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }
  if (params.maxTokens !== undefined) {
    body.max_tokens = params.maxTokens;
  }
  if (params.stopSequences) {
    body.stop = params.stopSequences;
  }

  if (params.stream && params.onStreamChunk) {
    body.stream = true;

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: getAuthHeader(config),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Grok API error (${response.status}): ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        const parsed = JSON.parse(data);
        const content = parsed.choices[0].delta?.content;
        if (content) {
          fullText += content;
          params.onStreamChunk(content);
        }
      }
    }

    return fullText;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: getAuthHeader(config),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Grok API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;

  if (!data.choices?.[0]?.message?.content) {
    throw new Error("No content in Grok response");
  }

  return data.choices[0].message.content;
}

async function createEmbedding(config: GrokConfig, text: string): Promise<number[]> {
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: getAuthHeader(config),
    body: JSON.stringify({
      model: config.embeddingModel,
      input: text,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Grok Embedding API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as EmbeddingResponse;

  if (!data.data?.[0]?.embedding) {
    throw new Error("No embedding in Grok response");
  }

  return data.data[0].embedding;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const config = getConfig(runtime);
  logger.debug(`[Grok] Generating text with model: ${config.smallModel}`);
  return generateText(config, config.smallModel, params);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const config = getConfig(runtime);
  logger.debug(`[Grok] Generating text with model: ${config.largeModel}`);
  return generateText(config, config.largeModel, params);
}

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  if (params === null) {
    throw new Error("Null params provided for embedding");
  }
  const config = getConfig(runtime);
  const text = typeof params === "string" ? params : (params as TextEmbeddingParams).text;
  if (!text) {
    throw new Error("Empty text provided for embedding");
  }
  logger.debug(`[Grok] Creating embedding with model: ${config.embeddingModel}`);
  return createEmbedding(config, text);
}

export async function listModels(runtime: IAgentRuntime): Promise<Record<string, unknown>[]> {
  const config = getConfig(runtime);

  const response = await fetch(`${config.baseUrl}/models`, {
    headers: getAuthHeader(config),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Grok API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as { data: Record<string, unknown>[] };
  return data.data;
}

export function isGrokConfigured(runtime: IAgentRuntime): boolean {
  return !!runtime.getSetting("XAI_API_KEY");
}
