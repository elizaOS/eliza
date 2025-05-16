import type { Plugin } from '@elizaos/core';
import { type IAgentRuntime, Service, logger, type UUID } from '@elizaos/core';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
    this.workers = new Map();
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
          case 'KNOWLEDGE_ADDED': // Message from worker after it *thinks* it saved (if worker did DB ops)
            logger.info(
              `RagService: Worker confirmed knowledge added for doc ${message.payload.documentId}, count: ${message.payload.count} (agent: ${message.payload.agentId}).`
            );
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
    agentId: string,
    documentId: string,
    fileContentB64: string,
    contentType: string
  ): Promise<void> {
    logger.info(
      `RagService received addKnowledge request for agent ${agentId}, doc: ${documentId}`
    );
    const worker = this.getOrInitializeWorker(agentId);

    // Wait for worker to be ready if it was just created
    // A more robust solution might involve a ready promise on the worker object
    let attempts = 0;
    while (!worker.isReady && attempts < 10) {
      // Max 5 seconds wait (10 * 500ms)
      logger.debug(`Worker for ${agentId} not ready, waiting... (attempt ${attempts + 1})`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
    }
    if (!worker.isReady) {
      logger.error(`Worker for ${agentId} did not become ready in time.`);
      throw new Error(`RAG worker for agent ${agentId} not ready.`);
    }

    worker.postMessage({
      type: 'PROCESS_DOCUMENT',
      payload: { documentId, fileContentB64, contentType },
    });
    logger.info(`Document ${documentId} processing offloaded to RAG worker for agent ${agentId}.`);
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
