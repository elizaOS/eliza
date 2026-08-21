/**
 * Covers the update() lost-update race fixed for #23801: concurrent mutations
 * on one task must not clobber each other, and lock contention must fail
 * loudly rather than let a caller proceed unlocked. Runs against the real
 * store path over the in-memory MOCK_REDIS backend — no stubbing of the
 * system under test.
 */
import { beforeEach, describe, expect, test } from "bun:test";

process.env.MOCK_REDIS = "1";
const { a2aTaskStoreService } = await import("./a2a-task-store");
const { MockSocketRedis } = await import("../cache/mock-redis");

const organizationId = "org-race";

async function seedTask(taskId: string): Promise<void> {
  await a2aTaskStoreService.set(taskId, {
    task: {
      id: taskId,
      contextId: "context-race",
      status: { state: "working", timestamp: new Date().toISOString() },
      history: [],
      artifacts: [],
    },
    userId: "user-race",
    organizationId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe("A2A task store concurrent mutations", () => {
  test("keeps both appends when an artifact and a history message overlap", async () => {
    const taskId = "task-race-append";
    await seedTask(taskId);

    await Promise.all([
      a2aTaskStoreService.addArtifact(taskId, organizationId, {
        artifactId: "artifact-1",
        parts: [],
      }),
      a2aTaskStoreService.addMessageToHistory(taskId, organizationId, {
        messageId: "message-1",
        role: "agent",
        parts: [{ type: "text", text: "done" }],
      }),
    ]);

    const result = await a2aTaskStoreService.get(taskId, organizationId);
    expect(result?.task.artifacts).toHaveLength(1);
    expect(result?.task.history).toHaveLength(1);
  });

  test("does not resurrect a canceled task when a history append overlaps", async () => {
    const taskId = "task-race-cancel";
    await seedTask(taskId);

    await Promise.all([
      a2aTaskStoreService.updateTaskState(taskId, organizationId, "canceled"),
      a2aTaskStoreService.addMessageToHistory(taskId, organizationId, {
        messageId: "message-late",
        role: "agent",
        parts: [{ type: "text", text: "late" }],
      }),
    ]);

    const result = await a2aTaskStoreService.get(taskId, organizationId);
    expect(result?.task.status.state).toBe("canceled");
  });

  test("serializes many overlapping history appends without dropping any", async () => {
    const taskId = "task-race-many";
    await seedTask(taskId);

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        a2aTaskStoreService.addMessageToHistory(taskId, organizationId, {
          messageId: `message-${i}`,
          role: "agent",
          parts: [{ type: "text", text: `chunk-${i}` }],
        }),
      ),
    );

    const result = await a2aTaskStoreService.get(taskId, organizationId);
    expect(result?.task.history).toHaveLength(12);
    const messageIds = new Set(
      (result?.task.history ?? []).map((m: { messageId: string }) => m.messageId),
    );
    expect(messageIds.size).toBe(12);
  });
});

describe("A2A task store update lock", () => {
  beforeEach(() => {
    process.env.ENVIRONMENT = "local";
  });

  test("throws rather than proceeding unlocked when the lock stays held", async () => {
    const taskId = "task-lock-contended";
    await seedTask(taskId);

    // Hold the exact lock key update() will contend for, on the same
    // process-global mock store the service reads/writes.
    const rawClient = new MockSocketRedis();
    const lockKey = "local:a2a:task-lock:task-lock-contended";
    const acquired = await rawClient.set(lockKey, "foreign-holder", { nx: true, px: 30_000 });
    expect(acquired).toBe("OK");

    await expect(
      a2aTaskStoreService.updateTaskState(taskId, organizationId, "completed"),
    ).rejects.toMatchObject({
      code: "A2A_TASK_STORE_LOCK_TIMEOUT",
    });

    // The foreign holder's lock must survive — a timed-out waiter must never
    // release a lock it doesn't own.
    expect(await rawClient.get(lockKey)).toBe("foreign-holder");

    // Task state must be unchanged: the failed acquisition must not have let
    // the update proceed unlocked.
    const result = await a2aTaskStoreService.get(taskId, organizationId);
    expect(result?.task.status.state).toBe("working");
  }, 10_000);
});
