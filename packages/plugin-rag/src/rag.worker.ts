import { parentPort, workerData } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createDatabaseAdapter } from '@elizaos/plugin-sql';
import type { IDatabaseAdapter, UUID, Memory } from '@elizaos/core';
import { MemoryType, logger, splitChunks } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { generateTextEmbedding } from './llm';
import { extractTextFromFileBuffer, convertPdfToTextFromBuffer } from './utils';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

logger.info('RAG Worker starting...');

let dbAdapter: IDatabaseAdapter | null = null;

function postProcessingErrorToParent(documentId: string | UUID, errorMsg: string, stack?: string) {
  logger.error(errorMsg, stack);
  parentPort?.postMessage({
    type: 'PROCESSING_ERROR',
    payload: {
      documentId,
      error: errorMsg,
      stack,
      agentId: workerData.agentId,
    },
  });
}

async function initializeDatabaseAdapter() {
  try {
    logger.debug('Initializing Database Adapter in worker with config:', workerData.dbConfig);
    if (!workerData.agentId || !workerData.dbConfig) {
      throw new Error(
        'agentId and dbConfig must be provided in workerData for worker DB adapter initialization.'
      );
    }
    dbAdapter = createDatabaseAdapter(workerData.dbConfig, workerData.agentId as UUID);
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
            payload: { agentId: workerData.agentId, error: criticalErrorMsg },
          });
          throw new Error(criticalErrorMsg);
        }
        logger.debug(
          `[RAG_WORKER] About to call ensureEmbeddingDimension on dbAdapter for agentId: ${workerData.agentId}.`
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
          agentId: workerData.agentId,
          error: `Failed to set embedding dimension: ${dimError.message}`,
          stack: dimError.stack,
        },
      });
      throw dimError;
    }

    parentPort?.postMessage({ type: 'WORKER_READY', payload: { agentId: workerData.agentId } });
  } catch (e: any) {
    logger.error('Failed to initialize Database Adapter in worker:', e.message, e.stack);
    parentPort?.postMessage({
      type: 'WORKER_ERROR',
      payload: { agentId: workerData.agentId, error: e.message, stack: e.stack },
    });
  }
}

async function chunkAndSaveDocumentFragments(documentId: UUID, textContent: string, agentId: UUID) {
  if (!textContent || textContent.trim() === '') {
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
  const chunks = await splitChunks(textContent, tokenChunkSize, tokenChunkOverlap);

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
      workerData.agentId as UUID
    );
  } catch (error: any) {
    postProcessingErrorToParent(
      documentId,
      `Failed to process document ${originalFilename}: ${error.message}`,
      error.stack
    );
  }
}

async function saveToDbViaAdapter({
  documentId,
  chunks,
  agentId,
  isFragment = true,
  mainDocText,
  originalMetadata,
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
    let savedCount = 0;
    const CONCURRENCY_LIMIT = 10; // Max concurrent embedding requests

    for (let i = 0; i < chunks.length; i += CONCURRENCY_LIMIT) {
      const batchChunks = chunks.slice(i, i + CONCURRENCY_LIMIT);
      const batchOriginalIndices = Array.from({ length: batchChunks.length }, (_, k) => i + k);

      logger.debug(
        `Processing batch of ${batchChunks.length} chunks for document ${documentId}. Starting original index: ${batchOriginalIndices[0]}`
      );

      const embeddingPromises = batchChunks.map((chunk) => generateTextEmbedding(chunk));

      try {
        const embeddingResults = await Promise.all(embeddingPromises);

        for (let j = 0; j < batchChunks.length; j++) {
          const originalChunkIndex = batchOriginalIndices[j];
          const chunkText = batchChunks[j];
          const embeddingResult = embeddingResults[j];

          const embedding = Array.isArray(embeddingResult)
            ? embeddingResult
            : embeddingResult?.embedding;

          if (!embedding || embedding.length === 0) {
            logger.warn(
              `Skipping chunk ${originalChunkIndex + 1} for document ${documentId} due to empty embedding.`
            );
            continue;
          }

          const fragmentMemory: Memory = {
            id: uuidv4() as UUID,
            agentId: agentId,
            roomId: agentId, // TODO: Review if roomId should be different, e.g. worldId or a dedicated room for docs
            worldId: agentId, // TODO: Review if worldId should be from original document or context
            entityId: agentId, // Assuming agent is the entity creating/owning this fragment
            embedding: embedding,
            content: { text: chunkText },
            metadata: {
              type: MemoryType.FRAGMENT,
              documentId: documentId, // Link to the original document ID (could be clientDocId or storedMainDocId)
              position: originalChunkIndex, // Original position of the chunk in the document
              timestamp: Date.now(),
              source: 'rag-worker-fragment-upload',
            },
          };

          await dbAdapter.createMemory(fragmentMemory, 'knowledge');
          logger.debug(
            `Saved chunk ${originalChunkIndex + 1}/${chunks.length} for document ${documentId} (Fragment ID: ${fragmentMemory.id})`
          );
          savedCount++;
        }
      } catch (batchError: any) {
        logger.error(
          `Error processing a batch of embeddings for document ${documentId} (starting index ${batchOriginalIndices[0]}): ${batchError.message}`,
          batchError.stack
        );
        // Decide if we want to skip the whole batch or continue with other batches.
        // For now, we log and continue with the next batch. The failed chunks in this batch won't be saved.
        // To inform parent, we could accumulate errors and send a more comprehensive PROCESSING_ERROR.
      }
    }

    if (savedCount > 0) {
      parentPort?.postMessage({
        type: 'KNOWLEDGE_ADDED',
        payload: { documentId, count: savedCount, agentId },
      });
    }
    logger.info(`Finished saving ${savedCount} fragments for document ${documentId}.`);
    return { savedFragmentCount: savedCount };
  } else if (isFragment && (!chunks || chunks.length === 0)) {
    logger.warn(`No chunks provided to save for document ${documentId}. Nothing saved.`);
    return { savedFragmentCount: 0 };
  }
  return {};
}

parentPort?.on('message', async (message: any) => {
  logger.debug('RAG Worker received message:', message.type, 'for agent:', workerData.agentId);

  if (!dbAdapter && message.type !== 'INIT_DB_ADAPTER') {
    logger.warn(
      'Worker DB adapter not initialized. Ignoring message:',
      message.type,
      '(Agent:',
      workerData.agentId,
      ')'
    );
    parentPort?.postMessage({
      type: 'WORKER_ERROR',
      payload: {
        agentId: workerData.agentId,
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
            agentId: workerData.agentId as UUID,
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
            agentId: workerData.agentId,
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
            workerData.agentId as UUID
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
