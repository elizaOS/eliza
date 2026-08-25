/**
 * Verifies group reminder dispatch against the binding delivery lease: a fire
 * authorizes under the stored authority generation, commits the lease before
 * any connector egress, records provider receipts through the same lease
 * afterwards, and never sends the owner a DM-styled push. A refused lease is
 * terminal when the binding is gone, inactive, or on another authority
 * generation / provider chat, and retryable while the live binding is only
 * held by a concurrent group send. Covers both the gateway path and the
 * Personal Shared Telegram edge dispatch path. Mocked scheduler and repository
 * harness with an intercepted gateway fetch.
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
const OWNER_USER_ID = "00000000-0000-4000-8000-000000000002";
const PERSONAL_AGENT_ID = "personal:00000000-0000-5000-8000-000000000000";
const AUTHORITY = {
  bindingId: BINDING_ID,
  ownerUserId: OWNER_USER_ID,
  personalAgentId: PERSONAL_AGENT_ID,
  version: 7,
};
const activeTelegramBinding = {
  id: BINDING_ID,
  organization_id: "00000000-0000-4000-8000-000000000001",
  owner_user_id: OWNER_USER_ID,
  personal_agent_id: PERSONAL_AGENT_ID,
  authority_version: 7,
  platform: "telegram",
  project: "eliza-app",
  connector_account_id: "telegram:test-bot",
  provider_chat_id: "-100123456789",
  conversation_id: "group:00000000-0000-5000-8000-000000000030",
  state: "active",
  response_policy: "mention_only",
  created_by_platform_user_id: "123456789",
};
const IDEMPOTENCY_KEY = "group-reminder-1:2026-08-20T19:30:00.000Z";
const telegramLease = {
  authority: AUTHORITY,
  platform: "telegram",
  project: "eliza-app",
  connectorAccountId: "telegram:test-bot",
  providerChatId: "-100123456789",
  sourceMessageId: IDEMPOTENCY_KEY,
  leaseToken: expect.stringMatching(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
};

const findBindingById = mock(
  async (): Promise<Record<string, unknown> | null> => activeTelegramBinding,
);
type DeliveryLease = {
  authorized: boolean;
  leaseToken: string | null;
  expiresAt: string | null;
};
const authorizeDelivery = mock(
  async (input: { leaseToken: string }): Promise<DeliveryLease> => ({
    authorized: true,
    leaseToken: input.leaseToken,
    expiresAt: "2026-08-20T19:31:30.000Z",
  }),
);
const commitDelivery = mock(async () => true);
const recordDeliveryReceipts = mock(async () => ({ recorded: true, inserted: 1 }));

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
    authorizeDelivery,
    commitDelivery,
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
  authorizeDelivery.mockClear();
  authorizeDelivery.mockImplementation(
    async (input: { leaseToken: string }): Promise<DeliveryLease> => ({
      authorized: true,
      leaseToken: input.leaseToken,
      expiresAt: "2026-08-20T19:31:30.000Z",
    }),
  );
  commitDelivery.mockClear();
  commitDelivery.mockImplementation(async () => true);
  recordDeliveryReceipts.mockClear();
  recordDeliveryReceipts.mockImplementation(async () => ({ recorded: true, inserted: 1 }));
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
      dispatchIdempotencyKey: IDEMPOTENCY_KEY,
      delivery: {
        platform: "telegram",
        kind: "group",
        project: "eliza-app",
        connectorAccountId: "telegram:test-bot",
        chatId: "-100123456789",
        ownerLabel: "Nubs",
        authority: AUTHORITY,
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

function refusingFetch() {
  return mock(async () => {
    throw new Error("connector egress must not run");
  }) as typeof fetch;
}

function callOrder(): string[] {
  const calls: Array<[string, number]> = [];
  const order = (name: string, fn: { mock: { invocationCallOrder: number[] } }) => {
    for (const sequence of fn.mock.invocationCallOrder) calls.push([name, sequence]);
  };
  order("authorize", authorizeDelivery);
  order("commit", commitDelivery);
  order("fetch", globalThis.fetch as unknown as { mock: { invocationCallOrder: number[] } });
  order("receipt", recordDeliveryReceipts);
  return calls.sort((a, b) => a[1] - b[1]).map(([name]) => name);
}

describe("Shared group reminder dispatch", () => {
  test("leases, commits before egress, delivers the owner-attributed prefix, and reconciles the receipt", async () => {
    const requests: Request[] = [];
    globalThis.fetch = acceptingFetch(requests);
    const dispatcher = sharedReminderDispatcher(env, PERSONAL_AGENT_ID);

    const result = await dispatcher.dispatch(groupRecord());

    expect(authorizeDelivery).toHaveBeenCalledWith({
      ...telegramLease,
      invocation: "command",
    });
    expect(commitDelivery).toHaveBeenCalledWith(telegramLease);
    expect(callOrder()).toEqual(["authorize", "commit", "fetch", "receipt"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gateway.example/internal/deliver");
    await expect(requests[0]?.json()).resolves.toEqual({
      platform: "telegram",
      project: "eliza-app",
      chatId: "-100123456789",
      text: "Reminder for this group from Nubs: pay the rent",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(result).toMatchObject({
      ok: true,
      target: "-100123456789",
      metadata: { providerMessageIds: ["provider-group-1"] },
    });
    expect(recordDeliveryReceipts).toHaveBeenCalledWith({
      ...telegramLease,
      providerMessageIds: ["provider-group-1"],
    });
    // The same fire always derives the same lease token so a recovered
    // dispatch can re-authorize its own committed slot.
    const [authorizeInput] = authorizeDelivery.mock.calls[0] ?? [];
    const [commitInput] = commitDelivery.mock.calls[0] ?? [];
    const [receiptInput] = recordDeliveryReceipts.mock.calls[0] ?? [];
    expect(authorizeInput?.leaseToken).toBe(commitInput?.leaseToken);
    expect(authorizeInput?.leaseToken).toBe(receiptInput?.leaseToken);
    expect(findBindingById).not.toHaveBeenCalled();
    expect(coordinateSharedPushDispatch).not.toHaveBeenCalled();
  });

  test("derives a stable lease token per fire and a different one for another fire", async () => {
    globalThis.fetch = acceptingFetch([]);
    const dispatcher = sharedReminderDispatcher(env);

    await dispatcher.dispatch(groupRecord());
    await dispatcher.dispatch(groupRecord());
    await dispatcher.dispatch({
      ...groupRecord(),
      metadata: {
        ...groupRecord().metadata,
        dispatchIdempotencyKey: "group-reminder-1:2026-08-21T19:30:00.000Z",
      },
    });

    const tokens = authorizeDelivery.mock.calls.map(([input]) => input?.leaseToken);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[0]);
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
    const dispatcher = sharedReminderDispatcher(env, PERSONAL_AGENT_ID, { telegramDispatch });

    const result = await dispatcher.dispatch(groupRecord());

    expect(authorizeDelivery).toHaveBeenCalledTimes(1);
    expect(commitDelivery).toHaveBeenCalledTimes(1);
    expect(commitDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      telegramDispatch.mock.invocationCallOrder[0] ?? 0,
    );
    expect(telegramDispatch).toHaveBeenCalledWith({
      project: "eliza-app",
      chatId: "-100123456789",
      text: "Reminder for this group from Nubs: pay the rent",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      target: "-100123456789",
      metadata: { providerMessageIds: ["provider-group-edge-1"] },
    });
    expect(recordDeliveryReceipts).toHaveBeenCalledWith({
      ...telegramLease,
      providerMessageIds: ["provider-group-edge-1"],
    });
    expect(coordinateSharedPushDispatch).not.toHaveBeenCalled();
  });

  test("routes a Blooio group thread through the gateway by provider chat id", async () => {
    const requests: Request[] = [];
    globalThis.fetch = acceptingFetch(requests);
    const dispatcher = sharedReminderDispatcher(env);

    const result = await dispatcher.dispatch(
      groupRecord({
        delivery: {
          platform: "blooio",
          connectorAccountId: "blooio:test-number",
          chatId: "chat_group_123",
        },
      }),
    );

    expect(authorizeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "blooio",
        connectorAccountId: "blooio:test-number",
        providerChatId: "chat_group_123",
        authority: AUTHORITY,
      }),
    );
    expect(requests[0]?.url).toBe("https://gateway.example/internal/deliver");
    await expect(requests[0]?.json()).resolves.toEqual({
      platform: "blooio",
      project: "eliza-app",
      chatId: "chat_group_123",
      text: "Reminder for this group from Nubs: pay the rent",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(result).toMatchObject({ ok: true, target: "chat_group_123" });
  });

  for (const [label, binding] of [
    ["missing", null],
    ["suspended", { ...activeTelegramBinding, state: "suspended" }],
    ["revoked", { ...activeTelegramBinding, state: "revoked" }],
    [
      "rebound to another owner generation",
      {
        ...activeTelegramBinding,
        owner_user_id: "00000000-0000-4000-8000-000000000099",
        authority_version: 8,
      },
    ],
    ["on a newer authority version", { ...activeTelegramBinding, authority_version: 8 }],
    [
      "serving another personal agent",
      { ...activeTelegramBinding, personal_agent_id: "personal:other" },
    ],
    [
      "rebound to a different chat",
      { ...activeTelegramBinding, provider_chat_id: "-100987654321" },
    ],
    [
      "moved to another connector account",
      { ...activeTelegramBinding, connector_account_id: "telegram:other-bot" },
    ],
  ] as const) {
    test(`fails closed before egress when the lease is refused and the binding is ${label}`, async () => {
      authorizeDelivery.mockImplementationOnce(async () => ({
        authorized: false,
        leaseToken: null,
        expiresAt: null,
      }));
      findBindingById.mockImplementationOnce(async () => binding);
      globalThis.fetch = refusingFetch();
      const dispatcher = sharedReminderDispatcher(env, PERSONAL_AGENT_ID);

      await expect(dispatcher.dispatch(groupRecord())).resolves.toMatchObject({
        ok: false,
        reason: "unknown_recipient",
        userActionable: true,
        acceptance: "not_accepted",
      });
      expect(findBindingById).toHaveBeenCalledWith(BINDING_ID);
      expect(commitDelivery).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(recordDeliveryReceipts).not.toHaveBeenCalled();
      expect(coordinateSharedPushDispatch).not.toHaveBeenCalled();
    });
  }

  test("retries shortly when the live binding's slot is held by a concurrent group send", async () => {
    authorizeDelivery.mockImplementationOnce(async () => ({
      authorized: false,
      leaseToken: null,
      expiresAt: null,
    }));
    globalThis.fetch = refusingFetch();
    const dispatcher = sharedReminderDispatcher(env, PERSONAL_AGENT_ID);

    await expect(dispatcher.dispatch(groupRecord())).resolves.toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 1,
      userActionable: false,
      acceptance: "not_accepted",
    });
    expect(findBindingById).toHaveBeenCalledWith(BINDING_ID);
    expect(commitDelivery).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(recordDeliveryReceipts).not.toHaveBeenCalled();
  });

  test("never reaches the connector when the commit loses the lease after authorization", async () => {
    commitDelivery.mockImplementationOnce(async () => false);
    findBindingById.mockImplementationOnce(async () => ({
      ...activeTelegramBinding,
      state: "revoked",
      authority_version: 8,
    }));
    globalThis.fetch = refusingFetch();
    const dispatcher = sharedReminderDispatcher(env, PERSONAL_AGENT_ID);

    await expect(dispatcher.dispatch(groupRecord())).resolves.toMatchObject({
      ok: false,
      reason: "unknown_recipient",
      acceptance: "not_accepted",
    });
    expect(authorizeDelivery).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(recordDeliveryReceipts).not.toHaveBeenCalled();
  });

  test("rejects text that exceeds the connector limit after the group prefix before taking a lease", async () => {
    globalThis.fetch = refusingFetch();
    const dispatcher = sharedReminderDispatcher(env);

    await expect(
      dispatcher.dispatch(groupRecord({ body: "x".repeat(1990) })),
    ).resolves.toMatchObject({
      ok: false,
      userActionable: true,
      acceptance: "not_accepted",
    });
    expect(authorizeDelivery).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("keeps the verified acceptance when the receipt is not recorded or the store fails", async () => {
    recordDeliveryReceipts.mockImplementationOnce(async () => ({ recorded: false, inserted: 0 }));
    const requests: Request[] = [];
    globalThis.fetch = acceptingFetch(requests);
    const dispatcher = sharedReminderDispatcher(env);

    await expect(dispatcher.dispatch(groupRecord())).resolves.toMatchObject({
      ok: true,
      metadata: { providerMessageIds: ["provider-group-1"] },
    });

    recordDeliveryReceipts.mockImplementationOnce(async () => {
      throw new Error("receipt store unavailable");
    });
    await expect(dispatcher.dispatch(groupRecord())).resolves.toMatchObject({
      ok: true,
      metadata: { providerMessageIds: ["provider-group-1"] },
    });
    expect(requests).toHaveLength(2);
  });

  test("does not lease, gate, or receipt a private reminder through the group authority", async () => {
    const requests: Request[] = [];
    globalThis.fetch = acceptingFetch(requests);
    const dispatcher = sharedReminderDispatcher(env, PERSONAL_AGENT_ID);

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
    expect(authorizeDelivery).not.toHaveBeenCalled();
    expect(commitDelivery).not.toHaveBeenCalled();
    expect(findBindingById).not.toHaveBeenCalled();
    expect(recordDeliveryReceipts).not.toHaveBeenCalled();
    expect(coordinateSharedPushDispatch).toHaveBeenCalledTimes(1);
  });
});
