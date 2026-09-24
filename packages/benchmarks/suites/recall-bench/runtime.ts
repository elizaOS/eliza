/**
 * recall-bench — a headless, secret-free REAL runtime (#9956).
 *
 * Builds an `AgentRuntime` backed by `@elizaos/plugin-sql` + PGlite (embedded
 * WASM Postgres with real pgvector cosine — no DB server, no secrets) and the
 * real `DocumentService`, with this bench's deterministic embedding registered
 * as the `TEXT_EMBEDDING` model. The bench drives the SAME `addDocument` /
 * `searchDocuments` / `searchMemories` code shipped to users — not a re-impl.
 *
 * Construction mirrors plugin-sql's own `createIsolatedTestDatabase` (the
 * canonical integration-test bootstrap): PGlite manager → adapter → runtime
 * (`enableDocuments`) → register adapter + embedding → run plugin migrations →
 * create the agent → `initialize()` (starts `DocumentService`).
 *
 * A mutable `embedMode` lets the fail-open slice flip the query embedder to
 * throw mid-run — so `embedRecallQuery` returns null and `_vectorSearch` falls
 * open to keyword, exactly the silent degradation #9956 asks us to make visible.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  type Character,
  DocumentService,
  ModelType,
  type UUID,
} from "@elizaos/core";
import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { embedText, RECALL_BENCH_EMBEDDING_DIM } from "./embedding.ts";

export type EmbedMode = "ok" | "throw";

export interface BenchRuntime {
  runtime: AgentRuntime;
  documents: DocumentService;
  agentId: UUID;
  /** Flip to "throw" to make the QUERY embedder fail (fail-open regression). */
  setEmbedMode(mode: EmbedMode): void;
  cleanup(): Promise<void>;
}

const BENCH_CHARACTER: Character = {
  name: "recall-bench",
  bio: ["A headless agent used to benchmark memory recall."],
};

/** Build + initialize the real runtime. Caller must `await cleanup()`. */
export async function buildBenchRuntime(): Promise<BenchRuntime> {
  const agentId = crypto.randomUUID() as UUID;
  const tempDir = mkdtempSync(join(tmpdir(), "recall-bench-"));

  // The factory creates an embedded PGlite (WASM Postgres) adapter — no server,
  // no secrets — and is the only public entry (the manager/adapter classes are
  // not re-exported). `init()` brings up the embedded database.
  const adapter = createDatabaseAdapter({ dataDir: tempDir }, agentId);
  await adapter.init();

  const runtime = new AgentRuntime({
    character: { ...BENCH_CHARACTER, id: undefined },
    agentId,
    plugins: [sqlPlugin],
    settings: { CTX_DOCUMENTS_ENABLED: "false" },
  });
  runtime.registerDatabaseAdapter(adapter);

  // Deterministic, secret-free embedding. A mutable mode lets the fail-open
  // slice make the QUERY embed throw without disturbing already-stored vectors.
  const mode = { current: "ok" as EmbedMode };
  runtime.registerModel(
    ModelType.TEXT_EMBEDDING,
    async (_rt: unknown, params: { text?: string } | string | null) => {
      const text = typeof params === "string" ? params : (params?.text ?? "");
      if (mode.current === "throw") {
        throw new Error("[recall-bench] forced embed failure (fail-open test)");
      }
      return embedText(text, RECALL_BENCH_EMBEDDING_DIM);
    },
    "recall-bench",
  );

  const migration = new DatabaseMigrationService();
  // biome-ignore lint/suspicious/noExplicitAny: drizzle db type is adapter-internal
  await migration.initializeWithDatabase(adapter.getDatabase() as any);
  migration.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migration.runAllPluginMigrations();

  const created = await adapter.createAgent({
    ...BENCH_CHARACTER,
    id: agentId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!created) throw new Error("[recall-bench] failed to create bench agent");

  await runtime.initialize();

  // Construct DocumentService directly against the real runtime (the pattern
  // core's own document-search test uses) — this drives the SAME ingest/search
  // code, and avoids the `getService` native-feature gate that a bare runtime
  // (no agent feature-wiring) leaves off. `start()` runs config validation +
  // the (disabled) startup loaders; we only need the ingest/search methods.
  const documents = await DocumentService.start(runtime);

  return {
    runtime,
    documents,
    agentId,
    setEmbedMode: (m) => {
      mode.current = m;
    },
    cleanup: async () => {
      try {
        await adapter.close();
      } finally {
        if (existsSync(tempDir))
          rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}
