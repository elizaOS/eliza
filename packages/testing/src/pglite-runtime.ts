/**
 * Shared PGLite runtime helper for tests.
 *
 * Creates a real AgentRuntime backed by an in-process PGLite database.
 * Use this instead of mocking the database — PGLite needs no API keys
 * and runs entirely in-process.
 *
 * Usage:
 *   let runtime: AgentRuntime;
 *   let cleanup: () => Promise<void>;
 *
 *   beforeAll(async () => {
 *     ({ runtime, cleanup } = await createTestRuntime());
 *   }, 180_000);
 *
 *   afterAll(async () => {
 *     await cleanup();
 *   });
 */

import fs from "node:fs";
import type { Plugin, RuntimeSettings } from "@elizaos/core";
import { AgentRuntime, createCharacter, ElizaError } from "@elizaos/core";
import {
  createTestPgliteDataDir,
  isInMemoryPgliteDataDir,
} from "./pglite-storage.ts";

export interface TestRuntimeOptions {
  /** Host-owned lifecycle and transport setup before plugin registration. */
  configureRuntime?: (runtime: AgentRuntime) => void | Promise<void>;
  /** Name for the test agent character. Defaults to "TestAgent". */
  characterName?: string;
  /** Runtime settings available before plugin registration and service startup. */
  settings?: RuntimeSettings;
  /** Explicit autonomous execution; disabled by default in fixtures. */
  enableAutonomy?: boolean;
  /** Additional plugins to register (plugin-sql is always included). */
  plugins?: Plugin[];
  /** Embedding width shared by the database vector schema and model provider. */
  embeddingDimensions?: number;
  /**
   * Reuse an existing PGLite data directory instead of the default per-call
   * in-memory database. Pass a real directory when the test proves restart
   * persistence; otherwise omit it and the runtime gets a unique `memory://`
   * store (see ./pglite-storage).
   */
  pgliteDir?: string;
  /**
   * Remove the PGLite data directory during cleanup.
   * Defaults to true only when this helper created the directory.
   */
  removePgliteDirOnCleanup?: boolean;
  /**
   * Host-injected trajectory-write flush (the agent's `flushTrajectoryWrites`),
   * awaited during cleanup before the runtime stops. Injected so this core
   * `./testing` export never imports `@elizaos/agent` src (a reverse dependency
   * edge that silently degrades outside the monorepo checkout). When omitted,
   * cleanup relies on draining the trajectories service's own write queues.
   */
  flushTrajectoryWrites?: (runtime: AgentRuntime) => Promise<void>;
}

export interface TestRuntimeResult {
  runtime: AgentRuntime;
  /** Data dir backing the runtime: a `memory://` URL unless the caller passed a directory. */
  pgliteDir: string;
  /** Stops the runtime and removes the temp PGLite directory. */
  cleanup: () => Promise<void>;
}

type TrajectoryWriteService = {
  writeQueues?: Map<string, Promise<void>>;
};

type RuntimePluginModule = {
  default?: Plugin;
  elizaPlugin?: Plugin;
};

async function flushPendingTrajectoryWrites(
  runtime: AgentRuntime,
  flushTrajectoryWrites?: (runtime: AgentRuntime) => Promise<void>,
): Promise<void> {
  if (flushTrajectoryWrites) {
    await flushTrajectoryWrites(runtime);
  }

  for (;;) {
    const pending = runtime
      .getServicesByType("trajectories")
      .flatMap((service) => {
        const writeQueues = (service as TrajectoryWriteService).writeQueues;
        return writeQueues instanceof Map
          ? Array.from(writeQueues.values())
          : [];
      });
    if (pending.length === 0) {
      return;
    }
    const outcomes = await Promise.allSettled(pending);
    const failures = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (failures.length)
      throw new AggregateError(failures, "Trajectory writes failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Create a real AgentRuntime with a PGLite database in a temp directory.
 *
 * The runtime is fully initialized and ready for use. Call `cleanup()` in
 * afterAll to stop the runtime and remove the temp directory.
 *
 * Callers should use a generous timeout (e.g. `beforeAll(async () => { ... }, 180_000)`)
 * since PGLite initialization can take a few seconds.
 */
export async function createTestRuntime(
  options?: TestRuntimeOptions,
): Promise<TestRuntimeResult> {
  if (
    options?.embeddingDimensions !== undefined &&
    (!Number.isSafeInteger(options.embeddingDimensions) ||
      options.embeddingDimensions <= 0)
  ) {
    throw new ElizaError("embeddingDimensions must be a positive integer", {
      code: "TEST_RUNTIME_INVALID_DIMENSIONS",
    });
  }
  const pgliteDir =
    options?.pgliteDir ?? createTestPgliteDataDir("eliza-test-pglite-");
  const removePgliteDirOnCleanup =
    options?.removePgliteDirOnCleanup ??
    (options?.pgliteDir === undefined && !isInMemoryPgliteDataDir(pgliteDir));
  let runtime: AgentRuntime | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      const failures: unknown[] = [];
      if (runtime) {
        const owned = runtime;
        for (const drain of [
          () =>
            flushPendingTrajectoryWrites(owned, options?.flushTrajectoryWrites),
          () => owned.stop(),
          () =>
            flushPendingTrajectoryWrites(owned, options?.flushTrajectoryWrites),
          () => owned.close(),
        ]) {
          try {
            await drain();
          } catch (error) {
            // error-policy:J6 Finish teardown before reporting every failure.
            failures.push(error);
          }
        }
      }
      if (removePgliteDirOnCleanup && !isInMemoryPgliteDataDir(pgliteDir)) {
        try {
          fs.rmSync(pgliteDir, { recursive: true, force: true });
        } catch (error) {
          // error-policy:J6 Directory removal failure is part of teardown evidence.
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Test runtime teardown failed");
    })();
    return cleanupPromise;
  };
  try {
    runtime = new AgentRuntime({
      character: createCharacter({
        name: options?.characterName ?? "TestAgent",
      }),
      plugins: [],
      settings: options?.settings,
      enableAutonomy: options?.enableAutonomy ?? false,
      logLevel: "warn",
    });
    for (const [key, value] of Object.entries({
      ...options?.settings?.values,
      ...options?.settings,
    })) {
      if (typeof value === "string" || typeof value === "boolean") {
        runtime.setSetting(
          key,
          value,
          /(API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key),
        );
      }
    }
    // Pin storage on this runtime; never redirect other fixtures through process.env.
    runtime.setSetting("PGLITE_DATA_DIR", pgliteDir);
    runtime.setSetting("POSTGRES_URL", "");
    if (options?.embeddingDimensions !== undefined) {
      const dimension = String(options.embeddingDimensions);
      for (const key of [
        "EMBEDDING_DIMENSION",
        "EMBEDDING_DIMENSIONS",
        "LOCAL_EMBEDDING_DIMENSIONS",
      ]) {
        runtime.setSetting(key, dimension);
      }
    }
    await options?.configureRuntime?.(runtime);
    const pluginSqlModule = (await import(
      ["@elizaos", "plugin-sql"].join("/")
    )) as RuntimePluginModule;
    const pluginSql = pluginSqlModule.default ?? pluginSqlModule.elizaPlugin;
    if (!pluginSql)
      throw new ElizaError("plugin-sql did not export a plugin", {
        code: "TEST_RUNTIME_PLUGIN_INVALID",
      });
    await runtime.registerPlugin(pluginSql);
    for (const plugin of options?.plugins ?? [])
      await runtime.registerPlugin(plugin);
    await runtime.initialize();
    return { runtime, pgliteDir, cleanup };
  } catch (error) {
    // error-policy:J6 Roll back partial initialization without hiding its original failure.
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Test runtime initialization and rollback failed",
      );
    }
    throw error;
  }
}
