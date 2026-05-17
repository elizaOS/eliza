import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  createCharacter,
  logger,
  type Plugin,
} from "@elizaos/core";
import dotenv from "dotenv";
import { expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";
import { selectLiveProvider } from "../helpers/live-provider.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, "..", "..", ".env") });

const liveModelTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const selectedLiveProvider = liveModelTestsEnabled
  ? selectLiveProvider()
  : null;
const shouldRunRuntimeDebug =
  liveModelTestsEnabled && selectedLiveProvider !== null;

describeIf(shouldRunRuntimeDebug)("Runtime init debug", () => {
  it("find the hang in initialize()", async () => {
    logger.level = "warn";
    if (!selectedLiveProvider) {
      throw new Error("No live model provider configured.");
    }
    for (const [key, value] of Object.entries(selectedLiveProvider.env)) {
      process.env[key] = value;
    }

    const character = createCharacter({
      name: "DebugAgent",
      bio: "Debug test",
      secrets: { ...selectedLiveProvider.env },
    });

    const sqlMod = await import("@elizaos/plugin-sql");
    const sqlPlugin = (sqlMod.default?.default ||
      sqlMod.default ||
      sqlMod) as Plugin;

    const modelMod = await import(selectedLiveProvider.pluginPackage);
    const modelPlugin = (modelMod.default?.default ||
      modelMod.default ||
      modelMod) as Plugin;

    const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-pglite-"));
    process.env.PGLITE_DATA_DIR = pgliteDir;

    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;

    const runtime = new AgentRuntime({
      character,
      plugins: [sqlPlugin, modelPlugin],
      logLevel: "warn",
      enableAutonomy: false,
    });

    // Instrument key methods
    const wrap = (
      obj: Record<string, ((...a: unknown[]) => unknown) | undefined>,
      method: string,
      label: string,
    ) => {
      const orig = obj[method]?.bind(obj);
      if (!orig) return;
      obj[method] = async (...args: unknown[]) => {
        console.log(`[${elapsed()}] >>> ${label}`);
        const result = await orig(...args);
        console.log(`[${elapsed()}] <<< ${label}`);
        return result;
      };
    };

    // Wrap adapter methods
    if (runtime.adapter) {
      wrap(runtime.adapter, "isReady", "adapter.isReady");
      wrap(runtime.adapter, "initialize", "adapter.initialize");
    }

    // Wrap runtime methods
    wrap(runtime, "runPluginMigrations", "runPluginMigrations");
    wrap(runtime, "ensureAgentExists", "ensureAgentExists");
    wrap(runtime, "ensureEmbeddingDimension", "ensureEmbeddingDimension");
    wrap(runtime, "useModel", "useModel");
    wrap(runtime, "getRoom", "getRoom");
    wrap(runtime, "createEntity", "createEntity");

    console.log(`[${elapsed()}] Calling initialize()...`);

    const initPromise = runtime.initialize();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("TIMEOUT: init took > 30s")), 30_000);
    });

    try {
      await Promise.race([initPromise, timeoutPromise]);
      console.log(`[${elapsed()}] initialize() complete!`);
    } catch (e: unknown) {
      console.log(`[${elapsed()}] ERROR: ${(e as Error).message}`);
      throw e;
    }

    expect(runtime.agentId).toBeTruthy();
    fs.rmSync(pgliteDir, { recursive: true, force: true });
  }, 60_000);
});
