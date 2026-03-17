/**
 * Live E2E tests for Knowledge plugin integration.
 *
 * These tests use REAL API keys for LLM providers and exercise the full
 * knowledge management flow end-to-end: upload → search → retrieve via RAG → delete.
 *
 * Required env vars (loaded from ../eliza/.env):
 *   OPENAI_API_KEY or ANTHROPIC_API_KEY — for embeddings and LLM
 *
 * Run: MILADY_LIVE_TEST=1 npx vitest run -c vitest.e2e.config.ts test/knowledge-live.e2e.test.ts
 */
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Load .env from the eliza workspace root
const envPath = path.resolve(import.meta.dirname, "..", "..", "eliza", ".env");
try {
  const { config } = await import("dotenv");
  config({ path: envPath });
} catch {
  // dotenv may not be available — keys must be in process.env already
}

const hasLLM =
  Boolean(process.env.OPENAI_API_KEY?.trim()) ||
  Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
  Boolean(process.env.GROQ_API_KEY?.trim());
const isLiveTest = process.env.MILADY_LIVE_TEST === "1";
const canRun = hasLLM && isLiveTest;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function req(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
          ...(headers ?? {}),
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE: KNOWLEDGE MANAGEMENT FLOW
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!canRun)("Live: Knowledge management flow", () => {
  let port: number;
  let close: () => Promise<void>;
  let uploadedDocumentId: string | null = null;

  beforeAll(async () => {
    const { startApiServer } = await import("../src/api/server");
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  // ── Step 1: Get initial stats ──────────────────────────────────────────
  it("step 1: gets knowledge stats", async () => {
    const { status, data } = await req(port, "GET", "/api/knowledge/stats");
    expect(status).toBe(200);
    expect(typeof data.documentCount).toBe("number");
    expect(typeof data.fragmentCount).toBe("number");
    expect(typeof data.agentId).toBe("string");
    console.log(
      `  Stats: ${data.documentCount} docs, ${data.fragmentCount} fragments`,
    );
  });

  // ── Step 2: Upload a text document ─────────────────────────────────────
  it("step 2: uploads a text document", async () => {
    const testContent = `
# Test Knowledge Document

This is a test document for the Milady knowledge management system.

## Section 1: Introduction

The knowledge management system allows users to upload documents that can be
retrieved via RAG (Retrieval Augmented Generation) when the agent needs
relevant information to answer questions.

## Section 2: Features

- Document upload (text, markdown, PDF, DOCX)
- URL import with YouTube auto-transcription
- Semantic search with similarity scoring
- Fragment-based retrieval for precise context

## Section 3: Testing

This document is being used to verify that:
1. Documents can be uploaded via the API
2. Content is properly chunked into fragments
3. Search returns relevant results
4. RAG retrieval works in chat context
    `.trim();

    const { status, data } = await req(
      port,
      "POST",
      "/api/knowledge/documents",
      {
        content: testContent,
        filename: "test-knowledge-doc.md",
        contentType: "text/markdown",
      },
    );

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.documentId).toBe("string");
    expect(typeof data.fragmentCount).toBe("number");
    expect(data.fragmentCount).toBeGreaterThan(0);

    uploadedDocumentId = data.documentId as string;
    console.log(
      `  Uploaded: ${uploadedDocumentId} (${data.fragmentCount} fragments)`,
    );
  });

  // ── Step 3: List documents includes the uploaded doc ───────────────────
  it("step 3: lists documents including uploaded doc", async () => {
    const { status, data } = await req(port, "GET", "/api/knowledge/documents");
    expect(status).toBe(200);
    expect(Array.isArray(data.documents)).toBe(true);

    const docs = data.documents as Array<{ id: string; filename: string }>;
    const uploadedDoc = docs.find((d) => d.id === uploadedDocumentId);
    expect(uploadedDoc).toBeDefined();
    expect(uploadedDoc?.filename).toBe("test-knowledge-doc.md");

    console.log(`  Found ${docs.length} documents`);
  });

  // ── Step 4: Get document details ───────────────────────────────────────
  it("step 4: gets document details", async () => {
    expect(uploadedDocumentId).toBeTruthy();
    if (!uploadedDocumentId) throw new Error("uploadedDocumentId missing");

    const { status, data } = await req(
      port,
      "GET",
      `/api/knowledge/documents/${encodeURIComponent(uploadedDocumentId)}`,
    );

    expect(status).toBe(200);
    expect(data.document).toBeDefined();

    const doc = data.document as {
      id: string;
      filename: string;
      contentType: string;
    };
    expect(doc.id).toBe(uploadedDocumentId);
    expect(doc.filename).toBe("test-knowledge-doc.md");
    expect(doc.contentType).toBe("text/markdown");

    console.log(`  Document: ${doc.filename} (${doc.contentType})`);
  });

  // ── Step 5: Get document fragments ─────────────────────────────────────
  it("step 5: gets document fragments", async () => {
    expect(uploadedDocumentId).toBeTruthy();
    if (!uploadedDocumentId) throw new Error("uploadedDocumentId missing");

    const { status, data } = await req(
      port,
      "GET",
      `/api/knowledge/fragments/${encodeURIComponent(uploadedDocumentId)}`,
    );

    expect(status).toBe(200);
    expect(data.documentId).toBe(uploadedDocumentId);
    expect(Array.isArray(data.fragments)).toBe(true);

    const fragments = data.fragments as Array<{ id: string; text: string }>;
    expect(fragments.length).toBeGreaterThan(0);

    // Verify fragments contain expected content
    const hasIntroduction = fragments.some((f) =>
      f.text.toLowerCase().includes("introduction"),
    );
    expect(hasIntroduction).toBe(true);

    console.log(`  Found ${fragments.length} fragments`);
  });

  // ── Step 6: Search knowledge ───────────────────────────────────────────
  it("step 6: searches knowledge with semantic matching", async () => {
    const { status, data } = await req(
      port,
      "GET",
      "/api/knowledge/search?q=RAG%20retrieval%20documents&threshold=0.2&limit=5",
    );

    expect(status).toBe(200);
    expect(data.query).toBe("RAG retrieval documents");
    expect(Array.isArray(data.results)).toBe(true);

    const results = data.results as Array<{
      id: string;
      text: string;
      similarity: number;
    }>;

    if (results.length > 0) {
      // Results should be sorted by similarity (descending)
      for (let i = 1; i < results.length; i++) {
        expect(results[i].similarity).toBeLessThanOrEqual(
          results[i - 1].similarity,
        );
      }

      // At least one result should mention RAG or retrieval
      const hasRelevantResult = results.some(
        (r) =>
          r.text.toLowerCase().includes("rag") ||
          r.text.toLowerCase().includes("retrieval"),
      );
      expect(hasRelevantResult).toBe(true);

      console.log(
        `  Found ${results.length} results, top similarity: ${results[0]?.similarity?.toFixed(3)}`,
      );
    } else {
      console.log("  No search results (embeddings may not be configured)");
    }
  });

  // ── Step 7: Delete document ────────────────────────────────────────────
  it("step 7: deletes document and fragments", async () => {
    expect(uploadedDocumentId).toBeTruthy();
    if (!uploadedDocumentId) throw new Error("uploadedDocumentId missing");

    const { status, data } = await req(
      port,
      "DELETE",
      `/api/knowledge/documents/${encodeURIComponent(uploadedDocumentId)}`,
    );

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.deletedFragments).toBe("number");
    expect(data.deletedFragments).toBeGreaterThan(0);

    console.log(`  Deleted document and ${data.deletedFragments} fragments`);

    // Verify document is no longer listed
    const { data: listData } = await req(
      port,
      "GET",
      "/api/knowledge/documents",
    );
    const docs = listData.documents as Array<{ id: string }>;
    const stillExists = docs.some((d) => d.id === uploadedDocumentId);
    expect(stillExists).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LIVE: URL IMPORT (without actual YouTube to avoid rate limits)
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!canRun)("Live: URL import", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const { startApiServer } = await import("../src/api/server");
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  it("validates URL format", async () => {
    const { status, data } = await req(
      port,
      "POST",
      "/api/knowledge/documents/url",
      {
        url: "not-a-valid-url",
      },
    );

    expect(status).toBe(400);
    expect(data.error).toContain("Invalid URL");
  });

  it("handles missing URL", async () => {
    const { status, data } = await req(
      port,
      "POST",
      "/api/knowledge/documents/url",
      {},
    );

    expect(status).toBe(400);
    expect(data.error).toContain("url is required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LIVE: KNOWLEDGE PROVIDER SKIP BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!canRun)("Live: Knowledge provider skip behavior", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const { startApiServer } = await import("../src/api/server");
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  it("knowledge stats work when empty", async () => {
    // First delete all documents to ensure empty state
    const { data: listData } = await req(
      port,
      "GET",
      "/api/knowledge/documents",
    );
    const docs = listData.documents as Array<{ id: string }>;

    for (const doc of docs) {
      await req(
        port,
        "DELETE",
        `/api/knowledge/documents/${encodeURIComponent(doc.id)}`,
      );
    }

    // Now verify stats show zero
    const { status, data } = await req(port, "GET", "/api/knowledge/stats");
    expect(status).toBe(200);
    expect(data.documentCount).toBe(0);
    expect(data.fragmentCount).toBe(0);

    console.log("  Knowledge stats work with empty knowledge base");
  });

  it("search returns empty array when no documents", async () => {
    const { status, data } = await req(
      port,
      "GET",
      "/api/knowledge/search?q=test%20query&threshold=0.3",
    );

    expect(status).toBe(200);
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results).toHaveLength(0);

    console.log("  Search returns empty array with no documents");
  });
});
