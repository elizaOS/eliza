/**
 * Protects persisted legacy vectors at the managed boot preparation boundary.
 * Real PGlite migrations and storage retain old vectors and complete source text;
 * only credential minting is a fixture, and rejected boots never run inference.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ChannelType } from "@elizaos/core";
import { createDatabaseAdapter, DatabaseMigrationService, plugin } from "@elizaos/plugin-sql";

let mintedKeys = 0;
mock.module("./api-keys", () => ({
  apiKeysService: {
    createForAgent: async () => {
      mintedKeys++;
      return { plainKey: "replacement-test-key", revokedKeyHashes: [] };
    },
  },
}));
const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");
beforeEach(() => {
  mintedKeys = 0;
});

describe("legacy embedding store managed upgrade", () => {
  test.each([384, 1536])(
    "refuses ambiguous %i-dimensional local adoption before touching stored vectors",
    async (dimension) => {
      const agentId = randomUUID();
      const entityId = randomUUID();
      const roomId = randomUUID();
      const adapter = createDatabaseAdapter({ dataDir: ":memory:" }, agentId);
      await adapter.init();
      try {
        const migrations = new DatabaseMigrationService({ databaseBackend: "pglite" });
        await migrations.initializeWithDatabase(adapter.getDatabase());
        migrations.discoverAndRegisterPluginSchemas([plugin]);
        await migrations.runAllPluginMigrations();
        await adapter.ensureEmbeddingDimension(dimension);
        await adapter.createAgent({
          id: agentId,
          name: "Legacy owner",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await adapter.createEntities([{ id: entityId, agentId, names: ["Owner"] }]);
        await adapter.createRooms([
          { id: roomId, agentId, source: "test", type: ChannelType.GROUP },
        ]);
        const source = "Complete retained owner memory from before the embedding model migration.";
        const oldVector = Array.from({ length: dimension }, (_, index) => (index === 0 ? 1 : 0));
        const id = await adapter.createMemory(
          {
            id: randomUUID(),
            agentId,
            entityId,
            roomId,
            content: { text: source },
            embedding: oldVector,
            unique: false,
          },
          "messages",
        );
        const before = await adapter.getMemoryById(id);
        expect(before?.embedding).toEqual(oldVector);
        const existingEnv: Record<string, string> = {
          ELIZAOS_CLOUD_API_KEY: "existing-test-key",
          ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS: "1",
        };
        if (dimension === 384) {
          existingEnv.EMBEDDING_DIMENSION = "384";
          existingEnv.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS = "384";
        }
        await expect(
          prepareManagedElizaBaseEnvironment({
            existingEnv,
            organizationId: "org-test",
            userId: "owner-test",
            agentSandboxId: agentId,
          }),
        ).rejects.toMatchObject({ code: "MANAGED_EMBEDDING_MIGRATION_REQUIRED" });
        expect(mintedKeys).toBe(0);
        const after = await adapter.getMemoryById(id);
        expect(after?.content.text).toBe(source);
        expect(after?.embedding).toEqual(before?.embedding);
        expect(after?.embedding).toHaveLength(dimension);
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );
});
