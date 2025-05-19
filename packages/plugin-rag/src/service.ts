import { Service, IAgentRuntime, logger, UUID } from '@elizaos/core';
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

  /**
   * Create a new RAG service
   * @param runtime Agent runtime
   */
  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
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
  async addKnowledge({
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
    const agentId = this.runtime.agentId as string;
    logger.info(
      `RagService (agent: ${agentId}) processing document: ${originalFilename}, type: ${contentType}`
    );

    // Check if document already exists in database
    try {
      const existingDocument = await this.runtime.getMemoryById(clientDocumentId);
      if (existingDocument) {
        logger.info(
          `Document ${originalFilename} with ID ${clientDocumentId} already exists. Skipping processing.`
        );

        // Count existing fragments for this document
        const fragments = await this.runtime.getMemories({
          tableName: 'knowledge',
          entityId: clientDocumentId,
        });

        return {
          clientDocumentId,
          storedDocumentMemoryId: existingDocument.id as UUID,
          fragmentCount: fragments.length,
        };
      }
    } catch (error) {
      // Document doesn't exist, continue with processing
      logger.debug(
        `Document ${clientDocumentId} not found in database, proceeding with processing.`
      );
    }

    return this.processDocument({
      clientDocumentId,
      contentType,
      originalFilename,
      worldId,
      content,
      roomId: roomId || this.runtime.agentId,
      entityId: entityId || this.runtime.agentId,
    });
  }

  /**
   * Process a document regardless of type
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
      logger.debug(`Processing document: ${originalFilename} (type: ${contentType})`);

      // Convert content to buffer if it's binary content type
      let fileBuffer: Buffer | null = null;
      let extractedText: string;
      const isPdfFile =
        contentType === 'application/pdf' || originalFilename.toLowerCase().endsWith('.pdf');
      const isBinaryFile = this.isBinaryContentType(contentType, originalFilename);

      if (isBinaryFile) {
        // For binary files (PDF, DOCX, etc.), content should be base64
        try {
          fileBuffer = Buffer.from(content, 'base64');
          logger.debug(
            `Converted base64 to buffer for ${originalFilename} (size: ${fileBuffer.length} bytes)`
          );
        } catch (e: any) {
          logger.error(`Failed to convert base64 to buffer for ${originalFilename}: ${e.message}`);
          throw new Error(`Invalid base64 content for binary file ${originalFilename}`);
        }

        // Extract text for processing fragments
        logger.debug(`Extracting text from binary file: ${originalFilename}`);
        extractedText = await extractTextFromDocument(fileBuffer, contentType, originalFilename);
      } else {
        // For text files, content is already plain text
        logger.debug(`Using provided text content for ${originalFilename}`);
        extractedText = content;
      }

      if (!extractedText || extractedText.trim() === '') {
        const noTextError = new Error(
          `No text content extracted from ${originalFilename} (type: ${contentType}).`
        );
        logger.warn(noTextError.message);
        throw noTextError;
      }

      // Create document memory
      const documentMemory = createDocumentMemory({
        // Only PDF files are stored as base64, all other files are stored as extracted text
        // This makes all non-PDF files readable directly in the UI
        text: isPdfFile ? content : extractedText,
        agentId,
        clientDocumentId,
        originalFilename,
        contentType,
        worldId,
        fileSize: fileBuffer ? fileBuffer.length : extractedText.length,
      });

      // Store the document in the database
      logger.debug(`Storing document: ${originalFilename} (Memory ID: ${documentMemory.id})`);

      // Make sure to apply roomId and entityId to the memory
      const memoryWithScope = {
        ...documentMemory,
        roomId: roomId || agentId,
        entityId: entityId || agentId,
      };

      await this.runtime.createMemory(memoryWithScope, 'documents');

      // Process fragments using the extracted text
      logger.debug(`Processing fragments for document: ${originalFilename}`);
      const fragmentCount = await processFragmentsSynchronously({
        runtime: this.runtime,
        documentId: clientDocumentId,
        fullDocumentText: extractedText,
        agentId,
        contentType,
        roomId: roomId || agentId,
        entityId: entityId || agentId,
        worldId: worldId || agentId,
      });

      logger.info(
        `Document ${originalFilename} processed with ${fragmentCount} fragments for agent ${agentId}`
      );

      return {
        clientDocumentId,
        storedDocumentMemoryId: documentMemory.id as UUID,
        fragmentCount,
      };
    } catch (error: any) {
      logger.error(`Error processing document ${originalFilename}: ${error.message}`, error.stack);
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
}
