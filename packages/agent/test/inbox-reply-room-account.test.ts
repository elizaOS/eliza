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
  registeredProviders?: string[];
}

async function reply(input: ReplyCase) {
  const room = {
    id: "11111111-1111-4111-8111-111111111111",
    source: input.source,
    channelId: "777000",
    metadata: { accountId: input.roomAccountId },
  };
  const sends: Array<{ target: { accountId?: string } }> = [];
  const manager = {
    registerProvider() {},
    getStorage: () => ({ listAccounts: async () => input.accounts }),
    evaluatePolicy: async () => ({ allowed: true }),
    getAccount: async (provider: string, id: string) =>
      input.accounts.find(
        (account) => account.provider === provider && account.id === id,
      ) ?? null,
    listAccounts: async (provider: string) =>
      input.accounts.filter((account) => account.provider === provider),
    listProviders: () =>
      (input.registeredProviders ?? []).map((provider) => ({ provider })),
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
      callerAuthorization: { ok: true, role: "OWNER" },
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

it("refuses a reply when the room account no longer exists", async () => {
  const unselected = await telegramRoom("removed");
  expect(unselected.status).toBe(404);
  expect(unselected.body).toMatchObject({
    code: "INBOX_CONNECTOR_ACCOUNT_NOT_FOUND",
  });
  expect(unselected.sends).toEqual([]);
  const selected = await telegramRoom("removed", "work");
  expect(selected.status).toBe(409);
  expect(selected.body).toMatchObject({
    code: "INBOX_CONNECTOR_ACCOUNT_ROOM_MISMATCH",
  });
  expect(selected.sends).toEqual([]);
});

it("does not fall back to an unscoped handler after the last managed account is removed", async () => {
  const result = await reply({
    source: "telegram",
    roomAccountId: "removed",
    accounts: [],
    registeredProviders: ["telegram"],
    sendHandlerKeys: ["telegram"],
  });
  expect(result.status).toBe(404);
  expect(result.body).toMatchObject({
    code: "INBOX_CONNECTOR_ACCOUNT_NOT_FOUND",
  });
  expect(result.sends).toEqual([]);
});
