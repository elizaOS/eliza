/**
 * A MODEL_USED listener is usage accounting, not part of the embedding result.
 * When that listener fails, the embedding call must still return the vector and
 * the runtime must record the failure on the diagnostic boundary. This test
 * drives the real HTTP dispatch path through a loopback endpoint.
 */
import { createServer, type Server } from "node:http";
import { AgentRuntime, EventType } from "@elizaos/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { handleTextEmbedding } from "../src/models/embedding";

let server: Server;
let baseURL: string;

beforeEach(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input: { input: string | string[] } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const count = Array.isArray(input.input) ? input.input.length : 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: Array.from({ length: count }, (_, index) => ({
          index,
          embedding: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
        })),
        usage: { prompt_tokens: 3, total_tokens: 3 },
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

function fixture() {
  return new AgentRuntime({
    logLevel: "fatal",
    settings: {
      EMBEDDING_BASE_URL: baseURL,
      EMBEDDING_MODEL: "reviewed-bge",
      EMBEDDING_DIMENSIONS: "384",
    },
    plugins: [],
  });
}

it("keeps the embedding and reports a failing MODEL_USED listener", async () => {
  const runtime = fixture();
  runtime.registerEvent(EventType.MODEL_USED, async () => {
    throw new Error("MODEL_USED listener failed");
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const vector = await handleTextEmbedding(runtime, "synthetic embedding input");
    expect(vector).toHaveLength(384);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(unhandled).toEqual([]);
    expect(runtime.getRecentReportedErrors()).toContainEqual(
      expect.objectContaining({
        scope: "EmbeddingsModelUsage.emitEvent",
        message: "MODEL_USED listener failed",
      })
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
