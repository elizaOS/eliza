/**
 * `withMockLlmRuntime()` — the one-import test harness for driving a real
 * AgentRuntime turn through the deterministic mock LLM, at zero external cost.
 *
 * A plugin author writes a single import to get:
 *   - a fully-initialized {@link AgentRuntime} backed by a real in-process
 *     PGLite database (via `@elizaos/core/testing`'s `createRealTestRuntime`);
 *   - the deterministic LLM proxy ({@link createDeterministicLlmProxyPlugin})
 *     registered at `priority: 1000` so it wins model dispatch for every text
 *     `ModelType` plus `TEXT_EMBEDDING` — no provider key, no network;
 *   - their plugin(s) under test registered alongside;
 *   - the fixture registry + `assertFixturesConsumed()` + diagnostics bolted
 *     onto the result so the test can declare exactly what the model returns.
 *
 * `strict` defaults to `true`: every model call must match a declared fixture
 * or the proxy throws with full diagnostics. That is the contract — a
 * deterministic e2e where each LLM call is spelled out, correct *and*
 * incorrect (see `./negative-fixtures.ts` for the adversarial pack).
 *
 * @example
 * ```ts
 * import { withMockLlmRuntime } from "@elizaos/test-harness";
 *
 * const harness = await withMockLlmRuntime({
 *   plugins: [myPlugin],
 *   fixtures: [{ name: "small", match: { modelType: ModelType.TEXT_SMALL }, response: "ok" }],
 * });
 * try {
 *   const out = await harness.runtime.useModel(ModelType.TEXT_SMALL, { prompt: "hi" });
 *   harness.assertFixturesConsumed();
 * } finally {
 *   await harness.cleanup();
 * }
 * ```
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { createRealTestRuntime } from "@elizaos/core/testing";
import {
  createDeterministicLlmProxyPlugin,
  type DeterministicLlmFixtureRegistry,
  type LlmProxyFixture,
  type LlmProxyFixtureDiagnostics,
} from "../mocks/helpers/llm-proxy-plugin.ts";

/** Default embedding length. Kept small so PGLite vector inserts stay cheap. */
const DEFAULT_EMBEDDING_DIMENSIONS = 384;

export interface WithMockLlmRuntimeOptions {
  /** Plugin(s) under test, registered after `plugin-sql` and the proxy. */
  plugins?: Plugin[];
  /** Fixtures registered on the proxy before the runtime boots. */
  fixtures?: LlmProxyFixture[];
  /**
   * Fail-closed on any unmatched / multi-matched model call. Default `true` —
   * the whole point of a deterministic e2e is that every LLM call is declared.
   * Set `false` only to lean on the proxy's heuristic action-planner fallback.
   */
  strict?: boolean;
  /** Test agent character name. Default `"MockLlmTestAgent"`. */
  characterName?: string;
  /**
   * Embedding vector length. Must match the runtime's configured embedding
   * dimension so PGLite vector inserts succeed. Default {@link DEFAULT_EMBEDDING_DIMENSIONS}.
   */
  embeddingDimensions?: number;
  /** Reuse an existing PGLite data directory instead of a fresh temp dir. */
  pgliteDir?: string;
}

export interface MockLlmRuntime {
  /** A real, fully-initialized AgentRuntime — PGLite-backed, mock-LLM-driven. */
  runtime: IAgentRuntime;
  /** The proxy's fixture registry — register more fixtures mid-test. */
  fixtures: DeterministicLlmFixtureRegistry;
  /** Throws if any `required` fixture went unconsumed or bounds went unmet. */
  assertFixturesConsumed: () => void;
  /** Per-call / per-fixture diagnostics for debugging a failed match. */
  getFixtureDiagnostics: () => LlmProxyFixtureDiagnostics;
  /** The PGLite data directory backing this runtime. */
  pgliteDir: string;
  /** Stops the runtime and removes the temp PGLite directory. */
  cleanup: () => Promise<void>;
}

function resolveEmbeddingDimensions(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const fromEnv =
    process.env.EMBEDDING_DIMENSION?.trim() ||
    process.env.LOCAL_EMBEDDING_DIMENSIONS?.trim();
  const parsed = fromEnv ? Number.parseInt(fromEnv, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EMBEDDING_DIMENSIONS;
}

/**
 * Boot a PGLite-backed AgentRuntime wired to the deterministic mock LLM and the
 * caller's plugins. Always call {@link MockLlmRuntime.cleanup} in a `finally`.
 */
export async function withMockLlmRuntime(
  options: WithMockLlmRuntimeOptions = {},
): Promise<MockLlmRuntime> {
  const strict = options.strict ?? true;
  const embeddingDimensions = resolveEmbeddingDimensions(
    options.embeddingDimensions,
  );

  // Pin the runtime's embedding dimension to the proxy's zero-vector length so
  // PGLite's vector column and the mock embeddings agree. Set before the
  // runtime boots so createRealTestRuntime does not pick its own default.
  process.env.EMBEDDING_DIMENSION = String(embeddingDimensions);
  process.env.LOCAL_EMBEDDING_DIMENSIONS = String(embeddingDimensions);

  const proxy = createDeterministicLlmProxyPlugin({
    strict,
    embeddingDimensions,
    fixtures: options.fixtures,
  });

  const { runtime, pgliteDir, cleanup } = await createRealTestRuntime({
    characterName: options.characterName ?? "MockLlmTestAgent",
    withLLM: false,
    plugins: [proxy, ...(options.plugins ?? [])],
    pgliteDir: options.pgliteDir,
  });

  return {
    runtime,
    fixtures: proxy.llmFixtures,
    assertFixturesConsumed: proxy.assertFixturesConsumed,
    getFixtureDiagnostics: proxy.getFixtureDiagnostics,
    pgliteDir,
    cleanup,
  };
}
