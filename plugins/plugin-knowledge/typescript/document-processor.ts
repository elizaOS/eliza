import type { Buffer } from "node:buffer";
import {
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
  DEFAULT_CHARS_PER_TOKEN,
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

/**
 * Estimates token count for a text string (rough approximation)
 * Uses the common 4 characters per token rule
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Gets CTX_KNOWLEDGE_ENABLED setting from runtime or environment
 * Ensures consistency with config.ts validation
 */
function getCtxKnowledgeEnabled(runtime?: IAgentRuntime): boolean {
  let result: boolean;
  let source: string;
  let rawValue: string | undefined;

  if (runtime) {
    const settingValue = runtime.getSetting("CTX_KNOWLEDGE_ENABLED");
    rawValue = typeof settingValue === "string" ? settingValue : settingValue?.toString();
    // CRITICAL FIX: Use trim() and case-insensitive comparison
    const cleanValue = rawValue?.trim().toLowerCase();
    result = cleanValue === "true";
    source = "runtime.getSetting()";
  } else {
    rawValue = process.env.CTX_KNOWLEDGE_ENABLED;
    const cleanValue = rawValue?.toString().trim().toLowerCase();
    result = cleanValue === "true";
    source = "process.env";
  }

  // Only log when there's a mismatch or for initial debugging
  if (process.env.NODE_ENV === "development" && rawValue && !result) {
    logger.debug(`[Document Processor] CTX config mismatch - ${source}: '${rawValue}' → ${result}`);
  }

  return result;
}

/**
 * Check if custom LLM should be used based on environment variables
 * Custom LLM is enabled when all three key variables are set:
 * - TEXT_PROVIDER
 * - TEXT_MODEL
 * - OPENROUTER_API_KEY (or provider-specific API key)
 */
function shouldUseCustomLLM(): boolean {
  const textProvider = process.env.TEXT_PROVIDER;
  const textModel = process.env.TEXT_MODEL;

  if (!textProvider || !textModel) {
    return false;
  }

  // Check for provider-specific API keys
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

// =============================================================================
// MAIN DOCUMENT PROCESSING FUNCTIONS
// =============================================================================

/**
 * Process document fragments synchronously
 * This function:
 * 1. Splits the document text into chunks
 * 2. Enriches chunks with context if contextual Knowledge is enabled
 * 3. Generates embeddings for each chunk
 * 4. Stores fragments with embeddings in the database
 *
 * @param params Fragment parameters
 * @returns Number of fragments processed
 */
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
    logger.warn(`No text content available to chunk for document ${documentId}.`);
    return 0;
  }

  // Split the text into chunks using standard parameters
  const chunks = await splitDocumentIntoChunks(fullDocumentText);

  if (chunks.length === 0) {
    logger.warn(`No chunks generated from text for ${documentId}. No fragments to save.`);
    return 0;
  }

  const docName = documentTitle || documentId.substring(0, 8);
  logger.info(`[Document Processor] "${docName}": Split into ${chunks.length} chunks`);

  // Get provider limits for rate limiting
  const providerLimits = await getProviderRateLimits(runtime);
  const CONCURRENCY_LIMIT = providerLimits.maxConcurrentRequests || 30;
  const rateLimiter = createRateLimiter(
    providerLimits.requestsPerMinute || 60,
    providerLimits.tokensPerMinute,
    providerLimits.rateLimitEnabled
  );

  if (!providerLimits.rateLimitEnabled) {
    logger.info(
      `[Document Processor] UNLIMITED MODE: concurrency ${CONCURRENCY_LIMIT}, batch delay ${providerLimits.batchDelayMs}ms`
    );
  } else {
    logger.debug(
      `[Document Processor] Rate limits: ${providerLimits.requestsPerMinute} RPM, ${providerLimits.tokensPerMinute} TPM (${providerLimits.provider}, concurrency: ${CONCURRENCY_LIMIT})`
    );
  }

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

  // Report results with summary
  const successRate = ((savedCount / chunks.length) * 100).toFixed(1);

  if (failedCount > 0) {
    logger.warn(
      `[Document Processor] "${docName}": ${failedCount}/${chunks.length} chunks failed processing`
    );
  }

  logger.info(
    `[Document Processor] "${docName}" complete: ${savedCount}/${chunks.length} fragments saved (${successRate}% success)`
  );

  // Provide comprehensive end summary
  logKnowledgeGenerationSummary({
    documentId,
    totalChunks: chunks.length,
    savedCount,
    failedCount,
    successRate: parseFloat(successRate),
    ctxEnabled: getCtxKnowledgeEnabled(runtime),
    providerLimits,
  });

  return savedCount;
}

// =============================================================================
// DOCUMENT EXTRACTION & MEMORY FUNCTIONS
// =============================================================================

/**
 * Extract text from document buffer based on content type
 * @param fileBuffer Document buffer
 * @param contentType MIME type of the document
 * @param originalFilename Original filename
 * @returns Extracted text
 */
export async function extractTextFromDocument(
  fileBuffer: Buffer,
  contentType: string,
  originalFilename: string
): Promise<string> {
  // Validate buffer
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new Error(`Empty file buffer provided for ${originalFilename}. Cannot extract text.`);
  }

  try {
    if (contentType === "application/pdf") {
      logger.debug(`Extracting text from PDF: ${originalFilename}`);
      return await convertPdfToTextFromBuffer(fileBuffer, originalFilename);
    } else {
      logger.debug(`Extracting text from non-PDF: ${originalFilename} (Type: ${contentType})`);

      // For plain text files, try UTF-8 decoding first
      if (
        contentType.includes("text/") ||
        contentType.includes("application/json") ||
        contentType.includes("application/xml")
      ) {
        try {
          return fileBuffer.toString("utf8");
        } catch (_textError) {
          logger.warn(
            `Failed to decode ${originalFilename} as UTF-8, falling back to binary extraction`
          );
        }
      }

      // For other files, use general extraction
      return await extractTextFromFileBuffer(fileBuffer, contentType, originalFilename);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error extracting text from ${originalFilename}: ${errorMessage}`);
    throw new Error(`Failed to extract text from ${originalFilename}: ${errorMessage}`);
  }
}

/**
 * Create a memory object for the main document
 * @param params Document parameters
 * @returns Memory object for the main document
 */
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

  // Use the provided documentId or generate a new one
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
      // Merge custom metadata if provided
      ...(customMetadata || {}),
    } as unknown as Memory["metadata"],
  };
}

// =============================================================================
// CHUNKING AND FRAGMENT PROCESSING
// =============================================================================

/**
 * Split document text into chunks using standard parameters
 * @param documentText The full document text to split
 * @returns Array of text chunks
 */
async function splitDocumentIntoChunks(documentText: string): Promise<string[]> {
  // Use the standardized constants
  const tokenChunkSize = DEFAULT_CHUNK_TOKEN_SIZE;
  const tokenChunkOverlap = DEFAULT_CHUNK_OVERLAP_TOKENS;

  // Calculate character-based chunking sizes from token sizes for compatibility with splitChunks
  const targetCharChunkSize = Math.round(tokenChunkSize * DEFAULT_CHARS_PER_TOKEN);
  const targetCharChunkOverlap = Math.round(tokenChunkOverlap * DEFAULT_CHARS_PER_TOKEN);

  logger.debug(
    `Using core splitChunks with settings: tokenChunkSize=${tokenChunkSize}, tokenChunkOverlap=${tokenChunkOverlap}, ` +
      `charChunkSize=${targetCharChunkSize}, charChunkOverlap=${targetCharChunkOverlap}`
  );

  // Split the text into chunks
  return await splitChunks(documentText, tokenChunkSize, tokenChunkOverlap);
}

/**
 * Process and save document fragments
 * @param params Processing parameters
 * @returns Object with counts of saved and failed fragments
 */
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

  // Process chunks in batches to respect concurrency limits
  for (let i = 0; i < chunks.length; i += concurrencyLimit) {
    const batchChunks = chunks.slice(i, i + concurrencyLimit);
    const batchOriginalIndices = Array.from({ length: batchChunks.length }, (_, k) => i + k);

    logger.debug(
      `[Document Processor] Batch ${Math.floor(i / concurrencyLimit) + 1}/${Math.ceil(chunks.length / concurrencyLimit)}: processing ${batchChunks.length} chunks (${batchOriginalIndices[0]}-${batchOriginalIndices[batchOriginalIndices.length - 1]})`
    );

    // Process context generation in an optimized batch
    const contextualizedChunks = await getContextualizedChunks(
      runtime,
      fullDocumentText,
      batchChunks,
      contentType,
      batchOriginalIndices,
      documentTitle
    );

    // Generate embeddings with rate limiting
    const embeddingResults = await generateEmbeddingsForChunks(
      runtime,
      contextualizedChunks,
      rateLimiter
    );

    // Save fragments with embeddings
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
        logger.warn(
          `Zero vector detected for chunk ${originalChunkIndex} (document ${documentId}). Embedding: ${JSON.stringify(result.embedding)}`
        );
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
        // Log when all chunks for this document are processed
        if (originalChunkIndex === chunks.length - 1) {
          const docName = documentTitle || documentId.substring(0, 8);
          logger.info(
            `[Document Processor] "${docName}": All ${chunks.length} chunks processed successfully`
          );
        }
        savedCount++;
      } catch (saveError) {
        const errorMessage = saveError instanceof Error ? saveError.message : String(saveError);
        const errorStack = saveError instanceof Error ? saveError.stack : undefined;
        logger.error(
          `Error saving chunk ${originalChunkIndex} to database: ${errorMessage}`,
          errorStack
        );
        failedCount++;
        failedChunks.push(originalChunkIndex);
      }
    }

    // Add a configurable delay between batches to prevent overwhelming the API
    // Set BATCH_DELAY_MS=0 to disable delay for maximum throughput
    if (i + concurrencyLimit < chunks.length && batchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
    }
  }

  return { savedCount, failedCount, failedChunks };
}

const EMBEDDING_BATCH_SIZE = 100;

/**
 * Generate embeddings for contextualized chunks using BATCH API
 * This sends multiple texts in ONE request, dramatically reducing API calls
 *
 * @param runtime IAgentRuntime
 * @param contextualizedChunks Array of contextualized chunks
 * @param rateLimiter Rate limiter function
 * @returns Array of embedding results
 */
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
  // Separate valid and failed chunks
  const validChunks = contextualizedChunks.filter((chunk) => chunk.success);
  const failedChunks = contextualizedChunks.filter((chunk) => !chunk.success);

  // Prepare results array with failed chunks pre-populated
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

  // Check if batch embeddings are available (via environment or runtime)
  const useBatchEmbeddings = shouldUseBatchEmbeddings(runtime);

  if (useBatchEmbeddings) {
    logger.info(`[Document Processor] Using BATCH embeddings for ${validChunks.length} chunks`);
    return await generateEmbeddingsBatch(runtime, validChunks, rateLimiter, results);
  } else {
    // Fallback to individual embeddings (slower but works with any provider)
    logger.info(
      `[Document Processor] Using individual embeddings for ${validChunks.length} chunks`
    );
    return await generateEmbeddingsIndividual(runtime, validChunks, rateLimiter, results);
  }
}

/**
 * Check if batch embeddings should be used
 */
function shouldUseBatchEmbeddings(runtime: IAgentRuntime): boolean {
  // Default to true - batch is more efficient
  // Set BATCH_EMBEDDINGS=false to disable
  const setting = runtime.getSetting("BATCH_EMBEDDINGS") ?? process.env.BATCH_EMBEDDINGS;
  if (setting === "false" || setting === false) {
    return false;
  }
  return true;
}

/**
 * Generate embeddings using BATCH API (much more efficient)
 * Sends multiple texts in one request
 */
async function generateEmbeddingsBatch(
  runtime: IAgentRuntime,
  validChunks: Array<{ contextualizedText: string; index: number; success: boolean }>,
  rateLimiter: (estimatedTokens?: number) => Promise<void>,
  results: Array<EmbeddingResult>
): Promise<Array<EmbeddingResult>> {
  // Process in batches of EMBEDDING_BATCH_SIZE
  for (let batchStart = 0; batchStart < validChunks.length; batchStart += EMBEDDING_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + EMBEDDING_BATCH_SIZE, validChunks.length);
    const batch = validChunks.slice(batchStart, batchEnd);
    const batchTexts = batch.map((c) => c.contextualizedText);

    // Estimate tokens for rate limiting
    const totalTokens = batchTexts.reduce((sum, text) => sum + estimateTokens(text), 0);
    await rateLimiter(totalTokens);

    logger.info(
      `[Document Processor] Batch ${Math.floor(batchStart / EMBEDDING_BATCH_SIZE) + 1}/${Math.ceil(validChunks.length / EMBEDDING_BATCH_SIZE)}: ` +
        `${batch.length} texts, ~${totalTokens} tokens`
    );

    try {
      // Call batch embedding via runtime model (single request for all texts)
      const embeddings = await generateBatchEmbeddingsViaRuntime(runtime, batchTexts);

      // Map results back to original chunks
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
      logger.error(`[Document Processor] Batch embedding error: ${errorMessage}`);
      // Fall back to individual processing for this batch
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

/**
 * Generate batch embeddings via runtime.useModel
 * Uses { texts: string[] } for batch mode - handler must support both:
 * - { text: string } → single embedding (number[])
 * - { texts: string[] } → batch embeddings (number[][])
 */
async function generateBatchEmbeddingsViaRuntime(
  runtime: IAgentRuntime,
  texts: string[]
): Promise<number[][]> {
  // Call runtime.useModel with batch params { texts: string[] }
  // Note: Some handlers support batch mode with { texts: string[] } even though
  // the type definition only shows { text: string }
  const batchResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, { texts } as {
    text: string;
  } & { texts: string[] });

  // Handle the response - should be number[][] for batch
  if (Array.isArray(batchResult) && Array.isArray(batchResult[0])) {
    return batchResult as unknown as number[][];
  }

  // If handler returned single embedding (doesn't support batch), wrap it
  // This shouldn't happen if using plugin-elizacloud, but handle it gracefully
  if (Array.isArray(batchResult) && typeof batchResult[0] === "number") {
    logger.warn(
      "[Document Processor] Runtime returned single embedding for batch request - falling back to individual calls"
    );
    // Fallback: Process texts individually
    const embeddings: number[][] = await Promise.all(
      texts.map(async (text) => {
        const result = await runtime.useModel(ModelType.TEXT_EMBEDDING, { text });
        if (Array.isArray(result)) {
          return result as unknown as number[];
        }
        return (result as { embedding: number[] })?.embedding || [];
      })
    );
    return embeddings;
  }

  // Unknown format - try to extract embeddings
  logger.error("[Document Processor] Unexpected batch result format:", typeof batchResult);
  throw new Error("Unexpected batch embedding result format");
}

/**
 * Generate embeddings individually (fallback, slower)
 */
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
          embedding,
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

// =============================================================================
// CONTEXTUAL ENRICHMENT FUNCTIONS
// =============================================================================

/**
 * Generate contextual chunks if contextual Knowledge is enabled
 */
async function getContextualizedChunks(
  runtime: IAgentRuntime,
  fullDocumentText: string | undefined,
  chunks: string[],
  contentType: string | undefined,
  batchOriginalIndices: number[],
  documentTitle?: string
): Promise<Array<{ contextualizedText: string; index: number; success: boolean }>> {
  const ctxEnabled = getCtxKnowledgeEnabled(runtime);

  // Log configuration state once per document (not per batch)
  if (batchOriginalIndices[0] === 0) {
    const docName = documentTitle || "Document";
    const provider = runtime?.getSetting("TEXT_PROVIDER") || process.env.TEXT_PROVIDER;
    const model = runtime?.getSetting("TEXT_MODEL") || process.env.TEXT_MODEL;
    logger.info(
      `[Document Processor] "${docName}": CTX enrichment ${ctxEnabled ? "ENABLED" : "DISABLED"}${ctxEnabled ? ` (${provider}/${model})` : ""}`
    );
  }

  // Enhanced logging for contextual processing
  if (ctxEnabled && fullDocumentText) {
    return await generateContextsInBatch(
      runtime,
      fullDocumentText,
      chunks,
      contentType,
      batchOriginalIndices,
      documentTitle
    );
  } else if (!ctxEnabled && batchOriginalIndices[0] === 0) {
    logger.debug(
      `[Document Processor] To enable CTX: Set CTX_KNOWLEDGE_ENABLED=true and configure TEXT_PROVIDER/TEXT_MODEL`
    );
  }

  // If contextual Knowledge is disabled, prepare the chunks without modification
  return chunks.map((chunkText, idx) => ({
    contextualizedText: chunkText,
    index: batchOriginalIndices[idx],
    success: true,
  }));
}

/**
 * Generate contexts for multiple chunks in a single batch
 */
async function generateContextsInBatch(
  runtime: IAgentRuntime,
  fullDocumentText: string,
  chunks: string[],
  contentType?: string,
  batchIndices?: number[],
  documentTitle?: string
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

  // Get active provider from validateModelConfig
  const config = validateModelConfig(runtime);
  const isUsingOpenRouter = config.TEXT_PROVIDER === "openrouter";
  const isUsingCacheCapableModel =
    isUsingOpenRouter &&
    (config.TEXT_MODEL?.toLowerCase().includes("claude") ||
      config.TEXT_MODEL?.toLowerCase().includes("gemini"));

  logger.debug(
    `[Document Processor] Contextualizing ${chunks.length} chunks with ${config.TEXT_PROVIDER}/${config.TEXT_MODEL} (cache: ${isUsingCacheCapableModel})`
  );

  // Prepare prompts or system messages in parallel
  const promptConfigs = prepareContextPrompts(
    chunks,
    fullDocumentText,
    contentType,
    batchIndices,
    isUsingCacheCapableModel
  );

  // Process valid prompts with rate limiting
  const contextualizedChunks = await Promise.all(
    promptConfigs.map(async (item) => {
      if (!item.valid) {
        return {
          contextualizedText: item.chunkText,
          success: false,
          index: item.originalIndex,
        };
      }

      // Apply rate limiting before making API call
      const llmTokens = estimateTokens(item.chunkText + (item.prompt || ""));
      await rateLimiter(llmTokens);

      try {
        const generateTextOperation = async () => {
          if (useCustomLLM) {
            // Use custom LLM with caching support
            if (item.usesCaching && item.promptText) {
              // Use the newer caching approach with separate document
              return await generateText(runtime, item.promptText, item.systemPrompt, {
                cacheDocument: item.fullDocumentTextForContext,
                cacheOptions: { type: "ephemeral" },
                autoCacheContextualRetrieval: true,
              });
            } else if (item.prompt) {
              // Original approach - document embedded in prompt
              return await generateText(runtime, item.prompt);
            }
            throw new Error("Missing prompt for text generation");
          } else {
            // Fall back to runtime.useModel (original behavior)
            if (item.usesCaching && item.promptText) {
              // Use the newer caching approach - embed system prompt into main prompt
              // Note: runtime.useModel doesn't support separate system prompt
              const combinedPrompt = item.systemPrompt
                ? `${item.systemPrompt}\n\n${item.promptText}`
                : item.promptText;
              return await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: combinedPrompt,
              });
            } else if (item.prompt) {
              // Original approach - document embedded in prompt
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

        // Track context generation progress without spam
        if (
          (item.originalIndex + 1) % Math.max(1, Math.floor(chunks.length / 3)) === 0 ||
          item.originalIndex === chunks.length - 1
        ) {
          const docName = documentTitle || "Document";
          logger.debug(
            `[Document Processor] "${docName}": Context added for ${item.originalIndex + 1}/${chunks.length} chunks`
          );
        }

        return {
          contextualizedText,
          success: true,
          index: item.originalIndex,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error(
          `Error generating context for chunk ${item.originalIndex}: ${errorMessage}`,
          errorStack
        );
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

/**
 * Prepare prompts for contextualization
 */
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
      // If we're using OpenRouter with Claude/Gemini, use the newer caching approach
      if (isUsingCacheCapableModel) {
        // Get optimized caching prompt from ctx-embeddings.ts
        const cachingPromptInfo = contentType
          ? getCachingPromptForMimeType(contentType, chunkText)
          : getCachingContextualizationPrompt(chunkText);

        // If there was an error in prompt generation
        if (cachingPromptInfo.prompt.startsWith("Error:")) {
          logger.warn(
            `Skipping contextualization for chunk ${originalIndex} due to: ${cachingPromptInfo.prompt}`
          );
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
        // Original approach - embed document in the prompt
        const prompt = contentType
          ? getPromptForMimeType(contentType, fullDocumentText, chunkText)
          : getContextualizationPrompt(fullDocumentText, chunkText);

        if (prompt.startsWith("Error:")) {
          logger.warn(`Skipping contextualization for chunk ${originalIndex} due to: ${prompt}`);
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
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(
        `Error preparing prompt for chunk ${originalIndex}: ${errorMessage}`,
        errorStack
      );
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

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Helper to generate embedding with proper error handling and validation
 * Rate limiting is handled at the API level (plugin-elizacloud)
 */
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

    // Handle different embedding result formats
    const embedding = Array.isArray(embeddingResult)
      ? embeddingResult
      : (embeddingResult as { embedding: number[] })?.embedding;

    if (!embedding || embedding.length === 0) {
      logger.warn(`Zero vector detected`);
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

/**
 * Handle rate-limited API calls with automatic retry
 */
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
      // Handle rate limiting with exponential backoff
      const delay = retryDelay || errorWithStatus.headers?.["retry-after"] || 5;
      logger.warn(`Rate limit hit for ${errorContext}. Retrying after ${delay}s`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));

      // Try one more time
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

/**
 * Creates a simple rate limiter for basic request/token tracking
 * Note: Actual rate limiting is now handled at the API level (plugin-elizacloud)
 * which reads x-ratelimit-remaining-* headers from the response
 */
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
        const reason = requestLimitExceeded ? "request" : "token";
        if (timeToWait > 5000) {
          logger.info(`[Rate Limiter] Waiting ${Math.round(timeToWait / 1000)}s (${reason} limit)`);
        }
        await new Promise((resolve) => setTimeout(resolve, timeToWait));
      }
    }

    requestTimes.push(now);
    if (tokensPerMinute) {
      tokenUsage.push({ timestamp: now, tokens: estimatedTokens });
    }
  };
}

/**
 * Logs a comprehensive summary of the knowledge generation process
 */
interface ProviderLimits {
  provider: string;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxConcurrentRequests?: number;
  rateLimitEnabled?: boolean;
  batchDelayMs?: number;
}

function logKnowledgeGenerationSummary({
  totalChunks,
  savedCount,
  failedCount,
  ctxEnabled,
  providerLimits,
}: {
  documentId: UUID;
  totalChunks: number;
  savedCount: number;
  failedCount: number;
  successRate: number;
  ctxEnabled: boolean;
  providerLimits: ProviderLimits;
}) {
  // Only show summary for failed processing or debug mode
  if (failedCount > 0 || process.env.NODE_ENV === "development") {
    const status = failedCount > 0 ? "PARTIAL" : "SUCCESS";
    logger.info(
      `[Document Processor] ${status}: ${savedCount}/${totalChunks} chunks, CTX: ${ctxEnabled ? "ON" : "OFF"}, Provider: ${providerLimits.provider}`
    );
  }

  if (failedCount > 0) {
    logger.warn(`[Document Processor] ${failedCount} chunks failed processing`);
  }
}
