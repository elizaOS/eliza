/**
 * Exercises Blooio webhook idempotency through the public service boundary with
 * a durable runtime cache and a controlled inbound dispatcher. The harness
 * proves failed dispatches remain retryable, concurrent deliveries cannot both
 * dispatch, and completed receipts survive a new service instance.
 */

import crypto from "node:crypto";
import type { IAgentRuntime, Media, Task, TaskWorker } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ChatDbMessage } from "./chatdb-reader.js";
import { BLOOIO_RECEIPT_RETENTION_MS, IMessageService } from "./service.js";
import type { IMessageSettings } from "./types.js";

const SECRET = "whsec_dedupe_test";
const CHANNEL_ID = "ch_bettina";
const MESSAGE_ID = "msg_retry_1";

function envelope(): string {
  return JSON.stringify({
    id: "evt_retry_1",
    type: "message.received",
    created_at: Date.now(),
    data: {
      id: MESSAGE_ID,
      chat_id: "chat_retry_1",
      channel_id: CHANNEL_ID,
      channel_type: "blooio",
      sender: "+15551234567",
      recipient: "+12692921765",
      text: "retry me safely",
    },
  });
}

function sign(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto.createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

interface CacheHarness {
  runtime: IAgentRuntime;
  store: Map<string, unknown>;
  reportError: ReturnType<typeof vi.fn>;
  deleteCache: ReturnType<typeof vi.fn>;
  tasks: Task[];
  workers: Map<string, TaskWorker>;
}

function makeRuntime(store = new Map<string, unknown>()): CacheHarness {
  const reportError = vi.fn();
  const tasks: Task[] = [];
  const workers = new Map<string, TaskWorker>();
  const deleteCache = vi.fn(async (key: string) => store.delete(key));
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: vi.fn(() => undefined),
    getCache: vi.fn(async (key: string) => store.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return true;
    }),
    deleteCache,
    registerTaskWorker: vi.fn((worker: TaskWorker) => workers.set(worker.name, worker)),
    getTaskWorker: vi.fn((name: string) => workers.get(name)),
    createTask: vi.fn(async (task: Task) => {
      const id = `00000000-0000-0000-0000-${String(tasks.length + 1).padStart(12, "0")}`;
      tasks.push({ ...task, id: id as Task["id"] });
      return id;
    }),
    deleteTask: vi.fn(async (id: string) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index >= 0) tasks.splice(index, 1);
    }),
    reportError,
  } as unknown as IAgentRuntime;
  return { runtime, store, reportError, deleteCache, tasks, workers };
}

type InboundDispatch = (row: ChatDbMessage, media?: Media[]) => Promise<void>;

function makeService(runtime: IAgentRuntime, dispatch: InboundDispatch): IMessageService {
  const service = new IMessageService(runtime);
  const internal = service as unknown as {
    settings: IMessageSettings;
    dispatchInboundMessage: InboundDispatch;
  };
  internal.settings = {
    transport: "blooio",
    pollIntervalMs: 0,
    heartbeatIntervalMs: 60_000,
    dmPolicy: "open",
    groupPolicy: "allowlist",
    allowFrom: [],
    enabled: true,
    blooioApiKey: "api_test",
    blooioWebhookSecret: SECRET,
    blooioFromNumber: "+12692921765",
    blooioChannelId: CHANNEL_ID,
  };
  internal.dispatchInboundMessage = dispatch;
  return service;
}

describe("Blooio webhook durable dispatch receipts", () => {
  it("leaves no receipt after dispatch failure so a provider retry can succeed", async () => {
    const { runtime, store } = makeRuntime();
    const dispatch = vi
      .fn<InboundDispatch>()
      .mockRejectedValueOnce(new Error("runtime temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const service = makeService(runtime, dispatch);
    const body = envelope();
    const signature = sign(body);

    await expect(service.handleBlooioWebhook(body, signature)).rejects.toThrow(
      "runtime temporarily unavailable"
    );
    expect(store.size).toBe(0);

    await expect(service.handleBlooioWebhook(body, signature)).resolves.toBe("accepted");
    await expect(service.handleBlooioWebhook(body, signature)).resolves.toBe("ignored");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(1);
    const [receiptKey] = store.keys();
    expect(receiptKey).toMatch(/^imessage:blooio-receipt:v1:[a-f0-9]{64}$/);
    expect(receiptKey).not.toContain(CHANNEL_ID);
    expect(receiptKey).not.toContain(MESSAGE_ID);
  });

  it("rejects a concurrent duplicate without dispatching it twice", async () => {
    const { runtime, reportError } = makeRuntime();
    let releaseDispatch: (() => void) | undefined;
    const dispatchBlocked = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const dispatch = vi.fn<InboundDispatch>(() => dispatchBlocked);
    const service = makeService(runtime, dispatch);
    const body = envelope();
    const signature = sign(body);

    const first = service.handleBlooioWebhook(body, signature);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await expect(service.handleBlooioWebhook(body, signature)).rejects.toMatchObject({
      code: "IMESSAGE_BLOOIO_DISPATCH_IN_FLIGHT",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "IMessageService.blooioWebhook",
      expect.objectContaining({ code: "IMESSAGE_BLOOIO_DISPATCH_IN_FLIGHT" }),
      expect.objectContaining({ receiptDigest: expect.any(String) })
    );

    releaseDispatch?.();
    await expect(first).resolves.toBe("accepted");
    await expect(service.handleBlooioWebhook(body, signature)).resolves.toBe("ignored");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("uses the durable receipt to suppress replay after a new service instance starts", async () => {
    const sharedStore = new Map<string, unknown>();
    const firstHarness = makeRuntime(sharedStore);
    const firstDispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    const firstService = makeService(firstHarness.runtime, firstDispatch);
    const body = envelope();
    const signature = sign(body);

    await expect(firstService.handleBlooioWebhook(body, signature)).resolves.toBe("accepted");

    const restartedHarness = makeRuntime(sharedStore);
    const restartedDispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    const restartedService = makeService(restartedHarness.runtime, restartedDispatch);
    await expect(restartedService.handleBlooioWebhook(body, signature)).resolves.toBe("ignored");
    expect(firstDispatch).toHaveBeenCalledTimes(1);
    expect(restartedDispatch).not.toHaveBeenCalled();
  });

  it("schedules a bounded cleanup task that deletes the matching durable receipt", async () => {
    const { runtime, store, tasks, workers } = makeRuntime();
    const dispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    const service = makeService(runtime, dispatch);
    const body = envelope();

    await expect(service.handleBlooioWebhook(body, sign(body))).resolves.toBe("accepted");
    expect(tasks).toHaveLength(1);
    const [task] = tasks;
    expect(task.tags).toContain("repeat");
    expect(task.metadata?.maxFailures).toBe(0);
    const acceptedAt = task.metadata?.acceptedAt;
    expect(typeof acceptedAt).toBe("number");
    expect(Number(task.dueAt) - Number(acceptedAt)).toBe(BLOOIO_RECEIPT_RETENTION_MS);
    const receiptKey = task.metadata?.receiptKey;
    expect(typeof receiptKey).toBe("string");
    expect(store.get(String(receiptKey))).toMatchObject({
      version: 1,
      acceptedAt,
      cleanupTaskId: task.id,
    });

    const worker = workers.get(task.name);
    expect(worker).toBeDefined();
    await worker?.execute(runtime, task.metadata ?? {}, task);
    expect(store.has(String(receiptKey))).toBe(false);
  });

  it("keeps the scheduled cleanup task retryable when durable deletion fails", async () => {
    const harness = makeRuntime();
    const service = makeService(
      harness.runtime,
      vi.fn<InboundDispatch>().mockResolvedValue(undefined)
    );
    const body = envelope();
    await service.handleBlooioWebhook(body, sign(body));
    const [task] = harness.tasks;
    const worker = harness.workers.get(task.name);
    harness.deleteCache.mockRejectedValueOnce(new Error("cache delete unavailable"));

    await expect(worker?.execute(harness.runtime, task.metadata ?? {}, task)).rejects.toMatchObject(
      {
        code: "IMESSAGE_BLOOIO_RECEIPT_CLEANUP_FAILED",
      }
    );
    expect(harness.tasks).toContain(task);
    expect(harness.store.has(String(task.metadata?.receiptKey))).toBe(true);
    expect(harness.reportError).toHaveBeenCalledWith(
      "IMessageService.blooioReceiptCleanup",
      expect.objectContaining({ code: "IMESSAGE_BLOOIO_RECEIPT_CLEANUP_FAILED" }),
      expect.objectContaining({ receiptDigest: expect.any(String) })
    );
  });

  it("repairs a receipt whose cleanup scheduling initially failed without redispatching", async () => {
    const harness = makeRuntime();
    vi.mocked(harness.runtime.createTask).mockRejectedValueOnce(
      new Error("task storage temporarily unavailable")
    );
    const dispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    const service = makeService(harness.runtime, dispatch);
    const body = envelope();
    const signature = sign(body);

    await expect(service.handleBlooioWebhook(body, signature)).rejects.toMatchObject({
      code: "IMESSAGE_BLOOIO_RECEIPT_CLEANUP_SCHEDULE_FAILED",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [receiptKey] = harness.store.keys();
    expect(harness.store.get(receiptKey)).toMatchObject({ version: 1 });
    expect(harness.store.get(receiptKey)).not.toHaveProperty("cleanupTaskId");

    await expect(service.handleBlooioWebhook(body, signature)).resolves.toBe("ignored");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(harness.store.get(receiptKey)).toMatchObject({
      version: 1,
      cleanupTaskId: expect.any(String),
    });
    expect(harness.tasks).toHaveLength(1);
  });

  it("cleans an expired receipt and allows the delivery to dispatch again", async () => {
    const sharedStore = new Map<string, unknown>();
    const firstHarness = makeRuntime(sharedStore);
    const firstService = makeService(
      firstHarness.runtime,
      vi.fn<InboundDispatch>().mockResolvedValue(undefined)
    );
    const body = envelope();
    const signature = sign(body);
    await firstService.handleBlooioWebhook(body, signature);
    const [receiptKey] = sharedStore.keys();
    sharedStore.set(receiptKey, {
      version: 1,
      acceptedAt: Date.now() - BLOOIO_RECEIPT_RETENTION_MS - 1,
      cleanupTaskId: "old-cleanup-task",
    });

    const retryHarness = makeRuntime(sharedStore);
    const retryDispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    const retryService = makeService(retryHarness.runtime, retryDispatch);
    await expect(retryService.handleBlooioWebhook(body, signature)).resolves.toBe("accepted");
    expect(retryHarness.deleteCache).toHaveBeenCalledWith(receiptKey);
    expect(retryDispatch).toHaveBeenCalledTimes(1);
    expect(sharedStore.get(receiptKey)).toMatchObject({ version: 1 });
  });

  it.each([
    ["primitive", "poison"],
    ["invalid current timestamp", { version: 1, acceptedAt: "yesterday" }],
    ["invalid version zero", { version: 0, acceptedAt: Date.now() }],
    ["far-future current timestamp", { version: 1, acceptedAt: Date.now() + 10 * 60 * 1000 }],
    ["invalid cleanup task id", { version: 1, acceptedAt: Date.now(), cleanupTaskId: "" }],
  ])(
    "removes malformed receipt state (%s) and self-heals through dispatch",
    async (_name, value) => {
      const sharedStore = new Map<string, unknown>();
      const seedHarness = makeRuntime(sharedStore);
      const body = envelope();
      const signature = sign(body);
      await makeService(
        seedHarness.runtime,
        vi.fn<InboundDispatch>().mockResolvedValue(undefined)
      ).handleBlooioWebhook(body, signature);
      const [receiptKey] = sharedStore.keys();
      sharedStore.set(receiptKey, value);

      const retryHarness = makeRuntime(sharedStore);
      const retryDispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
      await expect(
        makeService(retryHarness.runtime, retryDispatch).handleBlooioWebhook(body, signature)
      ).resolves.toBe("accepted");
      expect(retryHarness.deleteCache).toHaveBeenCalledWith(receiptKey);
      expect(retryDispatch).toHaveBeenCalledTimes(1);
      expect(retryHarness.reportError).toHaveBeenCalledWith(
        "IMessageService.blooioWebhook",
        expect.objectContaining({ code: "IMESSAGE_BLOOIO_RECEIPT_INVALID" }),
        expect.objectContaining({ receiptDigest: expect.any(String) })
      );
    }
  );

  it("treats a future receipt version as processed during rolling deploys", async () => {
    const sharedStore = new Map<string, unknown>();
    const seedHarness = makeRuntime(sharedStore);
    const body = envelope();
    const signature = sign(body);
    await makeService(
      seedHarness.runtime,
      vi.fn<InboundDispatch>().mockResolvedValue(undefined)
    ).handleBlooioWebhook(body, signature);
    const [receiptKey] = sharedStore.keys();
    const futureReceipt = { version: 2, lifecycle: "owned-by-newer-node" };
    sharedStore.set(receiptKey, futureReceipt);

    const olderHarness = makeRuntime(sharedStore);
    const olderDispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    await expect(
      makeService(olderHarness.runtime, olderDispatch).handleBlooioWebhook(body, signature)
    ).resolves.toBe("ignored");
    expect(olderDispatch).not.toHaveBeenCalled();
    expect(olderHarness.deleteCache).not.toHaveBeenCalled();
    expect(sharedStore.get(receiptKey)).toBe(futureReceipt);
  });

  it("fails without dispatch when expired receipt cleanup cannot complete", async () => {
    const sharedStore = new Map<string, unknown>();
    const seedHarness = makeRuntime(sharedStore);
    const body = envelope();
    const signature = sign(body);
    await makeService(
      seedHarness.runtime,
      vi.fn<InboundDispatch>().mockResolvedValue(undefined)
    ).handleBlooioWebhook(body, signature);
    const [receiptKey] = sharedStore.keys();
    sharedStore.set(receiptKey, {
      version: 1,
      acceptedAt: Date.now() - BLOOIO_RECEIPT_RETENTION_MS - 1,
      cleanupTaskId: "old-cleanup-task",
    });

    const retryHarness = makeRuntime(sharedStore);
    retryHarness.deleteCache.mockRejectedValueOnce(new Error("cache delete unavailable"));
    const retryDispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    await expect(
      makeService(retryHarness.runtime, retryDispatch).handleBlooioWebhook(body, signature)
    ).rejects.toMatchObject({ code: "IMESSAGE_BLOOIO_RECEIPT_CLEANUP_FAILED" });
    expect(retryDispatch).not.toHaveBeenCalled();
    expect(sharedStore.has(receiptKey)).toBe(true);
    expect(retryHarness.reportError).toHaveBeenCalledWith(
      "IMessageService.blooioWebhook",
      expect.objectContaining({ code: "IMESSAGE_BLOOIO_RECEIPT_CLEANUP_FAILED" }),
      expect.objectContaining({ receiptDigest: expect.any(String) })
    );
  });

  it("reports and fails before dispatch when durable receipt storage is unavailable", async () => {
    const { runtime, reportError } = makeRuntime();
    vi.mocked(runtime.getCache).mockRejectedValueOnce(new Error("cache offline"));
    const dispatch = vi.fn<InboundDispatch>().mockResolvedValue(undefined);
    const service = makeService(runtime, dispatch);
    const body = envelope();

    await expect(service.handleBlooioWebhook(body, sign(body))).rejects.toMatchObject({
      code: "IMESSAGE_BLOOIO_RECEIPT_READ_FAILED",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      "IMessageService.blooioWebhook",
      expect.objectContaining({ code: "IMESSAGE_BLOOIO_RECEIPT_READ_FAILED" }),
      expect.objectContaining({ receiptDigest: expect.any(String) })
    );
  });
});
