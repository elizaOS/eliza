import {
  type Content,
  type CustomMetadata,
  createUniqueUuid,
  type FragmentMetadata,
  type IAgentRuntime,
  type KnowledgeItem,
  logger,
  type Memory,
  MemoryType,
  type Metadata,
  ModelType,
  Semaphore,
  Service,
  splitChunks,
  type UUID,
} from "@elizaos/core";
import { validateModelConfig } from "./config";
import { loadDocsFromPath } from "./docs-loader";
import {
  createDocumentMemory,
  extractTextFromDocument,
  processFragmentsSynchronously,
} from "./document-processor.ts";
import type { KnowledgeConfig, LoadResult } from "./types";
import type { AddKnowledgeOptions } from "./types.ts";
import { generateContentBasedId, isBinaryContentType, looksLikeBase64 } from "./utils.ts";

const parseBooleanEnv = (value: string | number | boolean | null | undefined): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  if (typeof value === "number") return value !== 0;
  return false;
};

export class KnowledgeService extends Service {
  static readonly serviceType = "knowledge";
  public override config: Metadata = {};
  capabilityDescription =
    "Provides Retrieval Augmented Generation capabilities, including knowledge upload and querying.";

  private knowledgeProcessingSemaphore: Semaphore;

  constructor(runtime: IAgentRuntime, _config?: Partial<KnowledgeConfig>) {
    super(runtime);
    this.knowledgeProcessingSemaphore = new Semaphore(10);
  }

  private async loadInitialDocuments(): Promise<void> {
    logger.info(
      `KnowledgeService: Checking for documents to load on startup for agent ${this.runtime.agentId}`
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const knowledgePathSetting = this.runtime.getSetting("KNOWLEDGE_PATH");
      const knowledgePath =
        typeof knowledgePathSetting === "string" ? knowledgePathSetting : undefined;

      const result: LoadResult = await loadDocsFromPath(
        this as KnowledgeService,
        this.runtime.agentId,
        undefined,
        knowledgePath
      );

      if (result.successful > 0) {
        logger.info(
          `KnowledgeService: Loaded ${result.successful} documents from docs folder on startup for agent ${this.runtime.agentId}`
        );
      } else {
        logger.info(
          `KnowledgeService: No new documents found to load on startup for agent ${this.runtime.agentId}`
        );
      }
    } catch (error) {
      logger.error(
        { error },
        `KnowledgeService: Error loading documents on startup for agent ${this.runtime.agentId}`
      );
    }
  }

  static async start(runtime: IAgentRuntime): Promise<KnowledgeService> {
    logger.info(`Starting Knowledge service for agent: ${runtime.agentId}`);

    logger.info("Initializing Knowledge Plugin...");
    logger.info("Validating model configuration for Knowledge plugin...");

    logger.debug(`[Knowledge Plugin] INIT DEBUG:`);
    logger.debug(
      `[Knowledge Plugin] - process.env.CTX_KNOWLEDGE_ENABLED: '${process.env.CTX_KNOWLEDGE_ENABLED}'`
    );

    const config = {
      CTX_KNOWLEDGE_ENABLED: parseBooleanEnv(runtime.getSetting("CTX_KNOWLEDGE_ENABLED")),
    };

    logger.debug(
      `[Knowledge Plugin] - config.CTX_KNOWLEDGE_ENABLED: '${config.CTX_KNOWLEDGE_ENABLED}'`
    );
    logger.debug(
      `[Knowledge Plugin] - runtime.getSetting('CTX_KNOWLEDGE_ENABLED'): '${runtime.getSetting("CTX_KNOWLEDGE_ENABLED")}'`
    );

    const validatedConfig = validateModelConfig(runtime);

    const ctxEnabledFromEnv = parseBooleanEnv(process.env.CTX_KNOWLEDGE_ENABLED);
    const ctxEnabledFromRuntime = parseBooleanEnv(runtime.getSetting("CTX_KNOWLEDGE_ENABLED"));
    const ctxEnabledFromValidated = validatedConfig.CTX_KNOWLEDGE_ENABLED;

    const finalCtxEnabled = ctxEnabledFromValidated;

    logger.debug(`[Knowledge Plugin] CTX_KNOWLEDGE_ENABLED sources:`);
    logger.debug(`[Knowledge Plugin] - From env: ${ctxEnabledFromEnv}`);
    logger.debug(`[Knowledge Plugin] - From runtime: ${ctxEnabledFromRuntime}`);
    logger.debug(`[Knowledge Plugin] - FINAL RESULT: ${finalCtxEnabled}`);

    if (finalCtxEnabled) {
      logger.info("Running in Contextual Knowledge mode with text generation capabilities.");
      logger.info(
        `Using ${validatedConfig.EMBEDDING_PROVIDER || "auto-detected"} for embeddings and ${validatedConfig.TEXT_PROVIDER} for text generation.`
      );
      logger.info(`Text model: ${validatedConfig.TEXT_MODEL}`);
    } else {
      const usingPluginOpenAI = !process.env.EMBEDDING_PROVIDER;

      logger.warn("Running in Basic Embedding mode - documents will NOT be enriched with context!");
      logger.info("To enable contextual enrichment:");
      logger.info("   - Set CTX_KNOWLEDGE_ENABLED=true");
      logger.info("   - Configure TEXT_PROVIDER (anthropic/openai/openrouter/google)");
      logger.info("   - Configure TEXT_MODEL and API key");

      if (usingPluginOpenAI) {
        logger.info("Using auto-detected configuration from plugin-openai for embeddings.");
      } else {
        logger.info(
          `Using ${validatedConfig.EMBEDDING_PROVIDER} for embeddings with ${validatedConfig.TEXT_EMBEDDING_MODEL}.`
        );
      }
    }

    logger.info("Model configuration validated successfully.");
    logger.info(`Knowledge Plugin initialized for agent: ${runtime.character.name}`);

    logger.info(
      "Knowledge Plugin initialized. Frontend panel should be discoverable via its public route."
    );

    const service = new KnowledgeService(runtime);
    service.config = validatedConfig;

    if (service.config.LOAD_DOCS_ON_STARTUP) {
      logger.info("LOAD_DOCS_ON_STARTUP is enabled. Loading documents from docs folder...");
      service.loadInitialDocuments().catch((error) => {
        logger.error({ error }, "Error during initial document loading in KnowledgeService");
      });
    } else {
      logger.info("LOAD_DOCS_ON_STARTUP is disabled. Skipping automatic document loading.");
    }

    if (service.runtime.character?.knowledge && service.runtime.character.knowledge.length > 0) {
      logger.info(
        `KnowledgeService: Processing ${service.runtime.character.knowledge.length} character knowledge items.`
      );
      const stringKnowledge = service.runtime.character.knowledge.filter(
        (item): item is string => typeof item === "string"
      );
      await service.processCharacterKnowledge(stringKnowledge).catch((err) => {
        logger.error(
          { error: err },
          "KnowledgeService: Error processing character knowledge during startup"
        );
      });
    } else {
      logger.info(
        `KnowledgeService: No character knowledge to process for agent ${runtime.agentId}.`
      );
    }
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info(`Stopping Knowledge service for agent: ${runtime.agentId}`);
    const service = runtime.getService(KnowledgeService.serviceType);
    if (!service) {
      logger.warn(`KnowledgeService not found for agent ${runtime.agentId} during stop.`);
    }
    if (service instanceof KnowledgeService) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    logger.info(`Knowledge service stopping for agent: ${this.runtime.character?.name}`);
  }

  async addKnowledge(options: AddKnowledgeOptions): Promise<{
    clientDocumentId: string;
    storedDocumentMemoryId: UUID;
    fragmentCount: number;
  }> {
    const agentId = options.agentId || (this.runtime.agentId as UUID);

    const contentBasedId = generateContentBasedId(options.content, agentId, {
      includeFilename: options.originalFilename,
      contentType: options.contentType,
      maxChars: 2000,
    }) as UUID;

    logger.info(`Processing "${options.originalFilename}" (${options.contentType})`);

    try {
      const existingDocument = await this.runtime.getMemoryById(contentBasedId);
      if (existingDocument && existingDocument.metadata?.type === MemoryType.DOCUMENT) {
        logger.info(`"${options.originalFilename}" already exists - skipping`);

        const fragments = await this.runtime.getMemories({
          tableName: "knowledge",
        });

        const relatedFragments = fragments.filter(
          (f) =>
            f.metadata?.type === MemoryType.FRAGMENT &&
            (f.metadata as FragmentMetadata).documentId === contentBasedId
        );

        return {
          clientDocumentId: contentBasedId,
          storedDocumentMemoryId: existingDocument.id as UUID,
          fragmentCount: relatedFragments.length,
        };
      }
    } catch (error) {
      logger.debug(
        `Document ${contentBasedId} not found or error checking existence, proceeding with processing: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return this.processDocument({
      ...options,
      clientDocumentId: contentBasedId,
    });
  }

  private async processDocument({
    agentId: passedAgentId,
    clientDocumentId,
    contentType,
    originalFilename,
    worldId,
    content,
    roomId,
    entityId,
    metadata,
  }: AddKnowledgeOptions): Promise<{
    clientDocumentId: string;
    storedDocumentMemoryId: UUID;
    fragmentCount: number;
  }> {
    const agentId = passedAgentId || (this.runtime.agentId as UUID);

    try {
      logger.debug(
        `KnowledgeService: Processing document ${originalFilename} (type: ${contentType}) via processDocument for agent: ${agentId}`
      );

      let fileBuffer: Buffer | null = null;
      let extractedText: string;
      let documentContentToStore: string;
      const isPdfFile =
        contentType === "application/pdf" || originalFilename.toLowerCase().endsWith(".pdf");

      if (isPdfFile) {
        try {
          fileBuffer = Buffer.from(content, "base64");
        } catch (e) {
          logger.error(
            { error: e },
            `KnowledgeService: Failed to convert base64 to buffer for ${originalFilename}`
          );
          throw new Error(`Invalid base64 content for PDF file ${originalFilename}`);
        }
        extractedText = await extractTextFromDocument(fileBuffer, contentType, originalFilename);
        documentContentToStore = content;
      } else if (isBinaryContentType(contentType, originalFilename)) {
        try {
          fileBuffer = Buffer.from(content, "base64");
        } catch (e) {
          logger.error(
            { error: e },
            `KnowledgeService: Failed to convert base64 to buffer for ${originalFilename}`
          );
          throw new Error(`Invalid base64 content for binary file ${originalFilename}`);
        }
        extractedText = await extractTextFromDocument(fileBuffer, contentType, originalFilename);
        documentContentToStore = extractedText;
      } else {
        if (looksLikeBase64(content)) {
          try {
            const decodedBuffer = Buffer.from(content, "base64");
            const decodedText = decodedBuffer.toString("utf8");

            const invalidCharCount = (decodedText.match(/\ufffd/g) || []).length;
            const textLength = decodedText.length;

            if (invalidCharCount > 0 && invalidCharCount / textLength > 0.1) {
              throw new Error("Decoded content contains too many invalid characters");
            }

            logger.debug(`Successfully decoded base64 content for text file: ${originalFilename}`);
            extractedText = decodedText;
            documentContentToStore = decodedText;
          } catch (e) {
            logger.error(
              { error: e instanceof Error ? e : new Error(String(e)) },
              `Failed to decode base64 for ${originalFilename}`
            );
            throw new Error(
              `File ${originalFilename} appears to be corrupted or incorrectly encoded`
            );
          }
        } else {
          logger.debug(`Treating content as plain text for file: ${originalFilename}`);
          extractedText = content;
          documentContentToStore = content;
        }
      }

      if (!extractedText || extractedText.trim() === "") {
        const noTextError = new Error(
          `KnowledgeService: No text content extracted from ${originalFilename} (type: ${contentType}).`
        );
        logger.warn(noTextError.message);
        throw noTextError;
      }

      const documentMemory = createDocumentMemory({
        text: documentContentToStore,
        agentId,
        clientDocumentId,
        originalFilename,
        contentType,
        worldId,
        fileSize: fileBuffer ? fileBuffer.length : extractedText.length,
        documentId: clientDocumentId,
        customMetadata: metadata,
      });

      const memoryWithScope = {
        ...documentMemory,
        id: clientDocumentId,
        agentId: agentId,
        roomId: roomId || agentId,
        entityId: entityId || agentId,
      };

      logger.debug(
        `KnowledgeService: Creating memory with agentId=${agentId}, entityId=${entityId}, roomId=${roomId}, this.runtime.agentId=${this.runtime.agentId}`
      );
      logger.debug(
        `KnowledgeService: memoryWithScope agentId=${memoryWithScope.agentId}, entityId=${memoryWithScope.entityId}`
      );

      await this.runtime.createMemory(memoryWithScope, "documents");

      logger.debug(
        `KnowledgeService: Stored document ${originalFilename} (Memory ID: ${memoryWithScope.id})`
      );

      const fragmentCount = await processFragmentsSynchronously({
        runtime: this.runtime,
        documentId: clientDocumentId,
        fullDocumentText: extractedText,
        agentId,
        contentType,
        roomId: roomId || agentId,
        entityId: entityId || agentId,
        worldId: worldId || agentId,
        documentTitle: originalFilename,
      });

      logger.debug(`"${originalFilename}" stored with ${fragmentCount} fragments`);

      return {
        clientDocumentId,
        storedDocumentMemoryId: memoryWithScope.id as UUID,
        fragmentCount,
      };
    } catch (error) {
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(
        { error, stack: errorStack },
        `KnowledgeService: Error processing document ${originalFilename}`
      );
      throw error;
    }
  }

  private async handleProcessingError(error: unknown, context: string) {
    logger.error({ error }, `KnowledgeService: Error ${context}`);
    throw error;
  }

  async checkExistingKnowledge(knowledgeId: UUID): Promise<boolean> {
    const existingDocument = await this.runtime.getMemoryById(knowledgeId);
    return !!existingDocument;
  }

  async getKnowledge(
    message: Memory,
    scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID }
  ): Promise<KnowledgeItem[]> {
    logger.debug(`KnowledgeService: getKnowledge called for message id: ${message.id}`);
    if (!message?.content?.text || message?.content?.text.trim().length === 0) {
      logger.warn("KnowledgeService: Invalid or empty message content for knowledge query.");
      return [];
    }

    const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: message.content.text,
    });

    const filterScope: { roomId?: UUID; worldId?: UUID; entityId?: UUID } = {};
    if (scope?.roomId) filterScope.roomId = scope.roomId;
    if (scope?.worldId) filterScope.worldId = scope.worldId;
    if (scope?.entityId) filterScope.entityId = scope.entityId;

    const fragments = await this.runtime.searchMemories({
      tableName: "knowledge",
      embedding,
      query: message.content.text,
      ...filterScope,
      count: 20,
      match_threshold: 0.1,
    });

    return fragments
      .filter((fragment) => fragment.id !== undefined)
      .map((fragment) => ({
        id: fragment.id as UUID,
        content: fragment.content as Content,
        similarity: fragment.similarity,
        metadata: fragment.metadata,
        worldId: fragment.worldId,
      }));
  }

  async enrichConversationMemoryWithRAG(
    memoryId: UUID,
    ragMetadata: {
      retrievedFragments: Array<{
        fragmentId: UUID;
        documentTitle: string;
        similarityScore?: number;
        contentPreview: string;
      }>;
      queryText: string;
      totalFragments: number;
      retrievalTimestamp: number;
    }
  ): Promise<void> {
    try {
      const existingMemory = await this.runtime.getMemoryById(memoryId);
      if (!existingMemory) {
        logger.warn(`Cannot enrich memory ${memoryId} - memory not found`);
        return;
      }

      const ragUsageData = {
        retrievedFragments: ragMetadata.retrievedFragments,
        queryText: ragMetadata.queryText,
        totalFragments: ragMetadata.totalFragments,
        retrievalTimestamp: ragMetadata.retrievalTimestamp,
        usedInResponse: true,
      };
      const updatedMetadata: CustomMetadata = {
        ...(existingMemory.metadata as CustomMetadata),
        knowledgeUsed: true,
        ragUsage: JSON.stringify(ragUsageData),
        timestamp: existingMemory.metadata?.timestamp ?? Date.now(),
        type: MemoryType.CUSTOM,
      };

      await this.runtime.updateMemory({
        id: memoryId,
        metadata: updatedMetadata,
      });

      logger.debug(
        `Enriched conversation memory ${memoryId} with RAG data: ${ragMetadata.totalFragments} fragments`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Failed to enrich conversation memory ${memoryId} with RAG data: ${errorMessage}`
      );
    }
  }

  private pendingRAGEnrichment: Array<{
    ragMetadata: {
      retrievedFragments: Array<{
        fragmentId: UUID;
        documentTitle: string;
        similarityScore?: number;
        contentPreview: string;
      }>;
      queryText: string;
      totalFragments: number;
      retrievalTimestamp: number;
    };
    timestamp: number;
  }> = [];

  setPendingRAGMetadata(ragMetadata: {
    retrievedFragments: Array<{
      fragmentId: UUID;
      documentTitle: string;
      similarityScore?: number;
      contentPreview: string;
    }>;
    queryText: string;
    totalFragments: number;
    retrievalTimestamp: number;
  }): void {
    const now = Date.now();
    this.pendingRAGEnrichment = this.pendingRAGEnrichment.filter(
      (entry) => now - entry.timestamp < 30000
    );

    this.pendingRAGEnrichment.push({
      ragMetadata,
      timestamp: now,
    });

    logger.debug(`Stored pending RAG metadata for next conversation memory`);
  }

  async enrichRecentMemoriesWithPendingRAG(): Promise<void> {
    if (this.pendingRAGEnrichment.length === 0) {
      return;
    }

    try {
      const recentMemories = await this.runtime.getMemories({
        tableName: "messages",
        count: 10,
      });

      const now = Date.now();
      const recentConversationMemories = recentMemories
        .filter(
          (memory) =>
            memory.metadata?.type === "message" &&
            now - (memory.createdAt || 0) < 10000 &&
            !(memory.metadata && "ragUsage" in memory.metadata && memory.metadata.ragUsage)
        )
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      for (const pendingEntry of this.pendingRAGEnrichment) {
        const matchingMemory = recentConversationMemories.find(
          (memory) => (memory.createdAt || 0) > pendingEntry.timestamp
        );

        if (matchingMemory?.id) {
          await this.enrichConversationMemoryWithRAG(matchingMemory.id, pendingEntry.ragMetadata);

          const index = this.pendingRAGEnrichment.indexOf(pendingEntry);
          if (index > -1) {
            this.pendingRAGEnrichment.splice(index, 1);
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`Error enriching recent memories with RAG data: ${errorMessage}`);
    }
  }

  async processCharacterKnowledge(items: string[]): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    logger.info(
      `KnowledgeService: Processing ${items.length} character knowledge items for agent ${this.runtime.agentId}`
    );

    const processingPromises = items.map(async (item) => {
      await this.knowledgeProcessingSemaphore.acquire();
      try {
        const knowledgeId = generateContentBasedId(item, this.runtime.agentId, {
          maxChars: 2000,
          includeFilename: "character-knowledge",
        }) as UUID;

        if (await this.checkExistingKnowledge(knowledgeId)) {
          logger.debug(
            `KnowledgeService: Character knowledge item with ID ${knowledgeId} already exists. Skipping.`
          );
          return;
        }

        logger.debug(
          `KnowledgeService: Processing character knowledge for ${this.runtime.character?.name} - ${item.slice(0, 100)}`
        );

        let metadata: CustomMetadata = {
          type: MemoryType.CUSTOM,
          timestamp: Date.now(),
          source: "character",
        };

        const pathMatch = item.match(/^Path: (.+?)(?:\n|\r\n)/);
        if (pathMatch) {
          const filePath = pathMatch[1].trim();
          const extension = filePath.split(".").pop() || "";
          const filename = filePath.split("/").pop() || "";
          const title = filename.replace(`.${extension}`, "");
          metadata = {
            ...metadata,
            path: filePath,
            filename: filename,
            fileExt: extension,
            title: title,
            fileType: `text/${extension || "plain"}`,
            fileSize: item.length,
          };
        }

        await this._internalAddKnowledge(
          {
            id: knowledgeId,
            content: {
              text: item,
            },
            metadata,
          },
          undefined,
          {
            roomId: this.runtime.agentId,
            entityId: this.runtime.agentId,
            worldId: this.runtime.agentId,
          }
        );
      } catch (error) {
        await this.handleProcessingError(error, "processing character knowledge");
      } finally {
        this.knowledgeProcessingSemaphore.release();
      }
    });

    await Promise.all(processingPromises);
    logger.info(
      `KnowledgeService: Finished processing character knowledge for agent ${this.runtime.agentId}.`
    );
  }

  async _internalAddKnowledge(
    item: KnowledgeItem,
    options = {
      targetTokens: 1500,
      overlap: 200,
      modelContextSize: 4096,
    },
    scope = {
      roomId: this.runtime.agentId,
      entityId: this.runtime.agentId,
      worldId: this.runtime.agentId,
    }
  ): Promise<void> {
    const finalScope = {
      roomId: scope?.roomId ?? this.runtime.agentId,
      worldId: scope?.worldId ?? this.runtime.agentId,
      entityId: scope?.entityId ?? this.runtime.agentId,
    };

    logger.debug(`KnowledgeService: _internalAddKnowledge called for item ID ${item.id}`);

    const documentMetadata: CustomMetadata = {
      ...(item.metadata ?? {}),
      type: MemoryType.CUSTOM,
      documentId: item.id,
      timestamp: item.metadata?.timestamp ?? Date.now(),
    };

    const documentMemory: Memory = {
      id: item.id,
      agentId: this.runtime.agentId,
      roomId: finalScope.roomId,
      worldId: finalScope.worldId,
      entityId: finalScope.entityId,
      content: item.content,
      metadata: documentMetadata,
      createdAt: Date.now(),
    };

    const existingDocument = await this.runtime.getMemoryById(item.id);
    if (existingDocument) {
      logger.debug(
        `KnowledgeService: Document ${item.id} already exists in _internalAddKnowledge, updating...`
      );
      await this.runtime.updateMemory({
        ...documentMemory,
        id: item.id,
      });
    } else {
      await this.runtime.createMemory(documentMemory, "documents");
    }

    const fragments = await this.splitAndCreateFragments(
      item,
      options.targetTokens,
      options.overlap,
      finalScope
    );

    let fragmentsProcessed = 0;
    for (const fragment of fragments) {
      try {
        await this.processDocumentFragment(fragment);
        fragmentsProcessed++;
      } catch (error) {
        logger.error(
          { error },
          `KnowledgeService: Error processing fragment ${fragment.id} for document ${item.id}`
        );
      }
    }
    logger.debug(
      `KnowledgeService: Processed ${fragmentsProcessed}/${fragments.length} fragments for document ${item.id}.`
    );
  }

  private async processDocumentFragment(fragment: Memory): Promise<void> {
    try {
      await this.runtime.addEmbeddingToMemory(fragment);

      await this.runtime.createMemory(fragment, "knowledge");
    } catch (error) {
      logger.error({ error }, `KnowledgeService: Error processing fragment ${fragment.id}`);
      throw error;
    }
  }

  private async splitAndCreateFragments(
    document: KnowledgeItem,
    targetTokens: number,
    overlap: number,
    scope: { roomId: UUID; worldId: UUID; entityId: UUID }
  ): Promise<Memory[]> {
    if (!document.content.text) {
      return [];
    }

    const text = document.content.text;
    const chunks = await splitChunks(text, targetTokens, overlap);

    return chunks.map((chunk, index) => {
      const fragmentIdContent = `${document.id}-fragment-${index}-${Date.now()}`;
      const fragmentId = createUniqueUuid(this.runtime, fragmentIdContent);

      return {
        id: fragmentId,
        entityId: scope.entityId,
        agentId: this.runtime.agentId,
        roomId: scope.roomId,
        worldId: scope.worldId,
        content: {
          text: chunk,
        },
        metadata: {
          ...(document.metadata || {}),
          type: MemoryType.FRAGMENT,
          documentId: document.id,
          position: index,
          timestamp: Date.now(),
        },
        createdAt: Date.now(),
      };
    });
  }

  async getMemories(params: {
    tableName: string;
    roomId?: UUID;
    count?: number;
    offset?: number;
    end?: number;
  }): Promise<Memory[]> {
    return this.runtime.getMemories({
      ...params,
      agentId: this.runtime.agentId,
    });
  }

  async countMemories(params: {
    tableName: string;
    roomId?: UUID;
    unique?: boolean;
  }): Promise<number> {
    const roomId = params.roomId || this.runtime.agentId;
    const unique = params.unique ?? false;
    const tableName = params.tableName;

    return this.runtime.countMemories(roomId, unique, tableName);
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    await this.runtime.deleteMemory(memoryId);
    logger.info(
      `KnowledgeService: Deleted memory ${memoryId} for agent ${this.runtime.agentId}. Assumed it was a document or related fragment.`
    );
  }
}
