import type { Plugin } from '@elizaos/core';
import {
  type IAgentRuntime,
  Service,
  logger,
  type UUID,
  Memory,
  MemoryType,
  createUniqueUuid,
} from '@elizaos/core';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { extractTextFromFileBuffer } from './utils'; // Import the utility function

// Get __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RagWorker extends Worker {
  // We can add custom properties if needed, e.g., a ready promise
  isReady?: boolean;
}

// Define the expected structure for DB config passed to the worker, matching createDatabaseAdapter
interface WorkerDbConfig {
  dataDir?: string;
  postgresUrl?: string;
}

export class RagService extends Service {
  static serviceType = 'rag';
  capabilityDescription =
    'Provides Retrieval Augmented Generation capabilities, including knowledge upload and querying.';

  private workers: Map<string, RagWorker>; // Keyed by agentId
  private pendingPdfCallbacks: Map<
    UUID,
    (error: Error | null, result?: { clientDocumentId: UUID; storedDocumentMemoryId: UUID }) => void
  >;
  private workerReadyPromises: Map<string, Promise<void>> = new Map(); // For awaiting worker readiness

  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
    this.workers = new Map();
    this.pendingPdfCallbacks = new Map();
    logger.info(`RagService initialized for agent: ${runtime.agentId}`);
  }

  static async start(runtime: IAgentRuntime): Promise<RagService> {
    logger.info(`Starting RAG service for agent: ${runtime.agentId}`);
    const service = new RagService(runtime);
    // Worker will be initialized on first use or can be pre-warmed here if needed
    // service.getOrInitializeWorker(runtime.agentId);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info(`Stopping RAG service for agent: ${runtime.agentId}`);
    const service = runtime.getService(RagService.serviceType) as RagService | undefined;
    if (!service) {
      logger.warn(`RagService not found for agent ${runtime.agentId} during stop.`);
      return;
    }
    await service.stop();
  }

  async stop(): Promise<void> {
    logger.info(
      `RagService instance stopping for agent: ${this.runtime.agentId}. Terminating workers...`
    );
    for (const [agentId, worker] of this.workers) {
      try {
        await worker.terminate();
        logger.info(`Terminated RAG worker for agent: ${agentId}`);
      } catch (err) {
        logger.error(`Error terminating RAG worker for agent ${agentId}:`, err);
      }
    }
    this.workers.clear();
    logger.info(`All RAG workers for agent ${this.runtime.agentId} stopped and cleared.`);
  }

  private getDbConfigForWorker(): WorkerDbConfig {
    // Construct config from runtime settings, mirroring how plugin-sql does it.
    const dataDirSetting = this.runtime.getSetting('PGLITE_DATA_DIR');
    const postgresUrlSetting = this.runtime.getSetting('POSTGRES_URL');

    const config: WorkerDbConfig = {};
    if (postgresUrlSetting) {
      config.postgresUrl = postgresUrlSetting;
    } else if (dataDirSetting) {
      config.dataDir = dataDirSetting;
    } else {
      // Default logic if no specific settings found, consistent with plugin-sql's fallback for PGlite
      // This might need to import stringToUuid from core if not available globally.
      // For simplicity, assuming a generic default or that settings will be present.
      const baseDataDir = path.join(process.cwd(), '.eliza-data', 'pglite'); // General base
      config.dataDir = path.join(baseDataDir, this.runtime.agentId as string); // Cast UUID to string for path
      logger.warn(
        `DB config for RAG worker for agent ${this.runtime.agentId} falling back to default path: ${config.dataDir}. ` +
          `Ensure PGLITE_DATA_DIR or POSTGRES_URL settings are available in runtime for explicit configuration.`
      );
    }
    return config;
  }

  getOrInitializeWorker(agentId: string): RagWorker {
    if (!this.workers.has(agentId)) {
      logger.info(`Initializing new RAG worker for agentId: ${agentId}`);
      const workerPath = path.resolve(__dirname, 'rag.worker.js');

      const dbConfig = this.getDbConfigForWorker();
      logger.debug(`Resolved DB config for worker ${agentId}:`, dbConfig);

      const worker = new Worker(workerPath, {
        workerData: {
          agentId,
          dbConfig,
        },
      }) as RagWorker;

      // Setup a promise that resolves when the worker is ready
      const readyPromise = new Promise<void>((resolve, reject) => {
        worker.once('message', (message) => {
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
          reject(err); // Reject ready promise on critical error
          this.workers.delete(agentId);
          this.workerReadyPromises.delete(agentId);
        });
        worker.once('exit', (code) => {
          const exitMsg = `RAG Worker for agent ${agentId} exited with code ${code} during init.`;
          logger.warn(exitMsg);
          if (!worker.isReady) reject(new Error(exitMsg)); // Reject if exited before ready
          this.workers.delete(agentId);
          this.workerReadyPromises.delete(agentId);
        });
      });
      this.workerReadyPromises.set(agentId, readyPromise);

      worker.on('message', async (message) => {
        logger.debug(
          `RagService (agent: ${agentId}) received message from worker: ${message.type}`,
          message.payload
        );
        switch (message.type) {
          case 'WORKER_READY':
            // Handled by the readyPromise setup above for initial readiness
            break;
          case 'KNOWLEDGE_ADDED':
            logger.info(
              `RagService: Worker confirmed knowledge added for doc ${message.payload.documentId}, count: ${message.payload.count} (agent: ${message.payload.agentId}).`
            );
            break;
          case 'PDF_MAIN_DOCUMENT_STORED':
            logger.debug(
              `RagService: Worker confirmed PDF main document stored for clientDocId ${message.payload.clientDocumentId}, dbDocId: ${message.payload.storedDocumentMemoryId} (agent: ${message.payload.agentId}).`
            );
            const callback = this.pendingPdfCallbacks.get(message.payload.clientDocumentId as UUID);
            if (callback) {
              if (message.payload.error) {
                callback(
                  new Error(
                    message.payload.error.message ||
                      'Worker reported an error storing PDF main document'
                  ),
                  undefined
                );
              } else {
                callback(null, {
                  clientDocumentId: message.payload.clientDocumentId as UUID,
                  storedDocumentMemoryId: message.payload.storedDocumentMemoryId as UUID,
                });
              }
              this.pendingPdfCallbacks.delete(message.payload.clientDocumentId as UUID);
            } else {
              logger.warn(
                `No callback found for PDF_MAIN_DOCUMENT_STORED clientDocId: ${message.payload.clientDocumentId}`
              );
            }
            break;
          case 'PROCESSING_ERROR':
            logger.error(
              `RAG Worker for agent ${message.payload.agentId} reported a processing error for doc ${message.payload.documentId}:`,
              message.payload.error,
              message.payload.stack
            );
            // Potentially notify onDocumentStored callback if it's a non-PDF that failed in worker during fragmenting
            // This part might need more sophisticated error mapping if addKnowledge directly awaits fragmenting.
            // For now, PDF errors are handled via pendingPdfCallbacks.
            // If it was a non-PDF, the main doc might have succeeded but fragments failed.
            // The onDocumentStored for non-PDFs is currently called *before* offloading to worker.
            // If that callback needs to know about fragmenting errors, the flow needs adjustment.
            const processingErrorCallback = this.pendingPdfCallbacks.get(
              message.payload.documentId as UUID
            );
            if (processingErrorCallback) {
              // This case implies a PDF processing error that happened after PDF_MAIN_DOCUMENT_STORED or if that failed.
              // Or, if we started using pendingPdfCallbacks for non-PDF fragment errors.
              processingErrorCallback(
                new Error(
                  `Worker processing failed for ${message.payload.documentId}: ${message.payload.error.message || message.payload.error}`
                ),
                undefined
              );
              this.pendingPdfCallbacks.delete(message.payload.documentId as UUID);
            }
            break;
          case 'WORKER_ERROR': // General worker error not tied to a specific document, usually init.
            logger.error(
              `RAG Worker for agent ${message.payload.agentId} reported a worker-level error:`,
              message.payload.error,
              message.payload.stack
            );
            // This might have already been handled by the readyPromise rejection if it was an init error.
            // If it occurs post-initialization, we might need to re-initialize or mark as unhealthy.
            this.workers.delete(agentId);
            this.workerReadyPromises.delete(agentId);
            break;
          // WORKER_STARTED is not used in the service logic, it's mostly for worker's internal logging.
          default:
            logger.warn(
              `RagService (agent: ${agentId}) received unknown message type from worker: ${message.type}`
            );
        }
      });

      // Error and Exit handlers primarily for post-initialization issues.
      // Initial errors/exits are caught by the readyPromise setup.
      worker.on('error', (err) => {
        if (worker.isReady) {
          // Only log if it wasn't an init error handled by readyPromise
          logger.error(
            `RAG Worker for agent ${agentId} encountered an error post-initialization:`,
            err
          );
        }
        this.workers.delete(agentId);
        this.workerReadyPromises.delete(agentId);
      });

      worker.on('exit', (code) => {
        if (worker.isReady) {
          // Only log if it wasn't an init exit handled by readyPromise
          logger.info(
            `RAG Worker for agent ${agentId} exited with code ${code} post-initialization.`
          );
        }
        this.workers.delete(agentId);
        this.workerReadyPromises.delete(agentId);
      });

      this.workers.set(agentId, worker);
      logger.debug(`Sending INIT_DB_ADAPTER to new RAG worker for agent ${agentId}`);
      worker.postMessage({ type: 'INIT_DB_ADAPTER' });
      return worker;
    }
    return this.workers.get(agentId)!;
  }

  private async ensureWorkerIsReady(agentId: string, operationName: string): Promise<RagWorker> {
    const worker = this.getOrInitializeWorker(agentId);
    const readyPromise = this.workerReadyPromises.get(agentId);

    if (!worker.isReady && readyPromise) {
      logger.debug(
        `Waiting for RAG worker for agent ${agentId} to be ready for operation: ${operationName}...`
      );
      try {
        await readyPromise; // Wait for the worker to signal readiness or fail initialization
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
      // Should not happen if getOrInitializeWorker sets up promise correctly
      logger.error(
        `Worker ${agentId} is not ready and no ready promise found for ${operationName}. Re-initializing attempt.`
      );
      // Potentially attempt re-initialization or throw critical error.
      // For now, throw, as this indicates a logic flaw.
      throw new Error(
        `Critical: Worker ${agentId} not ready and no ready promise for ${operationName}.`
      );
    }
    logger.debug(`Worker ${agentId} is ready for ${operationName}.`);
    return worker;
  }

  async addKnowledge(
    clientDocumentId: UUID,
    fileBuffer: Buffer,
    contentType: string,
    originalFilename: string,
    worldId: UUID,
    onDocumentStored?: (
      error: Error | null,
      result?: { clientDocumentId: UUID; storedDocumentMemoryId: UUID }
    ) => void
  ): Promise<void> {
    const agentId = this.runtime.agentId as string;
    logger.info(
      `RagService (agent: ${agentId}) addKnowledge for clientDocId: ${clientDocumentId}, filename: ${originalFilename}, type: ${contentType}`
    );

    if (contentType.toLowerCase() !== 'application/pdf') {
      try {
        logger.debug(
          `Processing non-PDF ${originalFilename} (type: ${contentType}) in main thread for initial storage.`
        );
        // Use the utility function for text extraction
        const extractedText = await extractTextFromFileBuffer(
          fileBuffer,
          contentType,
          originalFilename
        );

        if (!extractedText || extractedText.trim() === '') {
          const noTextError = new Error(
            `No text content extracted from ${originalFilename} (type: ${contentType}).`
          );
          logger.warn(
            noTextError.message + ` for agent ${agentId}, clientDocId ${clientDocumentId}`
          );
          if (onDocumentStored) {
            onDocumentStored(noTextError);
          }
          // Optionally re-throw or simply return if allowing no-text docs
          return; // Or throw noTextError;
        }

        const fileExt = originalFilename.split('.').pop()?.toLowerCase() || '';
        const title = originalFilename.replace(`.${fileExt}`, '');
        // Create a unique ID for this main document memory in the DB
        const dbDocumentId = createUniqueUuid(
          this.runtime,
          `doc-main-${originalFilename}-${Date.now()}`
        ) as UUID;

        const documentMemory: Memory = {
          id: dbDocumentId,
          agentId: agentId as UUID,
          roomId: agentId as UUID, // Assuming agent's own space
          worldId: worldId,
          entityId: agentId as UUID, // Assuming agent is the entity
          content: { text: extractedText }, // Store the extracted text
          metadata: {
            type: MemoryType.DOCUMENT,
            documentId: clientDocumentId, // Link to the client's ID
            originalFilename: originalFilename,
            contentType: contentType,
            title: title,
            fileExt: fileExt,
            fileSize: fileBuffer.length,
            source: 'rag-service-main-upload-non-pdf', // Clarified source
            timestamp: Date.now(),
          },
        };

        logger.debug(
          `Storing full non-PDF document ${originalFilename} (Memory ID: ${dbDocumentId}, clientDocId: ${clientDocumentId}) to 'documents' table for agent ${agentId}.`
        );
        await this.runtime.createMemory(documentMemory, 'documents');
        logger.info(
          `Full non-PDF document ${originalFilename} (Memory ID: ${dbDocumentId}) stored successfully for agent ${agentId}.`
        );

        if (onDocumentStored) {
          onDocumentStored(null, {
            clientDocumentId: clientDocumentId,
            storedDocumentMemoryId: dbDocumentId,
          });
        }

        // Offload to worker for fragment processing
        try {
          const worker = await this.ensureWorkerIsReady(agentId, `fragmenting ${originalFilename}`);
          const fileContentB64 = fileBuffer.toString('base64');
          worker.postMessage({
            type: 'PROCESS_DOCUMENT',
            payload: {
              documentId: clientDocumentId, // Use client's ID for linking fragments
              fileContentB64: fileContentB64,
              contentType: contentType,
              originalFilename: originalFilename, // Pass filename for worker's context
            },
          });
          logger.info(
            `Non-PDF document ${clientDocumentId} (filename: ${originalFilename}) fragment processing offloaded to RAG worker for agent ${agentId}.`
          );
        } catch (workerError: any) {
          logger.error(
            `Failed to offload ${originalFilename} to worker for fragmenting due to worker readiness issue: ${workerError.message}`,
            workerError.stack
          );
          // The onDocumentStored has already been called for the main document.
          // If critical that fragments are processed, this error needs to bubble up or be handled differently.
          // For now, log it. The main document IS stored.
        }
      } catch (error: any) {
        logger.error(
          `RagService (agent: ${agentId}): Error processing or storing full non-PDF document ${originalFilename} (clientDocId: ${clientDocumentId}): ${error.message}`,
          error.stack
        );
        if (onDocumentStored) {
          onDocumentStored(error as Error);
        }
        // Optionally re-throw if this should halt further processing in the caller
        // throw error;
      }
    } else {
      // Handle PDFs: Offload PDF parsing, main document storage, and fragmenting to the worker
      logger.debug(
        `PDF detected: ${originalFilename}. Offloading entire processing to worker for agent ${agentId}, clientDocId ${clientDocumentId}.`
      );
      if (onDocumentStored) {
        // Register callback before attempting to get/start worker to avoid race conditions
        this.pendingPdfCallbacks.set(clientDocumentId, onDocumentStored);
      }

      try {
        const worker = await this.ensureWorkerIsReady(
          agentId,
          `processing PDF ${originalFilename}`
        );
        const fileContentB64 = fileBuffer.toString('base64');
        worker.postMessage({
          type: 'PROCESS_PDF_THEN_FRAGMENTS',
          payload: {
            clientDocumentId: clientDocumentId,
            fileContentB64: fileContentB64,
            contentType: contentType,
            originalFilename: originalFilename,
            worldId: worldId,
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
        const callback = this.pendingPdfCallbacks.get(clientDocumentId);
        if (callback) {
          callback(
            new Error(`Worker not available for PDF ${originalFilename}: ${workerError.message}`)
          );
          this.pendingPdfCallbacks.delete(clientDocumentId);
        }
      }
    }
  }
}

export const ragPlugin: Plugin = {
  name: 'plugin-rag',
  description:
    'Plugin for Retrieval Augmented Generation, including knowledge management and embedding.',
  config: {
    EXAMPLE_PLUGIN_VARIABLE: process.env.EXAMPLE_PLUGIN_VARIABLE,
    RAG_PLUGIN_SETTING: process.env.RAG_PLUGIN_SETTING,
  },
  async init(config: Record<string, string>, runtime?: IAgentRuntime) {
    logger.info('Initializing RAG Plugin...');
    try {
      if (runtime) {
        logger.info(
          `RAG Plugin global init for agent: ${runtime.agentId}. Per-agent RAG services will manage their own workers.`
        );
      }
      logger.info('RAG Plugin initialized.');
    } catch (error) {
      logger.error('Failed to initialize RAG plugin:', error);
      throw error;
    }
  },
  services: [RagService],
};

export default ragPlugin;
