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
      const workerPath = path.resolve(__dirname, 'rag.worker.js'); // Assuming .js after tsup build from .ts

      const dbConfig = this.getDbConfigForWorker();
      logger.info(`Resolved DB config for worker ${agentId}:`, dbConfig);

      const worker = new Worker(workerPath, {
        workerData: {
          agentId,
          dbConfig, // This needs to be the config object createDatabaseAdapter expects
        },
      }) as RagWorker;

      worker.isReady = false;

      worker.on('message', async (message) => {
        logger.debug(
          `RagService (agent: ${agentId}) received message from worker: ${message.type}`
        );
        switch (message.type) {
          case 'WORKER_READY':
            worker.isReady = true;
            logger.info(`RAG Worker for agent ${message.payload.agentId} reported ready.`);
            // Process any queued tasks for this worker
            break;
          case 'KNOWLEDGE_ADDED':
            logger.info(
              `RagService: Worker confirmed knowledge added for doc ${message.payload.documentId}, count: ${message.payload.count} (agent: ${message.payload.agentId}).`
            );
            break;
          case 'PDF_MAIN_DOCUMENT_STORED': // New message type from worker
            logger.info(
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
              `RAG Worker for agent ${message.payload.agentId} reported an error for doc ${message.payload.documentId}:`,
              message.payload.error,
              message.payload.stack
            );
            break;
          case 'WORKER_STARTED': // Worker script loaded, but not necessarily fully ready (DB adapter init pending)
            logger.info(`RAG worker for agent ${message.payload.agentId} has started its script.`);
            break;
          default:
            logger.warn(
              `RagService (agent: ${agentId}) received unknown message type from worker: ${message.type}`
            );
        }
      });

      worker.on('error', (err) => {
        logger.error(`RAG Worker for agent ${agentId} encountered an error:`, err);
        this.workers.delete(agentId); // Remove from active workers on critical error
      });

      worker.on('exit', (code) => {
        logger.info(`RAG Worker for agent ${agentId} exited with code ${code}.`);
        this.workers.delete(agentId);
      });

      this.workers.set(agentId, worker);
      // Send initialization message to the worker
      worker.postMessage({ type: 'INIT_DB_ADAPTER' });
      logger.info(`Sent INIT_DB_ADAPTER to new RAG worker for agent ${agentId}`);
      return worker;
    }
    return this.workers.get(agentId)!;
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
    const agentId = this.runtime.agentId;
    logger.info(
      `RagService (agent: ${agentId}) addKnowledge for clientDocId: ${clientDocumentId}, filename: ${originalFilename}, type: ${contentType}`
    );

    if (contentType !== 'application/pdf') {
      // Handle non-PDFs directly in the main thread for the initial document storage
      try {
        const extractedText = fileBuffer.toString('utf-8');
        if (extractedText === null || extractedText.trim() === '') {
          const noTextError = new Error('No text content extracted from the non-PDF document.');
          logger.warn(
            noTextError.message + ` for agent ${agentId}, clientDocId ${clientDocumentId}`
          );
          if (onDocumentStored) {
            onDocumentStored(noTextError);
          }
          throw noTextError; // Or just return if preferred
        }

        const fileExt = originalFilename.split('.').pop()?.toLowerCase() || '';
        const title = originalFilename.replace(`.${fileExt}`, '');
        const dbDocumentId = createUniqueUuid(
          this.runtime,
          `doc-${originalFilename}-${Date.now()}`
        ) as UUID;

        const documentMemory: Memory = {
          id: dbDocumentId,
          agentId: agentId,
          roomId: agentId,
          worldId: worldId,
          entityId: agentId,
          content: { text: extractedText },
          metadata: {
            type: MemoryType.DOCUMENT,
            documentId: clientDocumentId, // Link to the client's ID
            originalFilename: originalFilename,
            contentType: contentType,
            title: title,
            fileExt: fileExt,
            fileSize: fileBuffer.length,
            source: 'rag-service-upload-non-pdf',
            timestamp: Date.now(),
          },
        };

        logger.info(
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

        // Offload to worker for fragment processing (even for non-PDFs if chunking is desired)
        const worker = this.getOrInitializeWorker(agentId as string);
        // Ensure worker is ready (simplified wait, consider more robust ready check)
        let attempts = 0;
        while (!worker.isReady && attempts < 20) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          attempts++;
        }
        if (worker.isReady) {
          const fileContentB64 = fileBuffer.toString('base64'); // Worker expects base64
          worker.postMessage({
            type: 'PROCESS_DOCUMENT', // Worker will chunk and store fragments
            payload: {
              documentId: clientDocumentId, // Client's document ID for linking fragments
              fileContentB64: fileContentB64,
              contentType: contentType,
              // Worker can re-derive text if needed for chunking, or we pass extractedText
            },
          });
          logger.info(
            `Non-PDF document ${clientDocumentId} (filename: ${originalFilename}) fragment processing offloaded to RAG worker for agent ${agentId}.`
          );
        } else {
          logger.error(
            `RAG worker for ${agentId} not ready for fragmenting non-PDF ${originalFilename}. Main doc stored.`
          );
        }
      } catch (error) {
        logger.error(
          `RagService (agent: ${agentId}): Error processing or storing full non-PDF document ${originalFilename} (clientDocId: ${clientDocumentId}):`,
          error
        );
        if (onDocumentStored) {
          onDocumentStored(error as Error);
        }
      }
    } else {
      // Handle PDFs: Offload PDF parsing, main document storage, and fragmenting to the worker
      logger.info(
        `PDF detected: ${originalFilename}. Offloading entire processing to worker for agent ${agentId}, clientDocId ${clientDocumentId}.`
      );
      if (onDocumentStored) {
        this.pendingPdfCallbacks.set(clientDocumentId, onDocumentStored);
      }

      const worker = this.getOrInitializeWorker(agentId as string);
      let attempts = 0;
      while (!worker.isReady && attempts < 20) {
        logger.debug(
          `Worker for ${agentId} (PDF task) not ready, waiting... (attempt ${attempts + 1})`
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        attempts++;
      }

      if (!worker.isReady) {
        const workerErrorMsg = `RAG worker for agent ${agentId} not ready for PDF ${originalFilename}. Processing cannot start.`;
        logger.error(workerErrorMsg);
        const callback = this.pendingPdfCallbacks.get(clientDocumentId);
        if (callback) {
          callback(new Error(workerErrorMsg));
          this.pendingPdfCallbacks.delete(clientDocumentId);
        }
        return;
      }

      const fileContentB64 = fileBuffer.toString('base64');
      worker.postMessage({
        type: 'PROCESS_PDF_THEN_FRAGMENTS', // New type for worker
        payload: {
          clientDocumentId: clientDocumentId,
          fileContentB64: fileContentB64,
          contentType: contentType,
          originalFilename: originalFilename,
          worldId: worldId,
        },
      });
      logger.info(
        `PDF document ${clientDocumentId} (filename: ${originalFilename}) entire processing offloaded to RAG worker for agent ${agentId}.`
      );
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
