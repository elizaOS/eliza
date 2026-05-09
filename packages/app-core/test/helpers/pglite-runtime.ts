/** Builds a real AgentRuntime backed by an in-process PGLite database. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "@elizaos/core";
import { AgentRuntime, createCharacter, logger } from "@elizaos/core";

const helperDir = path.dirname(fileURLToPath(import.meta.url));

export interface TestRuntimeOptions {
  /** Name for the test agent character. Defaults to "TestAgent". */
  characterName?: string;
  /** Additional plugins to register (plugin-sql is always included). */
  plugins?: Plugin[];
  /** Reuse an existing PGLite data directory instead of creating a temp one. */
  pgliteDir?: string;
  /**
   * Remove the PGLite data directory during cleanup.
   * Defaults to true only when this helper created the directory.
   */
  removePgliteDirOnCleanup?: boolean;
}

export interface TestRuntimeResult {
  runtime: AgentRuntime;
  pgliteDir: string;
  /** Stops the runtime and removes the temp PGLite directory. */
  cleanup: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPendingTrajectoryWrites(service: unknown): Promise<void>[] {
  if (!isRecord(service)) {
    return [];
  }

  const { writeQueues } = service;
  if (!(writeQueues instanceof Map)) {
    return [];
  }

  return Array.from(writeQueues.values()).filter(
    (pending): pending is Promise<void> => pending instanceof Promise,
  );
}

async function importPluginSql(): Promise<Plugin> {
  try {
    const { default: pluginSql } = await import("@elizaos/plugin-sql");
    return pluginSql as Plugin;
  } catch (packageError) {
    const fallbackPath = path.resolve(
      helperDir,
      "../../../../plugins/plugin-sql/src/index.node.ts",
    );
    try {
      const { default: pluginSql } = await import(
        pathToFileURL(fallbackPath).href
      );
      return pluginSql as Plugin;
    } catch (fallbackError) {
      const packageMessage =
        packageError instanceof Error
          ? packageError.message
          : String(packageError);
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new Error(
        `Failed to import @elizaos/plugin-sql. Package import: ${packageMessage}; fallback ${fallbackPath}: ${fallbackMessage}`,
      );
    }
  }
}

async function flushPendingTrajectoryWrites(
  runtime: AgentRuntime,
): Promise<void> {
  try {
    const { flushTrajectoryWrites } = await import(
      "../../eliza/agent/src/runtime/trajectory-storage"
    );
    await flushTrajectoryWrites(runtime);
  } catch {
    // Some test runtimes do not register this helper.
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pending = runtime
      .getServicesByType("trajectories")
      .flatMap((service) => getPendingTrajectoryWrites(service));
    if (pending.length === 0) {
      return;
    }
    await Promise.allSettled(pending);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Creates a fully initialized PGLite-backed runtime for integration tests. */
export async function createTestRuntime(
  options?: TestRuntimeOptions,
): Promise<TestRuntimeResult> {
  const pgliteDir =
    options?.pgliteDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "eliza-test-pglite-"));
  const removePgliteDirOnCleanup =
    options?.removePgliteDirOnCleanup ?? options?.pgliteDir === undefined;

  const prevPgliteDir = process.env.PGLITE_DATA_DIR;
  process.env.PGLITE_DATA_DIR = pgliteDir;

  const character = createCharacter({
    name: options?.characterName ?? "TestAgent",
  });

  const runtime = new AgentRuntime({
    character,
    plugins: [],
    logLevel: "warn",
    enableAutonomy: false,
  });

  await runtime.registerPlugin(await importPluginSql());
  for (const plugin of options?.plugins ?? []) {
    await runtime.registerPlugin(plugin);
  }
  await runtime.initialize();

  const cleanup = async () => {
    try {
      await flushPendingTrajectoryWrites(runtime);
    } catch (err) {
      logger.debug(`[test] trajectory flush error: ${err}`);
    }
    try {
      await runtime.stop();
    } catch (err) {
      logger.debug(`[test] runtime.stop() error: ${err}`);
    }
    try {
      await flushPendingTrajectoryWrites(runtime);
    } catch (err) {
      logger.debug(`[test] post-stop trajectory flush error: ${err}`);
    }
    try {
      await runtime.close();
    } catch (err) {
      logger.debug(`[test] runtime.close() error: ${err}`);
    }
    // Restore previous env
    if (prevPgliteDir !== undefined) {
      process.env.PGLITE_DATA_DIR = prevPgliteDir;
    } else {
      delete process.env.PGLITE_DATA_DIR;
    }
    if (removePgliteDirOnCleanup) {
      try {
        fs.rmSync(pgliteDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  };

  return { runtime, pgliteDir, cleanup };
}
