import {
  Service,
  IAgentRuntime,
  logger,
  UUID,
  Memory,
  MemoryType,
  createUniqueUuid,
} from '@elizaos/core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { extractTextFromFileBuffer } from './utils';
import { WorkerManager } from './worker';
import { AddKnowledgeOptions, DocumentStoredCallback } from './types';

// Get __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * RAG Service - Provides retrieval augmented generation capabilities
 */
export class RagService extends Service {
  static serviceType = 'rag';
  capabilityDescription =
    'Provides Retrieval Augmented Generation capabilities, including knowledge upload and querying.';

  private workerManager: WorkerManager;

  /**
   * Create a new RAG service
   * @param runtime Agent runtime
   */
  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
    const workerPath = path.resolve(__dirname, 'rag-worker.js');
    this.workerManager = new WorkerManager(workerPath);
    logger.info(`RagService initialized for agent: ${runtime.agentId}`);
  }

  /**
   * Start the RAG service
   * @param runtime Agent runtime
   * @returns Initialized RAG service
   */
  static async start(runtime: IAgentRuntime): Promise<RagService> {
    logger.info(`Starting RAG service for agent: ${runtime.agentId}`);
    const service = new RagService(runtime);
    return service;
  }

  /**
   * Stop the RAG service
   * @param runtime Agent runtime
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info(`Stopping RAG service for agent: ${runtime.agentId}`);
    const service = runtime.getService(RagService.serviceType) as RagService | undefined;
    if (!service) {
      logger.warn(`RagService not found for agent ${runtime.agentId} during stop.`);
      return;
    }
    await service.stop();
  }

  /**
   * Stop the service and clean up resources
   */
  async stop(): Promise<void> {
    logger.info(
      `RagService instance stopping for agent: ${this.runtime.agentId}. Terminating workers...`
    );
    await this.workerManager.terminateAllWorkers();
    logger.info(`All RAG workers for agent ${this.runtime.agentId} stopped and cleared.`);
  }

  /**
   * Get the database configuration for the worker
   * @returns Database configuration
   */
  private getDbConfigForWorker() {
    // Construct config from runtime settings
    const dataDirSetting = this.runtime.getSetting('PGLITE_DATA_DIR');
    const postgresUrlSetting = this.runtime.getSetting('POSTGRES_URL');

    return this.workerManager.getDbConfigForWorker(
      this.runtime.agentId as UUID,
      dataDirSetting,
      postgresUrlSetting
    );
  }

  /**
   * Initialize a RAG worker for an agent
   * @param agentId Agent ID
   * @returns Initialized worker
   */
  private initializeWorker(agentId: string) {
    const dbConfig = this.getDbConfigForWorker();

    return this.workerManager.initializeWorker(agentId, dbConfig, (message) => {
      // Handle worker messages - already processed in WorkerManager
      logger.debug(`RagService (agent: ${agentId}) received message from worker: ${message.type}`);
    });
  }

  /**
   * Add knowledge to the system
   * @param options Knowledge options
   */
  async addKnowledge({
    clientDocumentId,
    fileBuffer,
    contentType,
    originalFilename,
    worldId,
    onDocumentStored,
  }: AddKnowledgeOptions): Promise<void> {
    const agentId = this.runtime.agentId as string;
    logger.info(
      `RagService (agent: ${agentId}) addKnowledge for clientDocId: ${clientDocumentId}, filename: ${originalFilename}, type: ${contentType}`
    );

    // Check if this is a PDF or other document type
    if (contentType.toLowerCase() !== 'application/pdf') {
      await this.processNonPdfDocument({
        clientDocumentId,
        fileBuffer,
        contentType,
        originalFilename,
        worldId,
        onDocumentStored,
      });
    } else {
      await this.processPdfDocument({
        clientDocumentId,
        fileBuffer,
        contentType,
        originalFilename,
        worldId,
        onDocumentStored,
      });
    }
  }

  /**
   * Process a non-PDF document
   * @param options Document options
   */
  private async processNonPdfDocument({
    clientDocumentId,
    fileBuffer,
    contentType,
    originalFilename,
    worldId,
    onDocumentStored,
  }: AddKnowledgeOptions): Promise<void> {
    const agentId = this.runtime.agentId as string;

    try {
      logger.debug(
        `Processing non-PDF ${originalFilename} (type: ${contentType}) in main thread for initial storage.`
      );

      // Extract text from document
      const extractedText = await extractTextFromFileBuffer(
        fileBuffer,
        contentType,
        originalFilename
      );

      if (!extractedText || extractedText.trim() === '') {
        const noTextError = new Error(
          `No text content extracted from ${originalFilename} (type: ${contentType}).`
        );
        logger.warn(noTextError.message + ` for agent ${agentId}, clientDocId ${clientDocumentId}`);
        if (onDocumentStored) {
          onDocumentStored(noTextError);
        }
        return;
      }

      // Save main document
      const dbDocumentId = await this.saveMainDocument({
        text: extractedText,
        clientDocumentId,
        originalFilename,
        contentType,
        worldId,
        fileSize: fileBuffer.length,
      });

      // Notify document stored
      if (onDocumentStored) {
        onDocumentStored(null, {
          clientDocumentId,
          storedDocumentMemoryId: dbDocumentId,
        });
      }

      // Process fragments in worker
      await this.processFragmentsInWorker({
        documentId: clientDocumentId,
        fileBuffer,
        contentType,
        originalFilename,
      });
    } catch (error: any) {
      logger.error(
        `RagService (agent: ${agentId}): Error processing non-PDF document ${originalFilename} (clientDocId: ${clientDocumentId}): ${error.message}`,
        error.stack
      );
      if (onDocumentStored) {
        onDocumentStored(error as Error);
      }
    }
  }

  /**
   * Process a PDF document entirely in the worker thread
   * @param options Document options
   */
  private async processPdfDocument({
    clientDocumentId,
    fileBuffer,
    contentType,
    originalFilename,
    worldId,
    onDocumentStored,
  }: AddKnowledgeOptions): Promise<void> {
    const agentId = this.runtime.agentId as string;

    logger.debug(
      `PDF detected: ${originalFilename}. Offloading entire processing to worker for agent ${agentId}, clientDocId ${clientDocumentId}.`
    );

    if (onDocumentStored) {
      // Register callback before attempting to start worker
      this.workerManager.registerPdfCallback(clientDocumentId, onDocumentStored);
    }

    try {
      // Initialize worker and ensure it's ready
      const worker = this.initializeWorker(agentId);
      await this.workerManager.ensureWorkerIsReady(agentId, `processing PDF ${originalFilename}`);

      // Send PDF processing task to worker
      const fileContentB64 = fileBuffer.toString('base64');
      worker.postMessage({
        type: 'PROCESS_PDF_THEN_FRAGMENTS',
        payload: {
          clientDocumentId,
          fileContentB64,
          contentType,
          originalFilename,
          worldId,
        },
      });

      logger.info(
        `PDF document ${clientDocumentId} (filename: ${originalFilename}) task offloaded to RAG worker for agent ${agentId}.`
      );
    } catch (workerError: any) {
      logger.error(
        `Failed to offload PDF ${originalFilename} to worker due to worker readiness issue: ${workerError.message}`,
        workerError.stack
      );

      // If worker failed, clean up callback and notify error
      if (onDocumentStored) {
        onDocumentStored(
          new Error(`Worker not available for PDF ${originalFilename}: ${workerError.message}`)
        );
        this.workerManager.removePdfCallback(clientDocumentId);
      }
    }
  }

  /**
   * Process document fragments in the worker thread
   * @param options Document options
   */
  private async processFragmentsInWorker({
    documentId,
    fileBuffer,
    contentType,
    originalFilename,
  }: {
    documentId: UUID;
    fileBuffer: Buffer;
    contentType: string;
    originalFilename: string;
  }): Promise<void> {
    const agentId = this.runtime.agentId as string;

    try {
      // Initialize worker and ensure it's ready
      const worker = this.initializeWorker(agentId);
      await this.workerManager.ensureWorkerIsReady(agentId, `fragmenting ${originalFilename}`);

      // Send fragment processing task to worker
      const fileContentB64 = fileBuffer.toString('base64');
      worker.postMessage({
        type: 'PROCESS_DOCUMENT',
        payload: {
          documentId,
          fileContentB64,
          contentType,
          originalFilename,
        },
      });

      logger.info(
        `Non-PDF document ${documentId} (filename: ${originalFilename}) fragment processing offloaded to RAG worker for agent ${agentId}.`
      );
    } catch (workerError: any) {
      logger.error(
        `Failed to offload ${originalFilename} to worker for fragmenting: ${workerError.message}`,
        workerError.stack
      );
      // Main document is already stored, so just log the error
    }
  }

  /**
   * Save a main document to the database
   * @param options Document options
   * @returns Document ID
   */
  private async saveMainDocument({
    text,
    clientDocumentId,
    originalFilename,
    contentType,
    worldId,
    fileSize,
  }: {
    text: string;
    clientDocumentId: UUID;
    originalFilename: string;
    contentType: string;
    worldId: UUID;
    fileSize: number;
  }): Promise<UUID> {
    const agentId = this.runtime.agentId as UUID;
    const fileExt = originalFilename.split('.').pop()?.toLowerCase() || '';
    const title = originalFilename.replace(`.${fileExt}`, '');

    // Create unique ID for the document
    const dbDocumentId = createUniqueUuid(
      this.runtime,
      `doc-main-${originalFilename}-${Date.now()}`
    ) as UUID;

    // Create memory object
    const documentMemory: Memory = {
      id: dbDocumentId,
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

    // Store document in database
    logger.debug(
      `Storing full document ${originalFilename} (Memory ID: ${dbDocumentId}, clientDocId: ${clientDocumentId}) to 'documents' table for agent ${agentId}.`
    );
    await this.runtime.createMemory(documentMemory, 'documents');
    logger.info(
      `Full document ${originalFilename} (Memory ID: ${dbDocumentId}) stored successfully for agent ${agentId}.`
    );

    return dbDocumentId;
  }
}
