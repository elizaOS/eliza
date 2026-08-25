/**
 * Proves the POST /api/snapshot HTTP boundary's transient/terminal split
 * against a real AgentRuntime and TCP API host: a PGlite closing-race failure
 * (the PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT sentinel) maps to 503 with the
 * structured transient code the cloud restart orchestrator keys on, while a
 * genuine dump failure stays a terminal 500. Only the database adapter is a
 * stub; server, routes, and snapshot capture are real.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, InMemoryDatabaseAdapter } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT,
  PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT_CODE,
} from "../services/agent-backup.ts";
import { startApiServer } from "./server.ts";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const API_TOKEN = "snapshot-transient-route-token";

const originalEnv = new Map<string, string | undefined>();
const touchedEnv = [
  "DATABASE_URL",
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_PORT",
  "ELIZA_STATE_DIR",
  "PGLITE_DATA_DIR",
  "POSTGRES_URL",
] as const;

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

async function seedState(root: string): Promise<void> {
  const stateDir = path.join(root, "state");
  const pgliteDir = path.join(stateDir, "pglite");
  await mkdir(pgliteDir, { recursive: true });
  const configPath = path.join(stateDir, "eliza.json");
  await writeFile(
    configPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );

  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.PGLITE_DATA_DIR = pgliteDir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = API_TOKEN;
  delete process.env.ELIZA_API_AUTH_TOKEN;
  delete process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;
}

/**
 * Real in-memory adapter widened with the bounded PGlite export surface the
 * snapshot capture path reads; materialization behavior is injected per test.
 */
class PgliteFacadeAdapter extends InMemoryDatabaseAdapter {
  constructor(
    private readonly dataDir: string,
    private readonly materialize: () => Promise<unknown>,
  ) {
    super();
  }

  getPgliteDataDir(): string {
    return this.dataDir;
  }

  async dumpPgliteDataDirAfterPreflight<T>(
    preflight: () => Promise<T>,
  ): Promise<{ dump: unknown; preflight: T; release: () => void }> {
    const proof = await preflight();
    return {
      dump: await this.materialize(),
      preflight: proof,
      release: () => undefined,
    };
  }
}

async function withSnapshotServer(
  dumpDataDir: () => Promise<unknown>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  snapshotEnvironment();
  const root = await mkdtemp(path.join(tmpdir(), "eliza-snapshot-route-"));
  let runtime: AgentRuntime | null = null;
  let api: ApiServer | null = null;
  try {
    await seedState(root);
    runtime = new AgentRuntime({ logLevel: "fatal", plugins: [] });
    // Register before initialize() so the runtime does not fall back to a
    // plain in-memory adapter without the raw-connection facade.
    runtime.registerDatabaseAdapter(
      new PgliteFacadeAdapter(path.join(root, "state", "pglite"), dumpDataDir),
    );
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

    api = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    process.env.ELIZA_PORT = String(api.port);
    process.env.ELIZA_API_PORT = String(api.port);

    await run(`http://127.0.0.1:${api.port}`);
  } finally {
    if (api) await api.close();
    if (runtime) {
      await runtime.stop({ fast: true });
      await runtime.close();
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function postSnapshot(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/api/snapshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
}

beforeEach(() => {
  vi.spyOn(process, "availableMemory").mockReturnValue(512 * 1024 * 1024);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnvironment();
});

describe("POST /api/snapshot transient/terminal mapping", () => {
  it("maps a PGlite closing race to 503 with the structured transient code", async () => {
    await withSnapshotServer(
      async () => {
        // Exact phrasing PGlite throws when dumpDataDir races a close.
        throw new Error("PGlite is closing");
      },
      async (baseUrl) => {
        const res = await postSnapshot(baseUrl);
        expect(res.status).toBe(503);
        await expect(res.json()).resolves.toEqual(
          expect.objectContaining({
            error: PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT,
            code: PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT_CODE,
          }),
        );
      },
    );
  }, 120_000);

  it("keeps a genuine dump failure a terminal 500 without the transient code", async () => {
    await withSnapshotServer(
      async () => {
        throw new Error("tar write failed: disk I/O error");
      },
      async (baseUrl) => {
        const res = await postSnapshot(baseUrl);
        expect(res.status).toBe(500);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toEqual(
          expect.objectContaining({
            error: "Snapshot failed",
          }),
        );
        expect(JSON.stringify(body)).not.toContain("disk I/O error");
        expect(body.code).toBeUndefined();
      },
    );
  }, 120_000);

  it("keeps filesystem diagnostics out of the backup list 500 body", async () => {
    await withSnapshotServer(
      async () => ({}),
      async (baseUrl) => {
        // A regular file where the backups directory belongs makes readdir
        // throw ENOTDIR with the absolute state path in the message.
        const backupsPath = path.join(
          process.env.ELIZA_STATE_DIR as string,
          "backups",
        );
        await writeFile(backupsPath, "not a directory", "utf8");
        const res = await fetch(`${baseUrl}/api/backups`, {
          headers: { Authorization: `Bearer ${API_TOKEN}` },
        });
        expect(res.status).toBe(500);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toMatchObject({ error: "Backup list failed" });
        expect(JSON.stringify(body)).not.toContain(backupsPath);
        expect(JSON.stringify(body)).not.toContain("ENOTDIR");
      },
    );
  }, 120_000);

  it("contains a snapshot failure with hostile diagnostic accessors", async () => {
    const hostile = new Proxy(Object.create(null), {
      getPrototypeOf() {
        throw new Error("prototype secret");
      },
      get() {
        throw new Error("getter secret");
      },
    });
    await withSnapshotServer(
      async () => {
        throw hostile;
      },
      async (baseUrl) => {
        const res = await postSnapshot(baseUrl);
        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toEqual({ error: "Snapshot failed" });
      },
    );
  }, 120_000);
});
