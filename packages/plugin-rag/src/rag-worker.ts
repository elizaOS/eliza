import { parentPort, workerData } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createDatabaseAdapter } from '@elizaos/plugin-sql';
import type { IDatabaseAdapter, UUID, Memory } from '@elizaos/core';
import { MemoryType, logger, splitChunks } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import {
  generateTextEmbedding,
  generateText,
  getProviderRateLimits,
  validateModelConfig,
} from './llm';
import { extractTextFromFileBuffer, convertPdfToTextFromBuffer } from './utils';
import {
  getContextualizationPrompt,
  getChunkWithContext,
  getPromptForMimeType,
  getCachingContextualizationPrompt,
  getCachingPromptForMimeType,
  DEFAULT_CHUNK_TOKEN_SIZE,
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_CHARS_PER_TOKEN,
} from './ctx-embeddings';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

logger.info('RAG Worker starting...');

// Get worker data for initialization
const { agentId: workerAgentId, dbConfig: workerDbConfig } = workerData;

// Read contextual RAG settings from environment variables
const ctxRagEnabled =
  process.env.CTX_RAG_ENABLED === 'true' || process.env.CTX_RAG_ENABLED === 'True';

// Log settings at startup
if (ctxRagEnabled) {
  logger.info(`Worker started with Contextual RAG ENABLED`);
} else {
  logger.info(`Worker started with Contextual RAG DISABLED`);
}

let dbAdapter: IDatabaseAdapter | null = null;

function postProcessingErrorToParent(documentId: string | UUID, errorMsg: string, stack?: string) {
  logger.error(errorMsg, stack);
  parentPort?.postMessage({
    type: 'PROCESSING_ERROR',
    payload: {
      documentId,
      error: errorMsg,
      stack,
      agentId: workerAgentId,
    },
  });
}

async function initializeDatabaseAdapter() {
  try {
    logger.debug('Initializing Database Adapter in worker with config:', workerDbConfig);
    if (!workerAgentId || !workerDbConfig) {
      throw new Error(
        'agentId and dbConfig must be provided in workerData for worker DB adapter initialization.'
      );
    }
    dbAdapter = createDatabaseAdapter(workerDbConfig, workerAgentId as UUID);
    if (typeof dbAdapter.init === 'function') {
      await dbAdapter.init();
    }
    logger.info('Database Adapter initialized successfully in worker.');

    try {
      logger.debug('Determining embedding dimension...');
      const sampleEmbeddingResult = await generateTextEmbedding('dimension_check_string');
      let dimension = 0;

      // Simplify the embedding dimension detection logic
      if (Array.isArray(sampleEmbeddingResult)) {
        dimension = sampleEmbeddingResult.length;
      } else if (
        sampleEmbeddingResult?.embedding &&
        Array.isArray(sampleEmbeddingResult.embedding)
      ) {
        dimension = sampleEmbeddingResult.embedding.length;
      }

      if (dimension <= 0) {
        throw new Error(
          'Failed to determine a valid embedding dimension from generateTextEmbedding.'
        );
      }

      logger.info(`Using embedding dimension: ${dimension}`);

      if (!dbAdapter) {
        throw new Error('Database adapter is null before calling ensureEmbeddingDimension');
      }

      await dbAdapter.ensureEmbeddingDimension(dimension);

      parentPort?.postMessage({ type: 'WORKER_READY', payload: { agentId: workerAgentId } });
    } catch (dimError: any) {
      logger.error('Failed to set embedding dimension:', dimError.message);
      parentPort?.postMessage({
        type: 'WORKER_ERROR',
        payload: {
          agentId: workerAgentId,
          error: `Failed to set embedding dimension: ${dimError.message}`,
          stack: dimError.stack,
        },
      });
      throw dimError;
    }
  } catch (e: any) {
    logger.error('Failed to initialize Database Adapter in worker:', e.message, e.stack);
    parentPort?.postMessage({
      type: 'WORKER_ERROR',
      payload: { agentId: workerAgentId, error: e.message, stack: e.stack },
    });
  }
}

async function chunkAndSaveDocumentFragments(
  documentId: UUID,
  fullDocumentText: string,
  agentId: UUID,
  contentType?: string
) {
  if (!fullDocumentText || fullDocumentText.trim() === '') {
    postProcessingErrorToParent(documentId, 'No text content available to chunk and save.');
    return;
  }

  // Use the standardized constants from ctx-embeddings.ts
  const tokenChunkSize = DEFAULT_CHUNK_TOKEN_SIZE;
  const tokenChunkOverlap = DEFAULT_CHUNK_OVERLAP_TOKENS;
  const charsToTokensApproximation = DEFAULT_CHARS_PER_TOKEN;

  // Calculate character-based chunking sizes from token sizes for compatibility with splitChunks
  const targetCharChunkSize = Math.round(tokenChunkSize * charsToTokensApproximation);
  const targetCharChunkOverlap = Math.round(tokenChunkOverlap * charsToTokensApproximation);

  logger.debug(
    `Using core splitChunks with settings: tokenChunkSize=${tokenChunkSize}, tokenChunkOverlap=${tokenChunkOverlap}, ` +
      `charChunkSize=${targetCharChunkSize}, charChunkOverlap=${targetCharChunkOverlap}`
  );
  const chunks = await splitChunks(fullDocumentText, tokenChunkSize, tokenChunkOverlap);

  logger.info(`Split content into ${chunks.length} chunks for document ${documentId}.`);

  if (chunks.length === 0) {
    logger.warn(`No chunks generated from text for ${documentId}. No fragments to save.`);
    return;
  }

  try {
    await saveToDbViaAdapter({
      documentId,
      chunks,
      agentId,
      isFragment: true,
      fullDocumentTextForContext: fullDocumentText,
      contentTypeForContext: contentType,
    });
  } catch (e: any) {
    postProcessingErrorToParent(
      documentId,
      `Error during fragment embedding or saving for doc ${documentId}: ${e.message}`,
      e.stack
    );
  }
}

async function processAndChunkDocument({
  documentId,
  fileContentB64,
  contentType,
  originalFilename,
}: {
  documentId: string;
  fileContentB64: string;
  contentType: string;
  originalFilename: string;
}) {
  logger.info(
    `Processing document in worker. Document ID: ${documentId}, ContentType: "${contentType}", Filename: "${originalFilename}"`
  );

  const fileBuffer = Buffer.from(fileContentB64, 'base64');
  const errorHandler = createErrorHandler(documentId, 'text extraction');

  try {
    // Extract text based on content type
    const textContent = await extractTextFromDocument(fileBuffer, contentType, originalFilename);

    if (!textContent || textContent.trim() === '') {
      postProcessingErrorToParent(
        documentId,
        `No text content extracted from ${originalFilename}.`
      );
      return;
    }

    logger.debug(
      `Text extraction complete for ${documentId}. Text length: ${textContent.length}. Now chunking.`
    );

    await chunkAndSaveDocumentFragments(
      documentId as UUID,
      textContent,
      workerAgentId as UUID,
      contentType
    );
  } catch (error: any) {
    errorHandler(error);
  }
}

/**
 * Extract text from document buffer based on content type
 */
async function extractTextFromDocument(
  fileBuffer: Buffer,
  contentType: string,
  originalFilename: string
): Promise<string> {
  if (contentType === 'application/pdf') {
    logger.debug(`Extracting text from PDF: ${originalFilename}`);
    return await convertPdfToTextFromBuffer(fileBuffer, originalFilename);
  } else {
    logger.debug(`Extracting text from non-PDF: ${originalFilename} (Type: ${contentType})`);
    return await extractTextFromFileBuffer(fileBuffer, contentType, originalFilename);
  }
}

// Helper functions to make code more DRY

/**
 * Helper to generate embedding with proper error handling and validation
 * @param text The text to generate embedding for
 * @returns Object containing embedding and success status
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
 * @param operation Async function to execute
 * @param errorContext Context information for logging
 * @param retryDelay Optional custom retry delay
 * @returns Result of the operation
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
 * Create an error handler that sends consistent error messages to the parent
 * @param documentId The document ID for context
 * @param operationName Name of the operation for error context
 * @returns Function that handles errors
 */
function createErrorHandler(documentId: string | UUID, operationName: string) {
  return (error: any) => {
    const errorMsg = `Error during ${operationName} for document ${documentId}: ${error.message}`;
    postProcessingErrorToParent(documentId, errorMsg, error.stack);
    return { success: false, error };
  };
}

/**
 * Generate contexts for multiple chunks in a single batch
 *
 * @param fullDocumentTextForContext Full document text for context
 * @param chunks Array of chunks to process
 * @param contentTypeForContext Optional content type for context
 * @param batchIndices Array of original indices of the chunks
 * @returns Array of contextualized chunks with success/failure information
 */
async function generateContextsInBatch(
  fullDocumentTextForContext: string,
  chunks: string[],
  contentTypeForContext?: string,
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
  const promptConfigs = chunks.map((chunkText, idx) => {
    const originalIndex = batchIndices ? batchIndices[idx] : idx;
    try {
      // If we're using OpenRouter with Claude/Gemini, use the newer caching approach
      if (isUsingCacheCapableModel) {
        // Get optimized caching prompt from ctx-embeddings.ts
        const cachingPromptInfo = contentTypeForContext
          ? getCachingPromptForMimeType(contentTypeForContext, chunkText)
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
          fullDocumentTextForContext,
        };
      } else {
        // Original approach - embed document in the prompt
        const prompt = contentTypeForContext
          ? getPromptForMimeType(contentTypeForContext, fullDocumentTextForContext, chunkText)
          : getContextualizationPrompt(fullDocumentTextForContext, chunkText);

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

async function saveToDbViaAdapter({
  documentId,
  chunks,
  agentId,
  isFragment = true,
  mainDocText,
  originalMetadata,
  fullDocumentTextForContext,
  contentTypeForContext,
}: {
  documentId: string;
  chunks?: string[];
  agentId: UUID;
  isFragment?: boolean;
  mainDocText?: string;
  originalMetadata?: {
    contentType: string;
    originalFilename: string;
    worldId: UUID;
    fileSize: number;
    clientDocumentId: UUID;
  };
  fullDocumentTextForContext?: string;
  contentTypeForContext?: string;
}) {
  if (!dbAdapter) {
    const errMsg = 'Database Adapter not initialized in worker. Cannot save.';
    logger.error(errMsg);
    throw new Error(errMsg);
  }

  // We've already extracted the main document saving to a separate function
  if (!isFragment && mainDocText && originalMetadata) {
    return await saveMainDocument(mainDocText, originalMetadata);
  } else if (isFragment && chunks && chunks.length > 0) {
    return await processAndSaveFragments({
      documentId,
      chunks,
      agentId,
      fullDocumentTextForContext,
      contentTypeForContext,
    });
  } else if (isFragment && (!chunks || chunks.length === 0)) {
    logger.warn(`No chunks provided to save for document ${documentId}. Nothing saved.`);
    return { savedFragmentCount: 0 };
  }
  return {};
}

/**
 * Process text chunks and save them as fragments with embeddings
 */
async function processAndSaveFragments({
  documentId,
  chunks,
  agentId,
  fullDocumentTextForContext,
  contentTypeForContext,
}: {
  documentId: string;
  chunks: string[];
  agentId: UUID;
  fullDocumentTextForContext?: string;
  contentTypeForContext?: string;
}) {
  logger.debug(
    `Worker saving ${chunks.length} chunks for document ${documentId} via DatabaseAdapter for agent ${agentId}.`
  );

  // Get rate limits from provider config
  const providerLimits = await getProviderRateLimits();

  // Determine optimal concurrency based on provider rate limits
  const CONCURRENCY_LIMIT = Math.min(30, providerLimits.maxConcurrentRequests || 30);
  logger.debug(`Using concurrency limit of ${CONCURRENCY_LIMIT} based on provider limits`);

  // Create a rate limiter function to prevent exceeding provider limits
  const rateLimiter = createRateLimiter(providerLimits.requestsPerMinute || 60);

  let savedCount = 0;
  let failedCount = 0;
  const failedChunks: number[] = [];

  // Process chunks in batches
  for (let i = 0; i < chunks.length; i += CONCURRENCY_LIMIT) {
    const batchChunks = chunks.slice(i, i + CONCURRENCY_LIMIT);
    const batchOriginalIndices = Array.from({ length: batchChunks.length }, (_, k) => i + k);

    logger.debug(
      `Processing batch of ${batchChunks.length} chunks for document ${documentId}. ` +
        `Starting original index: ${batchOriginalIndices[0]}, batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1}/${Math.ceil(chunks.length / CONCURRENCY_LIMIT)}`
    );

    // Process context generation in an optimized batch
    const contextualizedChunks = await getContextualizedChunks(
      fullDocumentTextForContext,
      batchChunks,
      contentTypeForContext,
      batchOriginalIndices,
      ctxRagEnabled
    );

    // Generate embeddings with rate limiting
    const embeddingResults = await generateEmbeddingsForChunks(contextualizedChunks, rateLimiter);

    // Save fragments with embeddings
    const saveResults = await saveFragmentsToDatabase(embeddingResults, documentId, agentId);

    savedCount += saveResults.savedCount;
    failedCount += saveResults.failedCount;
    failedChunks.push(...saveResults.failedChunks);

    // Add a small delay between batches to prevent overwhelming the API
    if (i + CONCURRENCY_LIMIT < chunks.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // Report results to parent
  if (savedCount > 0) {
    parentPort?.postMessage({
      type: 'KNOWLEDGE_ADDED',
      payload: { documentId, count: savedCount, agentId },
    });
  }

  if (failedCount > 0) {
    logger.warn(
      `Failed to process ${failedCount} chunks out of ${chunks.length} for document ${documentId}`
    );
  }

  logger.info(`Finished saving ${savedCount} fragments for document ${documentId}.`);
  return { savedFragmentCount: savedCount, failedCount };
}

/**
 * Get contextualized chunks for the given text chunks
 */
async function getContextualizedChunks(
  fullDocumentTextForContext: string | undefined,
  chunks: string[],
  contentTypeForContext: string | undefined,
  batchOriginalIndices: number[],
  contextualRagEnabled: boolean
) {
  if (contextualRagEnabled && fullDocumentTextForContext) {
    logger.debug(`Generating contexts for ${chunks.length} chunks`);
    return await generateContextsInBatch(
      fullDocumentTextForContext,
      chunks,
      contentTypeForContext,
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
 * Generate embeddings for a batch of chunks
 */
async function generateEmbeddingsForChunks(
  contextualizedChunks: Array<{ contextualizedText: string; index: number; success: boolean }>,
  rateLimiter: () => Promise<void>
) {
  const embeddingPromises = contextualizedChunks.map(async (contextualizedChunk) => {
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
  });

  return await Promise.all(embeddingPromises);
}

/**
 * Save fragments with embeddings to the database
 */
async function saveFragmentsToDatabase(
  embeddingResults: Array<any>,
  documentId: string,
  agentId: UUID
) {
  let savedCount = 0;
  let failedCount = 0;
  const failedChunks: number[] = [];

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
      // Log detailed information when we encounter a zero vector
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
        roomId: agentId,
        worldId: agentId,
        entityId: agentId,
        embedding,
        content: { text: contextualizedChunkText },
        metadata: {
          type: MemoryType.FRAGMENT,
          documentId,
          position: originalChunkIndex,
          timestamp: Date.now(),
          source: 'rag-worker-fragment-upload',
        },
      };

      await dbAdapter!.createMemory(fragmentMemory, 'knowledge');
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

  return { savedCount, failedCount, failedChunks };
}

/**
 * Creates a rate limiter function that ensures we don't exceed provider rate limits
 * @param requestsPerMinute Maximum requests allowed per minute
 * @returns A function that resolves when it's safe to make another request
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

parentPort?.on('message', async (message: any) => {
  logger.debug('RAG Worker received message:', message.type, 'for agent:', workerAgentId);

  if (!dbAdapter && message.type !== 'INIT_DB_ADAPTER') {
    logger.warn(
      'Worker DB adapter not initialized. Ignoring message:',
      message.type,
      '(Agent:',
      workerAgentId,
      ')'
    );
    parentPort?.postMessage({
      type: 'WORKER_ERROR',
      payload: {
        agentId: workerAgentId,
        error: 'Worker not ready, DB adapter not initialized.',
      },
    });
    return;
  }

  try {
    switch (message.type) {
      case 'INIT_DB_ADAPTER':
        await initializeDatabaseAdapter();
        break;
      case 'PROCESS_DOCUMENT':
        if (!message.payload.originalFilename) {
          logger.warn(
            `PROCESS_DOCUMENT message for docId ${message.payload.documentId} missing originalFilename. Utility functions might need it.`
          );
        }
        await processAndChunkDocument({
          documentId: message.payload.documentId,
          fileContentB64: message.payload.fileContentB64,
          contentType: message.payload.contentType,
          originalFilename: message.payload.originalFilename || 'unknown_file',
        });
        break;
      case 'PROCESS_PDF_THEN_FRAGMENTS': {
        await processPdfWithFragments(message.payload);
        break;
      }
      default:
        logger.warn('Unknown message type received by RAG worker:', message.type);
    }
  } catch (error: any) {
    logger.error('Error processing message in RAG worker:', error.message, error.stack);
    const docIdForError =
      message.payload?.documentId || message.payload?.clientDocumentId || 'unknown_document';
    postProcessingErrorToParent(
      docIdForError,
      `Unhandled error processing message type ${message.type}: ${error.message}`,
      error.stack
    );
  }
});

/**
 * Process a PDF document, extract and store text, then create fragments
 * @param payload The message payload containing document details
 */
async function processPdfWithFragments(payload: any) {
  const { clientDocumentId, fileContentB64, contentType, originalFilename, worldId } = payload;
  logger.info(
    `Worker processing PDF_THEN_FRAGMENTS for clientDocId: ${clientDocumentId}, filename: ${originalFilename}`
  );

  const pdfFileBuffer = Buffer.from(fileContentB64, 'base64');
  const errorHandler = createErrorHandler(clientDocumentId, 'PDF processing');

  try {
    // Extract text from PDF
    const mainPdfText = await extractTextFromDocument(pdfFileBuffer, contentType, originalFilename);

    if (!mainPdfText || mainPdfText.trim() === '') {
      throw new Error(`No text content extracted from PDF ${originalFilename} by worker.`);
    }

    logger.debug(`Main PDF text extracted for ${originalFilename}, length: ${mainPdfText.length}`);

    // Save main document
    const saveResult = await saveMainDocument(mainPdfText, {
      contentType,
      originalFilename,
      worldId,
      fileSize: pdfFileBuffer.length,
      clientDocumentId: clientDocumentId as UUID,
    });

    // Notify the parent process that the main document was stored
    parentPort?.postMessage({
      type: 'PDF_MAIN_DOCUMENT_STORED',
      payload: {
        clientDocumentId: clientDocumentId,
        storedDocumentMemoryId: saveResult.actualStoredMainDocId || null,
        agentId: workerAgentId,
        error: null,
      },
    });

    // Process fragments
    logger.debug(
      `Main PDF ${originalFilename} (clientDocId: ${clientDocumentId}) processed. Now chunking for fragments.`
    );
    await chunkAndSaveDocumentFragments(
      saveResult.clientDocumentId,
      mainPdfText,
      workerAgentId as UUID
    );
  } catch (error: any) {
    // Use the errorHandler instead of manual error handling
    errorHandler(error);

    // Send specific message about PDF document processing failure
    parentPort?.postMessage({
      type: 'PDF_MAIN_DOCUMENT_STORED',
      payload: {
        clientDocumentId: clientDocumentId,
        storedDocumentMemoryId: null,
        agentId: workerAgentId,
        error: { message: error.message, stack: error.stack },
      },
    });
  }
}

/**
 * Save the main document to the database
 * @param mainDocText The document text content
 * @param metadata Metadata about the document
 * @returns Information about the stored document
 */
async function saveMainDocument(
  mainDocText: string,
  metadata: {
    contentType: string;
    originalFilename: string;
    worldId: UUID;
    fileSize: number;
    clientDocumentId: UUID;
  }
): Promise<{ actualStoredMainDocId: UUID; clientDocumentId: UUID }> {
  if (!dbAdapter) {
    throw new Error('Database Adapter not initialized in worker. Cannot save main document.');
  }

  const fileExt = metadata.originalFilename.split('.').pop()?.toLowerCase() || '';
  const title = metadata.originalFilename.replace(`.${fileExt}`, '');
  const actualStoredMainDocId = uuidv4() as UUID;

  const mainDocumentMemory: Memory = {
    id: actualStoredMainDocId,
    agentId: workerAgentId as UUID,
    roomId: workerAgentId as UUID,
    worldId: metadata.worldId,
    entityId: workerAgentId as UUID,
    content: { text: mainDocText },
    metadata: {
      type: MemoryType.DOCUMENT,
      documentId: metadata.clientDocumentId,
      originalFilename: metadata.originalFilename,
      contentType: metadata.contentType,
      title: title,
      fileExt: fileExt,
      fileSize: metadata.fileSize,
      source: 'rag-worker-main-document-upload',
      timestamp: Date.now(),
    },
  };

  await dbAdapter.createMemory(mainDocumentMemory, 'documents');

  logger.info(
    `Worker saved main document ${metadata.originalFilename} (Client ID: ${metadata.clientDocumentId}, DB ID: ${actualStoredMainDocId}) for agent ${workerAgentId}.`
  );

  return { actualStoredMainDocId, clientDocumentId: metadata.clientDocumentId };
}

async function gracefulShutdown() {
  logger.info('RAG worker shutting down...');
  if (dbAdapter && typeof (dbAdapter as any).close === 'function') {
    try {
      await (dbAdapter as any).close();
      logger.info('Database Adapter connection closed by worker.');
    } catch (e: any) {
      logger.error('Error closing database adapter in worker:', e.message);
    }
  }
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

logger.info(
  'RAG Worker script loaded, awaiting INIT_DB_ADAPTER message to become fully operational.'
);
