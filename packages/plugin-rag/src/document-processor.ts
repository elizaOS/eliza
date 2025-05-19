import { Buffer } from 'node:buffer';
import { UUID, Memory, MemoryType, logger, splitChunks, IAgentRuntime } from '@elizaos/core';
import { extractTextFromFileBuffer, convertPdfToTextFromBuffer } from './utils';
import { v4 as uuidv4 } from 'uuid';
import {
  generateTextEmbedding,
  generateText,
  getProviderRateLimits,
  validateModelConfig,
} from './llm';
import {
  DEFAULT_CHUNK_TOKEN_SIZE,
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_CHARS_PER_TOKEN,
  getContextualizationPrompt,
  getChunkWithContext,
  getPromptForMimeType,
  getCachingContextualizationPrompt,
  getCachingPromptForMimeType,
} from './ctx-embeddings';

// Read contextual RAG settings from environment variables
const ctxRagEnabled =
  process.env.CTX_RAG_ENABLED === 'true' || process.env.CTX_RAG_ENABLED === 'True';

// Log settings at startup
if (ctxRagEnabled) {
  logger.info(`Document processor starting with Contextual RAG ENABLED`);
} else {
  logger.info(`Document processor starting with Contextual RAG DISABLED`);
}

// =============================================================================
// MAIN DOCUMENT PROCESSING FUNCTIONS
// =============================================================================

/**
 * Process document fragments synchronously
 * This function:
 * 1. Splits the document text into chunks
 * 2. Enriches chunks with context if contextual RAG is enabled
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
}: {
  runtime: IAgentRuntime;
  documentId: UUID;
  fullDocumentText: string;
  agentId: UUID;
  contentType?: string;
  roomId?: UUID;
  entityId?: UUID;
  worldId?: UUID;
}): Promise<number> {
  if (!fullDocumentText || fullDocumentText.trim() === '') {
    logger.warn(`No text content available to chunk for document ${documentId}.`);
    return 0;
  }

  // Split the text into chunks using standard parameters
  const chunks = await splitDocumentIntoChunks(fullDocumentText);

  if (chunks.length === 0) {
    logger.warn(`No chunks generated from text for ${documentId}. No fragments to save.`);
    return 0;
  }

  logger.info(`Split content into ${chunks.length} chunks for document ${documentId}`);

  // Get provider limits for rate limiting
  const providerLimits = await getProviderRateLimits();
  const CONCURRENCY_LIMIT = Math.min(30, providerLimits.maxConcurrentRequests || 30);
  const rateLimiter = createRateLimiter(providerLimits.requestsPerMinute || 60);

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
  });

  // Report results
  if (failedCount > 0) {
    logger.warn(
      `Failed to process ${failedCount} chunks out of ${chunks.length} for document ${documentId}`
    );
  }

  logger.info(`Finished saving ${savedCount} fragments for document ${documentId}.`);
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
    if (contentType === 'application/pdf') {
      logger.debug(`Extracting text from PDF: ${originalFilename}`);
      return await convertPdfToTextFromBuffer(fileBuffer, originalFilename);
    } else {
      logger.debug(`Extracting text from non-PDF: ${originalFilename} (Type: ${contentType})`);

      // For plain text files, try UTF-8 decoding first
      if (
        contentType.includes('text/') ||
        contentType.includes('application/json') ||
        contentType.includes('application/xml')
      ) {
        try {
          return fileBuffer.toString('utf8');
        } catch (textError) {
          logger.warn(
            `Failed to decode ${originalFilename} as UTF-8, falling back to binary extraction`
          );
        }
      }

      // For other files, use general extraction
      return await extractTextFromFileBuffer(fileBuffer, contentType, originalFilename);
    }
  } catch (error: any) {
    logger.error(`Error extracting text from ${originalFilename}: ${error.message}`);
    throw new Error(`Failed to extract text from ${originalFilename}: ${error.message}`);
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
}: {
  text: string;
  agentId: UUID;
  clientDocumentId: UUID;
  originalFilename: string;
  contentType: string;
  worldId: UUID;
  fileSize: number;
  documentId?: UUID;
}): Memory {
  const fileExt = originalFilename.split('.').pop()?.toLowerCase() || '';
  const title = originalFilename.replace(`.${fileExt}`, '');

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
      type: MemoryType.DOCUMENT,
      documentId: clientDocumentId,
      originalFilename,
      contentType,
      title,
      fileExt,
      fileSize,
      source: 'rag-service-main-upload',
      timestamp: Date.now(),
    },
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
  rateLimiter: () => Promise<void>;
}): Promise<{ savedCount: number; failedCount: number; failedChunks: number[] }> {
  let savedCount = 0;
  let failedCount = 0;
  const failedChunks: number[] = [];

  // Process chunks in batches to respect concurrency limits
  for (let i = 0; i < chunks.length; i += concurrencyLimit) {
    const batchChunks = chunks.slice(i, i + concurrencyLimit);
    const batchOriginalIndices = Array.from({ length: batchChunks.length }, (_, k) => i + k);

    logger.debug(
      `Processing batch of ${batchChunks.length} chunks for document ${documentId}. ` +
        `Starting original index: ${batchOriginalIndices[0]}, batch ${Math.floor(i / concurrencyLimit) + 1}/${Math.ceil(chunks.length / concurrencyLimit)}`
    );

    // Process context generation in an optimized batch
    const contextualizedChunks = await getContextualizedChunks(
      fullDocumentText,
      batchChunks,
      contentType,
      batchOriginalIndices
    );

    // Generate embeddings with rate limiting
    const embeddingResults = await generateEmbeddingsForChunks(contextualizedChunks, rateLimiter);

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
            source: 'rag-service-fragment-sync',
          },
        };

        await runtime.createMemory(fragmentMemory, 'knowledge');
        logger.debug(
          `Saved fragment ${originalChunkIndex + 1} for document ${documentId} (Fragment ID: ${fragmentMemory.id})`
        );
        savedCount++;
      } catch (saveError: any) {
        logger.error(
          `Error saving chunk ${originalChunkIndex} to database: ${saveError.message}`,
          saveError.stack
        );
        failedCount++;
        failedChunks.push(originalChunkIndex);
      }
    }

    // Add a small delay between batches to prevent overwhelming the API
    if (i + concurrencyLimit < chunks.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return { savedCount, failedCount, failedChunks };
}

/**
 * Generate embeddings for contextualized chunks
 * @param contextualizedChunks Array of contextualized chunks
 * @param rateLimiter Rate limiter function
 * @returns Array of embedding results
 */
async function generateEmbeddingsForChunks(
  contextualizedChunks: Array<{ contextualizedText: string; index: number; success: boolean }>,
  rateLimiter: () => Promise<void>
): Promise<Array<any>> {
  return await Promise.all(
    contextualizedChunks.map(async (contextualizedChunk) => {
      // Apply rate limiting before embedding generation
      await rateLimiter();

      try {
        const generateEmbeddingOperation = async () => {
          return await generateEmbeddingWithValidation(contextualizedChunk.contextualizedText);
        };

        const { embedding, success, error } = await withRateLimitRetry(
          generateEmbeddingOperation,
          `embedding generation for chunk ${contextualizedChunk.index}`
        );

        if (!success) {
          return {
            success: false,
            index: contextualizedChunk.index,
            error,
            text: contextualizedChunk.contextualizedText,
          };
        }

        return {
          embedding,
          success: true,
          index: contextualizedChunk.index,
          text: contextualizedChunk.contextualizedText,
        };
      } catch (error: any) {
        logger.error(
          `Error generating embedding for chunk ${contextualizedChunk.index}: ${error.message}`
        );
        return {
          success: false,
          index: contextualizedChunk.index,
          error,
          text: contextualizedChunk.contextualizedText,
        };
      }
    })
  );
}

// =============================================================================
// CONTEXTUAL ENRICHMENT FUNCTIONS
// =============================================================================

/**
 * Generate contextual chunks if contextual RAG is enabled
 */
async function getContextualizedChunks(
  fullDocumentText: string | undefined,
  chunks: string[],
  contentType: string | undefined,
  batchOriginalIndices: number[]
): Promise<Array<{ contextualizedText: string; index: number; success: boolean }>> {
  if (ctxRagEnabled && fullDocumentText) {
    logger.debug(`Generating contexts for ${chunks.length} chunks`);
    return await generateContextsInBatch(
      fullDocumentText,
      chunks,
      contentType,
      batchOriginalIndices
    );
  } else {
    // If contextual RAG is disabled, prepare the chunks without modification
    return chunks.map((chunkText, idx) => ({
      contextualizedText: chunkText,
      index: batchOriginalIndices[idx],
      success: true,
    }));
  }
}

/**
 * Generate contexts for multiple chunks in a single batch
 */
async function generateContextsInBatch(
  fullDocumentText: string,
  chunks: string[],
  contentType?: string,
  batchIndices?: number[]
): Promise<Array<{ contextualizedText: string; success: boolean; index: number }>> {
  if (!chunks || chunks.length === 0) {
    return [];
  }

  const providerLimits = await getProviderRateLimits();
  const rateLimiter = createRateLimiter(providerLimits.requestsPerMinute || 60);

  // Get active provider from validateModelConfig
  const config = validateModelConfig();
  const isUsingOpenRouter = config.TEXT_PROVIDER === 'openrouter';
  const isUsingCacheCapableModel =
    isUsingOpenRouter &&
    (config.TEXT_MODEL?.toLowerCase().includes('claude') ||
      config.TEXT_MODEL?.toLowerCase().includes('gemini'));

  logger.info(
    `Using provider: ${config.TEXT_PROVIDER}, model: ${config.TEXT_MODEL}, caching capability: ${isUsingCacheCapableModel}`
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
      await rateLimiter();

      try {
        let llmResponse;

        const generateTextOperation = async () => {
          if (item.usesCaching) {
            // Use the newer caching approach with separate document
            return await generateText(item.promptText!, item.systemPrompt, {
              cacheDocument: item.fullDocumentTextForContext,
              cacheOptions: { type: 'ephemeral' },
            });
          } else {
            // Original approach - document embedded in prompt
            return await generateText(item.prompt!);
          }
        };

        llmResponse = await withRateLimitRetry(
          generateTextOperation,
          `context generation for chunk ${item.originalIndex}`
        );

        const generatedContext = llmResponse.text;
        const contextualizedText = getChunkWithContext(item.chunkText, generatedContext);

        logger.debug(
          `Context added for chunk ${item.originalIndex}. New length: ${contextualizedText.length}`
        );

        return {
          contextualizedText,
          success: true,
          index: item.originalIndex,
        };
      } catch (error: any) {
        logger.error(
          `Error generating context for chunk ${item.originalIndex}: ${error.message}`,
          error.stack
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
function prepareContextPrompts(
  chunks: string[],
  fullDocumentText: string,
  contentType?: string,
  batchIndices?: number[],
  isUsingCacheCapableModel = false
): Array<any> {
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
        if (cachingPromptInfo.prompt.startsWith('Error:')) {
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

        if (prompt.startsWith('Error:')) {
          logger.warn(`Skipping contextualization for chunk ${originalIndex} due to: ${prompt}`);
          return { prompt: null, originalIndex, chunkText, valid: false, usesCaching: false };
        }

        return { prompt, originalIndex, chunkText, valid: true, usesCaching: false };
      }
    } catch (error: any) {
      logger.error(
        `Error preparing prompt for chunk ${originalIndex}: ${error.message}`,
        error.stack
      );
      return { prompt: null, originalIndex, chunkText, valid: false, usesCaching: false };
    }
  });
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Helper to generate embedding with proper error handling and validation
 */
async function generateEmbeddingWithValidation(text: string): Promise<{
  embedding: number[] | null;
  success: boolean;
  error?: any;
}> {
  try {
    const embeddingResult = await generateTextEmbedding(text);

    // Handle different embedding result formats consistently
    const embedding = Array.isArray(embeddingResult) ? embeddingResult : embeddingResult?.embedding;

    // Validate embedding
    if (!embedding || embedding.length === 0) {
      logger.warn(`Zero vector detected. Embedding result: ${JSON.stringify(embeddingResult)}`);
      return { embedding: null, success: false, error: new Error('Zero vector detected') };
    }

    return { embedding, success: true };
  } catch (error: any) {
    return { embedding: null, success: false, error };
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
  } catch (error: any) {
    if (error.status === 429) {
      // Handle rate limiting with exponential backoff
      const delay = retryDelay || error.headers?.['retry-after'] || 5;
      logger.warn(`Rate limit hit for ${errorContext}. Retrying after ${delay}s`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));

      // Try one more time
      try {
        return await operation();
      } catch (retryError: any) {
        logger.error(`Failed after retry for ${errorContext}: ${retryError.message}`);
        throw retryError;
      }
    }
    throw error;
  }
}

/**
 * Creates a rate limiter function that ensures we don't exceed provider rate limits
 */
function createRateLimiter(requestsPerMinute: number) {
  const requestTimes: number[] = [];
  const intervalMs = 60 * 1000; // 1 minute in milliseconds

  return async function rateLimiter() {
    const now = Date.now();

    // Remove timestamps older than our interval
    while (requestTimes.length > 0 && now - requestTimes[0] > intervalMs) {
      requestTimes.shift();
    }

    // If we've hit our rate limit, wait until we can make another request
    if (requestTimes.length >= requestsPerMinute) {
      const oldestRequest = requestTimes[0];
      const timeToWait = Math.max(0, oldestRequest + intervalMs - now);

      if (timeToWait > 0) {
        logger.debug(`Rate limiting applied, waiting ${timeToWait}ms before next request`);
        await new Promise((resolve) => setTimeout(resolve, timeToWait));
      }
    }

    // Add current timestamp to our history and proceed
    requestTimes.push(Date.now());
  };
}
