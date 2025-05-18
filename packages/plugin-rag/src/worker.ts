import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { logger, UUID } from '@elizaos/core';
import { RagWorker, WorkerDbConfig, WorkerMessageTypes, DocumentStoredCallback } from './types';

/**
 * Worker Manager - Handles creation, lifecycle and messaging for RAG workers
 */
export class WorkerManager {
  private workers: Map<string, RagWorker> = new Map();
  private workerReadyPromises: Map<string, Promise<void>> = new Map();
  private pendingPdfCallbacks: Map<UUID, DocumentStoredCallback> = new Map();
  private workerPath: string;

  /**
   * Create a new worker manager
   * @param workerPath Path to the worker script
   */
  constructor(workerPath: string) {
    this.workerPath = workerPath;
  }

  /**
   * Get the database configuration for a worker
   * @param agentId Agent ID
   * @param dataDirSetting Data directory setting
   * @param postgresUrlSetting Postgres URL setting
   * @returns Worker database configuration
   */
  getDbConfigForWorker(
    agentId: UUID,
    dataDirSetting?: string,
    postgresUrlSetting?: string
  ): WorkerDbConfig {
    const config: WorkerDbConfig = {};

    if (postgresUrlSetting) {
      config.postgresUrl = postgresUrlSetting;
    } else if (dataDirSetting) {
      config.dataDir = dataDirSetting;
    } else {
      // Default fallback path for PGlite
      const baseDataDir = path.join(process.cwd(), '.eliza-data', 'pglite');
      config.dataDir = path.join(baseDataDir, agentId as string);
      logger.warn(
        `DB config for RAG worker for agent ${agentId} falling back to default path: ${config.dataDir}. ` +
          `Ensure PGLITE_DATA_DIR or POSTGRES_URL settings are available in runtime for explicit configuration.`
      );
    }

    return config;
  }

  /**
   * Initialize or get an existing worker
   * @param agentId Agent ID
   * @param dbConfig Database configuration
   * @param messageHandler Handler for worker messages
   * @returns Initialized worker
   */
  initializeWorker(
    agentId: string,
    dbConfig: WorkerDbConfig,
    messageHandler: (message: WorkerMessageTypes) => void
  ): RagWorker {
    if (this.workers.has(agentId)) {
      return this.workers.get(agentId)!;
    }

    logger.info(`Initializing new RAG worker for agentId: ${agentId}`);

    // Create worker data with minimal necessary information
    const workerData = { agentId, dbConfig };

    // Create the worker
    const worker = new Worker(this.workerPath, { workerData }) as RagWorker;

    // Setup ready promise
    const readyPromise = this.setupWorkerReadyPromise(worker, agentId);
    this.workerReadyPromises.set(agentId, readyPromise);

    // Setup message handler
    worker.on('message', (message: WorkerMessageTypes) => {
      this.handleWorkerMessage(message, agentId);
      // Forward message to the caller's handler
      messageHandler(message);
    });

    // Setup error handlers
    this.setupWorkerErrorHandlers(worker, agentId);

    // Store and initialize the worker
    this.workers.set(agentId, worker);
    logger.debug(`Sending INIT_DB_ADAPTER to new RAG worker for agent ${agentId}`);
    worker.postMessage({ type: 'INIT_DB_ADAPTER' });

    return worker;
  }

  /**
   * Set up a promise that resolves when the worker is ready
   * @param worker The worker to monitor
   * @param agentId The agent ID
   * @returns A promise that resolves when the worker is ready
   */
  private setupWorkerReadyPromise(worker: RagWorker, agentId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      worker.once('message', (message: WorkerMessageTypes) => {
        if (message.type === 'WORKER_READY') {
          worker.isReady = true;
          logger.info(`RAG Worker for agent ${message.payload.agentId} reported ready.`);
          resolve();
        } else if (message.type === 'WORKER_ERROR' && !worker.isReady) {
          // If worker errors before becoming ready (e.g. DB init failure)
          logger.error(
            `RAG Worker for agent ${agentId} failed to initialize: ${message.payload.error}`,
            message.payload.stack
          );
          reject(new Error(`Worker ${agentId} failed to initialize: ${message.payload.error}`));
        }
      });

      worker.once('error', (err) => {
        logger.error(`RAG Worker for agent ${agentId} critical error during init:`, err);
        reject(err);
        this.cleanupWorker(agentId);
      });

      worker.once('exit', (code) => {
        const exitMsg = `RAG Worker for agent ${agentId} exited with code ${code} during init.`;
        logger.warn(exitMsg);
        if (!worker.isReady) reject(new Error(exitMsg));
        this.cleanupWorker(agentId);
      });
    });
  }

  /**
   * Set up error handlers for the worker
   * @param worker The worker to monitor
   * @param agentId The agent ID
   */
  private setupWorkerErrorHandlers(worker: RagWorker, agentId: string): void {
    worker.on('error', (err) => {
      if (worker.isReady) {
        logger.error(
          `RAG Worker for agent ${agentId} encountered an error post-initialization:`,
          err
        );
      }
      this.cleanupWorker(agentId);
    });

    worker.on('exit', (code) => {
      if (worker.isReady) {
        logger.info(
          `RAG Worker for agent ${agentId} exited with code ${code} post-initialization.`
        );
      }
      this.cleanupWorker(agentId);
    });
  }

  /**
   * Clean up worker resources
   * @param agentId The agent ID
   */
  private cleanupWorker(agentId: string): void {
    this.workers.delete(agentId);
    this.workerReadyPromises.delete(agentId);
  }

  /**
   * Handle messages from workers
   * @param message The worker message
   * @param agentId The agent ID
   */
  private handleWorkerMessage(message: WorkerMessageTypes, agentId: string): void {
    logger.debug(`WorkerManager received message from worker: ${message.type}`, message.payload);

    switch (message.type) {
      case 'PDF_MAIN_DOCUMENT_STORED':
        this.handlePdfDocumentStored(message);
        break;
      case 'PROCESSING_ERROR':
        this.handleProcessingError(message);
        break;
      case 'WORKER_ERROR':
        // This might have already been handled by the readyPromise rejection
        this.cleanupWorker(agentId);
        break;
    }
  }

  /**
   * Handle PDF document stored messages
   * @param message The PDF document stored message
   */
  private handlePdfDocumentStored(message: WorkerMessageTypes): void {
    if (message.type !== 'PDF_MAIN_DOCUMENT_STORED') return;

    const { clientDocumentId, storedDocumentMemoryId, error } = message.payload;
    const callback = this.pendingPdfCallbacks.get(clientDocumentId as UUID);

    if (callback) {
      if (error) {
        callback(
          new Error(error.message || 'Worker reported an error storing PDF main document'),
          undefined
        );
      } else {
        callback(null, {
          clientDocumentId: clientDocumentId as UUID,
          storedDocumentMemoryId: storedDocumentMemoryId as UUID,
        });
      }
      this.pendingPdfCallbacks.delete(clientDocumentId as UUID);
    } else {
      logger.warn(
        `No callback found for PDF_MAIN_DOCUMENT_STORED clientDocId: ${clientDocumentId}`
      );
    }
  }

  /**
   * Handle processing error messages
   * @param message The processing error message
   */
  private handleProcessingError(message: WorkerMessageTypes): void {
    if (message.type !== 'PROCESSING_ERROR') return;

    const { documentId, error } = message.payload;
    const callback = this.pendingPdfCallbacks.get(documentId as UUID);

    if (callback) {
      callback(new Error(`Worker processing failed for ${documentId}: ${error}`), undefined);
      this.pendingPdfCallbacks.delete(documentId as UUID);
    }
  }

  /**
   * Make sure the worker is ready before submitting work
   * @param agentId The agent ID
   * @param operationName The operation name for logging
   * @returns The ready worker
   */
  async ensureWorkerIsReady(agentId: string, operationName: string): Promise<RagWorker> {
    const worker = this.workers.get(agentId);
    if (!worker) {
      throw new Error(`No worker found for agent ${agentId} for operation ${operationName}`);
    }

    const readyPromise = this.workerReadyPromises.get(agentId);

    if (!worker.isReady && readyPromise) {
      logger.debug(
        `Waiting for RAG worker for agent ${agentId} to be ready for operation: ${operationName}...`
      );
      try {
        await readyPromise;
      } catch (error) {
        logger.error(
          `Worker ${agentId} failed to become ready for ${operationName}:`,
          (error as Error).message
        );
        throw new Error(
          `Failed to ensure worker readiness for ${agentId} for ${operationName}: ${(error as Error).message}`
        );
      }
    } else if (!worker.isReady && !readyPromise) {
      logger.error(
        `Worker ${agentId} is not ready and no ready promise found for ${operationName}.`
      );
      throw new Error(
        `Critical: Worker ${agentId} not ready and no ready promise for ${operationName}.`
      );
    }

    logger.debug(`Worker ${agentId} is ready for ${operationName}.`);
    return worker;
  }

  /**
   * Register a callback for PDF document processing
   * @param documentId The document ID
   * @param callback The callback function
   */
  registerPdfCallback(documentId: UUID, callback: DocumentStoredCallback): void {
    this.pendingPdfCallbacks.set(documentId, callback);
  }

  /**
   * Remove a PDF callback
   * @param documentId The document ID
   */
  removePdfCallback(documentId: UUID): void {
    this.pendingPdfCallbacks.delete(documentId);
  }

  /**
   * Terminate all workers
   */
  async terminateAllWorkers(): Promise<void> {
    for (const [agentId, worker] of this.workers) {
      try {
        await worker.terminate();
        logger.info(`Terminated RAG worker for agent: ${agentId}`);
      } catch (err) {
        logger.error(`Error terminating RAG worker for agent ${agentId}:`, err);
      }
    }
    this.workers.clear();
    this.workerReadyPromises.clear();
    this.pendingPdfCallbacks.clear();
  }
}
