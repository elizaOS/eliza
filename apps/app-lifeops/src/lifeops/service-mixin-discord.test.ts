import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./discord-browser-scraper.js", () => ({
  DISCORD_APP_URL: "https://discord.com/app",
  captureDiscordDeliveryStatus: vi.fn(async () => []),
  closeDiscordTab: vi.fn(async () => undefined),
  discordBrowserWorkspaceAvailable: vi.fn(() => false),
  emptyDiscordDmInboxProbe: vi.fn(() => ({
    visible: false,
    selectedChannelId: null,
    conversations: [],
    unreadCount: 0,
    lastError: null,
  })),
  ensureDiscordTab: vi.fn(async () => ({ tabId: "tab-1" })),
  probeDiscordCapturedPage: vi.fn(async () => null),
  probeDiscordTab: vi.fn(async () => null),
  searchDiscordMessages: vi.fn(async () => []),
}));

vi.mock("./discord-desktop-cdp.js", () => ({
  getDiscordDesktopCdpStatus: vi.fn(async () => ({
    cdpAvailable: false,
    port: null,
    probe: null,
    targetUrl: null,
    lastError: null,
  })),
  relaunchDiscordDesktopForCdp: vi.fn(async () => ({
    cdpAvailable: false,
    port: null,
    probe: null,
    targetUrl: null,
    lastError: null,
  })),
  sendDiscordViaDesktopCdp: vi.fn(async () => ({ ok: true })),
}));

import { withDiscord } from "./service-mixin-discord.js";

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

  constructor(discordService: unknown = null) {
    this.runtime = {
      agentId: "agent-discord",
      getService: vi.fn((serviceType: string) =>
        serviceType === "discord" ? discordService : null,
      ),
      sendMessageToTarget: vi.fn(async () => undefined),
    };
  }

  agentId(): string {
    return this.runtime.agentId;
  }
}

type DiscordConsumer = {
  getDiscordConnectorStatus: (side?: "owner" | "agent") => Promise<{
    available: boolean;
    connected: boolean;
    reason: string;
    grantedCapabilities: string[];
    identity: { id?: string; username?: string } | null;
    grant: unknown | null;
    browserAccess?: unknown[];
  }>;
  authorizeDiscordConnector: (side?: "owner" | "agent") => Promise<{
    connected: boolean;
    grant: unknown | null;
  }>;
  sendDiscordMessage: (request: {
    side?: "owner" | "agent";
    channelId?: string;
    text: string;
  }) => Promise<{
    provider: "discord";
    side: "owner" | "agent";
    channelId: string;
    ok: true;
    deliveryStatus: string;
  }>;
  disconnectDiscord: (side?: "owner" | "agent") => Promise<unknown>;
};

const Composed = withDiscord(StubBase as never);

function createService(
  discordService: unknown = null,
): StubBase & DiscordConsumer {
  return new (
    Composed as unknown as new (
      discordService?: unknown,
    ) => StubBase & DiscordConsumer
  )(discordService);
}

describe("withDiscord agent plugin surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports agent-side Discord from the elizaOS plugin without creating a LifeOps grant", async () => {
    const pluginService = {
      isReady: vi.fn(() => true),
      client: {
        user: {
          id: "discord-bot-1",
          username: "milady",
          discriminator: "0001",
        },
      },
    };
    const service = createService(pluginService);
    service.repository.getConnectorGrant.mockRejectedValue(
      new Error("agent plugin status must not read LifeOps grants"),
    );

    const status = await service.getDiscordConnectorStatus("agent");

    expect(status.available).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.reason).toBe("connected");
    expect(status.identity).toMatchObject({
      id: "discord-bot-1",
      username: "milady",
      discriminator: "0001",
    });
    expect(status.grantedCapabilities).toEqual([
      "discord.read",
      "discord.send",
    ]);
    expect(status.browserAccess).toEqual([]);
    expect(status.grant).toBeNull();
    expect(service.repository.getConnectorGrant).not.toHaveBeenCalled();
    expect(service.repository.upsertConnectorGrant).not.toHaveBeenCalled();
  });

  it("treats agent-side connect as plugin status instead of opening a LifeOps browser session", async () => {
    const service = createService({
      isReady: vi.fn(() => true),
      client: { user: { id: "discord-bot-1", username: "milady" } },
    });

    const status = await service.authorizeDiscordConnector("agent");

    expect(status.connected).toBe(true);
    expect(status.grant).toBeNull();
    expect(service.repository.getConnectorGrant).not.toHaveBeenCalled();
    expect(service.repository.upsertConnectorGrant).not.toHaveBeenCalled();
  });

  it("sends agent-side Discord messages through the elizaOS plugin send handler", async () => {
    const service = createService({
      isReady: vi.fn(() => true),
      client: { user: { id: "discord-bot-1", username: "milady" } },
    });

    await expect(
      service.sendDiscordMessage({
        side: "agent",
        channelId: "channel-1",
        text: "Plugin path",
      }),
    ).resolves.toEqual({
      provider: "discord",
      side: "agent",
      channelId: "channel-1",
      ok: true,
      deliveryStatus: "unknown",
    });

    expect(service.runtime.sendMessageToTarget).toHaveBeenCalledWith(
      { source: "discord", channelId: "channel-1" },
      { text: "Plugin path", source: "lifeops" },
    );
    expect(service.repository.getConnectorGrant).not.toHaveBeenCalled();
  });

  it("does not delete LifeOps grants for agent-side Discord", async () => {
    const service = createService();

    await expect(service.disconnectDiscord("agent")).rejects.toThrow(
      "@elizaos/plugin-discord",
    );
    expect(service.repository.deleteConnectorGrant).not.toHaveBeenCalled();
  });
});
