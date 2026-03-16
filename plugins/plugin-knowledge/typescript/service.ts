import {
  type Content,
  type CustomMetadata,
  createUniqueUuid,
  type FragmentMetadata,
  type IAgentRuntime,
  logger,
  type Memory,
  type MemoryMetadata,
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
import type { KnowledgeConfig, LoadResult, StoredKnowledgeItem } from "./types";
import type { AddKnowledgeOptions } from "./types.ts";
import { generateContentBasedId, isBinaryContentType, looksLikeBase64 } from "./utils.ts";

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
    logger.info(`Loading documents on startup for agent ${this.runtime.agentId}`);
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
        logger.info(`Loaded ${result.successful} documents on startup`);
      }
    } catch (error) {
      logger.error({ error }, "Error loading documents on startup");
    }
  }

  static async start(runtime: IAgentRuntime): Promise<KnowledgeService> {
    logger.info(`Starting Knowledge service for agent: ${runtime.agentId}`);

    const validatedConfig = validateModelConfig(runtime);
    const ctxEnabled = validatedConfig.CTX_KNOWLEDGE_ENABLED;

    if (ctxEnabled) {
      logger.info(
        `Contextual Knowledge enabled: ${validatedConfig.EMBEDDING_PROVIDER || "auto"} embeddings, ${validatedConfig.TEXT_PROVIDER} text generation`
      );
      logger.info(`Text model: ${validatedConfig.TEXT_MODEL}`);
    } else {
      const usingPluginOpenAI = !process.env.EMBEDDING_PROVIDER;
      logger.warn("Basic Embedding mode - documents will not be enriched with context");
      logger.info(
        "To enable contextual enrichment: Set CTX_KNOWLEDGE_ENABLED=true and configure TEXT_PROVIDER/TEXT_MODEL"
      );

      if (usingPluginOpenAI) {
        logger.info("Using plugin-openai configuration for embeddings");
      } else {
        logger.info(
          `Using ${validatedConfig.EMBEDDING_PROVIDER} for embeddings with ${validatedConfig.TEXT_EMBEDDING_MODEL}`
        );
      }
    }

    const service = new KnowledgeService(runtime);
    service.config = validatedConfig;

    if (service.config.LOAD_DOCS_ON_STARTUP) {
      service.loadInitialDocuments().catch((error) => {
        logger.error({ error }, "Error loading initial documents");
      });
    }

    if (service.runtime.character?.knowledge && service.runtime.character.knowledge.length > 0) {
      const stringKnowledge = service.runtime.character.knowledge
        .map((item) => {
          // Handle new KnowledgeSourceItem format with item.case/item.value
          const itemAny = item as { item?: { case?: string; value?: string }; path?: string };
          if (itemAny?.item?.case === "path" && typeof itemAny.item.value === "string") {
            return itemAny.item.value;
          }
          // Handle legacy format with direct path property
          if (typeof itemAny?.path === "string") {
            return itemAny.path;
          }
          // Handle string items directly
          if (typeof item === "string") {
            return item;
          }
          return null;
        })
        .filter((item): item is string => item !== null);
      await service.processCharacterKnowledge(stringKnowledge).catch((err) => {
        logger.error({ error: err }, "Error processing character knowledge");
      });
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
        `Processing document ${originalFilename} (type: ${contentType}) for agent: ${agentId}`
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
          logger.error({ error: e }, `Failed to convert base64 to buffer for ${originalFilename}`);
          throw new Error(`Invalid base64 content for PDF file ${originalFilename}`);
        }
        extractedText = await extractTextFromDocument(fileBuffer, contentType, originalFilename);
        documentContentToStore = content;
      } else if (isBinaryContentType(contentType, originalFilename)) {
        try {
          fileBuffer = Buffer.from(content, "base64");
        } catch (e) {
          logger.error({ error: e }, `Failed to convert base64 to buffer for ${originalFilename}`);
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
        throw new Error(
          `No text content extracted from ${originalFilename} (type: ${contentType})`
        );
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

      await this.runtime.createMemory(memoryWithScope, "documents");

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
      logger.error({ error }, `Error processing document ${originalFilename}`);
      throw error;
    }
  }

  async checkExistingKnowledge(knowledgeId: UUID): Promise<boolean> {
    const existingDocument = await this.runtime.getMemoryById(knowledgeId);
    return !!existingDocument;
  }

  async getKnowledge(
    message: Memory,
    scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID }
  ): Promise<StoredKnowledgeItem[]> {
    if (!message?.content?.text || message?.content?.text.trim().length === 0) {
      logger.warn("Invalid or empty message content for knowledge query");
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
      })) as StoredKnowledgeItem[];
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
    logger.info(`Processing ${items.length} character knowledge items`);

    const processingPromises = items.map(async (item) => {
      await this.knowledgeProcessingSemaphore.acquire();
      try {
        const knowledgeId = generateContentBasedId(item, this.runtime.agentId, {
          maxChars: 2000,
          includeFilename: "character-knowledge",
        }) as UUID;

        if (await this.checkExistingKnowledge(knowledgeId)) {
          return;
        }

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
            } as Content,
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
        logger.error({ error }, "Error processing character knowledge");
      } finally {
        this.knowledgeProcessingSemaphore.release();
      }
    });

    await Promise.all(processingPromises);
  }

  async _internalAddKnowledge(
    item: StoredKnowledgeItem,
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

    const documentMetadata = {
      ...(item.metadata ?? {}),
      type: MemoryType.CUSTOM,
      documentId: item.id,
    };

    const documentMemory: Memory = {
      id: item.id,
      agentId: this.runtime.agentId,
      roomId: finalScope.roomId,
      worldId: finalScope.worldId,
      entityId: finalScope.entityId,
      content: item.content as unknown as Content,
      metadata: documentMetadata as unknown as MemoryMetadata,
      createdAt: Date.now(),
    };

    const existingDocument = await this.runtime.getMemoryById(item.id);
    if (existingDocument) {
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

    for (const fragment of fragments) {
      try {
        await this.processDocumentFragment(fragment);
      } catch (error) {
        logger.error(
          { error },
          `KnowledgeService: Error processing fragment ${fragment.id} for document ${item.id}`
        );
      }
    }
  }

  private async processDocumentFragment(fragment: Memory): Promise<void> {
    try {
      await this.runtime.addEmbeddingToMemory(fragment);

      await this.runtime.createMemory(fragment, "knowledge");
    } catch (error) {
      logger.error({ error }, `Error processing fragment ${fragment.id}`);
      throw error;
    }
  }

  private async splitAndCreateFragments(
    document: StoredKnowledgeItem,
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
  }
}
