/** A CLI-host hot reload stops the replaced runtime without closing the database connection its replacement reuses. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  ChannelType,
  stringToUuid,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import {
  closeRuntimeAdapter,
  disposeReplacedRuntime,
} from "../src/runtime/eliza.ts";
import { MemoryRetentionService } from "../src/runtime/memory-retention-service.ts";

const directories: string[] = [];
const agentId = stringToUuid("hot-reload-shared-database") as UUID;

afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function runtimeOn(dataDir: string): Promise<AgentRuntime> {
  const adapter = createDatabaseAdapter({ dataDir }, agentId);
  await adapter.initialize();
  return new AgentRuntime({
    agentId,
    character: { name: "HotReload" },
    adapter,
  });
}

async function selectOne(runtime: AgentRuntime): Promise<unknown> {
  const raw = (
    runtime.adapter as unknown as {
      getRawConnection(): { query(sql: string): Promise<{ rows: unknown[] }> };
    }
  ).getRawConnection();
  return (await raw.query("select 1 as ok")).rows[0];
}

it("keeps the shared connection open for the replacement and closes it on the replacement's shutdown", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "eliza-hot-reload-db-"));
  directories.push(dataDir);
  const previous = await runtimeOn(dataDir);
  const replacement = await runtimeOn(dataDir);

  await disposeReplacedRuntime(previous, replacement);

  expect(await selectOne(replacement)).toEqual({ ok: 1 });
  await closeRuntimeAdapter(replacement, "final shutdown");
  await expect(selectOne(replacement)).rejects.toThrow();
}, 120_000);

it("closes the replaced runtime's database when the replacement uses another one", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "eliza-hot-reload-db-a-"));
  const second = await mkdtemp(path.join(tmpdir(), "eliza-hot-reload-db-b-"));
  directories.push(first, second);
  const previous = await runtimeOn(first);
  const replacement = await runtimeOn(second);

  await disposeReplacedRuntime(previous, replacement);

  await expect(selectOne(previous)).rejects.toThrow();
  expect(await selectOne(replacement)).toEqual({ ok: 1 });
  await closeRuntimeAdapter(replacement, "final shutdown");
}, 120_000);

for (const { name, fail } of [
  {
    name: "drains the real retention callback before HTTP replacement closes its SQLite adapter",
    fail: false,
  },
  {
    name: "reports a real SQLite callback failure after retirement without closing replacement storage",
    fail: true,
  },
]) {
  it(name, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "eliza-retire-sqlite-"),
    );
    directories.push(directory);
    const apiToken = randomUUID();
    for (const [key, value] of Object.entries({
      ELIZA_STATE_DIR: directory,
      ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
      ELIZA_API_TOKEN: apiToken,
      ELIZA_REQUIRE_LOCAL_AUTH: "1",
    }))
      vi.stubEnv(key, value);
    const previousFile = path.join(directory, "previous.sqlite");
    const open = async (name: string, file: string) => {
      const runtime = new AgentRuntime({
        agentId,
        character: { name, bio: [], settings: {} },
        adapter: SQLiteDatabaseAdapter.create(file, agentId),
        logLevel: "fatal",
      });
      Object.assign(runtime, { serverless: true });
      await runtime.initialize({ skipMigrations: true });
      return runtime;
    };
    const previous = await open("Previous retention owner", previousFile);
    const replacement = await open(
      "Replacement retention owner",
      path.join(directory, "replacement.sqlite"),
    );
    let releaseDelete!: () => void;
    let observeDelete!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      observeDelete = resolve;
    });
    let sweep: Promise<void> | undefined;
    let restarting: Promise<Response> | undefined;
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    let restartSettled = false;
    const effects: string[] = [];
    const activationFailures: unknown[] = [];
    let readOnly = false;
    const storageConnection = () =>
      (
        previous.adapter.db as { connection(): { exec(sql: string): void } }
      ).connection();
    let readback: SQLiteDatabaseAdapter | undefined;
    try {
      const roomId = randomUUID() as UUID;
      const worldId = randomUUID() as UUID;
      const older = randomUUID() as UUID;
      const newer = randomUUID() as UUID;
      await previous.createWorld({
        id: worldId,
        agentId,
        name: "Retirement proof",
      });
      await previous.createRoom({
        id: roomId,
        worldId,
        agentId,
        source: "test",
        type: ChannelType.DM,
      });
      await previous.createMemories(
        [older, newer].map((id, index) => ({
          tableName: "messages",
          memory: {
            id,
            roomId,
            entityId: agentId,
            agentId,
            createdAt: index + 1,
            content: { text: `durable row ${index}` },
          },
        })),
      );
      previous.setSetting("ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM", "1");
      // This is the same service registered by the CLI eliza plugin. Only its
      // storage boundary is held; scheduling, stop ownership and deletion are real.
      await previous.registerService(MemoryRetentionService);
      await previous.getServiceLoadPromise(MemoryRetentionService.serviceType);
      await previous.registerService(TaskService);
      const scheduler = (await previous.getServiceLoadPromise(
        TaskService.serviceType,
      )) as TaskService;
      for (const task of await previous.getTasks({ tags: ["queue"] })) {
        if (!task.id)
          throw new Error("Stored retention task is missing its ID");
        await previous.updateTask(task.id, {
          metadata: { ...task.metadata, updatedAt: 0 },
        });
      }
      const deleteMemories = previous.adapter.deleteMemories.bind(
        previous.adapter,
      );
      const closeAdapter = previous.adapter.close.bind(previous.adapter);
      vi.spyOn(previous.adapter, "close").mockImplementation(async () => {
        effects.push("close");
        if (readOnly) {
          storageConnection().exec("PRAGMA query_only = OFF");
          readOnly = false;
        }
        await closeAdapter();
      });
      vi.spyOn(previous.adapter, "deleteMemories").mockImplementation(
        async (ids) => {
          observeDelete();
          await gate;
          effects.push("delete");
          if (fail) {
            // The real SQLite connection rejects writes. Restore it only when
            // host closure begins, after original callback failures are retained.
            storageConnection().exec("PRAGMA query_only = ON");
            readOnly = true;
          }
          await deleteMemories(ids);
        },
      );
      sweep = scheduler.runDueTasks();
      void sweep.catch(() => undefined);
      await entered;
      server = await startApiServer({
        port: 0,
        runtime: previous,
        skipDeferredStartupWork: true,
        onRestart: async () => replacement,
        onRuntimeActivated: async (outgoing, active) => {
          if (!outgoing) throw new Error("Missing outgoing runtime");
          try {
            await disposeReplacedRuntime(outgoing, active);
          } catch (error) {
            // The CLI keeps its published replacement and reports old-runtime
            // cleanup failures through this same production error boundary.
            activationFailures.push(error);
            active.reportError("eliza.hotReload.disposePrevious", error);
          }
        },
      });
      restarting = fetch(`http://127.0.0.1:${server.port}/api/agent/restart`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiToken}` },
      }).then((response) => {
        restartSettled = true;
        return response;
      });
      // Fast shutdown clears the registry at its real 500 ms service-stop cap.
      // The original stop callback remains owned even after lookup is cleared.
      await vi.waitFor(() => expect(previous.getAllServices().size).toBe(0), {
        timeout: 10_000,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(effects).toEqual([]);
      expect(await previous.adapter.isReady()).toBe(true);
      expect(restartSettled).toBe(false);
      releaseDelete();
      if (fail) await expect(sweep).rejects.toBeDefined();
      else await sweep;
      expect((await restarting).status).toBe(200);
      expect(await previous.adapter.isReady()).toBe(false);
      expect(await replacement.adapter.isReady()).toBe(true);
      expect(effects).toEqual(["delete", "close"]);
      if (fail) {
        expect(activationFailures).toMatchObject([
          { code: "RUNTIME_QUIESCENCE_FAILED" },
        ]);
      } else {
        expect(activationFailures).toEqual([]);
        readback = SQLiteDatabaseAdapter.create(previousFile, agentId);
        await readback.initialize();
        expect(
          (
            await readback.getMemories({
              roomId,
              tableName: "messages",
              count: 10,
            })
          ).map((row) => row.id),
        ).toEqual([newer]);
      }
    } finally {
      releaseDelete();
      await Promise.allSettled([sweep, restarting]);
      if (server) await server.close();
      await readback?.close();
      vi.restoreAllMocks();
      await previous.stop();
      await previous.close();
      await replacement.stop();
      await replacement.close();
      vi.unstubAllEnvs();
    }
  }, 180_000);
}
