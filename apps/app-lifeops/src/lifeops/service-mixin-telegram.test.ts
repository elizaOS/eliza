import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsConnectorGrant } from "../contracts/index.js";
import { createLifeOpsConnectorGrant } from "./repository.js";
import { withTelegram } from "./service-mixin-telegram.js";
import type { StoredTelegramConnectorToken } from "./telegram-auth.js";

const telegramAuthMocks = vi.hoisted(() => ({
  cancelTelegramAuth: vi.fn(),
  deleteStoredTelegramToken: vi.fn(),
  findPendingTelegramAuthSession: vi.fn(),
  findStoredTelegramTokenForSide: vi.fn(),
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
  findStoredTelegramTokenForSide:
    telegramAuthMocks.findStoredTelegramTokenForSide,
  hasManagedTelegramCredentials:
    telegramAuthMocks.hasManagedTelegramCredentials,
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
  verifyTelegramLocalConnector:
    telegramClientMocks.verifyTelegramLocalConnector,
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
  runtime: {
    agentId: string;
    getService: ReturnType<typeof vi.fn>;
    sendMessageToTarget: ReturnType<typeof vi.fn>;
  };
  ownerEntityId = null;
  repository = {
    deleteConnectorGrant: vi.fn(),
    getConnectorGrant: vi.fn(),
    upsertConnectorGrant: vi.fn(),
  };
  recordConnectorAudit = vi.fn(async () => undefined);

  constructor(telegramService: unknown = null) {
    this.runtime = {
      agentId: "agent-telegram",
      getService: vi.fn((serviceType: string) =>
        serviceType === "telegram" ? telegramService : null,
      ),
      sendMessageToTarget: vi.fn(async () => undefined),
    };
  }

  agentId(): string {
    return this.runtime.agentId;
  }
}

type TelegramConsumer = {
  getTelegramConnectorStatus: (side?: "owner" | "agent") => Promise<{
    connected: boolean;
    reason: string;
    grantedCapabilities: string[];
    identity: { id?: string; username?: string } | null;
    grant: unknown | null;
  }>;
  startTelegramAuth: (request: {
    side?: "owner" | "agent";
    phone: string;
  }) => Promise<unknown>;
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

function createService(
  telegramService: unknown = null,
): StubBase & TelegramConsumer {
  return new (
    Composed as unknown as new (
      telegramService?: unknown,
    ) => StubBase & TelegramConsumer
  )(telegramService);
}

describe("withTelegram consumer surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    telegramAuthMocks.findPendingTelegramAuthSession.mockReturnValue(null);
    telegramAuthMocks.findStoredTelegramTokenForSide.mockReturnValue(null);
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
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(
      buildStoredToken(),
    );
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

  it("reports agent-side Telegram from the elizaOS plugin without creating a LifeOps grant", async () => {
    const pluginService = {
      messageManager: {},
      bot: {
        botInfo: {
          id: 12345,
          username: "milady_bot",
          first_name: "Milady",
        },
      },
    };
    const service = createService(pluginService);
    service.repository.getConnectorGrant.mockRejectedValue(
      new Error("agent plugin status must not read LifeOps grants"),
    );

    const status = await service.getTelegramConnectorStatus("agent");

    expect(status.connected).toBe(true);
    expect(status.reason).toBe("connected");
    expect(status.identity).toMatchObject({
      id: "12345",
      username: "milady_bot",
      firstName: "Milady",
    });
    expect(status.grantedCapabilities).toEqual([
      "telegram.read",
      "telegram.send",
    ]);
    expect(status.grant).toBeNull();
    expect(service.repository.getConnectorGrant).not.toHaveBeenCalled();
    expect(service.repository.upsertConnectorGrant).not.toHaveBeenCalled();
  });

  it("sends agent-side Telegram messages through the elizaOS plugin send handler", async () => {
    const service = createService({ messageManager: {} });
    service.repository.getConnectorGrant.mockRejectedValue(
      new Error("agent plugin send must not read LifeOps grants"),
    );

    await expect(
      service.sendTelegramMessage({
        side: "agent",
        target: "123456",
        message: "Plugin path",
      }),
    ).resolves.toEqual({ ok: true, messageId: null });

    expect(service.runtime.sendMessageToTarget).toHaveBeenCalledWith(
      { source: "telegram", channelId: "123456" },
      { text: "Plugin path", source: "lifeops" },
    );
    expect(
      telegramClientMocks.sendTelegramAccountMessage,
    ).not.toHaveBeenCalled();
    expect(service.repository.getConnectorGrant).not.toHaveBeenCalled();
  });

  it("does not start LifeOps phone auth for agent-side Telegram", async () => {
    const service = createService();

    await expect(
      service.startTelegramAuth({
        side: "agent",
        phone: "+15551234567",
      }),
    ).rejects.toThrow("@elizaos/plugin-telegram");
    expect(telegramAuthMocks.startTelegramAuth).not.toHaveBeenCalled();
  });

  it("adopts the only stored token for the requested side when the grant is missing", async () => {
    const service = createService();
    const storedToken = buildStoredToken();
    service.repository.getConnectorGrant.mockResolvedValue(null);
    telegramAuthMocks.findStoredTelegramTokenForSide.mockReturnValue({
      agentId: "agent-previous",
      side: "owner",
      tokenRef: "agent-previous/owner/local.json",
      token: storedToken,
    });
    telegramClientMocks.telegramLocalSessionAvailable.mockReturnValue(true);

    const status = await service.getTelegramConnectorStatus("owner");

    expect(status.connected).toBe(true);
    expect(status.reason).toBe("connected");
    expect(status.grantedCapabilities).toEqual(
      expect.arrayContaining(["telegram.read", "telegram.send"]),
    );
    expect(service.repository.upsertConnectorGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-telegram",
        provider: "telegram",
        side: "owner",
        tokenRef: "agent-previous/owner/local.json",
        identity: expect.objectContaining({
          id: "telegram-user-1",
          phone: "+15551234567",
        }),
        metadata: expect.objectContaining({
          adoptedFromAgentId: "agent-previous",
          phone: "+15551234567",
        }),
      }),
    );
  });

  it("sends through the Telegram local client with the connected token ref", async () => {
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(buildGrant());
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(
      buildStoredToken(),
    );
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
    expect(telegramClientMocks.sendTelegramAccountMessage).toHaveBeenCalledWith(
      {
        tokenRef: TOKEN_REF,
        target: "Carol",
        message: "On my way",
      },
    );
  });

  it("does not report outbound success when the local Telegram send fails", async () => {
    const service = createService();
    service.repository.getConnectorGrant.mockResolvedValue(buildGrant());
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(
      buildStoredToken(),
    );
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
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(
      buildStoredToken(),
    );
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
    telegramAuthMocks.readStoredTelegramToken.mockReturnValue(
      buildStoredToken(),
    );
    telegramClientMocks.telegramLocalSessionAvailable.mockReturnValue(true);

    await expect(
      service.verifyTelegramConnector({
        sendTarget: "me",
        sendMessage: "self-test",
      }),
    ).rejects.toThrow("Telegram connector is missing read permission.");
    expect(
      telegramClientMocks.verifyTelegramLocalConnector,
    ).not.toHaveBeenCalled();
  });
});
