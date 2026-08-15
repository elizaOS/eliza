/**
 * Proves the POST /api/restore HTTP boundary rebuilds the live runtime after
 * replacing PGlite files, using a real snapshot, TCP API host, and PGlite dump.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { AgentRuntime, InMemoryDatabaseAdapter } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { startApiServer } from "./server.ts";

const API_TOKEN = "restore-runtime-restart-token";
const touchedEnv = [
  "DATABASE_URL",
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_STATE_DIR",
  "PGLITE_DATA_DIR",
  "POSTGRES_URL",
] as const;
const originalEnv = new Map<string, string | undefined>();

class PgliteDumpAdapter extends InMemoryDatabaseAdapter {
  constructor(private readonly dump: Blob) {
    super();
  }

  getRawConnection(): unknown {
    return { dumpDataDir: async () => this.dump };
  }
}

function snapshotEnvironment(): void {
  originalEnv.clear();
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
}

function restoreEnvironment(): void {
  for (const key of touchedEnv) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  originalEnv.clear();
}

afterEach(restoreEnvironment);

describe("POST /api/restore runtime lifecycle", () => {
  it("returns success only after a replacement runtime is active", async () => {
    snapshotEnvironment();
    const root = await mkdtemp(path.join(tmpdir(), "eliza-restore-route-"));
    const sourceDir = path.join(root, "source-pglite");
    const stateDir = path.join(root, "state");
    const targetDir = path.join(stateDir, "pglite");
    const configPath = path.join(stateDir, "eliza.json");
    let runtime: AgentRuntime | null = null;
    const replacementRuntimes: AgentRuntime[] = [];
    let api: Awaited<ReturnType<typeof startApiServer>> | null = null;

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ logging: { level: "error" } }),
        "utf8",
      );
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.PGLITE_DATA_DIR = targetDir;
      process.env.ELIZA_CONFIG_PATH = configPath;
      process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
      process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
      process.env.ELIZA_API_TOKEN = API_TOKEN;
      delete process.env.ELIZA_API_AUTH_TOKEN;
      delete process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;

      const source = new PGlite(`file://${sourceDir}`);
      await source.waitReady;
      await source.exec("CREATE TABLE restore_probe (value text)");
      await source.exec("INSERT INTO restore_probe VALUES ('preserved')");
      const dump = await source.dumpDataDir("gzip");
      await source.close();

      runtime = new AgentRuntime({ logLevel: "fatal", plugins: [] });
      runtime.registerDatabaseAdapter(new PgliteDumpAdapter(dump));
      await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

      let restartCalls = 0;
      let disposeCurrentBeforeBuild = false;
      api = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
        onRestart: async (options) => {
          restartCalls += 1;
          disposeCurrentBeforeBuild =
            options?.disposeCurrentBeforeBuild === true;
          const replacement = new AgentRuntime({
            logLevel: "fatal",
            plugins: [],
          });
          replacementRuntimes.push(replacement);
          replacement.registerDatabaseAdapter(new InMemoryDatabaseAdapter());
          await replacement.initialize({
            allowNoDatabase: true,
            skipMigrations: true,
          });
          return replacement;
        },
      });
      const headers = { Authorization: `Bearer ${API_TOKEN}` };
      const snapshotResponse = await fetch(
        `http://127.0.0.1:${api.port}/api/snapshot`,
        { method: "POST", headers },
      );
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json();

      const restoreResponse = await fetch(
        `http://127.0.0.1:${api.port}/api/restore`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        },
      );

      expect(restoreResponse.status).toBe(200);
      await expect(restoreResponse.json()).resolves.toEqual({
        restored: true,
        requiresRestart: false,
      });
      expect(restartCalls).toBe(1);
      expect(disposeCurrentBeforeBuild).toBe(true);

      const restored = new PGlite(`file://${targetDir}`);
      await restored.waitReady;
      await expect(
        restored.query("SELECT value FROM restore_probe"),
      ).resolves.toMatchObject({
        rows: [{ value: "preserved" }],
      });
      await restored.close();
    } finally {
      if (api) await api.close();
      for (const replacement of replacementRuntimes) {
        await replacement.stop({ fast: true });
        await replacement.close();
      }
      if (runtime) {
        await runtime.stop({ fast: true });
        await runtime.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
