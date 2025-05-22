import {
  Service,
  IAgentRuntime,
  logger,
  UUID,
  Memory,
  MemoryType,
  KnowledgeItem,
  ModelType,
  createUniqueUuid,
  splitChunks,
  Semaphore,
  MemoryMetadata,
  FragmentMetadata,
  Content,
} from '@elizaos/core';
import { AddKnowledgeOptions } from './types';
import {
  processFragmentsSynchronously,
  extractTextFromDocument,
  createDocumentMemory,
} from './document-processor';

/**
 * RAG Service - Provides retrieval augmented generation capabilities
 */
export class RagService extends Service {
  static serviceType = 'rag';
  capabilityDescription =
    'Provides Retrieval Augmented Generation capabilities, including knowledge upload and querying.';

  private knowledgeProcessingSemaphore: Semaphore;

  /**
   * Create a new RAG service
   * @param runtime Agent runtime
   */
  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
    this.knowledgeProcessingSemaphore = new Semaphore(10); // Initialize semaphore
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

    // Process character knowledge AFTER service is initialized
    if (service.runtime.character?.knowledge && service.runtime.character.knowledge.length > 0) {
      logger.info(
        `RagService: Processing ${service.runtime.character.knowledge.length} character knowledge items.`
      );
      const stringKnowledge = service.runtime.character.knowledge.filter(
        (item): item is string => typeof item === 'string'
      );
      // Run in background, don't await here to prevent blocking startup
      service.processCharacterKnowledge(stringKnowledge).catch((err) => {
        logger.error(
          `RagService: Error processing character knowledge during startup: ${err.message}`,
          err
        );
      });
    } else {
      logger.info(`RagService: No character knowledge to process for agent ${runtime.agentId}.`);
    }
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
    }
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    logger.info(`RAG service stopping for agent: ${this.runtime.agentId}`);
  }

  /**
   * Add knowledge to the system
   * @param options Knowledge options
   * @returns Promise with document processing result
   */
  async addKnowledge(options: AddKnowledgeOptions): Promise<{
    clientDocumentId: string;
    storedDocumentMemoryId: UUID;
    fragmentCount: number;
  }> {
    const agentId = this.runtime.agentId as string;
    logger.info(
      `RagService (agent: ${agentId}) processing document for public addKnowledge: ${options.originalFilename}, type: ${options.contentType}`
    );

    // Check if document already exists in database using clientDocumentId as the primary key for "documents" table
    try {
      // The `getMemoryById` in runtime usually searches generic memories.
      // We need a way to specifically query the 'documents' table or ensure clientDocumentId is unique across all memories if used as ID.
      // For now, assuming clientDocumentId is the ID used when creating document memory.
      const existingDocument = await this.runtime.getMemoryById(options.clientDocumentId);
      if (existingDocument && existingDocument.metadata?.type === MemoryType.DOCUMENT) {
        logger.info(
          `Document ${options.originalFilename} with ID ${options.clientDocumentId} already exists. Skipping processing.`
        );

        // Count existing fragments for this document
        const fragments = await this.runtime.getMemories({
          tableName: 'knowledge',
          // Assuming fragments store original documentId in metadata.documentId
          // This query might need adjustment based on actual fragment metadata structure.
          // A more robust way would be to query where metadata.documentId === options.clientDocumentId
        });

        // Filter fragments related to this specific document
        const relatedFragments = fragments.filter(
          (f) =>
            f.metadata?.type === MemoryType.FRAGMENT &&
            (f.metadata as FragmentMetadata).documentId === options.clientDocumentId
        );

        return {
          clientDocumentId: options.clientDocumentId,
          storedDocumentMemoryId: existingDocument.id as UUID,
          fragmentCount: relatedFragments.length,
        };
      }
    } catch (error) {
      // Document doesn't exist or other error, continue with processing
      logger.debug(
        `Document ${options.clientDocumentId} not found or error checking existence, proceeding with processing: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return this.processDocument(options);
  }

  /**
   * Process a document regardless of type - Called by public addKnowledge
   * @param options Document options
   * @returns Promise with document processing result
   */
  private async processDocument({
    clientDocumentId,
    contentType,
    originalFilename,
    worldId,
    content,
    roomId,
    entityId,
  }: AddKnowledgeOptions): Promise<{
    clientDocumentId: string;
    storedDocumentMemoryId: UUID;
    fragmentCount: number;
  }> {
    const agentId = this.runtime.agentId as UUID;

    try {
      logger.debug(
        `RagService: Processing document ${originalFilename} (type: ${contentType}) via processDocument`
      );

      let fileBuffer: Buffer | null = null;
      let extractedText: string;
      const isPdfFile =
        contentType === 'application/pdf' || originalFilename.toLowerCase().endsWith('.pdf');
      const isBinaryFile = this.isBinaryContentType(contentType, originalFilename);

      if (isBinaryFile) {
        try {
          fileBuffer = Buffer.from(content, 'base64');
        } catch (e: any) {
          logger.error(
            `RagService: Failed to convert base64 to buffer for ${originalFilename}: ${e.message}`
          );
          throw new Error(`Invalid base64 content for binary file ${originalFilename}`);
        }
        extractedText = await extractTextFromDocument(fileBuffer, contentType, originalFilename);
      } else {
        extractedText = content;
      }

      if (!extractedText || extractedText.trim() === '') {
        const noTextError = new Error(
          `RagService: No text content extracted from ${originalFilename} (type: ${contentType}).`
        );
        logger.warn(noTextError.message);
        throw noTextError;
      }

      // Create document memory using the clientDocumentId as the memory ID
      const documentMemory = createDocumentMemory({
        text: isPdfFile ? content : extractedText, // Store base64 for PDF, text for others
        agentId,
        clientDocumentId, // This becomes the memory.id
        originalFilename,
        contentType,
        worldId,
        fileSize: fileBuffer ? fileBuffer.length : extractedText.length,
        documentId: clientDocumentId, // Explicitly set documentId in metadata as well
      });

      const memoryWithScope = {
        ...documentMemory,
        id: clientDocumentId, // Ensure the ID of the memory is the clientDocumentId
        roomId: roomId || agentId,
        entityId: entityId || agentId,
      };

      await this.runtime.createMemory(memoryWithScope, 'documents');

      logger.debug(
        `RagService: Stored document ${originalFilename} (Memory ID: ${memoryWithScope.id})`
      );

      const fragmentCount = await processFragmentsSynchronously({
        runtime: this.runtime,
        documentId: clientDocumentId, // Pass clientDocumentId to link fragments
        fullDocumentText: extractedText,
        agentId,
        contentType,
        roomId: roomId || agentId,
        entityId: entityId || agentId,
        worldId: worldId || agentId,
      });

      logger.info(
        `RagService: Document ${originalFilename} processed with ${fragmentCount} fragments for agent ${agentId}`
      );

      return {
        clientDocumentId,
        storedDocumentMemoryId: memoryWithScope.id as UUID,
        fragmentCount,
      };
    } catch (error: any) {
      logger.error(
        `RagService: Error processing document ${originalFilename}: ${error.message}`,
        error.stack
      );
      throw error;
    }
  }

  /**
   * Determines if a file should be treated as binary based on its content type and filename
   * @param contentType MIME type of the file
   * @param filename Original filename
   * @returns True if the file should be treated as binary (base64 encoded)
   */
  private isBinaryContentType(contentType: string, filename: string): boolean {
    const binaryContentTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream',
      'image/',
      'audio/',
      'video/',
    ];

    // Check MIME type
    const isBinaryMimeType = binaryContentTypes.some((type) => contentType.includes(type));

    if (isBinaryMimeType) {
      return true;
    }

    // Check file extension as fallback
    const fileExt = filename.split('.').pop()?.toLowerCase() || '';
    const binaryExtensions = [
      'pdf',
      'docx',
      'doc',
      'xls',
      'xlsx',
      'ppt',
      'pptx',
      'zip',
      'jpg',
      'jpeg',
      'png',
      'gif',
      'mp3',
      'mp4',
      'wav',
    ];

    return binaryExtensions.includes(fileExt);
  }

  // --- Knowledge methods moved from AgentRuntime ---

  private async handleProcessingError(error: any, context: string) {
    logger.error(`RagService: Error ${context}:`, error?.message || error || 'Unknown error');
    throw error;
  }

  async checkExistingKnowledge(knowledgeId: UUID): Promise<boolean> {
    // This checks if a specific memory (fragment or document) ID exists.
    // In the context of processCharacterKnowledge, knowledgeId is a UUID derived from the content.
    const existingDocument = await this.runtime.getMemoryById(knowledgeId);
    return !!existingDocument;
  }

  async getKnowledge(
    message: Memory,
    scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID }
  ): Promise<KnowledgeItem[]> {
    logger.debug('RagService: getKnowledge called for message id: ' + message.id);
    if (!message?.content?.text || message?.content?.text.trim().length === 0) {
      logger.warn('RagService: Invalid or empty message content for knowledge query.');
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
      tableName: 'knowledge',
      embedding,
      query: message.content.text,
      ...filterScope,
      count: 20,
      match_threshold: 0.1, // TODO: Make configurable
    });

    return fragments
      .filter((fragment) => fragment.id !== undefined) // Ensure fragment.id is defined
      .map((fragment) => ({
        id: fragment.id as UUID, // Cast as UUID after filtering
        content: fragment.content as Content, // Cast if necessary, ensure Content type matches
        similarity: fragment.similarity,
        metadata: fragment.metadata,
        worldId: fragment.worldId,
      }));
  }

  async processCharacterKnowledge(items: string[]): Promise<void> {
    // Wait briefly to allow services to initialize fully
    await new Promise((resolve) => setTimeout(resolve, 1000));
    logger.info(
      `RagService: Processing ${items.length} character knowledge items for agent ${this.runtime.agentId}`
    );

    const processingPromises = items.map(async (item) => {
      await this.knowledgeProcessingSemaphore.acquire();
      try {
        // For character knowledge, the item itself (string) is the source.
        // A unique ID is generated from this string content.
        const knowledgeId = createUniqueUuid(this.runtime.agentId + item, item); // Use agentId in seed for uniqueness

        if (await this.checkExistingKnowledge(knowledgeId)) {
          logger.debug(
            `RagService: Character knowledge item with ID ${knowledgeId} already exists. Skipping.`
          );
          return;
        }

        logger.debug(
          `RagService: Processing character knowledge for ${this.runtime.character?.name} - ${item.slice(0, 100)}`
        );

        let metadata: MemoryMetadata = {
          type: MemoryType.DOCUMENT, // Character knowledge often represents a doc/fact.
          timestamp: Date.now(),
          source: 'character', // Indicate the source
        };

        const pathMatch = item.match(/^Path: (.+?)(?:\n|\r\n)/);
        if (pathMatch) {
          const filePath = pathMatch[1].trim();
          const extension = filePath.split('.').pop() || '';
          const filename = filePath.split('/').pop() || '';
          const title = filename.replace(`.${extension}`, '');
          metadata = {
            ...metadata,
            path: filePath,
            filename: filename,
            fileExt: extension,
            title: title,
            fileType: `text/${extension || 'plain'}`, // Assume text if not specified
            fileSize: item.length,
          };
        }

        // Using _internalAddKnowledge for character knowledge
        await this._internalAddKnowledge(
          {
            id: knowledgeId, // Use the content-derived ID
            content: {
              text: item,
            },
            metadata,
          },
          undefined,
          {
            // Scope to the agent itself for character knowledge
            roomId: this.runtime.agentId,
            entityId: this.runtime.agentId,
            worldId: this.runtime.agentId,
          }
        );
      } catch (error) {
        await this.handleProcessingError(error, 'processing character knowledge');
      } finally {
        this.knowledgeProcessingSemaphore.release();
      }
    });

    await Promise.all(processingPromises);
    logger.info(
      `RagService: Finished processing character knowledge for agent ${this.runtime.agentId}.`
    );
  }

  // Renamed from AgentRuntime's addKnowledge
  // This is the core logic for adding text-based knowledge items and creating fragments.
  async _internalAddKnowledge(
    item: KnowledgeItem, // item.id here is expected to be the ID of the "document"
    options = {
      targetTokens: 1500, // TODO: Make these configurable, perhaps from plugin config
      overlap: 200,
      modelContextSize: 4096,
    },
    scope = {
      // Default scope for internal additions (like character knowledge)
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

    logger.debug(`RagService: _internalAddKnowledge called for item ID ${item.id}`);

    // For _internalAddKnowledge, we assume item.content.text is always present
    // and it's not a binary file needing RAG plugin's special handling for extraction.
    // This path is for already-textual content like character knowledge or direct text additions.

    const documentMemory: Memory = {
      id: item.id, // This ID should be the unique ID for the document being added.
      agentId: this.runtime.agentId,
      roomId: finalScope.roomId,
      worldId: finalScope.worldId,
      entityId: finalScope.entityId,
      content: item.content,
      metadata: {
        ...(item.metadata || {}), // Spread existing metadata
        type: MemoryType.DOCUMENT, // Ensure it's marked as a document
        documentId: item.id, // Ensure metadata.documentId is set to the item's ID
        timestamp: item.metadata?.timestamp || Date.now(),
      },
      createdAt: Date.now(),
    };

    const existingDocument = await this.runtime.getMemoryById(item.id);
    if (existingDocument) {
      logger.debug(
        `RagService: Document ${item.id} already exists in _internalAddKnowledge, updating...`
      );
      await this.runtime.updateMemory({
        ...documentMemory,
        id: item.id, // Ensure ID is passed for update
      });
    } else {
      await this.runtime.createMemory(documentMemory, 'documents');
    }

    const fragments = await this.splitAndCreateFragments(
      item, // item.id is the documentId
      options.targetTokens,
      options.overlap,
      finalScope
    );

    let fragmentsProcessed = 0;
    for (const fragment of fragments) {
      try {
        await this.processDocumentFragment(fragment); // fragment already has metadata.documentId from splitAndCreateFragments
        fragmentsProcessed++;
      } catch (error) {
        logger.error(
          `RagService: Error processing fragment ${fragment.id} for document ${item.id}:`,
          error
        );
      }
    }
    logger.debug(
      `RagService: Processed ${fragmentsProcessed}/${fragments.length} fragments for document ${item.id}.`
    );
  }

  private async splitAndCreateFragments(
    document: KnowledgeItem, // document.id is the ID of the parent document
    targetTokens: number,
    overlap: number,
    scope: { roomId: UUID; worldId: UUID; entityId: UUID }
  ): Promise<Memory[]> {
    if (!document.content.text) {
      return [];
    }

    const text = document.content.text;
    // TODO: Consider using DEFAULT_CHUNK_TOKEN_SIZE and DEFAULT_CHUNK_OVERLAP_TOKENS from ctx-embeddings
    // For now, using passed in values or defaults from _internalAddKnowledge.
    const chunks = await splitChunks(text, targetTokens, overlap);

    return chunks.map((chunk, index) => {
      // Create a unique ID for the fragment based on document ID, index, and timestamp
      const fragmentIdContent = `${document.id}-fragment-${index}-${Date.now()}`;
      const fragmentId = createUniqueUuid(
        this.runtime.agentId + fragmentIdContent,
        fragmentIdContent
      );

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
          ...(document.metadata || {}), // Spread metadata from parent document
          type: MemoryType.FRAGMENT,
          documentId: document.id, // Link fragment to parent document
          position: index,
          timestamp: Date.now(), // Fragment's own creation timestamp
          // Ensure we don't overwrite essential fragment metadata with document's
          // For example, source might be different or more specific for the fragment.
          // Here, we primarily inherit and then set fragment-specifics.
        },
        createdAt: Date.now(),
      };
    });
  }

  private async processDocumentFragment(fragment: Memory): Promise<void> {
    try {
      // Add embedding to the fragment
      // Runtime's addEmbeddingToMemory will use runtime.useModel(ModelType.TEXT_EMBEDDING, ...)
      await this.runtime.addEmbeddingToMemory(fragment);

      // Store the fragment in the knowledge table
      await this.runtime.createMemory(fragment, 'knowledge');
    } catch (error) {
      logger.error(
        `RagService: Error processing fragment ${fragment.id}:`,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }
  // --- End of moved knowledge methods ---
}
