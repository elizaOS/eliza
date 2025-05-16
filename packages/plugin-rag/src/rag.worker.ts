import { parentPort, workerData } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createDatabaseAdapter } from '@elizaos/plugin-sql';
import type { IDatabaseAdapter, UUID, Memory } from '@elizaos/core';
import { MemoryType } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { generateTextEmbedding } from './llm';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

const logger = {
  info: (...args: any[]) => console.log(`[RAG_WORKER_INFO ${workerData.agentId}]`, ...args),
  error: (...args: any[]) => console.error(`[RAG_WORKER_ERROR ${workerData.agentId}]`, ...args),
  warn: (...args: any[]) => console.warn(`[RAG_WORKER_WARN ${workerData.agentId}]`, ...args),
};

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
    let fullText = '';
    for (let i = 1; i <= pdfDocument.numPages; i++) {
      const page = await pdfDocument.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .filter((item: any) => typeof item.str === 'string')
        .map((item: any) => item.str)
        .join(' ');
      fullText += pageText + (textContent.items.length > 0 ? '\n' : '');
    }
    return fullText.trim();
  } catch (error) {
    logger.error('Error parsing PDF in worker:', error);
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
}: {
  documentId: string;
  chunks: string[];
  agentId: UUID;
}) {
  if (!dbAdapter) {
    const errMsg = 'Database Adapter not initialized in worker. Cannot save.';
    logger.error(errMsg);
    throw new Error(errMsg);
  }
  logger.info(
    `Worker saving ${chunks.length} chunks for document ${documentId} via DatabaseAdapter for agent ${agentId}.`
  );
  try {
    for (let i = 0; i < chunks.length; i++) {
      const embeddingResult = await generateTextEmbedding(chunks[i]);

      const fragmentMemory: Memory = {
        id: uuidv4() as UUID,
        agentId: agentId,
        roomId: agentId, // Assuming agent-scoped knowledge, uses agentId as roomId
        worldId: agentId, // Assuming agent-scoped knowledge, uses agentId as worldId
        entityId: agentId, // The agent is the owner of this memory
        embedding: embeddingResult.embedding,
        content: { text: chunks[i] },
        metadata: {
          type: MemoryType.FRAGMENT,
          documentId: documentId,
          position: i,
          timestamp: Date.now(),
          source: 'rag-worker-upload', // Indicate the source of this fragment
        },
      };

      // Use the createMemory method from the adapter
      await dbAdapter.createMemory(fragmentMemory, 'knowledge');
      logger.info(
        `Saved chunk ${i + 1}/${chunks.length} for document ${documentId} (ID: ${fragmentMemory.id})`
      );
    }

    logger.info(
      `Successfully processed and saved ${chunks.length} chunks for document ${documentId} using DatabaseAdapter.`
    );
    parentPort?.postMessage({
      type: 'KNOWLEDGE_ADDED',
      payload: { documentId, count: chunks.length, agentId },
    });
  } catch (e: any) {
    logger.error('Error saving to DB via adapter in worker:', e.message, e.stack);
    throw e;
  }
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
