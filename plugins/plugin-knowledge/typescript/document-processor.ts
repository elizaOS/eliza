import type { Buffer } from "node:buffer";
import {
  type CustomMetadata,
  type IAgentRuntime,
  logger,
  type Memory,
  MemoryType,
  ModelType,
  splitChunks,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { getProviderRateLimits, validateModelConfig } from "./config.ts";
import {
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_CHUNK_TOKEN_SIZE,
  getCachingContextualizationPrompt,
  getCachingPromptForMimeType,
  getChunkWithContext,
  getContextualizationPrompt,
  getPromptForMimeType,
} from "./ctx-embeddings.ts";
import { generateText } from "./llm.ts";
import { convertPdfToTextFromBuffer, extractTextFromFileBuffer } from "./utils.ts";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getCtxKnowledgeEnabled(runtime?: IAgentRuntime): boolean {
  let result: boolean;
  let _source: string;
  let rawValue: string | undefined;

  if (runtime) {
    const settingValue = runtime.getSetting("CTX_KNOWLEDGE_ENABLED");
    rawValue = typeof settingValue === "string" ? settingValue : settingValue?.toString();
    const cleanValue = rawValue?.trim().toLowerCase();
    result = cleanValue === "true";
  } else {
    rawValue = process.env.CTX_KNOWLEDGE_ENABLED;
    const cleanValue = rawValue?.toString().trim().toLowerCase();
    result = cleanValue === "true";
  }

  return result;
}

function shouldUseCustomLLM(): boolean {
  const textProvider = process.env.TEXT_PROVIDER;
  const textModel = process.env.TEXT_MODEL;

  if (!textProvider || !textModel) {
    return false;
  }

  switch (textProvider.toLowerCase()) {
    case "openrouter":
      return !!process.env.OPENROUTER_API_KEY;
    case "openai":
      return !!process.env.OPENAI_API_KEY;
    case "anthropic":
      return !!process.env.ANTHROPIC_API_KEY;
    case "google":
      return !!process.env.GOOGLE_API_KEY;
    default:
      return false;
  }
}

const useCustomLLM = shouldUseCustomLLM();

export async function processFragmentsSynchronously({
  runtime,
  documentId,
  fullDocumentText,
  agentId,
  contentType,
  roomId,
  entityId,
  worldId,
  documentTitle,
}: {
  runtime: IAgentRuntime;
  documentId: UUID;
  fullDocumentText: string;
  agentId: UUID;
  contentType?: string;
  roomId?: UUID;
  entityId?: UUID;
  worldId?: UUID;
  documentTitle?: string;
}): Promise<number> {
  if (!fullDocumentText || fullDocumentText.trim() === "") {
    logger.warn(`No text content available for document ${documentId}`);
    return 0;
  }

  const chunks = await splitDocumentIntoChunks(fullDocumentText);

  if (chunks.length === 0) {
    logger.warn(`No chunks generated for document ${documentId}`);
    return 0;
  }

  logger.info(`Split into ${chunks.length} chunks`);

  const providerLimits = await getProviderRateLimits(runtime);
  const CONCURRENCY_LIMIT = providerLimits.maxConcurrentRequests || 30;
  const rateLimiter = createRateLimiter(
    providerLimits.requestsPerMinute || 60,
    providerLimits.tokensPerMinute,
    providerLimits.rateLimitEnabled
  );

  // Process and save fragments
  const { savedCount, failedCount } = await processAndSaveFragments({
    runtime,
    documentId,
    chunks,
    fullDocumentText,
    contentType,
    agentId,
    roomId: roomId || agentId,
    entityId: entityId || agentId,
    worldId: worldId || agentId,
    concurrencyLimit: CONCURRENCY_LIMIT,
    rateLimiter,
    documentTitle,
    batchDelayMs: providerLimits.batchDelayMs,
  });

  if (failedCount > 0) {
    logger.warn(`${failedCount}/${chunks.length} chunks failed processing`);
  }

  return savedCount;
}

export async function extractTextFromDocument(
  fileBuffer: Buffer,
  contentType: string,
  originalFilename: string
): Promise<string> {
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new Error(`Empty file buffer provided for ${originalFilename}`);
  }

  try {
    if (contentType === "application/pdf") {
      logger.debug(`Extracting text from PDF: ${originalFilename}`);
      return await convertPdfToTextFromBuffer(fileBuffer, originalFilename);
    } else {
      if (
        contentType.includes("text/") ||
        contentType.includes("application/json") ||
        contentType.includes("application/xml")
      ) {
        try {
          return fileBuffer.toString("utf8");
        } catch (_textError) {
          logger.warn(`Failed to decode ${originalFilename} as UTF-8`);
        }
      }

      return await extractTextFromFileBuffer(fileBuffer, contentType, originalFilename);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error extracting text from ${originalFilename}: ${errorMessage}`);
    throw new Error(`Failed to extract text from ${originalFilename}: ${errorMessage}`);
  }
}

export function createDocumentMemory({
  text,
  agentId,
  clientDocumentId,
  originalFilename,
  contentType,
  worldId,
  fileSize,
  documentId,
  customMetadata,
}: {
  text: string;
  agentId: UUID;
  clientDocumentId: UUID;
  originalFilename: string;
  contentType: string;
  worldId: UUID;
  fileSize: number;
  documentId?: UUID;
  customMetadata?: Record<string, unknown>;
}): Memory {
  const fileExt = originalFilename.split(".").pop()?.toLowerCase() || "";
  const title = originalFilename.replace(`.${fileExt}`, "");
  const docId = documentId || (uuidv4() as UUID);

  return {
    id: docId,
    agentId,
    roomId: agentId,
    worldId,
    entityId: agentId,
    content: { text },
    metadata: {
      type: MemoryType.CUSTOM,
      documentId: clientDocumentId,
      originalFilename,
      contentType,
      title,
      fileExt,
      fileSize,
      source: "rag-service-main-upload",
      timestamp: Date.now(),
      ...(customMetadata || {}),
    } satisfies CustomMetadata,
  };
}

async function splitDocumentIntoChunks(documentText: string): Promise<string[]> {
  const tokenChunkSize = DEFAULT_CHUNK_TOKEN_SIZE;
  const tokenChunkOverlap = DEFAULT_CHUNK_OVERLAP_TOKENS;

  return await splitChunks(documentText, tokenChunkSize, tokenChunkOverlap);
}

async function processAndSaveFragments({
  runtime,
  documentId,
  chunks,
  fullDocumentText,
  contentType,
  agentId,
  roomId,
  entityId,
  worldId,
  concurrencyLimit,
  rateLimiter,
  documentTitle,
  batchDelayMs = 500,
}: {
  runtime: IAgentRuntime;
  documentId: UUID;
  chunks: string[];
  fullDocumentText: string;
  contentType?: string;
  agentId: UUID;
  roomId?: UUID;
  entityId?: UUID;
  worldId?: UUID;
  concurrencyLimit: number;
  rateLimiter: (estimatedTokens?: number) => Promise<void>;
  documentTitle?: string;
  batchDelayMs?: number;
}): Promise<{
  savedCount: number;
  failedCount: number;
  failedChunks: number[];
}> {
  let savedCount = 0;
  let failedCount = 0;
  const failedChunks: number[] = [];

  for (let i = 0; i < chunks.length; i += concurrencyLimit) {
    const batchChunks = chunks.slice(i, i + concurrencyLimit);
    const batchOriginalIndices = Array.from({ length: batchChunks.length }, (_, k) => i + k);

    const contextualizedChunks = await getContextualizedChunks(
      runtime,
      fullDocumentText,
      batchChunks,
      contentType,
      batchOriginalIndices,
      documentTitle
    );

    const embeddingResults = await generateEmbeddingsForChunks(
      runtime,
      contextualizedChunks,
      rateLimiter
    );

    for (const result of embeddingResults) {
      const originalChunkIndex = result.index;

      if (!result.success) {
        failedCount++;
        failedChunks.push(originalChunkIndex);
        logger.warn(`Failed to process chunk ${originalChunkIndex} for document ${documentId}`);
        continue;
      }

      const contextualizedChunkText = result.text;
      const embedding = result.embedding;

      if (!embedding || embedding.length === 0) {
        failedCount++;
        failedChunks.push(originalChunkIndex);
        continue;
      }

      try {
        const fragmentMemory: Memory = {
          id: uuidv4() as UUID,
          agentId,
          roomId: roomId || agentId,
          worldId: worldId || agentId,
          entityId: entityId || agentId,
          embedding,
          content: { text: contextualizedChunkText },
          metadata: {
            type: MemoryType.FRAGMENT,
            documentId,
            position: originalChunkIndex,
            timestamp: Date.now(),
            source: "rag-service-fragment-sync",
          },
        };

        await runtime.createMemory(fragmentMemory, "knowledge");
        savedCount++;
      } catch (saveError) {
        const errorMessage = saveError instanceof Error ? saveError.message : String(saveError);
        logger.error(`Error saving chunk ${originalChunkIndex} to database: ${errorMessage}`);
        failedCount++;
        failedChunks.push(originalChunkIndex);
      }
    }

    if (i + concurrencyLimit < chunks.length && batchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
    }
  }

  return { savedCount, failedCount, failedChunks };
}

const EMBEDDING_BATCH_SIZE = 100;

interface EmbeddingResult {
  embedding?: number[];
  success: boolean;
  index: number;
  error?: Error;
  text: string;
}

async function generateEmbeddingsForChunks(
  runtime: IAgentRuntime,
  contextualizedChunks: Array<{
    contextualizedText: string;
    index: number;
    success: boolean;
  }>,
  rateLimiter: (estimatedTokens?: number) => Promise<void>
): Promise<Array<EmbeddingResult>> {
  const validChunks = contextualizedChunks.filter((chunk) => chunk.success);
  const failedChunks = contextualizedChunks.filter((chunk) => !chunk.success);

  const results: Array<EmbeddingResult> = [];
  for (const chunk of failedChunks) {
    results.push({
      success: false,
      index: chunk.index,
      error: new Error("Chunk processing failed"),
      text: chunk.contextualizedText,
    });
  }

  if (validChunks.length === 0) {
    return results;
  }

  const useBatchEmbeddings = shouldUseBatchEmbeddings(runtime);

  if (useBatchEmbeddings) {
    return await generateEmbeddingsBatch(runtime, validChunks, rateLimiter, results);
  } else {
    return await generateEmbeddingsIndividual(runtime, validChunks, rateLimiter, results);
  }
}

function shouldUseBatchEmbeddings(runtime: IAgentRuntime): boolean {
  const setting = runtime.getSetting("BATCH_EMBEDDINGS") ?? process.env.BATCH_EMBEDDINGS;
  if (setting === "false" || setting === false) {
    return false;
  }
  return true;
}

async function generateEmbeddingsBatch(
  runtime: IAgentRuntime,
  validChunks: Array<{ contextualizedText: string; index: number; success: boolean }>,
  rateLimiter: (estimatedTokens?: number) => Promise<void>,
  results: Array<EmbeddingResult>
): Promise<Array<EmbeddingResult>> {
  for (let batchStart = 0; batchStart < validChunks.length; batchStart += EMBEDDING_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + EMBEDDING_BATCH_SIZE, validChunks.length);
    const batch = validChunks.slice(batchStart, batchEnd);
    const batchTexts = batch.map((c) => c.contextualizedText);

    const totalTokens = batchTexts.reduce((sum, text) => sum + estimateTokens(text), 0);
    await rateLimiter(totalTokens);

    try {
      const embeddings = await generateBatchEmbeddingsViaRuntime(runtime, batchTexts);

      for (let i = 0; i < batch.length; i++) {
        const chunk = batch[i];
        const embedding = embeddings[i];

        if (embedding && embedding.length > 0 && embedding[0] !== 0) {
          results.push({
            embedding,
            success: true,
            index: chunk.index,
            text: chunk.contextualizedText,
          });
        } else {
          results.push({
            success: false,
            index: chunk.index,
            error: new Error("Empty or invalid embedding returned"),
            text: chunk.contextualizedText,
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Batch embedding error: ${errorMessage}`);
      for (const chunk of batch) {
        try {
          const result = await generateEmbeddingWithValidation(runtime, chunk.contextualizedText);
          if (result.success && result.embedding) {
            results.push({
              embedding: result.embedding,
              success: true,
              index: chunk.index,
              text: chunk.contextualizedText,
            });
          } else {
            results.push({
              success: false,
              index: chunk.index,
              error: result.error instanceof Error ? result.error : new Error("Embedding failed"),
              text: chunk.contextualizedText,
            });
          }
        } catch (fallbackError) {
          results.push({
            success: false,
            index: chunk.index,
            error:
              fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)),
            text: chunk.contextualizedText,
          });
        }
      }
    }
  }

  return results;
}

async function generateBatchEmbeddingsViaRuntime(
  runtime: IAgentRuntime,
  texts: string[]
): Promise<number[][]> {
  const batchResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, { texts } as {
    text: string;
  } & { texts: string[] });

  const isEmbeddingBatch = (val: unknown): val is number[][] =>
    Array.isArray(val) && val.length > 0 && Array.isArray(val[0]) && typeof val[0][0] === "number";

  const isEmbeddingVector = (val: unknown): val is number[] =>
    Array.isArray(val) && val.length > 0 && typeof val[0] === "number";

  if (isEmbeddingBatch(batchResult)) {
    return batchResult;
  }

  if (isEmbeddingVector(batchResult)) {
    const embeddings: number[][] = await Promise.all(
      texts.map(async (text) => {
        const result = await runtime.useModel(ModelType.TEXT_EMBEDDING, { text });
        if (isEmbeddingVector(result)) {
          return result;
        }
        const embeddingResult = result as { embedding?: number[] } | undefined;
        return embeddingResult?.embedding ?? [];
      })
    );
    return embeddings;
  }

  throw new Error("Unexpected batch embedding result format");
}

async function generateEmbeddingsIndividual(
  runtime: IAgentRuntime,
  validChunks: Array<{ contextualizedText: string; index: number; success: boolean }>,
  rateLimiter: (estimatedTokens?: number) => Promise<void>,
  results: Array<EmbeddingResult>
): Promise<Array<EmbeddingResult>> {
  for (const chunk of validChunks) {
    const embeddingTokens = estimateTokens(chunk.contextualizedText);
    await rateLimiter(embeddingTokens);

    try {
      const generateEmbeddingOperation = async () => {
        return await generateEmbeddingWithValidation(runtime, chunk.contextualizedText);
      };

      const { embedding, success, error } = await withRateLimitRetry(
        generateEmbeddingOperation,
        `embedding generation for chunk ${chunk.index}`
      );

      if (!success) {
        results.push({
          success: false,
          index: chunk.index,
          error,
          text: chunk.contextualizedText,
        });
      } else {
        results.push({
          embedding: embedding ?? undefined,
          success: true,
          index: chunk.index,
          text: chunk.contextualizedText,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error generating embedding for chunk ${chunk.index}: ${errorMessage}`);
      results.push({
        success: false,
        index: chunk.index,
        error: error instanceof Error ? error : new Error(String(error)),
        text: chunk.contextualizedText,
      });
    }
  }

  return results;
}

async function getContextualizedChunks(
  runtime: IAgentRuntime,
  fullDocumentText: string | undefined,
  chunks: string[],
  contentType: string | undefined,
  batchOriginalIndices: number[],
  documentTitle?: string
): Promise<Array<{ contextualizedText: string; index: number; success: boolean }>> {
  const ctxEnabled = getCtxKnowledgeEnabled(runtime);

  if (ctxEnabled && fullDocumentText) {
    return await generateContextsInBatch(
      runtime,
      fullDocumentText,
      chunks,
      contentType,
      batchOriginalIndices,
      documentTitle
    );
  }

  return chunks.map((chunkText, idx) => ({
    contextualizedText: chunkText,
    index: batchOriginalIndices[idx],
    success: true,
  }));
}

async function generateContextsInBatch(
  runtime: IAgentRuntime,
  fullDocumentText: string,
  chunks: string[],
  contentType?: string,
  batchIndices?: number[],
  _documentTitle?: string
): Promise<Array<{ contextualizedText: string; success: boolean; index: number }>> {
  if (!chunks || chunks.length === 0) {
    return [];
  }

  const providerLimits = await getProviderRateLimits(runtime);
  const rateLimiter = createRateLimiter(
    providerLimits.requestsPerMinute || 60,
    providerLimits.tokensPerMinute,
    providerLimits.rateLimitEnabled
  );

  const config = validateModelConfig(runtime);
  const isUsingOpenRouter = config.TEXT_PROVIDER === "openrouter";
  const isUsingCacheCapableModel =
    isUsingOpenRouter &&
    (config.TEXT_MODEL?.toLowerCase().includes("claude") ||
      config.TEXT_MODEL?.toLowerCase().includes("gemini"));

  logger.debug(
    `Contextualizing ${chunks.length} chunks with ${config.TEXT_PROVIDER}/${config.TEXT_MODEL} (cache: ${isUsingCacheCapableModel})`
  );

  const promptConfigs = prepareContextPrompts(
    chunks,
    fullDocumentText,
    contentType,
    batchIndices,
    isUsingCacheCapableModel
  );

  const contextualizedChunks = await Promise.all(
    promptConfigs.map(async (item) => {
      if (!item.valid) {
        return {
          contextualizedText: item.chunkText,
          success: false,
          index: item.originalIndex,
        };
      }

      const llmTokens = estimateTokens(item.chunkText + (item.prompt || ""));
      await rateLimiter(llmTokens);

      try {
        const generateTextOperation = async () => {
          if (useCustomLLM) {
            if (item.usesCaching && item.promptText) {
              return await generateText(runtime, item.promptText, item.systemPrompt, {
                cacheDocument: item.fullDocumentTextForContext,
                cacheOptions: { type: "ephemeral" },
                autoCacheContextualRetrieval: true,
              });
            } else if (item.prompt) {
              return await generateText(runtime, item.prompt);
            }
            throw new Error("Missing prompt for text generation");
          } else {
            if (item.usesCaching && item.promptText) {
              const combinedPrompt = item.systemPrompt
                ? `${item.systemPrompt}\n\n${item.promptText}`
                : item.promptText;
              return await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: combinedPrompt,
              });
            } else if (item.prompt) {
              return await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: item.prompt,
              });
            }
            throw new Error("Missing prompt for text generation");
          }
        };

        const llmResponse = await withRateLimitRetry(
          generateTextOperation,
          `context generation for chunk ${item.originalIndex}`
        );

        const generatedContext = typeof llmResponse === "string" ? llmResponse : llmResponse.text;
        const contextualizedText = getChunkWithContext(item.chunkText, generatedContext);

        return {
          contextualizedText,
          success: true,
          index: item.originalIndex,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Error generating context for chunk ${item.originalIndex}: ${errorMessage}`);
        return {
          contextualizedText: item.chunkText,
          success: false,
          index: item.originalIndex,
        };
      }
    })
  );

  return contextualizedChunks;
}

interface ContextPromptConfig {
  valid: boolean;
  originalIndex: number;
  chunkText: string;
  usesCaching: boolean;
  prompt?: string | null;
  systemPrompt?: string;
  promptText?: string;
  fullDocumentTextForContext?: string;
}

function prepareContextPrompts(
  chunks: string[],
  fullDocumentText: string,
  contentType?: string,
  batchIndices?: number[],
  isUsingCacheCapableModel = false
): Array<ContextPromptConfig> {
  return chunks.map((chunkText, idx) => {
    const originalIndex = batchIndices ? batchIndices[idx] : idx;
    try {
      if (isUsingCacheCapableModel) {
        const cachingPromptInfo = contentType
          ? getCachingPromptForMimeType(contentType, chunkText)
          : getCachingContextualizationPrompt(chunkText);

        if (cachingPromptInfo.prompt.startsWith("Error:")) {
          return {
            originalIndex,
            chunkText,
            valid: false,
            usesCaching: false,
          };
        }

        return {
          valid: true,
          originalIndex,
          chunkText,
          usesCaching: true,
          systemPrompt: cachingPromptInfo.systemPrompt,
          promptText: cachingPromptInfo.prompt,
          fullDocumentTextForContext: fullDocumentText,
        };
      } else {
        const prompt = contentType
          ? getPromptForMimeType(contentType, fullDocumentText, chunkText)
          : getContextualizationPrompt(fullDocumentText, chunkText);

        if (prompt.startsWith("Error:")) {
          return {
            prompt: null,
            originalIndex,
            chunkText,
            valid: false,
            usesCaching: false,
          };
        }

        return {
          prompt,
          originalIndex,
          chunkText,
          valid: true,
          usesCaching: false,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error preparing prompt for chunk ${originalIndex}: ${errorMessage}`);
      return {
        prompt: null,
        originalIndex,
        chunkText,
        valid: false,
        usesCaching: false,
      };
    }
  });
}

async function generateEmbeddingWithValidation(
  runtime: IAgentRuntime,
  text: string
): Promise<{
  embedding: number[] | null;
  success: boolean;
  error?: Error;
}> {
  try {
    const embeddingResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, { text });

    const embedding = Array.isArray(embeddingResult)
      ? embeddingResult
      : (embeddingResult as { embedding: number[] })?.embedding;

    if (!embedding || embedding.length === 0) {
      return { embedding: null, success: false, error: new Error("Zero vector detected") };
    }

    return { embedding, success: true };
  } catch (error) {
    return {
      embedding: null,
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  errorContext: string,
  retryDelay?: number
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const errorWithStatus = error as { status?: number; headers?: { "retry-after"?: number } };
    if (errorWithStatus.status === 429) {
      const delay = retryDelay || errorWithStatus.headers?.["retry-after"] || 5;
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));

      try {
        return await operation();
      } catch (retryError) {
        const retryErrorMessage =
          retryError instanceof Error ? retryError.message : String(retryError);
        logger.error(`Failed after retry for ${errorContext}: ${retryErrorMessage}`);
        throw retryError;
      }
    }
    throw error;
  }
}

function createRateLimiter(
  requestsPerMinute: number,
  tokensPerMinute?: number,
  rateLimitEnabled: boolean = true
) {
  const requestTimes: number[] = [];
  const tokenUsage: Array<{ timestamp: number; tokens: number }> = [];
  const intervalMs = 60 * 1000;

  return async function rateLimiter(estimatedTokens: number = 1000) {
    if (!rateLimitEnabled) return;

    const now = Date.now();

    while (requestTimes.length > 0 && now - requestTimes[0] > intervalMs) {
      requestTimes.shift();
    }
    while (tokenUsage.length > 0 && now - tokenUsage[0].timestamp > intervalMs) {
      tokenUsage.shift();
    }

    const currentTokens = tokenUsage.reduce((sum, usage) => sum + usage.tokens, 0);
    const requestLimitExceeded = requestTimes.length >= requestsPerMinute;
    const tokenLimitExceeded = tokensPerMinute && currentTokens + estimatedTokens > tokensPerMinute;

    if (requestLimitExceeded || tokenLimitExceeded) {
      let timeToWait = 0;
      if (requestLimitExceeded) {
        timeToWait = Math.max(timeToWait, requestTimes[0] + intervalMs - now);
      }
      if (tokenLimitExceeded && tokenUsage.length > 0) {
        timeToWait = Math.max(timeToWait, tokenUsage[0].timestamp + intervalMs - now);
      }
      if (timeToWait > 0) {
        await new Promise((resolve) => setTimeout(resolve, timeToWait));
      }
    }

    requestTimes.push(now);
    if (tokensPerMinute) {
      tokenUsage.push({ timestamp: now, tokens: estimatedTokens });
    }
  };
}
