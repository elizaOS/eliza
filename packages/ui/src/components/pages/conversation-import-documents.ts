import type {
  DocumentSink,
  SinkDocument,
} from "@elizaos/import-conversations/browser";

export interface ConversationImportDocumentClient {
  uploadDocument(data: {
    content: string;
    filename: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
    entityId?: string;
    scope?: SinkDocument["scope"];
    scopedToEntityId?: string;
  }): Promise<{ documentId: string }>;
  deleteDocument(documentId: string): Promise<unknown>;
}

export function createConversationImportDocumentSink(
  client: ConversationImportDocumentClient,
): DocumentSink {
  return {
    async addDocument(doc) {
      const result = await client.uploadDocument({
        content: doc.content,
        filename: doc.originalFilename,
        contentType: doc.contentType,
        metadata: doc.metadata,
        scope: doc.scope,
        scopedToEntityId: doc.scopedToEntityId,
      });
      return {
        id: result.documentId,
        status: "stored",
      };
    },
    async deleteDocument(documentId) {
      await client.deleteDocument(documentId);
    },
  };
}
