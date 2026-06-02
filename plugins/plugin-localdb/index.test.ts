import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseAdapter, plugin } from "./index.js";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eliza-localdb-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("plugin-localdb node adapter", () => {
  it("persists storage data across adapter restarts", async () => {
    const dir = await makeTempDir();
    const first = createDatabaseAdapter("agent-1" as never, dir);
    await first.initialize();
    const firstStorage = await first.getConnection();

    await firstStorage.set("custom", "key", { value: 42 });
    await first.close();

    const second = createDatabaseAdapter("agent-1" as never, dir);
    await second.initialize();
    const secondStorage = await second.getConnection();

    expect(await secondStorage.get("custom", "key")).toEqual({ value: 42 });
    expect(JSON.parse(await readFile(join(dir, "localdb.json"), "utf8"))).toEqual(
      {
        custom: {
          key: {
            value: 42,
          },
        },
      },
    );

    await second.close();
  });

  it("registers a file-backed adapter using LOCALDB_DATA_DIR", async () => {
    const dir = await makeTempDir();
    process.env.LOCALDB_DATA_DIR = dir;
    const registerDatabaseAdapter = vi.fn();

    await plugin.init?.(
      {},
      {
        agentId: "agent-1",
        registerDatabaseAdapter,
      } as never,
    );

    expect(registerDatabaseAdapter).toHaveBeenCalledTimes(1);
    const adapter = registerDatabaseAdapter.mock.calls[0]?.[0];
    const storage = await adapter.getConnection();
    await storage.set("settings", "theme", { value: "dark" });
    await adapter.close();

    expect(JSON.parse(await readFile(join(dir, "localdb.json"), "utf8"))).toEqual(
      {
        settings: {
          theme: {
            value: "dark",
          },
        },
      },
    );
  });

  it("does not replace an existing runtime adapter", async () => {
    const registerDatabaseAdapter = vi.fn();

    await plugin.init?.(
      {},
      {
        agentId: "agent-1",
        adapter: {},
        registerDatabaseAdapter,
      } as never,
    );

    expect(registerDatabaseAdapter).not.toHaveBeenCalled();
  });

  it("prefers runtime LOCALDB_DATA_DIR settings over process env", async () => {
    const envDir = await makeTempDir();
    const runtimeDir = await makeTempDir();
    process.env.LOCALDB_DATA_DIR = envDir;
    const registerDatabaseAdapter = vi.fn();

    await plugin.init?.(
      {},
      {
        agentId: "agent-1",
        getSetting: vi.fn((key: string) =>
          key === "LOCALDB_DATA_DIR" ? runtimeDir : undefined,
        ),
        registerDatabaseAdapter,
      } as never,
    );

    const adapter = registerDatabaseAdapter.mock.calls[0]?.[0];
    const storage = await adapter.getConnection();
    await storage.set("settings", "source", { value: "runtime" });
    await adapter.close();

    expect(JSON.parse(await readFile(join(runtimeDir, "localdb.json"), "utf8"))).toEqual(
      {
        settings: {
          source: {
            value: "runtime",
          },
        },
      },
    );
    await expect(readFile(join(envDir, "localdb.json"), "utf8")).rejects.toThrow();
  });
});
