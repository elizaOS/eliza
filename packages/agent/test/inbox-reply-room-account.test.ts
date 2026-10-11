/**
 * An inbox reply leaves from the connector account the room belongs to when
 * that account is registered for the provider. The real POST
 * /api/inbox/messages handler runs against a recorded send target.
 */
import { expect, it } from "vitest";
import { handleInboxRoute } from "../src/api/inbox-routes.ts";

const telegramAccounts = [
  {
    id: "personal",
    provider: "telegram",
    status: "connected",
    accessGate: "open",
    purpose: ["messaging"],
    role: "AGENT",
    metadata: { isDefault: true },
  },
  {
    id: "work",
    provider: "telegram",
    status: "connected",
    accessGate: "open",
    purpose: ["messaging"],
    role: "AGENT",
    metadata: {},
  },
];

interface ReplyCase {
  source: string;
  roomAccountId: string;
  accounts: typeof telegramAccounts;
  sendHandlerKeys: string[];
  accountId?: string;
  callerRole?: string
  roomMetadata?: Record<string, unknown>
}

async function reply(input: ReplyCase) {
  const room = {
    id: "11111111-1111-4111-8111-111111111111",
    source: input.source,
    channelId: "777000",
    metadata: input.roomMetadata ?? { accountId: input.roomAccountId },
  };
  const sends: Array<{ target: { accountId?: string } }> = [];
  const manager = {
    registerProvider() {},
    evaluatePolicy: async () => ({ allowed: true }),
    getAccount: async (provider: string, id: string) =>
      input.accounts.find(
        (account) => account.provider === provider && account.id === id,
      ) ?? null,
    listAccounts: async (provider: string) =>
      input.accounts.filter((account) => account.provider === provider),
    listProviders: () => [],
  };
  const runtime = {
    agentId: "agent",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getService: (type: string) => (type ? manager : null),
    getRoom: async () => room,
    sendHandlers: new Map(input.sendHandlerKeys.map((key) => [key, () => {}])),
    sendMessageToTarget: async (target: { accountId?: string }) => {
      sends.push({ target });
      return { delivery: "delivered", receipts: [{ providerMessageId: "1" }] };
    },
    getMemories: async () => [],
    getRoomsByIds: async () => [room],
  };
  let status = 200;
  let body: unknown;
  await handleInboxRoute(
    {} as never,
    {} as never,
    "/api/inbox/messages",
    "POST",
    {
      runtime: runtime as never,
      callerAuthorization: { ok: true, role: input.callerRole ?? "OWNER" },
    } as never,
    {
      readJsonBody: async () => ({
        ...(input.accountId ? { accountId: input.accountId } : {}),
        roomId: room.id,
        source: input.source,
        text: "reply in the inbox",
      }),
      json: (_res: unknown, payload: unknown, code = 200) => {
        body = payload;
        status = code;
      },
      error: (_res: unknown, message: string, code = 500) => {
        body = { error: message };
        status = code;
      },
    } as never,
  );
  return { status, body, sends };
}

const telegramRoom = (roomAccountId: string, accountId?: string) =>
  reply({
    source: "telegram",
    roomAccountId,
    accounts: telegramAccounts,
    sendHandlerKeys: ["telegram\u0000personal", "telegram\u0000work"],
    accountId,
  });

it("replies from the room's account when no account is selected", async () => {
  const { status, sends } = await telegramRoom("work");
  expect(status).toBe(200);
  expect(sends.map((send) => send.target.accountId)).toEqual(["work"]);
});

it("refuses to reply from a different account than the room's", async () => {
  const { status, body, sends } = await telegramRoom("work", "personal");
  expect(status).toBe(409);
  expect(body).toMatchObject({
    code: "INBOX_CONNECTOR_ACCOUNT_ROOM_MISMATCH",
    context: { accountId: "personal", roomAccountId: "work" },
  });
  expect(sends).toEqual([]);
});

it("keeps source routing for a provider with no accounts and an unscoped handler", async () => {
  const { status, sends } = await reply({
    source: "discord-local",
    roomAccountId: "default",
    accounts: [],
    sendHandlerKeys: ["discord-local"],
  });
  expect(status).toBe(200);
  expect(sends).toHaveLength(1);
  expect(sends[0]?.target.accountId).toBeUndefined();
});

it("keeps account routing for a room whose stored account no longer exists", async () => {
  const unselected = await telegramRoom("removed");
  expect(unselected.status).toBe(200);
  expect(unselected.sends.map((send) => send.target.accountId)).toEqual([
    "personal",
  ]);
  const selected = await telegramRoom("removed", "work");
  expect(selected.status).toBe(200);
  expect(selected.sends.map((send) => send.target.accountId)).toEqual(["work"]);
});

it("prefers a case-insensitive source-scoped room account", async () => {
  const { status, sends } = await reply({
    source: "telegram",
    roomAccountId: "personal",
    roomMetadata: { accountId: "personal", Telegram: { accountId: "work" } },
    accounts: telegramAccounts,
    sendHandlerKeys: ["telegram\u0000personal", "telegram\u0000work"],
  })
  expect(status).toBe(200)
  expect(sends.map((send) => send.target.accountId)).toEqual(["work"])
})

it("checks room account authorization before exposing a mismatch", async () => {
  const accounts = [
    {
      ...telegramAccounts[0],
    },
    {
      id: "owner",
      provider: "telegram",
      status: "connected",
      accessGate: "owner_binding",
      purpose: ["messaging"],
      role: "AGENT",
      metadata: {},
    },
  ] as typeof telegramAccounts
  const result = await reply({
    source: "telegram",
    roomAccountId: "owner",
    accounts,
    sendHandlerKeys: ["telegram\u0000personal", "telegram\u0000owner"],
    accountId: "personal",
    callerRole: "USER",
  })
  expect(result.status).toBe(403)
  expect(result.body).toMatchObject({
    code: "INBOX_CONNECTOR_ACCOUNT_CALLER_UNAUTHORIZED",
  })
  expect(result.sends).toEqual([])
})
