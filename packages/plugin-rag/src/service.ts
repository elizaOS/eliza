import { Service, IAgentRuntime, logger, UUID } from '@elizaos/core';
import { AddKnowledgeOptions } from './types';
import {
  processDocumentSynchronously,
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
    fileBuffer,
    contentType,
    originalFilename,
    worldId,
    text,
  }: Omit<AddKnowledgeOptions, 'onDocumentStored'> & { text?: string }): Promise<{
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

    // Check if this is a PDF or other document type
    if (contentType.toLowerCase() === 'application/pdf') {
      return this.processPdfDocument({
        clientDocumentId,
        fileBuffer,
        contentType,
        originalFilename,
        worldId,
      });
    } else {
      return this.processNonPdfDocument({
        clientDocumentId,
        fileBuffer,
        contentType,
        originalFilename,
        worldId,
        text,
      });
    }
  }

  /**
   * Process a PDF document
   * @param options Document options
   * @returns Promise with document processing result
   */
  private async processPdfDocument({
    clientDocumentId,
    fileBuffer,
    contentType,
    originalFilename,
    worldId,
  }: Omit<AddKnowledgeOptions, 'onDocumentStored'>): Promise<{
    clientDocumentId: string;
    storedDocumentMemoryId: UUID;
    fragmentCount: number;
  }> {
    const agentId = this.runtime.agentId as string;

    try {
      logger.debug(`Processing PDF document: ${originalFilename}`);

      // Ensure fileBuffer exists
      if (!fileBuffer) {
        throw new Error(`No file buffer provided for PDF document ${originalFilename}`);
      }

      // Process the document synchronously
      const { documentId, fragmentCount } = await processDocumentSynchronously({
        runtime: this.runtime,
        clientDocumentId,
        fileBuffer,
        contentType,
        originalFilename,
        worldId,
      });

      logger.info(
        `PDF document ${originalFilename} processed with ${fragmentCount} fragments for agent ${agentId}`
      );

      return {
        clientDocumentId,
        storedDocumentMemoryId: documentId,
        fragmentCount,
      };
    } catch (error: any) {
      logger.error(
        `Error processing PDF document ${originalFilename}: ${error.message}`,
        error.stack
      );
      throw error;
    }
  }

  /**
   * Process a non-PDF document
   * @param options Document options
   * @returns Promise with document processing result
   */
  private async processNonPdfDocument({
    clientDocumentId,
    fileBuffer,
    contentType,
    originalFilename,
    worldId,
    text,
  }: Omit<AddKnowledgeOptions, 'onDocumentStored'> & { text?: string }): Promise<{
    clientDocumentId: string;
    storedDocumentMemoryId: UUID;
    fragmentCount: number;
  }> {
    const agentId = this.runtime.agentId as UUID;

    try {
      logger.debug(`Processing non-PDF document: ${originalFilename} (type: ${contentType})`);

      // Use the provided text if available, otherwise extract it from the fileBuffer
      let extractedText: string;

      if (text) {
        // Use the text that was directly provided
        logger.debug(`Using provided text content for ${originalFilename}`);
        extractedText = text;
      } else if (fileBuffer) {
        // Extract text from fileBuffer
        logger.debug(`Extracting text from non-PDF: ${originalFilename} (Type: ${contentType})`);
        extractedText = await extractTextFromDocument(fileBuffer, contentType, originalFilename);
      } else {
        // Neither text nor fileBuffer was provided - throw an error
        const noContentError = new Error(
          `No content provided for ${originalFilename}. Both fileBuffer and text are missing.`
        );
        logger.warn(noContentError.message);
        throw noContentError;
      }

      if (!extractedText || extractedText.trim() === '') {
        const noTextError = new Error(
          `No text content extracted from ${originalFilename} (type: ${contentType}).`
        );
        logger.warn(noTextError.message);
        throw noTextError;
      }

      // Create and save main document memory
      const documentMemory = createDocumentMemory({
        text: extractedText,
        agentId,
        clientDocumentId,
        originalFilename,
        contentType,
        worldId,
        fileSize: fileBuffer ? fileBuffer.length : extractedText.length,
      });

      logger.debug(`Storing main document: ${originalFilename} (Memory ID: ${documentMemory.id})`);
      await this.runtime.createMemory(documentMemory, 'documents');

      // Process fragments
      logger.debug(`Processing fragments for document: ${originalFilename}`);
      const fragmentCount = await processFragmentsSynchronously({
        runtime: this.runtime,
        documentId: clientDocumentId,
        fullDocumentText: extractedText,
        agentId,
        contentType,
      });

      logger.info(
        `Non-PDF document ${originalFilename} processed with ${fragmentCount} fragments for agent ${agentId}`
      );

      return {
        clientDocumentId,
        storedDocumentMemoryId: documentMemory.id as UUID,
        fragmentCount,
      };
    } catch (error: any) {
      logger.error(
        `Error processing non-PDF document ${originalFilename}: ${error.message}`,
        error.stack
      );
      throw error;
    }
  }
}
