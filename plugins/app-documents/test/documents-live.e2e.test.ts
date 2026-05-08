/**
 * Live E2E tests for document integration.
 *
 * These tests use a real runtime, real embeddings, and a real LLM-backed chat
 * route for retrieval.
 */
import path from "node:path";
import { createElizaPlugin } from "@elizaos/agent";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../../../test/helpers/http";
import {
  isLiveTestEnabled,
  selectLiveProvider,
} from "../../../test/helpers/live-provider";
import { createRealTestRuntime } from "../../../test/helpers/real-runtime";

const envPath = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  ".env",
);
try {
  const { config } = await import("dotenv");
  config({ path: envPath });
} catch {
  // dotenv may not be available.
}

const LIVE_PROVIDER = selectLiveProvider("openai") ?? selectLiveProvider();
const CAN_RUN = isLiveTestEnabled() && Boolean(LIVE_PROVIDER);
const DOCUMENT_CODEWORD = "VELVET-MOON-4821";

type StartedDocumentServer = {
  close: () => Promise<void>;
  port: number;
};

async function askForExactDocumentCodeword(
  port: number,
  conversationId: string,
): Promise<string> {
  const prompts = [
    "What is the exact deployment codeword from the uploaded document? Reply with only the exact codeword, including hyphens and digits. Do not execute any actions.",
    "Search the uploaded document and copy the exact string from the sentence 'The deployment codeword is ...'. Reply with the codeword only. Do not update any profile or entity.",
    "Return only the exact uppercase-and-hyphen codeword from documents. No actions. No explanation.",
  ];

  let lastText = "";
  for (const text of prompts) {
    const { status, data } = await postConversationMessage(
      port,
      conversationId,
      { text },
      undefined,
      { timeoutMs: 120_000 },
    );

    expect(status).toBe(200);
    lastText = String(data.text ?? data.response ?? "");
    expect(lastText.length).toBeGreaterThan(0);
    if (lastText.includes(DOCUMENT_CODEWORD)) {
      return lastText;
    }
  }

  return lastText;
}

async function startDocumentServer(): Promise<StartedDocumentServer> {
  const runtimeResult = await createRealTestRuntime({
    withLLM: true,
    preferredProvider: LIVE_PROVIDER?.name,
    plugins: [createElizaPlugin({ agentId: "main" })],
  });
  const { startApiServer } = await import("@elizaos/agent/api/server");
  const server = await startApiServer({
    port: 0,
    runtime: runtimeResult.runtime,
    skipDeferredStartupWork: true,
  });
  await req(server.port, "POST", "/api/agent/start");

  return {
    port: server.port,
    close: async () => {
      await server.close();
      await runtimeResult.cleanup();
    },
  };
}

describeIf(CAN_RUN)("Live: document management flow", () => {
  let server: StartedDocumentServer | null = null;
  let uploadedDocumentId: string | null = null;

  beforeAll(async () => {
    server = await startDocumentServer();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("step 1: gets document stats", async () => {
    const { status, data } = await req(
      server?.port ?? 0,
      "GET",
      "/api/documents/stats",
    );
    expect(status).toBe(200);
    expect(typeof data.documentCount).toBe("number");
    expect(typeof data.fragmentCount).toBe("number");
    expect(typeof data.agentId).toBe("string");
  });

  it("step 2: uploads a text document", async () => {
    const testContent = `
# Test Document

The deployment codeword is ${DOCUMENT_CODEWORD}.

This document verifies that document upload, semantic search, and chat
retrieval all use the real runtime path.

RAG retrieval should answer questions about this codeword from the document.
    `.trim();

    const { status, data } = await req(
      server?.port ?? 0,
      "POST",
      "/api/documents",
      {
        content: testContent,
        filename: "test-document-doc.md",
        contentType: "text/markdown",
      },
    );

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.documentId).toBe("string");
    expect(typeof data.fragmentCount).toBe("number");
    expect(data.fragmentCount).toBeGreaterThan(0);
    uploadedDocumentId = data.documentId as string;
  });

  it("step 3: lists documents including the uploaded doc", async () => {
    const { status, data } = await req(
      server?.port ?? 0,
      "GET",
      "/api/documents",
    );
    expect(status).toBe(200);
    expect(Array.isArray(data.documents)).toBe(true);

    const docs = data.documents as Array<{ filename: string; id: string }>;
    const uploadedDoc = docs.find((entry) => entry.id === uploadedDocumentId);
    expect(uploadedDoc?.filename).toContain("test-document-doc");
  });

  it("step 4: gets document details", async () => {
    const { status, data } = await req(
      server?.port ?? 0,
      "GET",
      `/api/documents/${encodeURIComponent(uploadedDocumentId ?? "")}`,
    );

    expect(status).toBe(200);
    expect(data.document).toBeDefined();
    const doc = data.document as {
      contentType: string;
      filename: string;
      id: string;
    };
    expect(doc.id).toBe(uploadedDocumentId);
    expect(doc.filename).toContain("test-document-doc");
    expect(doc.contentType).toBe("text/markdown");
  });

  it("step 5: gets document fragments", async () => {
    const { status, data } = await req(
      server?.port ?? 0,
      "GET",
      `/api/documents/${encodeURIComponent(uploadedDocumentId ?? "")}/fragments`,
    );

    expect(status).toBe(200);
    expect(data.documentId).toBe(uploadedDocumentId);
    expect(Array.isArray(data.fragments)).toBe(true);

    const fragments = data.fragments as Array<{ text: string }>;
    expect(fragments.length).toBeGreaterThan(0);
    expect(
      fragments.some((fragment) => fragment.text.includes(DOCUMENT_CODEWORD)),
    ).toBe(true);
  });

  it("step 6: searches documents with semantic matching", async () => {
    const { status, data } = await req(
      server?.port ?? 0,
      "GET",
      "/api/documents/search?q=deployment%20codeword&threshold=0.2&limit=5",
    );

    expect(status).toBe(200);
    expect(Array.isArray(data.results)).toBe(true);
    const results = data.results as Array<{
      similarity: number;
      text: string;
    }>;
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((result) => result.text.includes(DOCUMENT_CODEWORD)),
    ).toBe(true);
    for (let index = 1; index < results.length; index += 1) {
      expect(results[index].similarity).toBeLessThanOrEqual(
        results[index - 1].similarity,
      );
    }
  });

  it("step 7: chat retrieves the uploaded document through the real runtime", async () => {
    const conversation = await createConversation(server?.port ?? 0, {
      title: "Document retrieval",
    });
    const text = await askForExactDocumentCodeword(
      server?.port ?? 0,
      conversation.id,
    );
    expect(text).toContain(DOCUMENT_CODEWORD);
  }, 120_000);

  it("step 8: deletes document and fragments", async () => {
    const { status, data } = await req(
      server?.port ?? 0,
      "DELETE",
      `/api/documents/${encodeURIComponent(uploadedDocumentId ?? "")}`,
    );

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.deletedFragments).toBe("number");
    expect(data.deletedFragments).toBeGreaterThan(0);

    const { data: listData } = await req(
      server?.port ?? 0,
      "GET",
      "/api/documents",
    );
    const docs = listData.documents as Array<{ id: string }>;
    expect(docs.some((doc) => doc.id === uploadedDocumentId)).toBe(false);
  });
});

describeIf(CAN_RUN)("Live: URL import validation", () => {
  let server: StartedDocumentServer | null = null;

  beforeAll(async () => {
    server = await startDocumentServer();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("validates URL format", async () => {
    const { status, data } = await req(
      server?.port ?? 0,
      "POST",
      "/api/documents/url",
      {
        url: "not-a-valid-url",
      },
    );
    expect(status).toBe(400);
    expect(data.error).toContain("Invalid URL");
  });

  it("handles missing URL", async () => {
    const { status, data } = await req(
      server?.port ?? 0,
      "POST",
      "/api/documents/url",
      {},
    );
    expect(status).toBe(400);
    expect(data.error).toContain("url is required");
  });
});

describeIf(CAN_RUN)("Live: empty document store behavior", () => {
  let server: StartedDocumentServer | null = null;

  beforeAll(async () => {
    server = await startDocumentServer();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("document stats work when empty", async () => {
    const { data: listData } = await req(
      server?.port ?? 0,
      "GET",
      "/api/documents",
    );
    const docs = listData.documents as Array<{ id: string }>;
    for (const doc of docs) {
      await req(
        server?.port ?? 0,
        "DELETE",
        `/api/documents/${encodeURIComponent(doc.id)}`,
      );
    }

    const { status, data } = await req(
      server?.port ?? 0,
      "GET",
      "/api/documents/stats",
    );
    expect(status).toBe(200);
    expect(data.documentCount).toBe(0);
    expect(data.fragmentCount).toBe(0);
  });

  it("search returns an empty array when no documents exist", async () => {
    const { status, data } = await req(
      server?.port ?? 0,
      "GET",
      "/api/documents/search?q=test%20query&threshold=0.3",
    );

    expect(status).toBe(200);
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results).toHaveLength(0);
  });
});
