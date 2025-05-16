import { parentPort, workerData } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createDatabaseAdapter } from '@elizaos/plugin-sql';
import type { IDatabaseAdapter, UUID, Memory } from '@elizaos/core';
import { MemoryType, logger } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { generateTextEmbedding } from './llm';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

logger.info('RAG Worker starting...');

let dbAdapter: IDatabaseAdapter | null = null;

async function initializeDatabaseAdapter() {
  try {
    logger.info('Initializing Database Adapter in worker with config:', workerData.dbConfig);
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

    // --- Log dbAdapter.db state IMMEDIATELY after init ---
    logger.info(`[RAG_WORKER_DEBUG] State of dbAdapter.db AFTER init call completion:`);
    logger.info(`[RAG_WORKER_DEBUG]   dbAdapter.db === null: ${dbAdapter.db === null}`);
    logger.info(`[RAG_WORKER_DEBUG]   dbAdapter.db === undefined: ${dbAdapter.db === undefined}`);
    if (dbAdapter.db) {
      logger.info(`[RAG_WORKER_DEBUG]   dbAdapter.db object type: ${typeof dbAdapter.db}`);
      logger.info(
        `[RAG_WORKER_DEBUG]   dbAdapter.db keys: ${Object.keys(dbAdapter.db).join(', ')}`
      );
    } else {
      logger.warn(`[RAG_WORKER_DEBUG]   dbAdapter.db is null or undefined AFTER init call.`);
    }
    // --- End log ---

    // Ensure embedding dimension is set based on the provider
    try {
      logger.info('Determining embedding dimension for worker...');
      // Generate a sample embedding to determine the dimension
      // Assuming generateTextEmbedding returns { embedding: number[] } or number[]
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
        logger.info(`Determined embedding dimension: ${dimension}. Ensuring in DB adapter.`);
        if (!dbAdapter) {
          // This case should ideally not be reached if init was called on dbAdapter
          const criticalErrorMsg =
            'CRITICAL: dbAdapter is unexpectedly null before calling ensureEmbeddingDimension!';
          logger.error(criticalErrorMsg);
          parentPort?.postMessage({
            type: 'WORKER_ERROR',
            payload: { agentId: workerData.agentId, error: criticalErrorMsg },
          });
          throw new Error(criticalErrorMsg);
        }
        // Detailed logging for dbAdapter state:
        logger.info(
          `[RAG_WORKER_DEBUG] About to call ensureEmbeddingDimension on dbAdapter for agentId: ${workerData.agentId}.`
        );
        logger.info(
          `[RAG_WORKER_DEBUG] dbAdapter has 'db' own property: ${Object.prototype.hasOwnProperty.call(dbAdapter, 'db')}`
        );
        logger.info(`[RAG_WORKER_DEBUG] dbAdapter.db === null: ${dbAdapter.db === null}`);
        logger.info(`[RAG_WORKER_DEBUG] dbAdapter.db === undefined: ${dbAdapter.db === undefined}`);
        if (dbAdapter.db) {
          logger.info(`[RAG_WORKER_DEBUG] dbAdapter.db object type: ${typeof dbAdapter.db}`);
          logger.info(
            `[RAG_WORKER_DEBUG] dbAdapter.db keys: ${Object.keys(dbAdapter.db).join(', ')}`
          );
        } else {
          logger.warn(`[RAG_WORKER_DEBUG] dbAdapter.db is null or undefined.`);
        }

        await dbAdapter.ensureEmbeddingDimension(dimension);
        logger.info(`Embedding dimension ${dimension} ensured successfully in worker.`);
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
      // Post a specific error for dimension failure, then rethrow to prevent WORKER_READY
      parentPort?.postMessage({
        type: 'WORKER_ERROR',
        payload: {
          agentId: workerData.agentId,
          error: `Failed to set embedding dimension: ${dimError.message}`,
          stack: dimError.stack,
        },
      });
      throw dimError; // Rethrow to prevent worker from becoming ready
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

async function convertPdfToText(pdfBuffer: Buffer): Promise<string> {
  try {
    const uint8ArrayBuffer = new Uint8Array(pdfBuffer);
    const loadingTask = pdfjsLib.getDocument({ data: uint8ArrayBuffer });
    const pdfDocument = await loadingTask.promise;
    let allPagesText: string[] = [];

    for (let i = 1; i <= pdfDocument.numPages; i++) {
      const page = await pdfDocument.getPage(i);
      const textContent = await page.getTextContent();

      // Filter for items that are actual text items and then map them
      const pageText = textContent.items
        .filter((item) => typeof (item as any).str === 'string' && (item as any).str.trim() !== '')
        .map((item) => (item as any).str as string)
        .join(' ');

      if (pageText.length > 0) {
        // Check if the joined pageText has content
        allPagesText.push(pageText);
      }
    }
    // Join the text from all pages with a single newline character.
    // If a page had no text, it won't contribute an extra newline.
    return allPagesText.join('\n').trim();
  } catch (error) {
    logger.error('Error parsing PDF in worker:', error);
    // It's good to log the specific error if possible
    if (error instanceof Error) {
      logger.error('PDF parsing error details:', error.message, error.stack);
    }
    throw new Error('Failed to convert PDF to text in worker.');
  }
}

async function processAndChunkDocument({
  documentId,
  fileContentB64,
  contentType,
}: {
  documentId: string;
  fileContentB64: string;
  contentType: string;
}) {
  logger.info(`Worker processing document ${documentId}, type: ${contentType}`);
  let textContent = '';
  const fileBuffer = Buffer.from(fileContentB64, 'base64');

  if (contentType === 'application/pdf') {
    logger.info('Parsing PDF content...');
    textContent = await convertPdfToText(fileBuffer);
    logger.info(`PDF parsing complete. Text length: ${textContent.length}`);
  } else if (contentType.startsWith('text/')) {
    textContent = fileBuffer.toString('utf-8');
  } else {
    const errorMsg = `Unsupported content type: ${contentType}`;
    logger.warn(errorMsg);
    parentPort?.postMessage({
      type: 'PROCESSING_ERROR',
      payload: { documentId, error: errorMsg, agentId: workerData.agentId },
    });
    return;
  }

  if (!textContent) {
    const errorMsg = 'No text content extracted.';
    logger.warn(errorMsg);
    parentPort?.postMessage({
      type: 'PROCESSING_ERROR',
      payload: { documentId, error: errorMsg, agentId: workerData.agentId },
    });
    return;
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 100,
  });
  const chunks = await splitter.splitText(textContent);
  logger.info(`Split content into ${chunks.length} chunks for document ${documentId}.`);

  try {
    // Directly proceed to save chunks and embeddings to DB
    await saveToDbViaAdapter({
      documentId,
      chunks,
      agentId: workerData.agentId as UUID,
    });
  } catch (e: any) {
    logger.error(
      `Error during embedding generation or saving for doc ${documentId}:`,
      e.message,
      e.stack
    );
    parentPort?.postMessage({
      type: 'PROCESSING_ERROR',
      payload: { documentId, error: e.message, stack: e.stack, agentId: workerData.agentId },
    });
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
        documentId: documentId,
        originalFilename: originalMetadata.originalFilename,
        contentType: originalMetadata.contentType,
        title: title,
        fileExt: fileExt,
        fileSize: originalMetadata.fileSize,
        source: 'rag-worker-pdf-main-upload',
        timestamp: Date.now(),
      },
    };
    await dbAdapter.createMemory(mainDocumentMemory, 'documents');
    logger.info(
      `Worker saved main PDF document ${originalMetadata.originalFilename} (Client ID: ${documentId}, DB ID: ${actualStoredMainDocId}) for agent ${agentId}.`
    );
    return { actualStoredMainDocId };
  } else if (isFragment && chunks && chunks.length > 0) {
    logger.info(
      `Worker saving ${chunks.length} chunks for document ${documentId} via DatabaseAdapter for agent ${agentId}.`
    );
    let savedCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      const embeddingResult = await generateTextEmbedding(chunks[i]);

      const fragmentMemory: Memory = {
        id: uuidv4() as UUID,
        agentId: agentId,
        roomId: agentId,
        worldId: agentId,
        entityId: agentId,
        embedding: embeddingResult.embedding,
        content: { text: chunks[i] },
        metadata: {
          type: MemoryType.FRAGMENT,
          documentId: documentId,
          position: i,
          timestamp: Date.now(),
          source: 'rag-worker-upload',
        },
      };

      await dbAdapter.createMemory(fragmentMemory, 'knowledge');
      logger.info(
        `Saved chunk ${i + 1}/${chunks.length} for document ${documentId} (ID: ${fragmentMemory.id})`
      );
      savedCount++;
    }
    parentPort?.postMessage({
      type: 'KNOWLEDGE_ADDED',
      payload: { documentId, count: chunks.length, agentId },
    });
    return { savedFragmentCount: savedCount };
  }
  return {};
}

parentPort?.on('message', async (message: any) => {
  logger.info('Worker received message:', message.type);

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
        await processAndChunkDocument(message.payload);
        break;
      case 'PROCESS_PDF_THEN_FRAGMENTS':
        const { clientDocumentId, fileContentB64, contentType, originalFilename, worldId } =
          message.payload;
        logger.info(
          `Worker processing PDF_THEN_FRAGMENTS for clientDocId: ${clientDocumentId}, filename: ${originalFilename}`
        );
        let mainPdfText: string | null = null;
        let actualStoredMainDocId: UUID | null = null;
        let pdfProcessingError: any = null;
        const pdfFileBuffer = Buffer.from(fileContentB64, 'base64');

        try {
          mainPdfText = await convertPdfToText(pdfFileBuffer);
          if (!mainPdfText || mainPdfText.trim() === '') {
            throw new Error('No text content extracted from PDF by worker.');
          }

          const saveResult = await saveToDbViaAdapter({
            documentId: clientDocumentId,
            agentId: workerData.agentId as UUID,
            isFragment: false,
            mainDocText: mainPdfText,
            originalMetadata: {
              contentType,
              originalFilename,
              worldId,
              fileSize: pdfFileBuffer.length,
            },
          });
          actualStoredMainDocId = saveResult.actualStoredMainDocId as UUID;
        } catch (error) {
          logger.error(
            `Error processing main PDF ${originalFilename} (clientDocId: ${clientDocumentId}) in worker:`,
            (error as Error).message,
            (error as Error).stack
          );
          pdfProcessingError = { message: (error as Error).message, stack: (error as Error).stack };
        }

        parentPort?.postMessage({
          type: 'PDF_MAIN_DOCUMENT_STORED',
          payload: {
            clientDocumentId: clientDocumentId,
            storedDocumentMemoryId: actualStoredMainDocId,
            agentId: workerData.agentId,
            error: pdfProcessingError,
          },
        });

        if (mainPdfText && !pdfProcessingError) {
          logger.info(
            `Main PDF ${originalFilename} (clientDocId: ${clientDocumentId}) processed. Now chunking for fragments.`
          );
          const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 100,
          });
          const chunks = await splitter.splitText(mainPdfText);
          logger.info(
            `Split PDF content into ${chunks.length} chunks for document ${clientDocumentId}.`
          );

          if (chunks.length > 0) {
            try {
              await saveToDbViaAdapter({
                documentId: clientDocumentId,
                chunks,
                agentId: workerData.agentId as UUID,
                isFragment: true,
              });
            } catch (e: any) {
              logger.error(
                `Error during fragment embedding/saving for PDF doc ${clientDocumentId}:`,
                e.message,
                e.stack
              );
              parentPort?.postMessage({
                type: 'PROCESSING_ERROR',
                payload: {
                  documentId: clientDocumentId,
                  error: e.message,
                  stack: e.stack,
                  agentId: workerData.agentId,
                },
              });
            }
          } else {
            logger.warn(
              `No chunks generated from PDF text for ${clientDocumentId}. No fragments to save.`
            );
          }
        } else {
          logger.warn(
            `Skipping fragment processing for PDF ${originalFilename} (clientDocId: ${clientDocumentId}) due to earlier error or no text.`
          );
        }
        break;
      default:
        logger.warn('Unknown message type received by RAG worker:', message.type);
    }
  } catch (error: any) {
    logger.error('Error processing message in RAG worker:', error.message, error.stack);
    parentPort?.postMessage({
      type: 'PROCESSING_ERROR',
      payload: {
        documentId: message.payload?.documentId,
        error: error.message,
        stack: error.stack,
        agentId: workerData.agentId,
      },
    });
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
