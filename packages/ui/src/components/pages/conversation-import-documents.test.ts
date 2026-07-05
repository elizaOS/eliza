import { describe, expect, it, vi } from "vitest";
import { createConversationImportDocumentSink } from "./conversation-import-documents";

describe("createConversationImportDocumentSink", () => {
  it("maps canonical importer documents onto the document upload client", async () => {
    const uploadDocument = vi.fn().mockResolvedValue({ documentId: "doc-1" });
    const deleteDocument = vi.fn().mockResolvedValue({ ok: true });
    const sink = createConversationImportDocumentSink({
      uploadDocument,
      deleteDocument,
    });

    const result = await sink.addDocument({
      content: "# Conversation",
      contentType: "text/markdown",
      originalFilename: "chatgpt/conv-1.md",
      scope: "user-private",
      scopedToEntityId: "entity-1",
      addedFrom: "import",
      metadata: {
        import: {
          source: "chatgpt",
          sourceConversationId: "conv-1",
          importBatchId: "batch-1",
        },
        tags: ["import", "import:chatgpt"],
      },
    });

    expect(result).toEqual({ id: "doc-1", status: "stored" });
    expect(uploadDocument).toHaveBeenCalledWith({
      content: "# Conversation",
      filename: "chatgpt/conv-1.md",
      contentType: "text/markdown",
      scope: "user-private",
      scopedToEntityId: "entity-1",
      metadata: {
        import: {
          source: "chatgpt",
          sourceConversationId: "conv-1",
          importBatchId: "batch-1",
        },
        tags: ["import", "import:chatgpt"],
        source: "import",
        addedFrom: "import",
      },
      addedFrom: "import",
    });

    await sink.deleteDocument("doc-1");
    expect(deleteDocument).toHaveBeenCalledWith("doc-1");
  });
});
