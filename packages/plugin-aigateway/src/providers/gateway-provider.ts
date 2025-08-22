import { createOpenAI } from "@ai-sdk/openai";
import {
  IAgentRuntime,
  ModelType,
  GenerateTextParams,
  TextEmbeddingParams,
  ObjectGenerationParams,
  ModelTypeName,
  EventType,
  logger,
} from "@elizaos/core";
import {
  generateObject,
  generateText,
  JSONParseError,
  type JSONValue,
  type LanguageModelUsage,
} from "ai";
import pRetry from "p-retry";
import { CacheService } from "../utils/cache";
import {
  getConfig,
  getApiKey,
  getBaseURL,
  getSmallModel,
  getLargeModel,
  getEmbeddingModel,
  getMaxRetries,
  getCacheTTL,
  getAppName,
} from "../utils/config";

/**
 * Create AI Gateway client
 */
function createGatewayClient(runtime: IAgentRuntime) {
  const apiKey = getApiKey(runtime);
  if (!apiKey) {
    throw new Error("AI Gateway API key not configured");
  }

  const appName = getAppName(runtime);

  return createOpenAI({
    apiKey: apiKey,
    baseURL: `${getBaseURL(runtime)}/openai`,
    headers: {
      "x-api-key": apiKey,
      "x-vercel-app": appName,
    },
  });
}

/**
 * Emit model usage event
 */
function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  prompt: string,
  usage: LanguageModelUsage,
) {
  runtime.emitEvent(EventType.MODEL_USED, {
    provider: "aigateway",
    type,
    prompt,
    tokens: {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens,
    },
  });
}

/**
 * Gateway Provider for AI models
 */
export class GatewayProvider {
  private runtime: IAgentRuntime;
  private cache: CacheService;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.cache = new CacheService(getCacheTTL(runtime));
  }

  /**
   * Generate text using small model
   */
  async generateTextSmall(params: GenerateTextParams): Promise<string> {
    const gateway = createGatewayClient(this.runtime);
    const modelName = getSmallModel(this.runtime);
    const maxRetries = getMaxRetries(this.runtime);

    logger.log(`[AIGateway] Using TEXT_SMALL model: ${modelName}`);

    // Check cache
    const cacheKey = this.cache.generateKey({ model: modelName, ...params });
    const cached = this.cache.get<string>(cacheKey);
    if (cached) {
      logger.debug("[AIGateway] Cache hit for TEXT_SMALL");
      return cached;
    }

    const result = await pRetry(
      async () => {
        const { text, usage } = await generateText({
          model: gateway.languageModel(modelName),
          prompt: params.prompt,
          system: this.runtime.character?.system ?? undefined,
          temperature: params.temperature ?? 0.7,
          maxTokens: params.maxTokens ?? 2048,
          frequencyPenalty: params.frequencyPenalty ?? 0.7,
          presencePenalty: params.presencePenalty ?? 0.7,
          stopSequences: params.stopSequences,
        });

        if (usage) {
          emitModelUsageEvent(
            this.runtime,
            ModelType.TEXT_SMALL,
            params.prompt,
            usage,
          );
        }

        return text;
      },
      {
        retries: maxRetries,
        onFailedAttempt: (error) => {
          logger.warn(
            `[AIGateway] Attempt ${error.attemptNumber} failed: ${error.message}`,
          );
        },
      },
    );

    // Cache result
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Generate text using large model
   */
  async generateTextLarge(params: GenerateTextParams): Promise<string> {
    const gateway = createGatewayClient(this.runtime);
    const modelName = getLargeModel(this.runtime);
    const maxRetries = getMaxRetries(this.runtime);

    logger.log(`[AIGateway] Using TEXT_LARGE model: ${modelName}`);

    // Check cache
    const cacheKey = this.cache.generateKey({ model: modelName, ...params });
    const cached = this.cache.get<string>(cacheKey);
    if (cached) {
      logger.debug("[AIGateway] Cache hit for TEXT_LARGE");
      return cached;
    }

    const result = await pRetry(
      async () => {
        const { text, usage } = await generateText({
          model: gateway.languageModel(modelName),
          prompt: params.prompt,
          system: this.runtime.character?.system ?? undefined,
          temperature: params.temperature ?? 0.7,
          maxTokens: params.maxTokens ?? 8192,
          frequencyPenalty: params.frequencyPenalty ?? 0.7,
          presencePenalty: params.presencePenalty ?? 0.7,
          stopSequences: params.stopSequences,
        });

        if (usage) {
          emitModelUsageEvent(
            this.runtime,
            ModelType.TEXT_LARGE,
            params.prompt,
            usage,
          );
        }

        return text;
      },
      {
        retries: maxRetries,
        onFailedAttempt: (error) => {
          logger.warn(
            `[AIGateway] Attempt ${error.attemptNumber} failed: ${error.message}`,
          );
        },
      },
    );

    // Cache result
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Generate embeddings
   */
  async generateEmbedding(
    params: TextEmbeddingParams | string | null,
  ): Promise<number[]> {
    const embeddingModel = getEmbeddingModel(this.runtime);
    const embeddingDimension = 1536; // Default for OpenAI

    if (params === null) {
      logger.debug("[AIGateway] Creating test embedding for initialization");
      const testVector = Array(embeddingDimension).fill(0);
      testVector[0] = 0.1;
      return testVector;
    }

    let text: string;
    if (typeof params === "string") {
      text = params;
    } else if (typeof params === "object" && params.text) {
      text = params.text;
    } else {
      logger.warn("[AIGateway] Invalid input format for embedding");
      const fallbackVector = Array(embeddingDimension).fill(0);
      fallbackVector[0] = 0.2;
      return fallbackVector;
    }

    if (!text.trim()) {
      logger.warn("[AIGateway] Empty text for embedding");
      const emptyVector = Array(embeddingDimension).fill(0);
      emptyVector[0] = 0.3;
      return emptyVector;
    }

    const baseURL = getBaseURL(this.runtime);
    const apiKey = getApiKey(this.runtime);

    if (!apiKey) {
      throw new Error("AI Gateway API key not configured");
    }

    try {
      const response = await fetch(`${baseURL}/openai/embeddings`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          "x-vercel-app": getAppName(this.runtime),
        },
        body: JSON.stringify({
          model: embeddingModel.replace(":", "/"),
          input: text,
        }),
      });

      if (!response.ok) {
        logger.error(
          `[AIGateway] API error: ${response.status} - ${response.statusText}`,
        );
        const errorVector = Array(embeddingDimension).fill(0);
        errorVector[0] = 0.4;
        return errorVector;
      }

      const data = (await response.json()) as {
        data: [{ embedding: number[] }];
        usage?: { prompt_tokens: number; total_tokens: number };
      };

      if (!data?.data?.[0]?.embedding) {
        logger.error("[AIGateway] API returned invalid structure");
        const errorVector = Array(embeddingDimension).fill(0);
        errorVector[0] = 0.5;
        return errorVector;
      }

      const embedding = data.data[0].embedding;

      if (data.usage) {
        const usage = {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: 0,
          totalTokens: data.usage.total_tokens,
        };

        emitModelUsageEvent(
          this.runtime,
          ModelType.TEXT_EMBEDDING,
          text,
          usage,
        );
      }

      logger.log(
        `[AIGateway] Got valid embedding with length ${embedding.length}`,
      );
      return embedding;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[AIGateway] Error generating embedding: ${message}`);
      const errorVector = Array(embeddingDimension).fill(0);
      errorVector[0] = 0.6;
      return errorVector;
    }
  }

  /**
   * Generate images
   */
  async generateImage(params: { prompt: string; n?: number; size?: string }) {
    const n = params.n || 1;
    const size = params.size || "1024x1024";
    const prompt = params.prompt;
    const modelName = "openai:dall-e-3";

    logger.log(`[AIGateway] Using IMAGE model: ${modelName}`);

    const baseURL = getBaseURL(this.runtime);
    const apiKey = getApiKey(this.runtime);

    if (!apiKey) {
      throw new Error("AI Gateway API key not configured");
    }

    try {
      const response = await fetch(`${baseURL}/openai/images/generations`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          "x-vercel-app": getAppName(this.runtime),
        },
        body: JSON.stringify({
          model: modelName.replace(":", "/"),
          prompt: prompt,
          n: n,
          size: size,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to generate image: ${response.statusText}`);
      }

      const data = await response.json();
      const typedData = data as { data: { url: string }[] };

      return typedData.data;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[AIGateway] Error generating image: ${message}`);
      throw error;
    }
  }

  /**
   * Generate structured objects (small model)
   */
  async generateObjectSmall(
    params: ObjectGenerationParams,
  ): Promise<JSONValue> {
    const gateway = createGatewayClient(this.runtime);
    const modelName = getSmallModel(this.runtime);

    logger.log(`[AIGateway] Using OBJECT_SMALL model: ${modelName}`);

    try {
      const { object, usage } = await generateObject({
        model: gateway.languageModel(modelName),
        output: "no-schema",
        prompt: params.prompt,
        temperature: params.temperature ?? 0,
      });

      if (usage) {
        emitModelUsageEvent(
          this.runtime,
          ModelType.OBJECT_SMALL,
          params.prompt,
          usage,
        );
      }

      return object;
    } catch (error: unknown) {
      if (error instanceof JSONParseError) {
        logger.error(`[AIGateway] Failed to parse JSON: ${error.message}`);
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[AIGateway] Error generating object: ${message}`);
      throw error;
    }
  }

  /**
   * Generate structured objects (large model)
   */
  async generateObjectLarge(
    params: ObjectGenerationParams,
  ): Promise<JSONValue> {
    const gateway = createGatewayClient(this.runtime);
    const modelName = getLargeModel(this.runtime);

    logger.log(`[AIGateway] Using OBJECT_LARGE model: ${modelName}`);

    try {
      const { object, usage } = await generateObject({
        model: gateway.languageModel(modelName),
        output: "no-schema",
        prompt: params.prompt,
        temperature: params.temperature ?? 0,
      });

      if (usage) {
        emitModelUsageEvent(
          this.runtime,
          ModelType.OBJECT_LARGE,
          params.prompt,
          usage,
        );
      }

      return object;
    } catch (error: unknown) {
      if (error instanceof JSONParseError) {
        logger.error(`[AIGateway] Failed to parse JSON: ${error.message}`);
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[AIGateway] Error generating object: ${message}`);
      throw error;
    }
  }
}
