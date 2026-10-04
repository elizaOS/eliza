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
  type IAgentRuntime,
  type NotificationInput,
  NotificationService,
  type ServiceClass,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { expect, it } from "vitest";
import { ApnsProvider } from "../src/services/push/apns-provider.ts";
import { FcmProvider } from "../src/services/push/fcm-provider.ts";
import {
  NOTIFICATION_PUSH_SERVICE_TYPE,
  NotificationPushService,
} from "../src/services/push/notification-push-service.ts";
import { PushTokenRegistry } from "../src/services/push/push-token-registry.ts";
import type { PushMessage } from "../src/services/push/push-types.ts";

it("boots push before its lazy event bus and carries persisted reminder urgency to Android HTTP", async () => {
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
    // Production registers the event bus lazily. Start push through the real
    // runtime lifecycle before anything explicitly starts that dependency.
    expect(runtime.hasService(ServiceType.AGENT_EVENT)).toBe(true);
    expect(runtime.getServiceRegistrationStatus(ServiceType.AGENT_EVENT)).toBe(
      "pending",
    );
    class LoopbackPushService extends NotificationPushService {
      static override async start(rt: IAgentRuntime) {
        const service = new LoopbackPushService(rt, {
          registry,
          providers: { android, ios: new ApnsProvider({}) },
        });
        await service.attach();
        return service;
      }
    }
    await runtime.registerService(LoopbackPushService as ServiceClass);
    push = (await runtime.getServiceLoadPromise(
      NOTIFICATION_PUSH_SERVICE_TYPE,
    )) as NotificationPushService;

    expect(push.isDeliveryEnabled("android")).toBe(true);
    expect(push.isDeliveryEnabled("ios")).toBe(false);

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
      // A readiness retry must not subscribe twice and duplicate later pushes.
      if (index === 0) await push.attach();
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

    // A negotiated device and a legacy device coexist in the same durable registry.
    const nativeToken = "synthetic-native-data-android-token";
    await registry.register("android", nativeToken, true);
    const previousCount = requests.length;
    const nativeReminder = await notifier.notify({
      title: "Cold pair",
      body: "First saved reminder",
      category: "reminder",
      deepLink: "/notifications",
    });
    await expect.poll(() => requests.length).toBe(previousCount + 2);
    const pair = requests.slice(previousCount);
    const nativeMessage = pair.find(
      (r) => r.message.token === nativeToken,
    )?.message;
    expect(nativeMessage).not.toHaveProperty("notification");
    expect(nativeMessage).toMatchObject({
      data: {
        elizaReminderData: "1",
        notificationId: nativeReminder.id,
        title: "Cold pair",
        body: "First saved reminder",
        deepLink: "/notifications",
        priority: "normal",
      },
      android: { priority: "HIGH" },
    });
    expect(nativeMessage).not.toHaveProperty("android.collapse_key");
    expect(
      pair.find((r) => r.message.token === token)?.message.notification,
    ).toEqual({ title: "Cold pair", body: "First saved reminder" });
    for (const ownerType of [
      "occurrence",
      "calendar_event",
      "unknown",
      null,
      { type: "occurrence" },
    ]) {
      const start = requests.length;
      await notifier.notify({
        title: "Owner type projection",
        category: "reminder",
        priority: "high",
        data: { ownerType },
      });
      await expect.poll(() => requests.length).toBe(start + 2);
      const native = requests
        .slice(start)
        .find((r) => r.message.token === nativeToken)?.message;
      if (ownerType === "occurrence" || ownerType === "calendar_event") {
        expect(native).toHaveProperty("data.ownerType", ownerType);
      } else {
        expect(native).not.toHaveProperty("data.ownerType");
      }
    }
    const genericStart = requests.length;
    await notifier.notify({
      title: "Generic stays stock",
      category: "workflow",
      data: { ownerType: "occurrence" },
    });
    await expect.poll(() => requests.length).toBe(genericStart + 2);
    expect(
      requests.slice(genericStart).every((r) => r.message.notification),
    ).toBe(true);
    expect(
      requests
        .slice(genericStart)
        .every(
          (r) => !("ownerType" in (r.message.data as Record<string, unknown>)),
        ),
    ).toBe(true);
    // Formerly accepted incompatible fields retain the legacy serializer.
    for (const incompatible of [
      { title: "x".repeat(513) },
      { body: "x".repeat(4097) },
      {
        data: {
          category: "reminder",
          notificationId: nativeReminder.id,
          deepLink: "x".repeat(2049),
        },
      },
    ]) {
      const shaped = JSON.parse(
        android.buildMessageBody(nativeToken, {
          title: "Reminder",
          data: { category: "reminder", notificationId: nativeReminder.id },
          androidReminderDataNotifications: true,
          ...incompatible,
        }),
      );
      expect(shaped.message).toHaveProperty("notification");
    }
    await push.stop();
    expect(push.isDeliveryEnabled("android")).toBe(false);
    push = new NotificationPushService(runtime, {
      registry,
      providers: { android: new FcmProvider({}), ios: new ApnsProvider({}) },
    });
    await push.attach();
    expect(push.isDeliveryEnabled("android")).toBe(false);
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
