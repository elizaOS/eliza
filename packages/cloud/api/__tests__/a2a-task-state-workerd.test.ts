import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStoreEntry } from "@elizaos/cloud-shared/lib/services/a2a-task-store";
import { Miniflare } from "miniflare";

describe("Cloudflare A2A tasks through the existing service", () => {
  let worker: Miniflare;
  let directory: string;
  let script: string;
  const start = (binding = true) =>
    new Miniflare({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
      bindings: {
        CLOUD_A2A_STATE_BACKEND: "cloudflare",
        NODE_ENV: "production",
        MOCK_REDIS: "1",
      },
      durableObjects: binding
        ? { A2A_TASK_STATE: { className: "A2ATaskState", useSQLite: true } }
        : {},
      durableObjectsPersist: directory,
      outboundService: () => {
        throw new Error("Unexpected external A2A I/O");
      },
    });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "a2a-task-state-"));
    const build = await Bun.build({
      entrypoints: [
        join(import.meta.dir, "../test/fixtures/a2a-task-state-worker.ts"),
      ],
      target: "browser",
      external: ["node:*", "cloudflare:*"],
      conditions: ["eliza-source"],
    });
    if (!build.success)
      throw new AggregateError(build.logs, "A2A fixture build failed");
    script = await build.outputs[0]!.text();
    worker = start();
  }, 60_000);
  afterAll(async () => {
    await worker?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const call = (input: Record<string, unknown>) =>
    worker.dispatchFetch("https://a2a.test/", {
      method: "POST",
      body: JSON.stringify(input),
    });
  const ok = async (input: Record<string, unknown>) => {
    const r = await call(input);
    expect(r.status).toBe(200);
    return r.json();
  };
  const entry = (taskId: string, organizationId: string): TaskStoreEntry => ({
    task: {
      id: taskId,
      status: { state: "working", timestamp: new Date().toISOString() },
      history: [
        {
          role: "user",
          parts: [{ type: "text", text: "認証 é".repeat(5000) }],
        },
      ],
      metadata: { retain: "full" },
    },
    userId: "user",
    organizationId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  test("concurrent history, artifacts and cancellation survive restart without losing complete content", async () => {
    const original = entry("task", "org");
    await ok({ operation: "set", taskId: "task", entry: original });
    await Promise.all([
      ...Array.from({ length: 12 }, (_, i) =>
        ok({
          operation: "history",
          taskId: "task",
          organization: "org",
          text: `message-${i}`,
        }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ok({
          operation: "artifact",
          taskId: "task",
          organization: "org",
          text: `artifact-${i}`,
        }),
      ),
      ok({ operation: "cancel", taskId: "task", organization: "org" }),
    ]);
    await worker.dispose();
    worker = start();
    const saved = (await ok({
      operation: "get",
      taskId: "task",
      organization: "org",
    })) as TaskStoreEntry;
    expect(saved.task.history).toHaveLength(13);
    expect(saved.task.history![0]).toEqual(original.task.history![0]);
    expect(saved.task.artifacts).toHaveLength(8);
    expect(saved.task.status.state).toBe("canceled");
    expect(saved.task.metadata).toEqual(original.task.metadata);
    expect(
      new Set(saved.task.history!.slice(1).map((m) => JSON.stringify(m))).size,
    ).toBe(12);
  }, 60_000);
  test("tenant reads, listing and deletion cannot affect another organization", async () => {
    expect(
      await ok({ operation: "get", taskId: "task", organization: "other" }),
    ).toBeNull();
    expect(
      await ok({ operation: "delete", taskId: "task", organization: "other" }),
    ).toBe(false);
    expect(await ok({ operation: "list", organization: "other" })).toEqual([]);
    await ok({
      operation: "set",
      taskId: "task",
      entry: entry("task", "other"),
    });
    expect(
      (
        (await ok({
          operation: "list",
          organization: "other",
        })) as TaskStoreEntry[]
      ).map((x) => x.organizationId),
    ).toEqual(["other"]);
    expect(
      await ok({ operation: "delete", taskId: "task", organization: "other" }),
    ).toBe(true);
    expect(
      await ok({ operation: "get", taskId: "task", organization: "org" }),
    ).not.toBeNull();
    expect(
      (
        await call({
          operation: "set",
          taskId: "wrong",
          entry: entry("task", "other"),
        })
      ).status,
    ).toBe(503);
  });
  test("import retains ordering and expiry, rejects conflicts and permanently closes after use", async () => {
    const snapshots = [
      {
        taskId: "old",
        entry: entry("old", "imported"),
        score: 1,
        expiresAt: Date.now() + 60_000,
      },
      {
        taskId: "new",
        entry: entry("new", "imported"),
        score: 2,
        expiresAt: Date.now() + 60_000,
      },
      {
        taskId: "expired",
        entry: entry("expired", "imported"),
        score: 3,
        expiresAt: Date.now() - 1,
      },
    ];
    const transfer = {
      operation: "import",
      organization: "imported",
      snapshots,
    };
    expect(await ok(transfer)).toBe(true);
    expect(await ok(transfer)).toBe(true);
    expect(
      (await call({ ...transfer, snapshots: [{ ...snapshots[0], score: 4 }] }))
        .status,
    ).toBe(503);
    expect(
      (
        (await ok({
          operation: "list",
          organization: "imported",
          limit: 0,
        })) as TaskStoreEntry[]
      ).map((x) => x.task.id),
    ).toEqual(["new", "old"]);
    await worker.dispose();
    worker = start();
    expect((await call(transfer)).status).toBe(503);
    expect(
      (
        (await ok({
          operation: "list",
          organization: "imported",
          limit: 1,
        })) as TaskStoreEntry[]
      ).map((x) => x.task.id),
    ).toEqual(["new"]);
  });
  test("original task expiry survives restart and removes the listing entry", async () => {
    await ok({
      operation: "import",
      organization: "expiry",
      snapshots: [
        {
          taskId: "short",
          entry: entry("short", "expiry"),
          score: 1,
          expiresAt: Date.now() + 1000,
        },
      ],
    });
    expect(
      await ok({ operation: "get", taskId: "short", organization: "expiry" }),
    ).not.toBeNull();
    await worker.dispose();
    await Bun.sleep(1100);
    worker = start();
    expect(
      await ok({ operation: "get", taskId: "short", organization: "expiry" }),
    ).toBeNull();
    expect(await ok({ operation: "list", organization: "expiry" })).toEqual([]);
    const retained = await ok({
      operation: "inspect-imports",
      organization: "expiry",
    });
    expect(retained).toEqual([
      { id: "short", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
  });
  test("selected store refuses missing bindings instead of falling back to mock Redis", async () => {
    await worker.dispose();
    worker = start(false);
    const response = await call({
      operation: "get",
      taskId: "task",
      organization: "org",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "A2AStateError",
      message: "A2A_TASK_STATE binding is required",
    });
    await worker.dispose();
    worker = start();
    await worker.ready;
  });
});
