/**
 * D10 — lean-chat local-state cloud agent boot, end-to-end.
 *
 * The pure env test (`managed-eliza-config.test.ts`) only checks the env VARS
 * `prepareManagedElizaBaseEnvironment` emits. This test takes that SAME env and
 * drives it through the DOWNSTREAM consumers a real container boot would hit, so
 * it catches an end-to-end REVERT of the #8779-restored fixes that the pure env
 * test cannot:
 *
 *   1. DB ADAPTER = PGlite. With the managed env's NO `DATABASE_URL` (and no
 *      `POSTGRES_URL`), `@elizaos/plugin-sql`'s `createDatabaseAdapter` must pick
 *      the embedded PGlite adapter — not the shared remote Postgres. (A revert
 *      that leaks `DATABASE_URL` back in would flip this and is the exact #8783
 *      regression.)
 *   2. PLUGIN SET = lean. `@elizaos/agent`'s `collectPluginNames`, driven by the
 *      env's `ELIZA_PLUGIN_SET=lean-chat` + `ELIZAOS_CLOUD_*`, must EXCLUDE
 *      local-inference / wallet / workflow but INCLUDE elizacloud (#8434).
 *   3. EMBEDDING COLUMN = dim1536. The env pins `EMBEDDING_DIMENSION=1536` so the
 *      cloud embedding model's 1536-d vectors land in the `dim_1536` column. We
 *      boot a REAL in-memory PGlite adapter, snap it to the env's dimension, and
 *      prove a 1536-d memory insert SUCCEEDS — while a 384-d insert hits the
 *      "dimension mismatch" guard (the negative control). A revert to the dim_384
 *      default reproduces the "Failed query: insert into embeddings" incident.
 *
 * Only `apiKeysService.createForAgent` is mocked (it needs the cloud DB to mint a
 * key, irrelevant to this chain) — exactly as the sibling pure-env test does.
 * Everything else is the real env-producer + real plugin-set resolver + real
 * PGlite adapter with real migrations. Runs in plain `bun test` (PGlite is
 * in-process WASM; no external Postgres).
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
  test("managed env pins local state + lean chat + 1536-d embeddings (no DATABASE_URL)", async () => {
    const env = await buildManagedEnv();
    expect(env.ELIZA_AGENT_LOCAL_STATE).toBe("1");
    expect(env.ELIZA_PLUGIN_SET).toBe("lean-chat");
    expect(env.EMBEDDING_DIMENSION).toBe("1536");
    expect(env.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS).toBe("1536");
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

  test("(2) resolved lean-chat plugin set excludes local-inference/wallet/workflow, includes elizacloud", async () => {
    const env = await buildManagedEnv();
    // The plugin resolver reads these signals from process.env directly.
    Object.assign(process.env, env);
    // ELIZA_CLOUD_PROVISIONED is set by the provisioning path, not the env
    // producer; the container always boots with it. Mirror that here.
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    // Must not be mobile (lean-chat only applies off-mobile).
    delete process.env.ELIZA_PLATFORM;

    const { collectPluginNames } = await import("@elizaos/agent/runtime");
    const plugins = [...collectPluginNames({} as never)];

    const has = (needle: string) => plugins.some((p) => p.includes(needle));
    expect(has("plugin-elizacloud")).toBe(true);
    expect(has("plugin-local-inference")).toBe(false);
    expect(has("plugin-wallet")).toBe(false);
    expect(has("plugin-workflow")).toBe(false);
  }, 30_000);

  test("(3) a 1536-d memory insert lands in the dim1536 column (not 'dimension mismatch')", async () => {
    const env = await buildManagedEnv();
    const dimension = Number(env.EMBEDDING_DIMENSION);
    expect(dimension).toBe(1536);

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

      // Snap the active embedding column to the env's dimension (1536) — the
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
        // itself throw a vector-width error against the dim1536 column for a
        // 384-d vector) so the test isolates the insert-path dimension guard.
        unique: false,
        createdAt: Date.now(),
        metadata: { type: "custom", source: "test" },
      });

      // A 1536-d vector matches the dim1536 column → the embedding insert runs.
      const okId = await adapter.createMemory(makeMemory(1536) as never, "messages");
      expect(okId).toBeTruthy();
      // The embedding row actually landed (proves it wasn't silently skipped):
      // getMemoryById joins on the active `dim_1536` column.
      const withEmbedding = await adapter.getMemoryById(okId);
      expect(withEmbedding?.embedding?.length).toBe(1536);

      // Negative control: a 384-d vector against the dim1536 column trips the
      // insert-path "dimension mismatch" guard — the memory row persists, the
      // embedding does NOT. Confirms the dim1536 column is the one in effect (a
      // revert to the dim_384 default would flip both assertions).
      const mismatchId = await adapter.createMemory(makeMemory(384) as never, "messages");
      const mismatch = await adapter.getMemoryById(mismatchId);
      expect(mismatch).toBeTruthy();
      expect(mismatch?.embedding ?? []).toHaveLength(0);
    } finally {
      await adapter.close();
    }
  }, 60_000);
});
