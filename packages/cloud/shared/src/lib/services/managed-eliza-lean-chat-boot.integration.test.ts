/**
 * Exercises managed configuration through canonical runtime routing, plugin
 * collection, and real in-memory PGlite migrations and vector storage. Credential
 * minting is a fixture; this does not start a container or inference provider.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";

mock.module("./api-keys", () => ({
  apiKeysService: {
    createForAgent: async () => ({ plainKey: "agent-api-key" }),
  },
}));

/** Snapshot + restore process.env so applying the managed env doesn't leak. */
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
});

// Resolve production modules before the timed behavior case; importing the
// entire host graph is preparation, not plugin-selection execution.
const { buildManagedElizaRuntimeConfig } = await import("./docker-sandbox-provider");
const { applyCloudConfigToEnv, collectPluginNames } = await import("@elizaos/agent/runtime");

async function buildManagedEnv(): Promise<Record<string, string>> {
  const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");
  // No existingEnv DATABASE_URL — a freshly-provisioned local-state agent. The
  // producer strips DATABASE_URL/ELIZA_MANAGED_DATABASE_URL regardless.
  const result = await prepareManagedElizaBaseEnvironment({
    existingEnv: {},
    organizationId: "org-d10",
    userId: "user-d10",
    agentSandboxId: randomUUID(),
  });
  return result.environmentVars;
}

describe("D10 lean-chat local-state cloud agent boot — end-to-end", () => {
  test("managed env pins local state + lean chat + 384-d local embeddings (no DATABASE_URL)", async () => {
    const env = await buildManagedEnv();
    expect(env.ELIZA_AGENT_LOCAL_STATE).toBe("1");
    expect(env.ELIZA_PLUGIN_SET).toBe("lean-chat");
    // Fresh provision (no ELIZAOS_CLOUD_API_KEY in existingEnv) => local-primary
    // BGE-small embeddings, 384-d hints, cloud embeddings off.
    expect(env.EMBEDDING_DIMENSION).toBe("384");
    expect(env.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS).toBe("384");
    expect(env.ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS).toBe("1");
    expect(env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("false");
    expect(env.ELIZAOS_CLOUD_ENABLED).toBe("true");
    // The load-bearing absence: the producer must NOT carry DATABASE_URL.
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ELIZA_MANAGED_DATABASE_URL).toBeUndefined();
  });

  test("(1) DB adapter resolves to PGlite when the managed env has no DATABASE_URL", async () => {
    const env = await buildManagedEnv();
    Object.assign(process.env, env);
    // The managed env never sets POSTGRES_URL/DATABASE_URL for a local-state
    // agent. In the full `bun run test`, the harness sets a test POSTGRES_URL/
    // DATABASE_URL for DB-backed packages; that ambient value leaks into this
    // process (this suite passes in isolation, fails in-suite). Clear the
    // ambient DB urls so the "no DATABASE_URL" path is tested deterministically;
    // the `env.DATABASE_URL` check below still guards the #8783
    // producer-strips-DATABASE_URL regression, and afterEach restores env.
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    delete process.env.ELIZA_MANAGED_DATABASE_URL;
    // plugin-sql keys adapter choice on the resolved postgres url.
    const postgresUrl = process.env.POSTGRES_URL || env.DATABASE_URL;
    expect(postgresUrl).toBeFalsy();

    const { createDatabaseAdapter } = await import("@elizaos/plugin-sql");
    const adapter = createDatabaseAdapter({ dataDir: ":memory:", postgresUrl }, randomUUID());
    // PgliteDatabaseAdapter is not exported for instanceof; assert by ctor name.
    expect(adapter.constructor.name).toBe("PgliteDatabaseAdapter");
  });

  test("(2) resolved lean-chat plugin set retains the local TEXT_EMBEDDING owner", async () => {
    const env = await buildManagedEnv();
    // The plugin resolver reads these signals from process.env directly.
    // Managed env producer always injects ELIZA_CLOUD_PROVISIONED=1 so the
    // agent/UI can detect managed Cloud vs user-owned installs.
    Object.assign(process.env, env);
    expect(process.env.ELIZA_CLOUD_PROVISIONED).toBe("1");
    // Must not be mobile (lean-chat only applies off-mobile).
    delete process.env.ELIZA_PLATFORM;

    // PID1 applies persisted canonical routing before it resolves plugins.
    const config = buildManagedElizaRuntimeConfig(env);
    applyCloudConfigToEnv(config);
    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("false");
    const plugins = [...collectPluginNames(config)];

    const has = (needle: string) => plugins.some((p) => p.includes(needle));
    expect(has("plugin-elizacloud")).toBe(true);
    expect(has("plugin-local-inference")).toBe(true);
    expect(has("plugin-wallet")).toBe(false);
    expect(has("plugin-workflow")).toBe(false);
  }, 30_000);

  test("(3) a 384-d memory insert lands in the dim384 column (not 'dimension mismatch')", async () => {
    const env = await buildManagedEnv();
    const dimension = Number(env.EMBEDDING_DIMENSION);
    expect(dimension).toBe(384);

    const { createDatabaseAdapter, DatabaseMigrationService, plugin } = await import(
      "@elizaos/plugin-sql"
    );

    const agentId = randomUUID();
    const adapter = createDatabaseAdapter({ dataDir: ":memory:" }, agentId);
    await adapter.init();
    try {
      // Real migrations create the embeddings table with the per-dimension cols.
      const db = adapter.getDatabase();
      const migrations = new DatabaseMigrationService();
      await migrations.initializeWithDatabase(db);
      migrations.discoverAndRegisterPluginSchemas([plugin]);
      await migrations.runAllPluginMigrations();

      // Snap the active embedding column to the env's dimension (384) — the
      // same call core's ensureEmbeddingDimension makes from EMBEDDING_DIMENSION.
      await adapter.ensureEmbeddingDimension(dimension);

      await adapter.createAgent({
        id: agentId,
        name: "d10",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never);
      const entityId = randomUUID();
      await adapter.createEntities([{ id: entityId, agentId, names: ["E"] } as never]);
      const roomId = randomUUID();
      await adapter.createRooms([
        { id: roomId, agentId, name: "R", source: "test", type: "GROUP" } as never,
      ]);

      const makeMemory = (len: number) => ({
        id: randomUUID(),
        agentId,
        entityId,
        roomId,
        content: { text: `vec-${len}` },
        embedding: Array.from({ length: len }, () => 0.01),
        // unique:false skips the costly uniqueness similarity search (which would
        // itself throw a vector-width error against the dim384 column for a
        // 1536-d vector) so the test isolates the insert-path dimension guard.
        unique: false,
        createdAt: Date.now(),
        metadata: { type: "custom", source: "test" },
      });

      // A 384-d vector matches the dim384 column → the embedding insert runs.
      const okId = await adapter.createMemory(makeMemory(384) as never, "messages");
      expect(okId).toBeTruthy();
      // The embedding row actually landed (proves it wasn't silently skipped):
      // getMemoryById joins on the active `dim_384` column.
      const withEmbedding = await adapter.getMemoryById(okId);
      expect(withEmbedding?.embedding?.length).toBe(384);

      // Negative control: a 1536-d vector against the dim384 column trips the
      // insert-path "dimension mismatch" guard — the memory row persists, the
      // embedding does NOT. Together these assertions prove the dim384 column
      // is the active fresh-provision contract.
      const mismatchId = await adapter.createMemory(makeMemory(1536) as never, "messages");
      const mismatch = await adapter.getMemoryById(mismatchId);
      expect(mismatch).toBeTruthy();
      expect(mismatch?.embedding ?? []).toHaveLength(0);
    } finally {
      await adapter.close();
    }
  }, 60_000);
});
