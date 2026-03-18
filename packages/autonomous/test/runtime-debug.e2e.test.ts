import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { AgentRuntime, createCharacter, logger, ModelType, type Plugin } from "@elizaos/core";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, "..", "..", ".env") });

const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);

describe("Runtime init debug", () => {
  it("find the hang in initialize()", async () => {
    if (!hasOpenAI) return;

    logger.level = "warn";

    const character = createCharacter({
      name: "DebugAgent",
      bio: "Debug test",
      secrets: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
    });

    const sqlMod = await import("@elizaos/plugin-sql");
    const sqlPlugin = (sqlMod.default?.default || sqlMod.default || sqlMod) as Plugin;

    const openaiMod = await import("@elizaos/plugin-openai");
    const openaiPlugin = (openaiMod.default?.default || openaiMod.default || openaiMod) as Plugin;

    const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-pglite-"));
    process.env.PGLITE_DATA_DIR = pgliteDir;

    const t0 = Date.now();
    const elapsed = () => `${Date.now()-t0}ms`;

    const runtime = new AgentRuntime({
      character,
      plugins: [sqlPlugin, openaiPlugin],
      logLevel: "warn",
      enableAutonomy: false,
    });

    // Instrument key methods
    const wrap = (obj: any, method: string, label: string) => {
      const orig = obj[method]?.bind(obj);
      if (!orig) return;
      obj[method] = async (...args: any[]) => {
        console.log(`[${elapsed()}] >>> ${label}`);
        const result = await orig(...args);
        console.log(`[${elapsed()}] <<< ${label}`);
        return result;
      };
    };

    // Wrap adapter methods
    if (runtime.adapter) {
      wrap(runtime.adapter, 'isReady', 'adapter.isReady');
      wrap(runtime.adapter, 'initialize', 'adapter.initialize');
    }

    // Wrap runtime methods
    wrap(runtime, 'runPluginMigrations', 'runPluginMigrations');
    wrap(runtime, 'ensureAgentExists', 'ensureAgentExists');
    wrap(runtime, 'ensureEmbeddingDimension', 'ensureEmbeddingDimension');
    wrap(runtime, 'useModel', 'useModel');
    wrap(runtime, 'getRoom', 'getRoom');
    wrap(runtime, 'createEntity', 'createEntity');

    console.log(`[${elapsed()}] Calling initialize()...`);

    const initPromise = runtime.initialize();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("TIMEOUT: init took > 30s")), 30_000);
    });

    try {
      await Promise.race([initPromise, timeoutPromise]);
      console.log(`[${elapsed()}] initialize() complete!`);
    } catch (e: any) {
      console.log(`[${elapsed()}] ERROR: ${e.message}`);
      throw e;
    }

    expect(runtime.agentId).toBeTruthy();
    fs.rmSync(pgliteDir, { recursive: true, force: true });
  }, 60_000);
});
