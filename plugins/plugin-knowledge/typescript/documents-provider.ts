import type { IAgentRuntime, Provider } from "@elizaos/core";
import { addHeader, logger, MemoryType } from "@elizaos/core";
import type { KnowledgeService } from "./service.ts";
import type { KnowledgeDocumentMetadata } from "./types.ts";

/**
 * Represents a static provider that lists available documents in the knowledge base.
 * This provider helps the agent understand which documents are available for retrieval.
 * @type {Provider}
 * @property {string} name - The name of the documents provider.
 * @property {string} description - The description of the documents provider.
 * @property {boolean} dynamic - Indicates if the provider is static (false).
 * @property {Function} get - Asynchronously retrieves the list of available documents.
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @returns {Object} An object containing the available documents list.
 */
export const documentsProvider: Provider = {
  name: "AVAILABLE_DOCUMENTS",
  description:
    "List of documents available in the knowledge base. Shows which documents the agent can reference and retrieve information from.",
  dynamic: false, // Static provider - doesn't change based on the message
  get: async (runtime: IAgentRuntime) => {
    try {
      const knowledgeService = runtime.getService("knowledge") as KnowledgeService;

      if (!knowledgeService) {
        logger.warn("Knowledge service not available for documents provider");
        return {
          data: { documents: [] },
          values: {
            documentsCount: 0,
            documents: "",
            availableDocuments: "",
          },
          text: "",
        };
      }

      // Retrieve all documents for the agent
      const allMemories = await knowledgeService.getMemories({
        tableName: "documents",
        roomId: runtime.agentId,
        count: 100, // Limit to 100 documents to avoid context overflow
      });

      // Filter to only documents (not fragments)
      const documents = allMemories.filter(
        (memory) => memory.metadata?.type === MemoryType.DOCUMENT
      );

      if (!documents || documents.length === 0) {
        return {
          data: { documents: [] },
          values: {
            documentsCount: 0,
            documents: "",
            availableDocuments: "",
          },
          text: "",
        };
      }

      // Format documents concisely
      const documentsList = documents
        .map((doc, index) => {
          const metadata = doc.metadata as KnowledgeDocumentMetadata | undefined;
          const filename = metadata?.filename || metadata?.title || `Document ${index + 1}`;
          const fileType = metadata?.fileExt || metadata?.fileType || "unknown";
          const source = metadata?.source || "upload";
          const fileSize = metadata?.fileSize;

          // Build description from metadata
          const parts = [filename];

          // Add file type info
          if (fileType && fileType !== "unknown") {
            parts.push(fileType);
          }

          // Add file size if available
          if (fileSize) {
            const sizeKB = Math.round(fileSize / 1024);
            if (sizeKB > 1024) {
              parts.push(`${Math.round(sizeKB / 1024)}MB`);
            } else {
              parts.push(`${sizeKB}KB`);
            }
          }

          // Add source if meaningful
          if (source && source !== "upload") {
            parts.push(`from ${source}`);
          }

          // Format: "filename (type, size, source)"
          return parts.join(" - ");
        })
        .join("\n");

      const documentsText = addHeader(
        "# Available Documents",
        `${documents.length} document(s) in knowledge base:\n${documentsList}`
      );

      return {
        data: {
          documents: documents.map((doc) => ({
            id: doc.id,
            filename:
              (doc.metadata as KnowledgeDocumentMetadata | undefined)?.filename ||
              (doc.metadata as KnowledgeDocumentMetadata | undefined)?.title,
            fileType:
              (doc.metadata as KnowledgeDocumentMetadata | undefined)?.fileType ||
              (doc.metadata as KnowledgeDocumentMetadata | undefined)?.fileExt,
            source: (doc.metadata as KnowledgeDocumentMetadata | undefined)?.source,
          })),
          count: documents.length,
        },
        values: {
          documentsCount: documents.length,
          documents: documentsList,
          availableDocuments: documentsText,
        },
        text: documentsText,
      };
    } catch (error) {
      logger.error(
        "Error in documents provider:",
        error instanceof Error ? error.message : String(error)
      );
      return {
        data: { documents: [], error: error instanceof Error ? error.message : String(error) },
        values: {
          documentsCount: 0,
          documents: "",
          availableDocuments: "",
        },
        text: "",
      };
    }
  },
};
