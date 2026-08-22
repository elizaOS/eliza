/**
 * Verifies group reminder dispatch against the binding authority: an active
 * binding is re-verified before any connector egress, inactive or drifted
 * bindings fail closed as not accepted, delivered group sends record provider
 * receipts, and the owner's phone receives no DM-styled push. Covers both the
 * gateway path and the Personal Shared Telegram edge dispatch path. Mocked
 * scheduler and repository harness with an intercepted gateway fetch.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

const listDueScheduledTaskRefs = mock(async () => []);
const listRecoverableScheduledTaskRefs = mock(async () => []);
const coordinateSharedPushDispatch = mock(async () => {});
const createSharedScheduledTaskRunner = mock(() => ({
  async fireWithResult() {
    return { kind: "fired" as const };
  },
}));

const BINDING_ID = "8b8f2c69-6a3e-4a0f-9be1-1f8f6a3e4a0f";
const activeTelegramBinding = {
  id: BINDING_ID,
  organization_id: "00000000-0000-4000-8000-000000000001",
  owner_user_id: "00000000-0000-4000-8000-000000000002",
  personal_agent_id: "personal:00000000-0000-5000-8000-000000000000",
  platform: "telegram",
  project: "eliza-app",
  connector_account_id: "telegram:test-bot",
  provider_chat_id: "-100123456789",
  conversation_id: "group:00000000-0000-5000-8000-000000000030",
  state: "active",
  response_policy: "mention_only",
  created_by_platform_user_id: "123456789",
};
const findBindingById = mock(
  async (): Promise<Record<string, unknown> | null> => activeTelegramBinding,
);
const recordDeliveryReceipts = mock(async () => 1);

// The real prefix builder keeps the asserted fire-time text and the plugin's
// creation-time budget on the same source of truth.
const { sharedGroupReminderMessageText } = await import("@elizaos/plugin-scheduling/edge");

mock.module("@elizaos/plugin-scheduling/edge", () => ({
  listDueScheduledTaskRefs,
  listRecoverableScheduledTaskRefs,
  SHARED_REMINDER_MAX_TEXT_LENGTH: 2000,
  sharedGroupReminderMessageText,
  parseSharedReminderDelivery(value: unknown) {
    if (!value || typeof value !== "object") return undefined;
    const delivery = value as Record<string, unknown>;
    if (delivery.platform === "telegram") return delivery;
    if (delivery.platform === "blooio") return delivery;
    if (delivery.platform === "discord") return delivery;
    return undefined;
  },
  isSharedGroupReminderDelivery(delivery: Record<string, unknown>) {
    return delivery.kind === "group";
  },
}));
mock.module("./shared-scheduling", () => ({
  createSharedScheduledTaskRunner,
  executeSharedSchedulingSql: mock(async () => []),
}));
mock.module("./conversation-coordinator", () => ({
  coordinateSharedPushDispatch,
}));
mock.module("../../../db/repositories/personal-shared-groups", () => ({
  personalSharedGroupsRepository: {
    findBindingById,
    recordDeliveryReceipts,
  },
}));

const { sharedReminderDispatcher } = await import("./shared-reminder-cron");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  coordinateSharedPushDispatch.mockClear();
  findBindingById.mockClear();
  findBindingById.mockImplementation(async () => activeTelegramBinding);
  recordDeliveryReceipts.mockClear();
  recordDeliveryReceipts.mockImplementation(async () => 1);
  mock.restore();
});

const env = {
  ELIZA_APP_WEBHOOK_GATEWAY_URL: "https://gateway.example/",
  ELIZA_APP_DISCORD_WEBHOOK_HANDLER_URL: "https://gateway-discord.example/",
  GATEWAY_INTERNAL_SECRET: "internal-secret",
  SHARED_RUNTIME_CONVERSATIONS: { getByName: mock() },
} as never;

function groupRecord(overrides: { delivery?: Record<string, unknown>; body?: string } = {}) {
  return {
    taskId: "group-reminder-1",
    promptInstructions: "pay the rent",
    firedAtIso: "2026-08-20T19:30:00.000Z",
    metadata: {
      dispatchIdempotencyKey: "group-reminder-1:2026-08-20T19:30:00.000Z",
      delivery: {
        platform: "telegram",
        kind: "group",
        project: "eliza-app",
        chatId: "-100123456789",
        groupBindingId: BINDING_ID,
        ownerLabel: "Nubs",
        ...overrides.delivery,
      },
    },
    output: { fallback: { body: overrides.body ?? "pay the rent" } },
  };
}

function acceptingFetch(requests: Request[]) {
  return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const body = (await request.clone().json()) as Record<string, unknown>;
    return Response.json({
      success: true,
      idempotencyKey: body.idempotencyKey,
      acceptedAt: "2026-08-20T19:30:00.100Z",
      providerMessageIds: ["provider-group-1"],
    });
  }) as typeof fetch;
}

describe("Shared group reminder dispatch", () => {
  test("delivers into the group thread with the owner-attributed prefix and records receipts", async () => {
    const requests: Request[] = [];
    globalThis.fetch = acceptingFetch(requests);
    const dispatcher = sharedReminderDispatcher(
      env,
      "personal:00000000-0000-5000-8000-000000000000",
    );

    const result = await dispatcher.dispatch(groupRecord());

    expect(findBindingById).toHaveBeenCalledWith(BINDING_ID);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gateway.example/internal/deliver");
    await expect(requests[0]?.json()).resolves.toEqual({
      platform: "telegram",
      project: "eliza-app",
      chatId: "-100123456789",
      text: "Reminder for this group from Nubs: pay the rent",
      idempotencyKey: "group-reminder-1:2026-08-20T19:30:00.000Z",
    });
    expect(result).toMatchObject({
      ok: true,
      target: "-100123456789",
      metadata: { providerMessageIds: ["provider-group-1"] },
    });
    expect(recordDeliveryReceipts).toHaveBeenCalledWith({
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:test-bot",
      providerChatId: "-100123456789",
      sourceMessageId: "group-reminder-1:2026-08-20T19:30:00.000Z",
      providerMessageIds: ["provider-group-1"],
    });
    expect(coordinateSharedPushDispatch).not.toHaveBeenCalled();
  });

  test("delivers a Telegram group reminder through the edge dispatch with the prefixed text and records receipts", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("gateway egress must not run when edge dispatch is configured");
    }) as typeof fetch;
    const telegramDispatch = mock(async () => ({
      ok: true as const,
      acceptedAt: "2026-08-20T19:30:00.100Z",
      providerMessageIds: ["provider-group-edge-1"],
    }));
    const dispatcher = sharedReminderDispatcher(
      env,
      "personal:00000000-0000-5000-8000-000000000000",
      { telegramDispatch },
    );

    const result = await dispatcher.dispatch(groupRecord());

    expect(findBindingById).toHaveBeenCalledWith(BINDING_ID);
    expect(telegramDispatch).toHaveBeenCalledWith({
      project: "eliza-app",
      chatId: "-100123456789",
      text: "Reminder for this group from Nubs: pay the rent",
      idempotencyKey: "group-reminder-1:2026-08-20T19:30:00.000Z",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      target: "-100123456789",
      metadata: { providerMessageIds: ["provider-group-edge-1"] },
    });
    expect(recordDeliveryReceipts).toHaveBeenCalledWith({
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:test-bot",
      providerChatId: "-100123456789",
      sourceMessageId: "group-reminder-1:2026-08-20T19:30:00.000Z",
      providerMessageIds: ["provider-group-edge-1"],
    });
    expect(coordinateSharedPushDispatch).not.toHaveBeenCalled();
  });

  test("routes a Blooio group thread through the gateway by provider chat id", async () => {
    findBindingById.mockImplementationOnce(async () => ({
      ...activeTelegramBinding,
      platform: "blooio",
      connector_account_id: "blooio:test-number",
      provider_chat_id: "chat_group_123",
    }));
    const requests: Request[] = [];
    globalThis.fetch = acceptingFetch(requests);
    const dispatcher = sharedReminderDispatcher(env);

    const result = await dispatcher.dispatch(
      groupRecord({
        delivery: { platform: "blooio", chatId: "chat_group_123" },
      }),
    );

    expect(requests[0]?.url).toBe("https://gateway.example/internal/deliver");
    await expect(requests[0]?.json()).resolves.toEqual({
      platform: "blooio",
      project: "eliza-app",
      chatId: "chat_group_123",
      text: "Reminder for this group from Nubs: pay the rent",
      idempotencyKey: "group-reminder-1:2026-08-20T19:30:00.000Z",
    });
    expect(result).toMatchObject({ ok: true, target: "chat_group_123" });
  });

  for (const [label, binding] of [
    ["missing", null],
    ["suspended", { ...activeTelegramBinding, state: "suspended" }],
    ["revoked", { ...activeTelegramBinding, state: "revoked" }],
    [
      "rebound to a different chat",
      { ...activeTelegramBinding, provider_chat_id: "-100987654321" },
    ],
  ] as const) {
    test(`fails closed before egress when the binding is ${label}`, async () => {
      findBindingById.mockImplementationOnce(async () => binding);
      globalThis.fetch = mock(async () => {
        throw new Error("connector egress must not run");
      }) as typeof fetch;
      const dispatcher = sharedReminderDispatcher(
        env,
        "personal:00000000-0000-5000-8000-000000000000",
      );

      await expect(dispatcher.dispatch(groupRecord())).resolves.toMatchObject({
        ok: false,
        reason: "unknown_recipient",
        userActionable: true,
        acceptance: "not_accepted",
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(recordDeliveryReceipts).not.toHaveBeenCalled();
      expect(coordinateSharedPushDispatch).not.toHaveBeenCalled();
    });
  }

  test("rejects text that exceeds the connector limit after the group prefix", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connector egress must not run");
    }) as typeof fetch;
    const dispatcher = sharedReminderDispatcher(env);

    await expect(
      dispatcher.dispatch(groupRecord({ body: "x".repeat(1990) })),
    ).resolves.toMatchObject({
      ok: false,
      userActionable: true,
      acceptance: "not_accepted",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("keeps the verified acceptance when receipt recording fails after delivery", async () => {
    recordDeliveryReceipts.mockImplementationOnce(async () => {
      throw new Error("receipt store unavailable");
    });
    const requests: Request[] = [];
    globalThis.fetch = acceptingFetch(requests);
    const dispatcher = sharedReminderDispatcher(env);

    await expect(dispatcher.dispatch(groupRecord())).resolves.toMatchObject({
      ok: true,
      metadata: { providerMessageIds: ["provider-group-1"] },
    });
    expect(requests).toHaveLength(1);
  });

  test("does not gate or receipt a private reminder through the group authority", async () => {
    const requests: Request[] = [];
    globalThis.fetch = acceptingFetch(requests);
    const dispatcher = sharedReminderDispatcher(
      env,
      "personal:00000000-0000-5000-8000-000000000000",
    );

    const result = await dispatcher.dispatch({
      taskId: "dm-reminder-1",
      promptInstructions: "stretch",
      firedAtIso: "2026-08-20T19:30:00.000Z",
      metadata: {
        dispatchIdempotencyKey: "dm-reminder-1:2026-08-20T19:30:00.000Z",
        delivery: {
          platform: "telegram",
          project: "eliza-app",
          chatId: "123456789",
        },
      },
      output: { fallback: { body: "stretch" } },
    });

    expect(result).toMatchObject({ ok: true, target: "123456789" });
    await expect(requests[0]?.json()).resolves.toMatchObject({
      text: "stretch",
    });
    expect(findBindingById).not.toHaveBeenCalled();
    expect(recordDeliveryReceipts).not.toHaveBeenCalled();
    expect(coordinateSharedPushDispatch).toHaveBeenCalledTimes(1);
  });
});
