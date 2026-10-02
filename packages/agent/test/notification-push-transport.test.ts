/** Real persisted notification rail and loopback HTTP transport; no Google sends. */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentEventService,
  AgentRuntime,
  defaultPriorityForCategory,
  type NotificationInput,
  NotificationService,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { expect, it } from "vitest";
import { ApnsProvider } from "../src/services/push/apns-provider.ts";
import { FcmProvider } from "../src/services/push/fcm-provider.ts";
import { NotificationPushService } from "../src/services/push/notification-push-service.ts";
import { PushTokenRegistry } from "../src/services/push/push-token-registry.ts";
import type { PushMessage } from "../src/services/push/push-types.ts";

it("carries persisted reminder urgency to Android HTTP bodies without elevating low or legacy traffic", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "notification-push-transport-"),
  );
  const agentId = randomUUID() as UUID;
  const token = "synthetic-current-agent-android-token";
  const requests: Array<{ message: Record<string, unknown> }> = [];
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: `local-message-${requests.length}` }));
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  const address = receiver.address();
  if (!address || typeof address === "string")
    throw new Error("Missing receiver address");
  const endpoint = `http://127.0.0.1:${address.port}/messages`;
  // Keep the production serializer and configuration gate. Only the delivery
  // target changes through the service's existing provider seam.
  class LoopbackFcmProvider extends FcmProvider {
    override async send(
      deviceToken: string,
      message: PushMessage,
    ): Promise<void> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: this.buildMessageBody(deviceToken, message),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        throw new Error(`Loopback push rejected: ${response.status}`);
    }
  }
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const android = new LoopbackFcmProvider({
    ELIZA_FCM_SERVICE_ACCOUNT: JSON.stringify({
      client_email: "fixture@example.invalid",
      project_id: "loopback-only",
      private_key: privateKey,
    }),
  });
  const runtime = new AgentRuntime({
    agentId,
    character: { name: "Push transport acceptance", bio: [] },
    logLevel: "fatal",
    enableAutonomy: false,
  });
  let push: NotificationPushService | undefined;
  try {
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(join(directory, "agent.sqlite"), agentId),
    );
    await runtime.init();
    await runtime.initialize();
    await runtime.registerService(AgentEventService);
    await runtime.registerService(NotificationService);
    await runtime.getServiceLoadPromise(ServiceType.AGENT_EVENT);
    const notifier = (await runtime.getServiceLoadPromise(
      ServiceType.NOTIFICATION,
    )) as NotificationService;
    const registry = new PushTokenRegistry(runtime);
    await registry.register("android", token);
    await registry.register("ios", "synthetic-unconfigured-ios-token");
    const foreignAgentId = randomUUID();
    await runtime.setCache(`push-tokens:${foreignAgentId}`, [
      {
        token: "synthetic-foreign-agent-token",
        platform: "android",
        createdAt: 1,
      },
    ]);
    const registryBefore = await runtime.getCache(`push-tokens:${agentId}`);
    push = new NotificationPushService(runtime, {
      registry,
      providers: { android, ios: new ApnsProvider({}) },
    });
    await push.attach();

    const cases: Array<{
      input: NotificationInput;
      androidPriority: "HIGH" | "NORMAL";
    }> = [
      {
        input: { title: "Due reminder", category: "reminder" },
        androidPriority: "HIGH",
      },
      {
        input: {
          title: "Quiet reminder",
          category: "reminder",
          priority: "low",
        },
        androidPriority: "NORMAL",
      },
      {
        input: {
          title: "High reminder",
          category: "reminder",
          priority: "high",
        },
        androidPriority: "HIGH",
      },
      {
        input: {
          title: "Urgent reminder",
          category: "reminder",
          priority: "urgent",
        },
        androidPriority: "HIGH",
      },
      {
        input: { title: "Workflow digest", category: "workflow" },
        androidPriority: "NORMAL",
      },
      {
        input: {
          title: "General interruption",
          category: "general",
          priority: "high",
        },
        androidPriority: "HIGH",
      },
      {
        input: { title: "System background", category: "system" },
        androidPriority: "NORMAL",
      },
    ];
    for (const [index, { input, androidPriority }] of cases.entries()) {
      const notification = await notifier.notify({
        ...input,
        body: "Exact owner-facing body",
        deepLink: "/chat",
        groupKey: `independent:${index}`,
        data: { privateContext: "Retain in the inbox, not the transport" },
      });
      await expect
        .poll(() => requests.length, { timeout: 5_000 })
        .toBe(index + 1);
      expect(requests[index]).toEqual({
        message: {
          token,
          notification: { title: input.title, body: "Exact owner-facing body" },
          android: { priority: androidPriority },
          data: {
            notificationId: notification.id,
            category: notification.category,
            deepLink: "/chat",
            groupKey: `independent:${index}`,
          },
        },
      });
      expect(await runtime.getCache(`notifications:${agentId}`)).toContainEqual(
        notification,
      );
      expect(notification.priority).toBe(
        input.priority ??
          defaultPriorityForCategory(input.category ?? "general"),
      );
    }
    const beforeReadUpdate = requests.length;
    expect(await notifier.markReadByGroupKey("independent:0")).toBe(1);
    // Give a wrongly re-dispatched update time to reach the loopback receiver.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(requests).toHaveLength(beforeReadUpdate);
    expect(
      notifier
        .list()
        .find((notification) => notification.groupKey === "independent:0")
        ?.readAt,
    ).toBeTypeOf("number");
    // Untyped legacy rail events still reach the same agent-owned transport.
    const bus = runtime.getService<AgentEventService>(ServiceType.AGENT_EVENT);
    if (!bus) throw new Error("Missing real event bus");
    bus.emit({
      runId: randomUUID(),
      stream: "notification",
      data: { notification: { ...notifier.list()[1], id: randomUUID() } },
    });
    await expect
      .poll(() => requests.length, { timeout: 5_000 })
      .toBe(beforeReadUpdate + 1);
    // Legacy senders do not acquire an Android override or an implicit reminder priority.
    await android.send(token, {
      title: "Legacy reminder",
      data: { category: "reminder" },
    });
    expect(requests.at(-1)?.message).toEqual({
      token,
      notification: { title: "Legacy reminder" },
      data: { category: "reminder" },
    });
    await android.send(token, {
      title: "Uncategorized normal",
      priority: "normal",
    });
    expect(requests.at(-1)?.message.android).toEqual({ priority: "NORMAL" });
    expect(requests).toHaveLength(cases.length + 3);
    expect(await runtime.getCache(`push-tokens:${agentId}`)).toEqual(
      registryBefore,
    );
    expect(await runtime.getCache(`push-tokens:${foreignAgentId}`)).toEqual([
      {
        token: "synthetic-foreign-agent-token",
        platform: "android",
        createdAt: 1,
      },
    ]);

    await push.stop();
    push = new NotificationPushService(runtime, {
      registry,
      providers: { android: new FcmProvider({}), ios: new ApnsProvider({}) },
    });
    await push.attach();
    const beforeUnconfigured = requests.length;
    const unavailable = await notifier.notify({
      title: "Unconfigured due reminder",
      category: "reminder",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(beforeUnconfigured);
    expect(await runtime.getCache(`notifications:${agentId}`)).toContainEqual(
      unavailable,
    );
  } finally {
    await push?.stop();
    await runtime.close();
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
