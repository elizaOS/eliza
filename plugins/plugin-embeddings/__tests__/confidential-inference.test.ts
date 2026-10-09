/** Exercises actual embedding HTTP dispatch through core admission using loopback servers; proof and audit fixtures do not represent hardware attestation or durable storage. */
import { createServer, type Server } from "node:http";
import {
  AgentRuntime,
  type ConfidentialInferenceAuditRecord,
  ConfidentialInferenceAuthority,
  ModelType,
  runWithConfidentialInference,
} from "@elizaos/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { handleBatchTextEmbedding, handleTextEmbedding } from "../src/models/embedding";

let server: Server;
let baseURL: string;
let responseStatus = 200;
const requests: Array<{ path: string; authorization: string | undefined; body: string }> = [];
beforeEach(async () => {
  requests.length = 0;
  responseStatus = 200;
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
    const input: { input: string | string[] } = JSON.parse(body);
    const count = Array.isArray(input.input) ? input.input.length : 1;
    response.writeHead(responseStatus, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: Array.from({ length: count }, (_, index) => ({
          index,
          embedding: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
        })),
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  baseURL = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

function fixture(options: { approved?: boolean; auditFails?: boolean; fallback?: boolean } = {}) {
  const runtime = new AgentRuntime({
    logLevel: "fatal",
    settings: {
      EMBEDDING_BASE_URL: baseURL,
      EMBEDDING_API_KEY: "synthetic-embedding-secret",
      EMBEDDING_MODEL: "reviewed-bge",
      EMBEDDING_DIMENSIONS: "384",
      EMBEDDING_FALLBACK_BASE_URL: options.fallback ? `${baseURL}/fallback` : "",
      EMBEDDING_FALLBACK_MODEL: "reviewed-bge",
      EMBEDDING_FALLBACK_API_KEY: "synthetic-fallback-secret",
    },
    plugins: [],
  });
  const records: ConfidentialInferenceAuditRecord[] = [];
  const expiresAt = Date.now() + 60_000;
  const authority = new ConfidentialInferenceAuthority({
    handlers: [handleTextEmbedding, handleBatchTextEmbedding],
    redispatchPolicy: "deny-after-authorization",
    currentProfile: () => ({
      revision: "synthetic-policy",
      expiresAt,
      routes: (options.approved === false ? [] : [baseURL, `${baseURL}/fallback`]).map(
        (url, index) => ({
          id: `route-${index}`,
          endpoint: `${url}/embeddings`,
          model: "reviewed-bge",
          modelTypes: [ModelType.TEXT_EMBEDDING, ModelType.TEXT_EMBEDDING_BATCH],
        })
      ),
    }),
    audit: {
      async append(record) {
        if (options.auditFails) throw new Error("Synthetic audit unavailable");
        records.push(record);
      },
    },
    transport: async (url, init, context) => {
      await context.beforeDispatch({
        evidenceDigest: "a".repeat(64),
        connectionBindingDigest: "b".repeat(64),
      });
      expect(records.at(-1)?.phase).toBe("dispatch_intent");
      return fetch(url, init);
    },
  });
  const embed = (input: string | string[]) =>
    runWithConfidentialInference(
      authority,
      {
        agentId: runtime.agentId,
        modelType: Array.isArray(input) ? ModelType.TEXT_EMBEDDING_BATCH : ModelType.TEXT_EMBEDDING,
        handler: Array.isArray(input) ? handleBatchTextEmbedding : handleTextEmbedding,
      },
      () =>
        Array.isArray(input)
          ? handleBatchTextEmbedding(runtime, input)
          : handleTextEmbedding(runtime, input)
    );
  return { runtime, records, embed };
}

it.each([{ approved: false }, { auditFails: true }])(
  "sends no credentials or input when admission fails: %j",
  async (options) => {
    const { embed } = fixture(options);
    await expect(embed("synthetic private memory")).rejects.toThrow();
    expect(requests).toEqual([]);
  }
);

it("admits complete single and batch inputs and records only dispatch metadata", async () => {
  const { embed, records } = fixture();
  const input = `${"complete synthetic memory Ω ".repeat(2000)}END`;
  expect(await embed(input)).toHaveLength(384);
  expect(await embed([input, "second memory"])).toHaveLength(2);
  expect(requests.map((request) => JSON.parse(request.body).input)).toEqual([
    input,
    [input, "second memory"],
  ]);
  expect(requests.map((request) => request.authorization)).toEqual(
    Array(2).fill("Bearer synthetic-embedding-secret")
  );
  expect(records.filter((record) => record.phase === "dispatch_intent")).toHaveLength(2);
  expect(JSON.stringify(records)).not.toContain("synthetic-embedding-secret");
  expect(JSON.stringify(records)).not.toContain("complete synthetic memory");
});

it("does not redispatch to fallback after an authorized send fails", async () => {
  responseStatus = 503;
  const { embed } = fixture({ fallback: true });
  await expect(embed("synthetic private memory")).rejects.toThrow();
  expect(requests.map((request) => request.path)).toEqual(["/embeddings"]);
});

it("preserves ordinary-mode dispatch", async () => {
  const { runtime } = fixture();
  expect(await handleTextEmbedding(runtime, "ordinary synthetic input")).toHaveLength(384);
  expect(requests).toHaveLength(1);
});
