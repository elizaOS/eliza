/** Exercises the actual login webhook worker, shared Core timer and durable receipts. */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import {
  getTaskSchedulerAdapter,
  startTaskScheduler,
  stopTaskScheduler,
  TaskService,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import type { startEmbeddedLogin } from "../../src/server/runtime";

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function received<T>(
  promise: Promise<T>,
  description = "Local webhook",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} did not arrive`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
    const directory = await mkdtemp(join(tmpdir(), "login-webhook-timer-"));
    const dataDir = join(directory, "database");
    const randomSecret = () => randomBytes(32).toString("hex");
    const environment = {
      NODE_ENV: "test",
      STEWARD_RUNTIME: "bun",
      STEWARD_PGLITE_MEMORY: "false",
      STEWARD_PGLITE_PATH: dataDir,
      STEWARD_MASTER_PASSWORD: randomSecret(),
      STEWARD_JWT_SECRET: randomSecret(),
      STEWARD_KDF_SALT: randomSecret(),
      STEWARD_AUDIT_HMAC_KEY: randomSecret(),
      STEWARD_WEBHOOK_SECRET_ENCRYPTION_KEY: randomSecret(),
      // This isolated fixture owns the only URL in its private database.
      STEWARD_ALLOW_PRIVATE_WEBHOOK_NETWORKS: "true",
      DATABASE_URL: "",
      REDIS_URL: "",
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      APP_URL: "https://eliza.app",
    };
    const previous = new Map(
      [...Object.keys(environment), "STEWARD_DB_MODE", "STEWARD_EMBEDDED"].map(
        (key) => [key, process.env[key]],
      ),
    );
    Object.assign(process.env, environment);
    const authorities = getCACertificates("default");
    const first = latch<string>(),
      next = latch<string>(),
      release = latch<void>();
    const delivered: string[] = [];
    const signatureResults: boolean[] = [];
    let endpoint: ReturnType<typeof Bun.serve> | undefined;
    let login: Awaited<ReturnType<typeof startEmbeddedLogin>> | undefined;
    let tasks: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      const certPath = join(directory, "cert.pem"),
        keyPath = join(directory, "key.pem");
      const certificate = Bun.spawnSync([
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ]);
      if (certificate.exitCode !== 0)
        throw new Error("Could not create local TLS certificate");
      const [cert, key] = await Promise.all([
        readFile(certPath, "utf8"),
        readFile(keyPath, "utf8"),
      ]);
      setDefaultCACertificates([...authorities, cert]);
      const { PersistentQueue, verifyWebhookSignature } = await import(
        "../../src/server/webhooks/index"
      );
      const secret = randomSecret();
      endpoint = Bun.serve({
        hostname: "localhost",
        port: 0,
        tls: { cert, key },
        async fetch(request) {
          const id = request.headers.get("X-Steward-Delivery-Id") ?? "";
          const body = await request.text();
          signatureResults.push(
            verifyWebhookSignature({
              body,
              deliveryId: id,
              eventType: request.headers.get("X-Steward-Event") ?? "",
              sentAt: request.headers.get("X-Steward-Sent-At") ?? "",
              signature: request.headers.get("X-Steward-Signature") ?? "",
              secret,
            }),
          );
          delivered.push(id);
          if (delivered.length === 1) {
            first.resolve(id);
            await release.promise;
            return new Response("fixture", { status: scenario.status });
          }
          next.resolve(id);
          return new Response("fixture");
        },
      });
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
          url: endpoint.url.toString(),
          secret,
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
      await stopping;
      await login?.stop();
      await stopTaskScheduler();
      await tasks?.cleanup();
      await endpoint?.stop(true);
      setDefaultCACertificates(authorities);
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
}
