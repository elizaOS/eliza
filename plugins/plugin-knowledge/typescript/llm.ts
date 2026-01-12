import { createAnthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { type IAgentRuntime, logger } from "@elizaos/core";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText as aiGenerateText, type CoreMessage, embed } from "ai";

type AIModel = Parameters<typeof aiGenerateText>[0]["model"];

interface TextGenerationResult {
  text: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  finishReason?: string;
  response?: {
    id?: string;
    modelId?: string;
  };
}

import { validateModelConfig } from "./config";
import type { ModelConfig, TextGenerationOptions } from "./types";

export async function generateTextEmbedding(
  runtime: IAgentRuntime,
  text: string
): Promise<{ embedding: number[] }> {
  const config = validateModelConfig(runtime);
  const dimensions = config.EMBEDDING_DIMENSION;

  try {
    if (config.EMBEDDING_PROVIDER === "openai") {
      return await generateOpenAIEmbedding(text, config, dimensions);
    } else if (config.EMBEDDING_PROVIDER === "google") {
      return await generateGoogleEmbedding(text, config);
    }

    throw new Error(`Unsupported embedding provider: ${config.EMBEDDING_PROVIDER}`);
  } catch (error) {
    logger.error({ error }, `[Document Processor] ${config.EMBEDDING_PROVIDER} embedding error`);
    throw error;
  }
}

export async function generateTextEmbeddingsBatch(
  runtime: IAgentRuntime,
  texts: string[],
  batchSize: number = 20
): Promise<
  Array<{ embedding: number[] | null; success: boolean; error?: unknown; index: number }>
> {
  const _config = validateModelConfig(runtime);
  const results: Array<{
    embedding: number[] | null;
    success: boolean;
    error?: unknown;
    index: number;
  }> = [];

  logger.debug(
    `[Document Processor] Processing ${texts.length} embeddings in batches of ${batchSize}`
  );

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchStartIndex = i;

    logger.debug(
      `[Document Processor] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} (${batch.length} items)`
    );

    const batchPromises = batch.map(async (text, batchIndex) => {
      const globalIndex = batchStartIndex + batchIndex;
      try {
        const result = await generateTextEmbedding(runtime, text);
        return {
          embedding: result.embedding,
          success: true,
          index: globalIndex,
        };
      } catch (error) {
        logger.error({ error }, `[Document Processor] Embedding error for item ${globalIndex}`);
        return {
          embedding: null,
          success: false,
          error,
          index: globalIndex,
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    if (i + batchSize < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.length - successCount;

  logger.debug(
    `[Document Processor] Embedding batch complete: ${successCount} success, ${failureCount} failures`
  );

  return results;
}

async function generateOpenAIEmbedding(
  text: string,
  config: ModelConfig,
  dimensions: number
): Promise<{ embedding: number[] }> {
  const openai = createOpenAI({
    apiKey: config.OPENAI_API_KEY as string,
    baseURL: config.OPENAI_BASE_URL,
  });

  const modelInstance = openai.embedding(config.TEXT_EMBEDDING_MODEL);

  const embedOptions: {
    model: ReturnType<typeof openai.embedding>;
    value: string;
    dimensions?: number;
  } = {
    model: modelInstance,
    value: text,
  };

  if (
    dimensions &&
    ["text-embedding-3-small", "text-embedding-3-large"].includes(config.TEXT_EMBEDDING_MODEL)
  ) {
    embedOptions.dimensions = dimensions;
  }

  const { embedding, usage } = await embed(embedOptions);

  const totalTokens = (usage as { totalTokens?: number })?.totalTokens;
  const usageMessage = totalTokens ? `${totalTokens} total tokens` : "Usage details N/A";
  logger.debug(
    `[Document Processor] OpenAI embedding ${config.TEXT_EMBEDDING_MODEL}${embedOptions.dimensions ? ` (${embedOptions.dimensions}D)` : ""}: ${usageMessage}`
  );

  return { embedding };
}

/**
 * Generates an embedding using Google
 */
async function generateGoogleEmbedding(
  text: string,
  config: ModelConfig
): Promise<{ embedding: number[] }> {
  const googleProvider = google;
  if (config.GOOGLE_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.GOOGLE_API_KEY;
  }

  const modelInstance = googleProvider.textEmbeddingModel(config.TEXT_EMBEDDING_MODEL);

  const { embedding, usage } = await embed({
    model: modelInstance,
    value: text,
  });

  const totalTokens = (usage as { totalTokens?: number })?.totalTokens;
  const usageMessage = totalTokens ? `${totalTokens} total tokens` : "Usage details N/A";
  logger.debug(
    `[Document Processor] Google embedding ${config.TEXT_EMBEDDING_MODEL}: ${usageMessage}`
  );

  return { embedding };
}

export async function generateText(
  runtime: IAgentRuntime,
  prompt: string,
  system?: string,
  overrideConfig?: TextGenerationOptions
): Promise<TextGenerationResult> {
  const config = validateModelConfig(runtime);
  const provider = overrideConfig?.provider || config.TEXT_PROVIDER;
  const modelName = overrideConfig?.modelName || config.TEXT_MODEL;
  const maxTokens = overrideConfig?.maxTokens || config.MAX_OUTPUT_TOKENS;
  const autoCacheContextualRetrieval = overrideConfig?.autoCacheContextualRetrieval !== false;

  if (!modelName) {
    throw new Error(`No model name configured for provider: ${provider}`);
  }

  try {
    switch (provider) {
      case "anthropic":
        return await generateAnthropicText(config, prompt, system, modelName, maxTokens);
      case "openai":
        return await generateOpenAIText(config, prompt, system, modelName, maxTokens);
      case "openrouter":
        return await generateOpenRouterText(
          config,
          prompt,
          system,
          modelName,
          maxTokens,
          overrideConfig?.cacheDocument,
          overrideConfig?.cacheOptions,
          autoCacheContextualRetrieval
        );
      case "google":
        return await generateGoogleText(prompt, system, modelName, maxTokens, config);
      default:
        throw new Error(`Unsupported text provider: ${provider}`);
    }
  } catch (error) {
    logger.error({ error }, `[Document Processor] ${provider} ${modelName} error`);
    throw error;
  }
}

async function generateAnthropicText(
  config: ModelConfig,
  prompt: string,
  system: string | undefined,
  modelName: string,
  maxTokens: number
): Promise<TextGenerationResult> {
  const anthropic = createAnthropic({
    apiKey: config.ANTHROPIC_API_KEY as string,
    baseURL: config.ANTHROPIC_BASE_URL,
  });

  const modelInstance = anthropic(modelName);
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await aiGenerateText({
        model: modelInstance,
        prompt: prompt,
        system: system,
        temperature: 0.3,
        maxOutputTokens: maxTokens,
      });

      const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
      logger.debug(
        `[Document Processor] ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
      );

      return result;
    } catch (error: unknown) {
      const errorObj = error as { status?: number; message?: string } | null;
      const isRateLimit =
        errorObj?.status === 429 ||
        errorObj?.message?.includes("rate limit") ||
        errorObj?.message?.includes("429");

      if (isRateLimit && attempt < maxRetries - 1) {
        const delay = 2 ** (attempt + 1) * 1000;
        logger.warn(
          `[Document Processor] Rate limit hit (${modelName}): attempt ${attempt + 1}/${maxRetries}, retrying in ${Math.round(delay / 1000)}s`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }

  throw new Error("Max retries exceeded for Anthropic text generation");
}

async function generateOpenAIText(
  config: ModelConfig,
  prompt: string,
  system: string | undefined,
  modelName: string,
  maxTokens: number
): Promise<TextGenerationResult> {
  const openai = createOpenAI({
    apiKey: config.OPENAI_API_KEY as string,
    baseURL: config.OPENAI_BASE_URL,
  });

  const modelInstance = openai.chat(modelName);

  const result = await aiGenerateText({
    model: modelInstance,
    prompt: prompt,
    system: system,
    temperature: 0.3,
    maxOutputTokens: maxTokens,
  });

  const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
  logger.debug(
    `[Document Processor] OpenAI ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
  );

  return result;
}

async function generateGoogleText(
  prompt: string,
  system: string | undefined,
  modelName: string,
  maxTokens: number,
  config: ModelConfig
): Promise<TextGenerationResult> {
  const googleProvider = google;
  if (config.GOOGLE_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.GOOGLE_API_KEY;
  }

  const modelInstance = googleProvider(modelName);

  const result = await aiGenerateText({
    model: modelInstance,
    prompt: prompt,
    system: system,
    temperature: 0.3,
    maxOutputTokens: maxTokens,
  });

  const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
  logger.debug(
    `[Document Processor] Google ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
  );

  return result;
}

async function generateOpenRouterText(
  config: ModelConfig,
  prompt: string,
  system: string | undefined,
  modelName: string,
  maxTokens: number,
  cacheDocument?: string,
  _cacheOptions?: { type: "ephemeral" },
  autoCacheContextualRetrieval = true
): Promise<TextGenerationResult> {
  const openrouter = createOpenRouter({
    apiKey: config.OPENROUTER_API_KEY as string,
    baseURL: config.OPENROUTER_BASE_URL,
  });

  const modelInstance = openrouter.chat(modelName);

  const isClaudeModel = modelName.toLowerCase().includes("claude");
  const isGeminiModel = modelName.toLowerCase().includes("gemini");
  const isGemini25Model = modelName.toLowerCase().includes("gemini-2.5");
  const supportsCaching = isClaudeModel || isGeminiModel;

  let documentForCaching: string | undefined = cacheDocument;

  if (!documentForCaching && autoCacheContextualRetrieval && supportsCaching) {
    const docMatch = prompt.match(/<document>([\s\S]*?)<\/document>/);
    if (docMatch?.[1]) {
      documentForCaching = docMatch[1].trim();
      logger.debug(
        `[Document Processor] Auto-detected document for caching (${documentForCaching.length} chars)`
      );
    }
  }

  if (documentForCaching && supportsCaching) {
    let promptText = prompt;
    if (promptText.includes("<document>")) {
      promptText = promptText.replace(/<document>[\s\S]*?<\/document>/, "").trim();
    }

    if (isClaudeModel) {
      return await generateClaudeWithCaching(
        promptText,
        system,
        modelInstance as AIModel,
        modelName,
        maxTokens,
        documentForCaching
      );
    } else if (isGeminiModel) {
      return await generateGeminiWithCaching(
        promptText,
        system,
        modelInstance as AIModel,
        modelName,
        maxTokens,
        documentForCaching,
        isGemini25Model
      );
    }
  }

  // Standard request without caching
  logger.debug("[Document Processor] Using standard request without caching");
  return await generateStandardOpenRouterText(
    prompt,
    system,
    modelInstance as AIModel,
    modelName,
    maxTokens
  );
}

async function generateClaudeWithCaching(
  promptText: string,
  system: string | undefined,
  modelInstance: AIModel,
  modelName: string,
  maxTokens: number,
  documentForCaching: string
): Promise<TextGenerationResult> {
  logger.debug(`[Document Processor] Using explicit prompt caching with Claude ${modelName}`);

  const messages = [
    system
      ? {
          role: "system",
          content: [
            {
              type: "text",
              text: system,
            },
            {
              type: "text",
              text: documentForCaching,
              cache_control: {
                type: "ephemeral",
              },
            },
          ],
        }
      : {
          role: "user",
          content: [
            {
              type: "text",
              text: "Document for context:",
            },
            {
              type: "text",
              text: documentForCaching,
              cache_control: {
                type: "ephemeral",
              },
            },
            {
              type: "text",
              text: promptText,
            },
          ],
        },
    system
      ? {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        }
      : null,
  ].filter(Boolean);

  const result = await aiGenerateText({
    model: modelInstance,
    messages: messages as CoreMessage[],
    temperature: 0.3,
    maxOutputTokens: maxTokens,
    providerOptions: {
      openrouter: {
        usage: {
          include: true,
        },
      },
    },
  });

  logCacheMetrics(result);
  const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
  logger.debug(
    `[Document Processor] OpenRouter ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
  );

  return result;
}

async function generateGeminiWithCaching(
  promptText: string,
  system: string | undefined,
  modelInstance: AIModel,
  modelName: string,
  maxTokens: number,
  documentForCaching: string,
  isGemini25Model: boolean
): Promise<TextGenerationResult> {
  const usingImplicitCaching = isGemini25Model;
  const _estimatedDocTokens = Math.ceil(documentForCaching.length / 4);
  const _minTokensForImplicitCache = modelName.toLowerCase().includes("flash") ? 1028 : 2048;

  if (usingImplicitCaching) {
    logger.debug(`[Document Processor] Using Gemini 2.5 implicit caching with ${modelName}`);
  }

  const geminiSystemPrefix = system ? `${system}\n\n` : "";
  const geminiPrompt = `${geminiSystemPrefix}${documentForCaching}\n\n${promptText}`;

  const result = await aiGenerateText({
    model: modelInstance,
    prompt: geminiPrompt,
    temperature: 0.3,
    maxOutputTokens: maxTokens,
    providerOptions: {
      openrouter: {
        usage: {
          include: true,
        },
      },
    },
  });

  logCacheMetrics(result);
  const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
  logger.debug(
    `[Document Processor] OpenRouter ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
  );

  return result;
}

async function generateStandardOpenRouterText(
  prompt: string,
  system: string | undefined,
  modelInstance: AIModel,
  modelName: string,
  maxTokens: number
): Promise<TextGenerationResult> {
  const result = await aiGenerateText({
    model: modelInstance,
    prompt: prompt,
    system: system,
    temperature: 0.3,
    maxOutputTokens: maxTokens,
    providerOptions: {
      openrouter: {
        usage: {
          include: true,
        },
      },
    },
  });

  const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
  logger.debug(
    `[Document Processor] OpenRouter ${modelName}: ${totalTokens} tokens (${result.usage.inputTokens || 0}→${result.usage.outputTokens || 0})`
  );

  return result;
}

function logCacheMetrics(result: TextGenerationResult): void {
  const usage = result.usage as { cacheTokens?: number; cacheDiscount?: number } | undefined;
  if (usage?.cacheTokens !== undefined) {
    logger.debug(
      `[Document Processor] Cache metrics - tokens: ${usage.cacheTokens}, discount: ${usage.cacheDiscount ?? 0}`
    );
  }
}
