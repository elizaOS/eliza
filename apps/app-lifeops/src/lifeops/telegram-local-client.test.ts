import { describe, expect, it, vi } from "vitest";
import type { StoredTelegramConnectorToken } from "./telegram-auth.js";
import {
  listRecentTelegramDialogs,
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
});
