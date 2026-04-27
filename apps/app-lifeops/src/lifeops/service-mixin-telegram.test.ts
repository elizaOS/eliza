import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsConnectorGrant } from "../contracts/index.js";
import { createLifeOpsConnectorGrant } from "./repository.js";
import { withTelegram } from "./service-mixin-telegram.js";
import type { StoredTelegramConnectorToken } from "./telegram-auth.js";

const telegramAuthMocks = vi.hoisted(() => ({
  cancelTelegramAuth: vi.fn(),
  deleteStoredTelegramToken: vi.fn(),
  findPendingTelegramAuthSession: vi.fn(),
  hasManagedTelegramCredentials: vi.fn(),
  inferRetryableTelegramAuthState: vi.fn(),
  readStoredTelegramToken: vi.fn(),
  startTelegramAuth: vi.fn(),
  submitTelegramAuthCode: vi.fn(),
  submitTelegramAuthPassword: vi.fn(),
}));

const telegramClientMocks = vi.hoisted(() => ({
  getTelegramReadReceipts: vi.fn(),
  searchTelegramMessages: vi.fn(),
  sendTelegramAccountMessage: vi.fn(),
  telegramLocalSessionAvailable: vi.fn(),
  verifyTelegramLocalConnector: vi.fn(),
}));

vi.mock("./telegram-auth.js", () => ({
  buildTelegramTokenRef: (agentId: string, side: string) =>
    `${agentId}/${side}/local.json`,
  cancelTelegramAuth: telegramAuthMocks.cancelTelegramAuth,
  deleteStoredTelegramToken: telegramAuthMocks.deleteStoredTelegramToken,
  findPendingTelegramAuthSession:
    telegramAuthMocks.findPendingTelegramAuthSession,
  hasManagedTelegramCredentials: telegramAuthMocks.hasManagedTelegramCredentials,
  inferRetryableTelegramAuthState:
    telegramAuthMocks.inferRetryableTelegramAuthState,
  readStoredTelegramToken: telegramAuthMocks.readStoredTelegramToken,
  startTelegramAuth: telegramAuthMocks.startTelegramAuth,
  submitTelegramAuthCode: telegramAuthMocks.submitTelegramAuthCode,
  submitTelegramAuthPassword: telegramAuthMocks.submitTelegramAuthPassword,
}));

vi.mock("./telegram-local-client.js", () => ({
  getTelegramReadReceipts: telegramClientMocks.getTelegramReadReceipts,
  searchTelegramMessages: telegramClientMocks.searchTelegramMessages,
  sendTelegramAccountMessage: telegramClientMocks.sendTelegramAccountMessage,
  telegramLocalSessionAvailable:
    telegramClientMocks.telegramLocalSessionAvailable,
  verifyTelegramLocalConnector: telegramClientMocks.verifyTelegramLocalConnector,
}));

const TOKEN_REF = "agent-telegram/owner/local.json";

function buildStoredToken(): StoredTelegramConnectorToken {
  return {
    provider: "telegram",
    agentId: "agent-telegram",
    side: "owner",
    sessionString: "session-data",
    apiId: 12345,
    apiHash: "hash-123",
    phone: "+15551234567",
    identity: {
      id: "telegram-user-1",
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

function buildGrant(
  capabilities: Array<"telegram.read" | "telegram.send"> = [
    "telegram.read",
    "telegram.send",
  ],
): LifeOpsConnectorGrant {
  return createLifeOpsConnectorGrant({
    agentId: "agent-telegram",
    provider: "telegram",
    identity: { id: "telegram-user-1", username: "carol" },
    grantedScopes: [],
    capabilities,
    tokenRef: TOKEN_REF,
    mode: "local",
    side: "owner",
    metadata: { phone: "+15551234567" },
    lastRefreshAt: "2026-04-17T00:00:00.000Z",
  });
}

class StubBase {
  runtime = { agentId: "agent-telegram" };
  ownerEntityId = null;
  repository = {
    deleteConnectorGrant: vi.fn(),
    getConnectorGrant: vi.fn(),
    upsertConnectorGrant: vi.fn(),
  };
  recordConnectorAudit = vi.fn(async () => undefined);

  agentId(): string {
    return this.runtime.agentId;
  }
}

type TelegramConsumer = {
  getTelegramConnectorStatus: (
    side?: "owner" | "agent",
  ) => Promise<{
    connected: boolean;
    reason: string;
    grantedCapabilities: string[];
    identity: { id?: string; username?: string } | null;
  }>;
  sendTelegramMessage: (request: {
    side?: "owner" | "agent";
    target: string;
    message: string;
  }) => Promise<{ ok: true; messageId: string | null }>;
  searchTelegramMessages: (request: {
    side?: "owner" | "agent";
    query: string;
    scope?: string;
    limit?: number;
  }) => Promise<unknown[]>;
  getTelegramDeliveryStatus: (request: {
    side?: "owner" | "agent";
    target: string;
    messageIds: string[];
  }) => Promise<unknown[]>;
  verifyTelegramConnector: (request: {
    side?: "owner" | "agent";
    recentLimit?: number;
    sendTarget?: string;
    sendMessage?: string;
  }) => Promise<unknown>;
};

const Composed = withTelegram(StubBase as never);

function createService(): StubBase & TelegramConsumer {
  return new (Composed as unknown as new () => StubBase & TelegramConsumer)();
}

describe("withTelegram consumer surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    telegramAuthMocks.findPendingTelegramAuthSession.mockReturnValue(null);
    telegramAuthMocks.hasManagedTelegramCredentials.mockReturnValue(false);
    telegramAuthMocks.inferRetryableTelegramAuthState.mockReturnValue(null);
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(null);
    telegramClientMocks.telegramLocalSessionAvailable.mockReturnValue(false);
  });

  it("reports disconnected when there is no grant, stored token, or session", async () => {
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(null);

    const status = await service.getTelegramConnectorStatus("owner");

    expect(status.connected).toBe(false);
    expect(status.reason).toBe("disconnected");
    expect(status.grantedCapabilities).toEqual([]);
  });

  it("reports connected when grant, stored token, and local session are present", async () => {
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(buildGrant());
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(buildStoredToken());
    telegramClientMocks.telegramLocalSessionAvailable.mockReturnValue(true);

    const status = await service.getTelegramConnectorStatus("owner");

    expect(status.connected).toBe(true);
    expect(status.reason).toBe("connected");
    expect(status.identity).toMatchObject({
      id: "telegram-user-1",
      username: "carol",
    });
    expect(status.grantedCapabilities).toEqual(
      expect.arrayContaining(["telegram.read", "telegram.send"]),
    );
  });

  it("sends through the Telegram local client with the connected token ref", async () => {
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(buildGrant());
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(buildStoredToken());
    telegramClientMocks.telegramLocalSessionAvailable.mockReturnValue(true);
    telegramClientMocks.sendTelegramAccountMessage.mockResolvedValue({
      messageId: "88",
    });

    await expect(
      service.sendTelegramMessage({
        target: "Carol",
        message: "On my way",
      }),
    ).resolves.toEqual({ ok: true, messageId: "88" });
    expect(telegramClientMocks.sendTelegramAccountMessage).toHaveBeenCalledWith({
      tokenRef: TOKEN_REF,
      target: "Carol",
      message: "On my way",
    });
  });

  it("does not report outbound success when the local Telegram send fails", async () => {
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(buildGrant());
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(buildStoredToken());
    telegramClientMocks.telegramLocalSessionAvailable.mockReturnValue(true);
    telegramClientMocks.sendTelegramAccountMessage.mockRejectedValue(
      new Error("Telegram send did not return a message id."),
    );

    await expect(
      service.sendTelegramMessage({
        target: "Carol",
        message: "On my way",
      }),
    ).rejects.toThrow("Telegram send did not return a message id.");
  });

  it("routes search and read-receipt lookups through the same connected token ref", async () => {
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(buildGrant());
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(buildStoredToken());
    telegramClientMocks.telegramLocalSessionAvailable.mockReturnValue(true);
    telegramClientMocks.searchTelegramMessages.mockResolvedValue([
      { id: "101", content: "needle" },
    ]);
    telegramClientMocks.getTelegramReadReceipts.mockResolvedValue([
      { messageId: "101", status: "delivered_read" },
    ]);

    await expect(
      service.searchTelegramMessages({
        query: "needle",
        scope: "Carol",
        limit: 5,
      }),
    ).resolves.toEqual([{ id: "101", content: "needle" }]);
    expect(telegramClientMocks.searchTelegramMessages).toHaveBeenCalledWith({
      tokenRef: TOKEN_REF,
      query: "needle",
      scope: "Carol",
      limit: 5,
    });

    await expect(
      service.getTelegramDeliveryStatus({
        target: "Carol",
        messageIds: ["101"],
      }),
    ).resolves.toEqual([{ messageId: "101", status: "delivered_read" }]);
    expect(telegramClientMocks.getTelegramReadReceipts).toHaveBeenCalledWith({
      tokenRef: TOKEN_REF,
      target: "Carol",
      messageIds: ["101"],
    });
  });

  it("requires read permission before running Telegram connector verification", async () => {
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(
      buildGrant(["telegram.send"]),
    );
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(buildStoredToken());
    telegramClientMocks.telegramLocalSessionAvailable.mockReturnValue(true);

    await expect(
      service.verifyTelegramConnector({
        sendTarget: "me",
        sendMessage: "self-test",
      }),
    ).rejects.toThrow("Telegram connector is missing read permission.");
    expect(telegramClientMocks.verifyTelegramLocalConnector).not.toHaveBeenCalled();
  });
});
