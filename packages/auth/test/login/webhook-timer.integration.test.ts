/** Exercises the actual login webhook worker, shared Core timer and durable receipts. */
import { expect, test } from "bun:test";
import {
  getTaskSchedulerAdapter,
  startTaskScheduler,
  stopTaskScheduler,
  TaskService,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import type { startEmbeddedLogin } from "../../src/server/runtime";

import {
  createLocalWebhookFixture,
  latch,
  received,
} from "./local-webhook-fixture";

for (const scenario of [
  {
    name: "detaching the task adapter preserves login delivery and shutdown commits its receipt",
    status: 200,
    receipt: "delivered",
    detachBeforeShutdown: true,
  },
  {
    name: "login shutdown drains a failed delivery and leaves the next claim for restart",
    status: 503,
    receipt: "failed",
    detachBeforeShutdown: false,
  },
] as const) {
  test(scenario.name, async () => {
    const first = latch<string>(),
      next = latch<string>(),
      release = latch<void>();
    const delivered: string[] = [];
    const signatureResults: boolean[] = [];
    const fixture = await createLocalWebhookFixture(
      async ({ id, verified }) => {
        signatureResults.push(verified);
        delivered.push(id);
        if (delivered.length === 1) {
          first.resolve(id);
          await release.promise;
          return new Response("fixture", { status: scenario.status });
        }
        next.resolve(id);
        return new Response("fixture");
      },
    );
    let login: Awaited<ReturnType<typeof startEmbeddedLogin>> | undefined;
    let tasks: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      const { PersistentQueue } = await import(
        "../../src/server/webhooks/index"
      );
      tasks = await createTestRuntime({
        characterName: "Login timer task owner",
      });
      const taskAdapter = tasks.runtime.adapter;
      startTaskScheduler(taskAdapter);
      const { startEmbeddedLogin: start } = await import(
        "../../src/server/runtime"
      );
      const { getDb, isEmbeddedDatabase, webhookConfigs, webhookDeliveries } =
        await import("../../src/server/db/index");
      const { createPGLiteDb } = await import("../../src/server/db/pglite");
      login = await start({ port: 0 });
      expect(getTaskSchedulerAdapter()).toBe(taskAdapter);
      if (scenario.detachBeforeShutdown) {
        await stopTaskScheduler();
        expect(getTaskSchedulerAdapter()).toBeNull();
      }
      const [config] = await getDb()
        .insert(webhookConfigs)
        .values({
          tenantId: "default",
          url: fixture.url.toString(),
          secret: fixture.secret,
          retryBackoffMs: 300_000,
        })
        .returning();
      const queue = new PersistentQueue();
      const event = {
        type: "webhook.test" as const,
        tenantId: config.tenantId,
        timestamp: new Date(),
        data: {},
      };
      const ids = [
        await queue.enqueue(event, config),
        await queue.enqueue(event, config),
      ];
      const current = await received(first.promise);
      const pending = ids.find((id) => id !== current);
      if (!ids.includes(current) || !pending)
        throw new Error("Unexpected delivery ID");
      let stopped = false;
      stopping = login.stop().then(() => {
        stopped = true;
      });
      await expect(start({ port: 0 })).rejects.toMatchObject({
        code: "LOGIN_ALREADY_RUNNING",
      });
      await expect(
        fetch(`http://127.0.0.1:${login.port}/auth/nonce`, {
          signal: AbortSignal.timeout(1_000),
        }),
      ).rejects.toBeDefined();
      expect(stopped).toBe(false);
      expect(isEmbeddedDatabase()).toBe(true);
      expect(await queue.getDelivery(current, config.tenantId)).toMatchObject({
        status: "processing",
        attempts: 1,
      });
      expect(await queue.getDelivery(pending, config.tenantId)).toMatchObject({
        status: "pending",
        attempts: 0,
      });
      release.resolve();
      await stopping;
      login = undefined;
      expect(isEmbeddedDatabase()).toBe(false);
      const readReceipts = async () => {
        const reopened = await createPGLiteDb();
        try {
          return await reopened.db
            .select({
              id: webhookDeliveries.id,
              status: webhookDeliveries.status,
              attempts: webhookDeliveries.attempts,
              lastError: webhookDeliveries.lastError,
            })
            .from(webhookDeliveries);
        } finally {
          await reopened.client.close();
        }
      };
      const firstReceipt = {
        id: current,
        status: scenario.receipt,
        attempts: 1,
        lastError:
          scenario.status === 503 ? "Webhook responded with status 503" : null,
      };
      expect(await readReceipts()).toEqual(
        expect.arrayContaining([
          firstReceipt,
          { id: pending, status: "pending", attempts: 0, lastError: null },
        ]),
      );
      expect(delivered).toEqual([current]);
      if (!scenario.detachBeforeShutdown) {
        expect(getTaskSchedulerAdapter()).toBe(taskAdapter);
        const taskCompleted = latch<void>();
        const taskRuntime = tasks.runtime;
        taskRuntime.registerTaskWorker({
          name: "AUTH_TIMER_PEER",
          execute: async () => {
            taskCompleted.resolve();
          },
        });
        await taskRuntime.createTask({
          name: "AUTH_TIMER_PEER",
          tags: ["queue"],
          metadata: { blocking: true },
        });
        const service = new TaskService(taskRuntime);
        try {
          service.startTimer();
          await received(taskCompleted.promise, "Core scheduled task");
        } finally {
          await service.stop();
        }
        await stopTaskScheduler();
      }
      login = await start({ port: 0 });
      expect(await received(next.promise)).toBe(pending);
      await login.stop();
      login = undefined;
      expect(await readReceipts()).toEqual(
        expect.arrayContaining([
          firstReceipt,
          { id: pending, status: "delivered", attempts: 1, lastError: null },
        ]),
      );
      expect(delivered).toEqual([current, pending]);
      expect(signatureResults).toEqual([true, true]);
    } finally {
      release.resolve();
      try {
        await stopping;
        await login?.stop();
        await stopTaskScheduler();
        await tasks?.cleanup();
      } finally {
        await fixture.close();
      }
    }
  }, 120_000);
}
