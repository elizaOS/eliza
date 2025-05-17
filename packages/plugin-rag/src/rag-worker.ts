import { parentPort, workerData } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createDatabaseAdapter } from '@elizaos/plugin-sql';
import type { IDatabaseAdapter, UUID, Memory } from '@elizaos/core';
import { MemoryType, logger, splitChunks } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { generateTextEmbedding, generateText, getProviderRateLimits } from './llm';
import { extractTextFromFileBuffer, convertPdfToTextFromBuffer } from './utils';
import {
  getContextualizationPrompt,
  getChunkWithContext,
  getPromptForMimeType,
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

    logger.debug(`[RAG_WORKER] State of dbAdapter.db AFTER init call completion:`);
    logger.debug(`[RAG_WORKER]   dbAdapter.db === null: ${dbAdapter.db === null}`);
    logger.debug(`[RAG_WORKER]   dbAdapter.db === undefined: ${dbAdapter.db === undefined}`);
    if (dbAdapter.db) {
      logger.debug(`[RAG_WORKER]   dbAdapter.db object type: ${typeof dbAdapter.db}`);
      logger.debug(`[RAG_WORKER]   dbAdapter.db keys: ${Object.keys(dbAdapter.db).join(', ')}`);
    } else {
      logger.warn(`[RAG_WORKER]   dbAdapter.db is null or undefined AFTER init call.`);
    }

    try {
      logger.debug('Determining embedding dimension for worker...');
      const sampleEmbeddingResult = await generateTextEmbedding('dimension_check_string');
      let dimension = 0;

      if (
        sampleEmbeddingResult &&
        Array.isArray(sampleEmbeddingResult) &&
        sampleEmbeddingResult.length > 0
      ) {
        dimension = sampleEmbeddingResult.length;
      } else if (
        sampleEmbeddingResult &&
        typeof sampleEmbeddingResult === 'object' &&
        Array.isArray(sampleEmbeddingResult.embedding) &&
        sampleEmbeddingResult.embedding.length > 0
      ) {
        dimension = sampleEmbeddingResult.embedding.length;
      }

      if (dimension > 0) {
        logger.debug(`Determined embedding dimension: ${dimension}. Ensuring in DB adapter.`);
        if (!dbAdapter) {
          const criticalErrorMsg =
            'CRITICAL: dbAdapter is unexpectedly null before calling ensureEmbeddingDimension!';
          logger.error(criticalErrorMsg);
          parentPort?.postMessage({
            type: 'WORKER_ERROR',
            payload: { agentId: workerAgentId, error: criticalErrorMsg },
          });
          throw new Error(criticalErrorMsg);
        }
        logger.debug(
          `[RAG_WORKER] About to call ensureEmbeddingDimension on dbAdapter for agentId: ${workerAgentId}.`
        );
        logger.debug(
          `[RAG_WORKER] dbAdapter has 'db' own property: ${Object.prototype.hasOwnProperty.call(dbAdapter, 'db')}`
        );
        logger.debug(`[RAG_WORKER] dbAdapter.db === null: ${dbAdapter.db === null}`);
        logger.debug(`[RAG_WORKER] dbAdapter.db === undefined: ${dbAdapter.db === undefined}`);
        if (dbAdapter.db) {
          logger.debug(`[RAG_WORKER] dbAdapter.db object type: ${typeof dbAdapter.db}`);
          logger.debug(`[RAG_WORKER]   dbAdapter.db keys: ${Object.keys(dbAdapter.db).join(', ')}`);
        } else {
          logger.warn(`[RAG_WORKER] dbAdapter.db is null or undefined.`);
        }

        await dbAdapter.ensureEmbeddingDimension(dimension);
        logger.debug(`Embedding dimension ${dimension} ensured successfully in worker.`);
      } else {
        throw new Error(
          'Failed to determine a valid embedding dimension from generateTextEmbedding.'
        );
      }
    } catch (dimError: any) {
      logger.error(
        'Failed to set embedding dimension in worker:',
        dimError.message,
        dimError.stack
      );
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

    parentPort?.postMessage({ type: 'WORKER_READY', payload: { agentId: workerAgentId } });
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

  const targetCharChunkSize = 1000;
  const targetCharChunkOverlap = 100;
  const charsToTokensApproximation = 3.5;

  const tokenChunkSize = Math.round(targetCharChunkSize / charsToTokensApproximation);
  const tokenChunkOverlap = Math.round(targetCharChunkOverlap / charsToTokensApproximation);

  logger.debug(
    `Using core splitChunks with effective char settings: targetChunkSize=${targetCharChunkSize} (tokens: ${tokenChunkSize}), targetOverlap=${targetCharChunkOverlap} (tokens: ${tokenChunkOverlap})`
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
  let textContent = '';
  const fileBuffer = Buffer.from(fileContentB64, 'base64');

  try {
    if (contentType === 'application/pdf') {
      logger.debug(`Extracting text from PDF: ${originalFilename} (Doc ID: ${documentId})`);
      textContent = await convertPdfToTextFromBuffer(fileBuffer, originalFilename);
    } else {
      logger.debug(
        `Extracting text from non-PDF: ${originalFilename} (Doc ID: ${documentId}, Type: ${contentType})`
      );
      textContent = await extractTextFromFileBuffer(fileBuffer, contentType, originalFilename);
    }

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
    postProcessingErrorToParent(
      documentId,
      `Failed to process document ${originalFilename}: ${error.message}`,
      error.stack
    );
  }
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

  // Prepare prompts in parallel
  const prompts = chunks.map((chunkText, idx) => {
    const originalIndex = batchIndices ? batchIndices[idx] : idx;
    try {
      const prompt = contentTypeForContext
        ? getPromptForMimeType(contentTypeForContext, fullDocumentTextForContext, chunkText)
        : getContextualizationPrompt(fullDocumentTextForContext, chunkText);

      if (prompt.startsWith('Error:')) {
        logger.warn(`Skipping contextualization for chunk ${originalIndex} due to: ${prompt}`);
        return { prompt: null, originalIndex, chunkText, valid: false };
      }

      return { prompt, originalIndex, chunkText, valid: true };
    } catch (error: any) {
      logger.error(
        `Error preparing prompt for chunk ${originalIndex}: ${error.message}`,
        error.stack
      );
      return { prompt: null, originalIndex, chunkText, valid: false };
    }
  });

  // Process valid prompts with rate limiting
  const contextualizedChunks = await Promise.all(
    prompts.map(async (item) => {
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
        const llmResponse = await generateText(item.prompt!);
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
      } catch (genError: any) {
        if (genError.status === 429) {
          // Handle rate limiting with exponential backoff
          const retryAfter = genError.headers?.['retry-after'] || 5;
          logger.warn(
            `Rate limit hit for context generation. Retrying after ${retryAfter}s for chunk ${item.originalIndex}`
          );
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));

          // Try once more
          try {
            const llmResponse = await generateText(item.prompt!);
            const generatedContext = llmResponse.text;
            const contextualizedText = getChunkWithContext(item.chunkText, generatedContext);

            return {
              contextualizedText,
              success: true,
              index: item.originalIndex,
            };
          } catch (retryError: any) {
            logger.error(
              `Failed to generate context after retry for chunk ${item.originalIndex}: ${retryError.message}`
            );
            return {
              contextualizedText: item.chunkText,
              success: false,
              index: item.originalIndex,
            };
          }
        } else {
          logger.error(
            `Error generating context for chunk ${item.originalIndex}: ${genError.message}`,
            genError.stack
          );
          return {
            contextualizedText: item.chunkText,
            success: false,
            index: item.originalIndex,
          };
        }
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

  if (!isFragment && mainDocText && originalMetadata) {
    const fileExt = originalMetadata.originalFilename.split('.').pop()?.toLowerCase() || '';
    const title = originalMetadata.originalFilename.replace(`.${fileExt}`, '');
    const actualStoredMainDocId = uuidv4() as UUID;

    const mainDocumentMemory: Memory = {
      id: actualStoredMainDocId,
      agentId: agentId,
      roomId: agentId,
      worldId: originalMetadata.worldId,
      entityId: agentId,
      content: { text: mainDocText },
      metadata: {
        type: MemoryType.DOCUMENT,
        documentId: originalMetadata.clientDocumentId,
        originalFilename: originalMetadata.originalFilename,
        contentType: originalMetadata.contentType,
        title: title,
        fileExt: fileExt,
        fileSize: originalMetadata.fileSize,
        source: 'rag-worker-main-document-upload',
        timestamp: Date.now(),
      },
    };
    await dbAdapter.createMemory(mainDocumentMemory, 'documents');
    logger.info(
      `Worker saved main document ${originalMetadata.originalFilename} (Client ID: ${originalMetadata.clientDocumentId}, DB ID: ${actualStoredMainDocId}) for agent ${agentId}.`
    );
    return { actualStoredMainDocId, clientDocumentId: originalMetadata.clientDocumentId };
  } else if (isFragment && chunks && chunks.length > 0) {
    logger.debug(
      `Worker saving ${chunks.length} chunks for document ${documentId} via DatabaseAdapter for agent ${agentId}.`
    );

    // Get rate limits from provider config
    const providerLimits = await getProviderRateLimits();

    // Determine optimal concurrency based on provider rate limits
    // Default to 30, but respect provider limits if they're lower
    const CONCURRENCY_LIMIT = Math.min(30, providerLimits.maxConcurrentRequests || 30);
    logger.debug(`Using concurrency limit of ${CONCURRENCY_LIMIT} based on provider limits`);

    // Create a rate limiter function to prevent exceeding provider limits
    const rateLimiter = createRateLimiter(providerLimits.requestsPerMinute || 60);

    let savedCount = 0;
    let failedCount = 0;
    const failedChunks: number[] = [];

    // Process chunks in batches of CONCURRENCY_LIMIT
    for (let i = 0; i < chunks.length; i += CONCURRENCY_LIMIT) {
      const batchChunks = chunks.slice(i, i + CONCURRENCY_LIMIT);
      const batchOriginalIndices = Array.from({ length: batchChunks.length }, (_, k) => i + k);

      logger.debug(
        `Processing batch of ${batchChunks.length} chunks for document ${documentId}. ` +
          `Starting original index: ${batchOriginalIndices[0]}, batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1}/${Math.ceil(chunks.length / CONCURRENCY_LIMIT)}`
      );

      // Process context generation in an optimized batch
      let contextualizedChunks: Array<{
        contextualizedText: string;
        index: number;
        success: boolean;
      }> = [];

      if (ctxRagEnabled && fullDocumentTextForContext) {
        logger.debug(
          `Generating contexts in batch for chunks ${i} to ${i + batchChunks.length - 1}`
        );
        contextualizedChunks = await generateContextsInBatch(
          fullDocumentTextForContext,
          batchChunks,
          contentTypeForContext,
          batchOriginalIndices
        );
      } else {
        // If contextual RAG is disabled, prepare the chunks without modification
        contextualizedChunks = batchChunks.map((chunkText, idx) => ({
          contextualizedText: chunkText,
          index: batchOriginalIndices[idx],
          success: true,
        }));
      }

      // Generate embeddings with rate limiting
      const embeddingPromises = contextualizedChunks.map(async (contextualizedChunk) => {
        // Apply rate limiting before embedding generation
        await rateLimiter();

        try {
          const embedding = await generateTextEmbedding(contextualizedChunk.contextualizedText);
          return {
            embedding,
            success: true,
            index: contextualizedChunk.index,
            text: contextualizedChunk.contextualizedText,
          };
        } catch (embeddingError: any) {
          if (embeddingError.status === 429) {
            // Handle rate limiting with exponential backoff
            const retryAfter = embeddingError.headers?.['retry-after'] || 5;
            logger.warn(
              `Rate limit hit for embedding generation on chunk ${contextualizedChunk.index}. Retrying after ${retryAfter}s`
            );
            await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));

            // Try once more
            try {
              const embedding = await generateTextEmbedding(contextualizedChunk.contextualizedText);
              return {
                embedding,
                success: true,
                index: contextualizedChunk.index,
                text: contextualizedChunk.contextualizedText,
              };
            } catch (retryError: any) {
              logger.error(
                `Failed to generate embedding after retry for chunk ${contextualizedChunk.index}: ${retryError.message}`
              );
              return {
                success: false,
                index: contextualizedChunk.index,
                error: retryError,
                text: contextualizedChunk.contextualizedText,
              };
            }
          } else {
            logger.error(
              `Error generating embedding for chunk ${contextualizedChunk.index}: ${embeddingError.message}`
            );
            return {
              success: false,
              index: contextualizedChunk.index,
              error: embeddingError,
              text: contextualizedChunk.contextualizedText,
            };
          }
        }
      });

      const embeddingResults = await Promise.all(embeddingPromises);

      // Process successful embeddings and track failures
      for (const result of embeddingResults) {
        const originalChunkIndex = result.index;

        if (!result.success) {
          failedCount++;
          failedChunks.push(originalChunkIndex);
          logger.warn(`Failed to process chunk ${originalChunkIndex} for document ${documentId}`);
          continue;
        }

        const contextualizedChunkText = result.text;
        const embedding = Array.isArray(result.embedding)
          ? result.embedding
          : result.embedding?.embedding;

        if (!embedding || embedding.length === 0) {
          logger.warn(
            `Skipping chunk ${originalChunkIndex + 1} for document ${documentId} due to empty embedding.`
          );
          failedCount++;
          failedChunks.push(originalChunkIndex);
          continue;
        }

        try {
          const fragmentMemory: Memory = {
            id: uuidv4() as UUID,
            agentId: agentId,
            roomId: agentId,
            worldId: agentId,
            entityId: agentId,
            embedding: embedding,
            content: { text: contextualizedChunkText },
            metadata: {
              type: MemoryType.FRAGMENT,
              documentId: documentId,
              position: originalChunkIndex,
              timestamp: Date.now(),
              source: 'rag-worker-fragment-upload',
            },
          };

          await dbAdapter.createMemory(fragmentMemory, 'knowledge');
          logger.debug(
            `Saved chunk ${originalChunkIndex + 1}/${chunks.length} for document ${documentId} (Fragment ID: ${fragmentMemory.id})`
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
      if (i + CONCURRENCY_LIMIT < chunks.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // Retry any failed chunks if there are any
    if (failedChunks.length > 0 && failedChunks.length < chunks.length / 2) {
      logger.info(`Retrying ${failedChunks.length} failed chunks for document ${documentId}`);

      // TODO: Consider implementing retry logic here if needed
      // For now, just log the failures
      logger.warn(
        `Skipped retrying ${failedChunks.length} chunks for document ${documentId}: ${failedChunks.join(', ')}`
      );
    }

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
  } else if (isFragment && (!chunks || chunks.length === 0)) {
    logger.warn(`No chunks provided to save for document ${documentId}. Nothing saved.`);
    return { savedFragmentCount: 0 };
  }
  return {};
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
        const { clientDocumentId, fileContentB64, contentType, originalFilename, worldId } =
          message.payload;
        logger.info(
          `Worker processing PDF_THEN_FRAGMENTS for clientDocId: ${clientDocumentId}, filename: ${originalFilename}`
        );

        let mainPdfText: string | null = null;
        let storedMainDocInfo: { actualStoredMainDocId: UUID; clientDocumentId: UUID } | null =
          null;
        let pdfProcessingErrorDetails: { message: string; stack?: string } | null = null;
        const pdfFileBuffer = Buffer.from(fileContentB64, 'base64');

        try {
          mainPdfText = await convertPdfToTextFromBuffer(pdfFileBuffer, originalFilename);
          if (!mainPdfText || mainPdfText.trim() === '') {
            throw new Error(`No text content extracted from PDF ${originalFilename} by worker.`);
          }
          logger.debug(
            `Main PDF text extracted for ${originalFilename}, length: ${mainPdfText.length}`
          );

          const saveResult = await saveToDbViaAdapter({
            documentId: uuidv4() as UUID,
            agentId: workerAgentId as UUID,
            isFragment: false,
            mainDocText: mainPdfText,
            originalMetadata: {
              contentType,
              originalFilename,
              worldId,
              fileSize: pdfFileBuffer.length,
              clientDocumentId: clientDocumentId as UUID,
            },
          });
          if (saveResult.actualStoredMainDocId && saveResult.clientDocumentId) {
            storedMainDocInfo = {
              actualStoredMainDocId: saveResult.actualStoredMainDocId as UUID,
              clientDocumentId: saveResult.clientDocumentId as UUID,
            };
          } else {
            throw new Error('Failed to get stored main document ID after saving.');
          }
        } catch (error: any) {
          logger.error(
            `Error processing main PDF ${originalFilename} (clientDocId: ${clientDocumentId}) in worker:`,
            error.message,
            error.stack
          );
          pdfProcessingErrorDetails = { message: error.message, stack: error.stack };
        }

        parentPort?.postMessage({
          type: 'PDF_MAIN_DOCUMENT_STORED',
          payload: {
            clientDocumentId: clientDocumentId,
            storedDocumentMemoryId: storedMainDocInfo?.actualStoredMainDocId || null,
            agentId: workerAgentId,
            error: pdfProcessingErrorDetails,
          },
        });

        if (mainPdfText && !pdfProcessingErrorDetails && storedMainDocInfo) {
          logger.debug(
            `Main PDF ${originalFilename} (clientDocId: ${clientDocumentId}) processed. Now chunking for fragments.`
          );
          await chunkAndSaveDocumentFragments(
            storedMainDocInfo.clientDocumentId,
            mainPdfText,
            workerAgentId as UUID
          );
        } else {
          logger.warn(
            `Skipping fragment processing for PDF ${originalFilename} (clientDocId: ${clientDocumentId}) due to earlier error or no text.`
          );
        }
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
