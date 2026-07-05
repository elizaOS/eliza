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
    addedFrom?: SinkDocument["addedFrom"];
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
        metadata: {
          ...doc.metadata,
          source: doc.addedFrom ?? "import",
          addedFrom: doc.addedFrom ?? "import",
        },
        scope: doc.scope,
        scopedToEntityId: doc.scopedToEntityId,
        addedFrom: doc.addedFrom,
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
