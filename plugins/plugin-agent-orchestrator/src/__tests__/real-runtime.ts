/**
 * PGlite-backed AgentRuntime factory for orchestrator integration tests. The
 * SQL plugin is imported from source so pre-build coverage lanes exercise the
 * same runtime boundary without depending on absent workspace dist artifacts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, createCharacter, type Plugin } from "@elizaos/core";
import pluginSql from "../../../plugin-sql/src/index.ts";

export async function createRealTestRuntime(options: {
  characterName: string;
  plugins?: Plugin[];
}): Promise<{ runtime: AgentRuntime; cleanup: () => Promise<void> }> {
  const pgliteDir = mkdtempSync(join(tmpdir(), "orchestrator-test-pglite-"));
  const previousPgliteDir = process.env.PGLITE_DATA_DIR;
  process.env.PGLITE_DATA_DIR = pgliteDir;

  const runtime = new AgentRuntime({
    character: createCharacter({ name: options.characterName }),
    plugins: [],
    logLevel: "warn",
    enableAutonomy: false,
  });
  await runtime.registerPlugin(pluginSql);
  for (const plugin of options.plugins ?? []) {
    await runtime.registerPlugin(plugin);
  }
  await runtime.initialize();

  const cleanup = async (): Promise<void> => {
    try {
      await runtime.stop();
    } finally {
      try {
        await runtime.close();
      } finally {
        if (previousPgliteDir === undefined) {
          delete process.env.PGLITE_DATA_DIR;
        } else {
          process.env.PGLITE_DATA_DIR = previousPgliteDir;
        }
        rmSync(pgliteDir, { recursive: true, force: true });
      }
    }
  };

  return { runtime, cleanup };
}
