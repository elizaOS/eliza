/**
 * Exercises managed embedding configuration through real Cloud embedding handlers.
 * Only credential minting and HTTP transport are fixtures; no provider or GPU runs.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentRuntime, BGE_SMALL_VECTOR_SPACE, getEmbeddingVectorSpace } from "@elizaos/core";

let mintedKeys = 0;
mock.module("./api-keys", () => ({
  apiKeysService: {
    createForAgent: async () => {
      mintedKeys++;
      return { plainKey: "test-managed-key", revokedKeyHashes: [] };
    },
  },
}));
const requests: Array<{ model: string; dimensions: number }> = [];
mock.module("../../../../../../plugins/plugin-elizacloud/src/utils/sdk-client", () => ({
  createCloudApiClient: () => ({
    requestRaw: async (
      _method: string,
      _path: string,
      options: { json: { model: string; dimensions: number; input: string[] } },
    ) => {
      requests.push({ model: options.json.model, dimensions: options.json.dimensions });
      return new Response(
        JSON.stringify({
          embedding_space: BGE_SMALL_VECTOR_SPACE,
          data: options.json.input.map((_text, index) => ({
            index,
            embedding: Array.from({ length: options.json.dimensions }, (_, i) => (i === 0 ? 1 : 0)),
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  }),
}));
const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");
const { handleTextEmbedding } = await import(
  "../../../../../../plugins/plugin-elizacloud/src/models/embeddings"
);
const savedEnv = { ...process.env };
beforeEach(() => {
  requests.length = 0;
  mintedKeys = 0;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

async function embedding(existingEnv: Record<string, string>) {
  const prepared = await prepareManagedElizaBaseEnvironment({
    existingEnv,
    organizationId: "org-test",
    userId: "user-test",
    agentSandboxId: "test-agent",
  });
  const runtime = new AgentRuntime({
    settings: prepared.environmentVars,
    disableBasicCapabilities: true,
  });
  return {
    env: prepared.environmentVars,
    vector: await handleTextEmbedding(runtime, "Complete embedding input"),
  };
}

describe("managed provider model and stored-width contract", () => {
  test.each<Record<string, string>>([
    { ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS: "0" },
    { ELIZAOS_CLOUD_USE_EMBEDDINGS: "true" },
  ])("fresh explicit Cloud selection uses actual BGE384 handler", async (override) => {
    const result = await embedding(override);
    expect(result.vector).toHaveLength(384);
    expect(getEmbeddingVectorSpace(result.vector)).toEqual(BGE_SMALL_VECTOR_SPACE);
    expect(requests).toEqual([{ model: "bge-small-en-v1.5", dimensions: 384 }]);
    expect(result.env.EMBEDDING_DIMENSION).toBe("384");
  });
  test("existing unpinned1536 store receives an explicit compatible legacy model, never BGE with1536", async () => {
    const result = await embedding({
      ELIZAOS_CLOUD_API_KEY: "existing-test-key",
      EMBEDDING_DIMENSION: "1536",
      ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: "1536",
    });
    expect(result.vector).toHaveLength(1536);
    expect(requests).toEqual([{ model: "text-embedding-3-small", dimensions: 1536 }]);
    expect(getEmbeddingVectorSpace(result.vector)).toBeUndefined();
    expect(result.env.EMBEDDING_DIMENSION).toBe("1536");
  });
  test.each<Record<string, string>>([
    { ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS: "1" },
    {
      ELIZAOS_CLOUD_USE_EMBEDDINGS: "true",
      ELIZAOS_CLOUD_EMBEDDING_MODEL: "bge-small-en-v1.5",
      EMBEDDING_BASE_URL: "https://embeddings.example.test/v1",
    },
  ])(
    "incompatible BGE selection refuses a persisted width before credential or transport effects",
    async (override) => {
      await expect(
        embedding({
          ELIZAOS_CLOUD_API_KEY: "existing-test-key",
          EMBEDDING_DIMENSION: "1536",
          ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: "1536",
          ...override,
        }),
      ).rejects.toMatchObject({ code: "MANAGED_EMBEDDING_MIGRATION_REQUIRED" });
      expect(requests).toHaveLength(0);
      expect(mintedKeys).toBe(0);
    },
  );
  test.each<Record<string, string>>([
    { EMBEDDING_DIMENSION: "384", ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: "384" },
    {},
  ])("legacy local selection cannot infer BGE identity or persisted width", async (hints) => {
    await expect(
      embedding({
        ELIZAOS_CLOUD_API_KEY: "existing-test-key",
        ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS: "1",
        ...hints,
      }),
    ).rejects.toMatchObject({ code: "MANAGED_EMBEDDING_MIGRATION_REQUIRED" });
    expect(mintedKeys).toBe(0);
    expect(requests).toHaveLength(0);
  });

  test("a freshly stamped BGE384 local configuration remains eligible on upgrade", async () => {
    const fresh = await prepareManagedElizaBaseEnvironment({
      existingEnv: {},
      organizationId: "org-test",
      userId: "user-test",
      agentSandboxId: "test-agent",
    });
    const next = await prepareManagedElizaBaseEnvironment({
      existingEnv: fresh.environmentVars,
      organizationId: "org-test",
      userId: "user-test",
      agentSandboxId: "test-agent",
    });
    expect(next.environmentVars.EMBEDDING_DIMENSION).toBe("384");
    expect(next.environmentVars.ELIZAOS_CLOUD_EMBEDDING_MODEL).toBe("bge-small-en-v1.5");
    expect(next.environmentVars.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("false");
  });
});
