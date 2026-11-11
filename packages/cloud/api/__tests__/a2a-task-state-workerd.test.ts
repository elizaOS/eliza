import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithCloudBindings } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import type { TaskStoreEntry } from "@elizaos/cloud-shared/lib/services/a2a-task-store";
import type { Task } from "@elizaos/cloud-shared/lib/types/a2a";
import type { RuntimeDurableObjectNamespace } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import * as workerAuth from "../../shared/src/lib/auth/workers-hono-auth";

import platformRoute from "../a2a/route";

const platform = new Hono().route("/api/a2a", platformRoute);

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
  const raw = (organization: string, payload: Record<string, unknown>) =>
    call({ operation: "raw", organization, payload });
  const rawOk = async (
    organization: string,
    payload: Record<string, unknown>,
  ) => {
    const response = await raw(organization, payload);
    expect(response.status).toBe(200);
    return response.json();
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
  test("versioned competing updates retry without losing content order or duplicates", async () => {
    const organizationId = "versioned";
    const original = entry("versioned-task", organizationId);
    const input = { organizationId, taskId: original.task.id };
    await rawOk(organizationId, {
      ...input,
      operation: "set",
      entry: original,
    });
    const [first, second] = (await Promise.all([
      rawOk(organizationId, { ...input, operation: "get" }),
      rawOk(organizationId, { ...input, operation: "get" }),
    ])) as Array<{ entry: TaskStoreEntry; version: string }>;
    expect(first!.version).toBe(second!.version);
    const duplicate = {
      role: "agent" as const,
      parts: [{ type: "text" as const, text: "同じ é" }],
    };
    const append = (snapshot: TaskStoreEntry): TaskStoreEntry => ({
      ...snapshot,
      task: {
        ...snapshot.task,
        history: [...snapshot.task.history!, duplicate],
      },
    });
    expect(
      await rawOk(organizationId, {
        ...input,
        operation: "set",
        version: first!.version,
        entry: append(first!.entry),
      }),
    ).toBe(true);
    expect(
      await rawOk(organizationId, {
        ...input,
        operation: "set",
        version: second!.version,
        entry: append(second!.entry),
      }),
    ).toBe(false);
    const current = (await rawOk(organizationId, {
      ...input,
      operation: "get",
    })) as {
      entry: TaskStoreEntry;
      version: string;
    };
    expect(current.version).not.toBe(first!.version);
    expect(
      await rawOk(organizationId, {
        ...input,
        operation: "set",
        version: current.version,
        entry: append(current.entry),
      }),
    ).toBe(true);
    const stored = (await ok({
      operation: "get",
      taskId: original.task.id,
      organization: organizationId,
    })) as TaskStoreEntry;
    expect(stored.task.history).toEqual([
      ...original.task.history!,
      duplicate,
      duplicate,
    ]);
    expect(stored.task.metadata).toEqual(original.task.metadata);
  });
  test("deletion and recreation refuse the original version receipt", async () => {
    const organizationId = "recreated";
    const original = entry("recreated-task", organizationId);
    const input = { organizationId, taskId: original.task.id };
    await rawOk(organizationId, {
      ...input,
      operation: "set",
      entry: original,
    });
    const stale = (await rawOk(organizationId, {
      ...input,
      operation: "get",
    })) as {
      entry: TaskStoreEntry;
      version: string;
    };
    expect(await rawOk(organizationId, { ...input, operation: "delete" })).toBe(
      true,
    );
    const replacement = {
      ...original,
      task: { ...original.task, metadata: { replacement: true } },
    };
    await rawOk(organizationId, {
      ...input,
      operation: "set",
      entry: replacement,
    });
    expect(
      await rawOk(organizationId, {
        ...input,
        operation: "set",
        entry: stale.entry,
        version: stale.version,
      }),
    ).toBe(false);
    const stored = (await rawOk(organizationId, {
      ...input,
      operation: "get",
    })) as {
      entry: TaskStoreEntry;
      version: string;
    };
    expect(stored.version).not.toBe(stale.version);
    expect(stored.entry).toEqual(replacement);
  });
  test("expired task versions cannot restore deleted content or listing entries", async () => {
    const organizationId = "expired-version";
    const original = entry("expiring-task", organizationId);
    const input = { organizationId, taskId: original.task.id };
    await rawOk(organizationId, {
      organizationId,
      operation: "import",
      sourceQuiesced: true,
      entries: [
        {
          taskId: original.task.id,
          entry: original,
          score: 1,
          expiresAt: Date.now() + 60_000,
        },
      ],
    });
    const stale = (await rawOk(organizationId, {
      ...input,
      operation: "get",
    })) as {
      entry: TaskStoreEntry;
      version: string;
    };
    expect(stale).not.toBeNull();
    // Install an expired stored deadline after obtaining the original receipt.
    // This checks the real expiry/CAS path without racing host scheduling.
    await ok({
      operation: "expire-fixture",
      organization: organizationId,
      taskId: original.task.id,
    });
    expect(
      await rawOk(organizationId, {
        ...input,
        operation: "set",
        entry: original,
        version: stale.version,
      }),
    ).toBe(false);
    expect(
      await rawOk(organizationId, { ...input, operation: "get" }),
    ).toBeNull();
    expect(
      await rawOk(organizationId, {
        organizationId,
        operation: "list",
        limit: 0,
      }),
    ).toEqual([]);
  });
  test("rejected foreign requests retain the owner's open import phase", async () => {
    const organizationId = "import-owner";
    const original = entry("import-owner-task", organizationId);
    const transfer = {
      organizationId,
      operation: "import",
      sourceQuiesced: true,
      entries: [
        {
          taskId: original.task.id,
          entry: original,
          score: 1,
          expiresAt: Date.now() + 60_000,
        },
      ],
    };
    expect(await rawOk(organizationId, transfer)).toBe(1);
    const denied = await raw(organizationId, {
      organizationId: "foreign",
      operation: "get",
      taskId: original.task.id,
    });
    expect(denied.status).toBe(403);
    expect(await rawOk(organizationId, transfer)).toBe(1);
    expect(
      await rawOk(organizationId, {
        organizationId,
        operation: "list",
        limit: 0,
      }),
    ).toEqual([original]);
    expect((await raw(organizationId, transfer)).status).toBe(409);
  });
  test("conflicting import batches do not retain preceding new rows or receipts", async () => {
    const organizationId = "atomic-import";
    const original = entry("original-import-task", organizationId);
    const first = {
      taskId: original.task.id,
      entry: original,
      score: 1,
      expiresAt: Date.now() + 60_000,
    };
    const transfer = {
      organizationId,
      operation: "import",
      sourceQuiesced: true,
    };
    expect(await rawOk(organizationId, { ...transfer, entries: [first] })).toBe(
      1,
    );
    const extra = entry("uncommitted-import-task", organizationId);
    const conflict = await raw(organizationId, {
      ...transfer,
      entries: [
        {
          taskId: extra.task.id,
          entry: extra,
          score: 2,
          expiresAt: first.expiresAt,
        },
        { ...first, score: 3 },
      ],
    });
    expect(conflict.status).toBe(409);
    const receipts = (await ok({
      operation: "inspect-imports",
      organization: organizationId,
    })) as Array<{ id: string }>;
    expect(receipts.map((row) => row.id)).toEqual([original.task.id]);
    expect(
      await rawOk(organizationId, {
        organizationId,
        operation: "list",
        limit: 0,
      }),
    ).toEqual([original]);
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
  test("stored task expiry survives restart and removes the listing entry", async () => {
    await ok({
      operation: "import",
      organization: "expiry",
      snapshots: [
        {
          taskId: "short",
          entry: entry("short", "expiry"),
          score: 1,
          expiresAt: Date.now() + 60_000,
        },
      ],
    });
    expect(
      await ok({ operation: "get", taskId: "short", organization: "expiry" }),
    ).not.toBeNull();
    await ok({
      operation: "expire-fixture",
      taskId: "short",
      organization: "expiry",
    });
    await worker.dispose();
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
  async function holdPlatformTaskRead(taskId: string, organization: string) {
    const namespace = await worker.getDurableObjectNamespace("A2A_TASK_STATE");
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const conditionalWrites: boolean[] = [];
    let hold = true;
    const state: RuntimeDurableObjectNamespace = {
      getByName(name) {
        const stub = namespace.get(namespace.idFromName(name));
        return {
          async fetch(input, init) {
            const request = new Request(input, init);
            const payload = await request.text();
            const body = JSON.parse(payload) as {
              operation: string;
              taskId: string;
              version?: string;
            };
            const receipt = await stub.fetch(request.url, {
              method: request.method,
              body: payload,
            });
            const text = await receipt.text();
            if (body.taskId === taskId && body.operation === "get" && hold) {
              hold = false;
              captured.resolve();
              await release.promise;
            }
            if (
              body.taskId === taskId &&
              body.operation === "set" &&
              body.version
            ) {
              conditionalWrites.push(JSON.parse(text) as boolean);
            }
            return new Response(text, {
              status: receipt.status,
              headers: Object.fromEntries(receipt.headers),
            });
          },
        };
      },
    };
    const env = {
      CLOUD_A2A_STATE_BACKEND: "cloudflare",
      A2A_TASK_STATE: state,
    };
    const actor = { id: "user", organization_id: organization } as Awaited<
      ReturnType<typeof workerAuth.requireUserOrApiKeyWithOrg>
    >;
    const auth = spyOn(
      workerAuth,
      "requireUserOrApiKeyWithOrg",
    ).mockResolvedValue(actor);
    return {
      restoreAuth: () => auth.mockRestore(),
      captured: captured.promise,
      release: release.resolve,
      conditionalWrites,
      async rpc(method: string, params: Record<string, unknown>) {
        const response = await runWithCloudBindings(env, () =>
          platform.request(
            "/api/a2a",
            {
              method: "POST",
              body: JSON.stringify({
                jsonrpc: "2.0",
                method,
                id: method,
                params,
              }),
            },
            env,
          ),
        );
        expect(response.status).toBe(200);
        return (await response.json()) as {
          result?: Task;
          error?: { code: number };
        };
      },
    };
  }

  test("stale platform cancellation preserves completed history and artifacts", async () => {
    const id = "terminal-after-completion";
    const organization = "terminal-completion";
    await ok({ operation: "set", taskId: id, entry: entry(id, organization) });
    const held = await holdPlatformTaskRead(id, organization);
    const cancellation = held.rpc("tasks/cancel", { id });
    try {
      await held.captured;
      const completed = await held.rpc("message/send", {
        message: {
          role: "user",
          parts: [{ type: "data", data: { skill: "cloud.capabilities.list" } }],
        },
        metadata: { taskId: id },
      });
      expect(completed.result?.status.state).toBe("completed");
      expect(completed.result?.history).toHaveLength(2);
      expect(completed.result?.artifacts).toHaveLength(1);
      held.release();
      const canceled = await cancellation;
      const stored = await held.rpc("tasks/get", { id });
      expect({
        lateState: canceled.result?.status.state,
        lateError: canceled.error?.code,
        storedState: stored.result?.status.state,
        writes: held.conditionalWrites,
      }).toEqual({
        lateState: undefined,
        lateError: -32000,
        storedState: "completed",
        writes: [false],
      });
      expect(stored.result).toEqual(completed.result);
    } finally {
      held.release();
      held.restoreAuth();
    }
  }, 60_000);

  test("competing platform cancellations acknowledge exactly one stored outcome", async () => {
    const id = "terminal-cancellation";
    const organization = "terminal-race";
    await ok({ operation: "set", taskId: id, entry: entry(id, organization) });
    const held = await holdPlatformTaskRead(id, organization);
    const stale = held.rpc("tasks/cancel", { id });
    try {
      await held.captured;
      const winner = await held.rpc("tasks/cancel", { id });
      expect(winner.result?.status.state).toBe("canceled");
      held.release();
      const canceled = await stale;
      const stored = await held.rpc("tasks/get", { id });
      expect({
        lateState: canceled.result?.status.state,
        lateError: canceled.error?.code,
        storedState: stored.result?.status.state,
        writes: held.conditionalWrites,
      }).toEqual({
        lateState: undefined,
        lateError: -32000,
        storedState: "canceled",
        writes: [true, false],
      });
      expect(stored.result).toEqual(winner.result);
    } finally {
      held.release();
      held.restoreAuth();
    }
  }, 60_000);

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
