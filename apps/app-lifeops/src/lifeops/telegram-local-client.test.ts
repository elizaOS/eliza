import { describe, expect, it, vi } from "vitest";
import type { StoredTelegramConnectorToken } from "./telegram-auth.js";
import {
  getTelegramReadReceipts,
  listRecentTelegramDialogs,
  searchTelegramMessages,
  sendTelegramAccountMessage,
  telegramLocalSessionAvailable,
  verifyTelegramLocalConnector,
  type TelegramLocalClientLike,
} from "./telegram-local-client.js";

function buildStoredToken(): StoredTelegramConnectorToken {
  return {
    provider: "telegram",
    agentId: "agent-1",
    side: "owner",
    sessionString: "persisted",
    apiId: 12345,
    apiHash: "hash-123",
    phone: "+15551234567",
    identity: {
      id: "user-1",
      username: "carol",
      firstName: "Carol",
    },
    connectorConfig: {
      phone: "+15551234567",
      appId: "12345",
      appHash: "hash-123",
      deviceModel: "Test Device",
      systemVersion: "Test OS",
      enabled: true,
    },
    createdAt: "2026-04-17T00:00:00.000Z",
    updatedAt: "2026-04-17T00:00:00.000Z",
  };
}

function buildClient(overrides: Partial<TelegramLocalClientLike> = {}): TelegramLocalClientLike {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getDialogs: vi.fn(async () => []),
    getEntity: vi.fn(async (target) => target),
    getMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ id: 42 })),
    ...overrides,
  };
}

describe("telegramLocalSessionAvailable", () => {
  it("returns false when the saved session is empty", () => {
    expect(
      telegramLocalSessionAvailable({
        loadSessionString: () => "",
      }),
    ).toBe(false);
  });

  it("returns true when a saved session exists", () => {
    expect(
      telegramLocalSessionAvailable({
        loadSessionString: () => "session-data",
      }),
    ).toBe(true);
  });
});

describe("listRecentTelegramDialogs", () => {
  it("returns normalized recent chat summaries", async () => {
    const client = buildClient({
      getDialogs: vi.fn(async () => [
        {
          id: 7,
          title: "Carol",
          unreadCount: 3,
          entity: { username: "carol" },
          message: {
            message: "On my way",
            date: new Date("2026-04-17T01:02:03.000Z"),
          },
        },
      ]),
    });

    const dialogs = await listRecentTelegramDialogs({
      tokenRef: "token-ref",
      deps: {
        loadSessionString: () => "session-data",
        readStoredToken: () => buildStoredToken(),
        createClient: () => client,
      },
    });

    expect(dialogs).toEqual([
      {
        id: "7",
        title: "Carol",
        username: "carol",
        lastMessageText: "On my way",
        lastMessageAt: "2026-04-17T01:02:03.000Z",
        unreadCount: 3,
      },
    ]);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("sendTelegramAccountMessage", () => {
  it("falls back to recent dialog matching when direct entity lookup fails", async () => {
    const sendTarget = { peer: "carol" };
    const client = buildClient({
      getEntity: vi.fn(async () => {
        throw new Error("not found");
      }),
      getDialogs: vi.fn(async () => [
        {
          id: 7,
          title: "Carol",
          inputEntity: sendTarget,
        },
      ]),
      sendMessage: vi.fn(async () => ({ id: 88 })),
    });

    const result = await sendTelegramAccountMessage({
      tokenRef: "token-ref",
      target: "Carol",
      message: "On my way",
      deps: {
        loadSessionString: () => "session-data",
        readStoredToken: () => buildStoredToken(),
        createClient: () => client,
      },
    });

    expect(result).toEqual({ messageId: "88" });
    expect(client.sendMessage).toHaveBeenCalledWith(sendTarget, {
      message: "On my way",
    });
  });

  it("fails instead of reporting success when Telegram returns no sent message id", async () => {
    const client = buildClient({
      getDialogs: vi.fn(async () => [{ id: 7, title: "Carol" }]),
      sendMessage: vi.fn(async () => ({})),
    });

    await expect(
      sendTelegramAccountMessage({
        tokenRef: "token-ref",
        target: "Carol",
        message: "On my way",
        deps: {
          loadSessionString: () => "session-data",
          readStoredToken: () => buildStoredToken(),
          createClient: () => client,
        },
      }),
    ).rejects.toThrow("Telegram send did not return a message id.");
  });
});

describe("verifyTelegramLocalConnector", () => {
  it("checks recent chats and sends a verification message to Saved Messages", async () => {
    const fixedNow = new Date("2026-04-17T05:00:00.000Z");
    const client = buildClient({
      getDialogs: vi.fn(async () => [
        {
          id: 1,
          title: "Saved Messages",
          message: {
            message: "Previous note",
            date: new Date("2026-04-17T04:58:00.000Z"),
          },
        },
      ]),
      sendMessage: vi.fn(async () => ({ id: 99 })),
    });

    const result = await verifyTelegramLocalConnector({
      tokenRef: "token-ref",
      deps: {
        now: () => fixedNow,
        loadSessionString: () => "session-data",
        readStoredToken: () => buildStoredToken(),
        createClient: () => client,
      },
    });

    expect(result.verifiedAt).toBe("2026-04-17T05:00:00.000Z");
    expect(result.read.ok).toBe(true);
    expect(result.read.dialogCount).toBe(1);
    expect(result.send.ok).toBe(true);
    expect(result.send.target).toBe("me");
    expect(result.send.message).toBe(
      "LifeOps Telegram verification 2026-04-17T05:00:00.000Z",
    );
    expect(result.send.messageId).toBe("99");
  });

  it("marks send verification failed when Telegram returns no message id", async () => {
    const fixedNow = new Date("2026-04-17T05:00:00.000Z");
    const client = buildClient({
      getDialogs: vi.fn(async () => [{ id: 1, title: "Saved Messages" }]),
      sendMessage: vi.fn(async () => ({})),
    });

    const result = await verifyTelegramLocalConnector({
      tokenRef: "token-ref",
      deps: {
        now: () => fixedNow,
        loadSessionString: () => "session-data",
        readStoredToken: () => buildStoredToken(),
        createClient: () => client,
      },
    });

    expect(result.read.ok).toBe(true);
    expect(result.send.ok).toBe(false);
    expect(result.send.error).toBe(
      "Telegram send did not return a message id.",
    );
    expect(result.send.messageId).toBeNull();
  });
});

describe("searchTelegramMessages", () => {
  it("searches within a scoped dialog and returns normalized message hits", async () => {
    const target = { peer: "carol" };
    const client = buildClient({
      getEntity: vi.fn(async () => {
        throw new Error("not found");
      }),
      getDialogs: vi.fn(async () => [
        {
          id: 7,
          title: "Carol",
          entity: { username: "carol" },
          inputEntity: target,
        },
      ]),
      getMessages: vi.fn(async () => [
        {
          id: 101,
          message: "needle in a haystack",
          date: new Date("2026-04-17T06:00:00.000Z"),
          out: true,
        },
      ]),
    });

    const results = await searchTelegramMessages({
      tokenRef: "token-ref",
      query: "needle",
      scope: "Carol",
      deps: {
        loadSessionString: () => "session-data",
        readStoredToken: () => buildStoredToken(),
        createClient: () => client,
      },
    });

    expect(results).toEqual([
      {
        id: "101",
        dialogId: "7",
        threadId: "7",
        dialogTitle: "Carol",
        username: "carol",
        peerId: null,
        senderId: null,
        content: "needle in a haystack",
        timestamp: "2026-04-17T06:00:00.000Z",
        outgoing: true,
      },
    ]);
    expect(client.getMessages).toHaveBeenCalledWith(target, {
      search: "needle",
      limit: 10,
    });
  });

  it("preserves dialog/thread metadata for global Telegram search hits", async () => {
    const client = buildClient({
      getDialogs: vi.fn(async () => [
        {
          id: 7,
          title: "Carol",
          entity: { username: "carol" },
        },
      ]),
      getMessages: vi.fn(async () => [
        {
          id: 101,
          message: "needle in a haystack",
          date: new Date("2026-04-17T06:00:00.000Z"),
          out: false,
          peerId: { userId: 7 },
          fromId: { userId: 7001 },
        },
      ]),
    });

    const results = await searchTelegramMessages({
      tokenRef: "token-ref",
      query: "needle",
      deps: {
        loadSessionString: () => "session-data",
        readStoredToken: () => buildStoredToken(),
        createClient: () => client,
      },
    });

    expect(results).toEqual([
      {
        id: "101",
        dialogId: "7",
        threadId: "7",
        dialogTitle: "Carol",
        username: "carol",
        peerId: "7",
        senderId: "7001",
        content: "needle in a haystack",
        timestamp: "2026-04-17T06:00:00.000Z",
        outgoing: false,
      },
    ]);
    expect(client.getMessages).toHaveBeenCalledWith(undefined, {
      search: "needle",
      limit: 10,
    });
  });
});

describe("getTelegramReadReceipts", () => {
  it("uses dialog readOutboxMaxId to mark outgoing messages as read", async () => {
    const target = { peer: "carol" };
    const client = buildClient({
      getEntity: vi.fn(async () => {
        throw new Error("not found");
      }),
      getDialogs: vi.fn(async () => [
        {
          id: 7,
          title: "Carol",
          inputEntity: target,
          dialog: {
            readOutboxMaxId: 200,
          },
        },
      ]),
      getMessages: vi.fn(async () => [
        {
          id: 199,
          message: "seen",
          date: new Date("2026-04-17T06:01:00.000Z"),
          out: true,
        },
        {
          id: 201,
          message: "pending",
          date: new Date("2026-04-17T06:02:00.000Z"),
          out: true,
        },
      ]),
    });

    const results = await getTelegramReadReceipts({
      tokenRef: "token-ref",
      target: "Carol",
      messageIds: ["199", "201", "oops"],
      deps: {
        loadSessionString: () => "session-data",
        readStoredToken: () => buildStoredToken(),
        createClient: () => client,
      },
    });

    expect(results).toEqual([
      {
        messageId: "199",
        status: "delivered_read",
        isRead: true,
        timestamp: "2026-04-17T06:01:00.000Z",
        content: "seen",
        outgoing: true,
      },
      {
        messageId: "201",
        status: "sent",
        isRead: false,
        timestamp: "2026-04-17T06:02:00.000Z",
        content: "pending",
        outgoing: true,
      },
      {
        messageId: "oops",
        status: "unknown",
        isRead: null,
        timestamp: null,
        content: null,
        outgoing: null,
      },
    ]);
    expect(client.getMessages).toHaveBeenCalledWith(target, {
      ids: [199, 201],
    });
  });
});
