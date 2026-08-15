/**
 * Proves bundled-document seeding survives a cold Eliza Cloud embedding
 * gateway through the real AgentRuntime model registry, HTTP client, and
 * in-memory persistence adapter. The local server is deterministic but no
 * runtime, model, transport, or database boundary is mocked.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  AgentRuntime,
  EventType,
  InMemoryDatabaseAdapter,
  MemoryType,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerCloudEmbeddingModels } from "../../../../../plugins/plugin-elizacloud/src/index.ts";

import {
  type DefaultDocumentDefinition,
  seedBundledDocuments,
} from "../default-documents.ts";

const AGENT_ID = "00000000-0000-0000-0000-00000000c01d" as UUID;
const EMBEDDING = Array.from({ length: 384 }, (_, index) => index / 384);
const DOCUMENT: DefaultDocumentDefinition = {
  key: "cold-cloud-seed",
  version: 1,
  filename: "cold-cloud-seed.txt",
  contentType: "text/plain",
  text: "A bundled document must survive a warming embedding gateway.",
  fragments: [
    { text: "A bundled document must survive a warming embedding gateway." },
  ],
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("bundled documents with a warming cloud embedding gateway", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it("retries the one-shot seed, persists its real vector, and stays idempotent", async () => {
    const requests: Array<{
      authorization: string | undefined;
      body: Record<string, unknown>;
      path: string | undefined;
    }> = [];
    server = createServer(async (request, response) => {
      const body = JSON.parse(await readBody(request)) as Record<
        string,
        unknown
      >;
      requests.push({
        authorization: request.headers.authorization,
        body,
        path: request.url,
      });

      response.setHeader("content-type", "application/json");
      if (requests.length <= 3) {
        response.statusCode = 503;
        response.end(
          JSON.stringify({ error: { code: "embedding_cache_warming" } }),
        );
        return;
      }

      response.statusCode = 200;
      response.end(
        JSON.stringify({
          data: [{ embedding: EMBEDDING, index: 0 }],
          usage: { prompt_tokens: 11, total_tokens: 11 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the embedding test server to bind a TCP port");
    }

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      adapter,
      logLevel: "fatal",
      settings: {
        ELIZAOS_CLOUD_EMBEDDING_API_KEY: "test-embedding-key",
        ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: "384",
        ELIZAOS_CLOUD_EMBEDDING_URL: `http://127.0.0.1:${address.port}`,
      },
    });
    registerCloudEmbeddingModels(runtime);
    const emitEvent = vi.spyOn(runtime, "emitEvent");

    await seedBundledDocuments(runtime, [DOCUMENT]);

    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request).toMatchObject({
        authorization: "Bearer test-embedding-key",
        path: "/api/v1/embeddings",
        body: {
          dimensions: 384,
          input: [DOCUMENT.fragments[0].text],
          model: "text-embedding-3-small",
        },
      });
    }
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith(
      EventType.MODEL_USED,
      expect.objectContaining({
        source: "elizacloud",
        type: "TEXT_EMBEDDING",
        tokens: { completion: 0, prompt: 11, total: 11 },
      }),
    );

    const fragments = await runtime.getMemories({
      agentId: AGENT_ID,
      roomId: AGENT_ID,
      tableName: "document_fragments",
      count: 10,
    });
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({
      content: { text: DOCUMENT.fragments[0].text },
      embedding: EMBEDDING,
      metadata: {
        bundledDocumentKey: DOCUMENT.key,
        type: MemoryType.FRAGMENT,
      },
    });

    await seedBundledDocuments(runtime, [DOCUMENT]);
    expect(requests).toHaveLength(4);
    expect(emitEvent).toHaveBeenCalledTimes(1);
    await expect(
      runtime.getMemories({
        agentId: AGENT_ID,
        roomId: AGENT_ID,
        tableName: "document_fragments",
        count: 10,
      }),
    ).resolves.toHaveLength(1);
  }, 10_000);
});
