/**
 * Proves the POST /api/restore HTTP boundary rebuilds the live runtime after
 * replacing PGlite files, using a real snapshot, TCP API host, and PGlite dump.
 */

import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { AgentRuntime, InMemoryDatabaseAdapter } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  constructor(
    private readonly dataDir: string,
    private readonly dump: Blob,
  ) {
    super();
  }

  getPgliteDataDir(): string {
    return this.dataDir;
  }

  async dumpPgliteDataDirAfterPreflight<T>(
    preflight: () => Promise<T>,
  ): Promise<{ dump: Blob; preflight: T; release: () => void }> {
    const proof = await preflight();
    return { dump: this.dump, preflight: proof, release: () => undefined };
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

async function logicalDirectoryBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else {
        total += (await lstat(absolutePath)).size;
      }
    }
  }
  return total;
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnvironment();
});

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
      process.env.PGLITE_DATA_DIR = sourceDir;
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
      const sourceLogicalBytes = await logicalDirectoryBytes(sourceDir);
      expect(sourceLogicalBytes).toBeGreaterThan(32 * 1024 * 1024);
      // A real initialized PGlite already carries a substantial WASM baseline.
      // Admission is based on remaining memory for the additional dump copies,
      // not on requiring the total process RSS to remain artificially low.
      expect(process.memoryUsage().rss).toBeGreaterThan(110 * 1024 * 1024);
      vi.spyOn(process, "availableMemory").mockReturnValue(512 * 1024 * 1024);

      runtime = new AgentRuntime({ logLevel: "fatal", plugins: [] });
      runtime.registerDatabaseAdapter(new PgliteDumpAdapter(sourceDir, dump));
      await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

      let restartCalls = 0;
      let failNextRestart = true;
      let disposeCurrentBeforeBuild = false;
      api = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
        onRestart: async (options) => {
          restartCalls += 1;
          disposeCurrentBeforeBuild =
            options?.disposeCurrentBeforeBuild === true;
          if (failNextRestart) {
            failNextRestart = false;
            return null;
          }
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
      process.env.PGLITE_DATA_DIR = targetDir;

      const failedRestoreResponse = await fetch(
        `http://127.0.0.1:${api.port}/api/restore`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        },
      );
      expect(failedRestoreResponse.status).toBe(500);
      expect(disposeCurrentBeforeBuild).toBe(true);

      const failedHealthResponse = await fetch(
        `http://127.0.0.1:${api.port}/api/health`,
        { headers },
      );
      expect(failedHealthResponse.status).toBe(200);
      await expect(failedHealthResponse.json()).resolves.toMatchObject({
        canRespond: false,
      });
      const failedAgentResponse = await fetch(
        `http://127.0.0.1:${api.port}/api/agents`,
        { headers },
      );
      await expect(failedAgentResponse.json()).resolves.toMatchObject({
        agents: [{ status: "error" }],
      });

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
      expect(restartCalls).toBe(2);
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
