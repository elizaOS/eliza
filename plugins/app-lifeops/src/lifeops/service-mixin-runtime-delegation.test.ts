// @ts-nocheck
import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsConnectorGrant } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsServiceBase } from "./service-mixin-core.js";
import { withSignal } from "./service-mixin-signal.js";
import { withTelegram } from "./service-mixin-telegram.js";
import { withWhatsApp } from "./service-mixin-whatsapp.js";

const TestMessagingService = withWhatsApp(
  withSignal(withTelegram(LifeOpsServiceBase)),
);

function runtimeWithServices(services: Record<string, unknown>): IAgentRuntime {
  const settings = new Map<string, unknown>();
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    character: { name: "Test Agent" },
    getService: vi.fn((serviceType: string) => services[serviceType] ?? null),
    getSetting: vi.fn((key: string) => settings.get(key)),
    setSetting: vi.fn((key: string, value: unknown) => {
      if (value === null || value === undefined) {
        settings.delete(key);
      } else {
        settings.set(key, value);
      }
    }),
  } as unknown as IAgentRuntime;
}

function legacyGrant(
  provider: "telegram" | "signal",
  overrides: Partial<LifeOpsConnectorGrant> = {},
): LifeOpsConnectorGrant {
  return {
    id: `${provider}-legacy-grant`,
    agentId: "11111111-1111-4111-8111-111111111111",
    provider,
    connectorAccountId: `acct-${provider}-owner`,
    side: "owner",
    identity:
      provider === "signal"
        ? { phoneNumber: "+15551234567" }
        : { id: "12345", username: "legacy_user", phone: "+15551234567" },
    identityEmail: null,
    grantedScopes: [],
    capabilities:
      provider === "signal"
        ? ["signal.read", "signal.send"]
        : ["telegram.read", "telegram.send"],
    tokenRef: `${provider}-legacy-token`,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadata: { phone: "+15551234567" },
    lastRefreshAt: null,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  } as LifeOpsConnectorGrant;
}

function serviceWithLegacyGrants(args: {
  services?: Record<string, unknown>;
  grants?: Record<string, LifeOpsConnectorGrant | null>;
}) {
  const service = new TestMessagingService(
    runtimeWithServices(args.services ?? {}),
  );
  service.repository.getConnectorGrant = vi.fn(
    async (_agentId: string, provider: string) =>
      args.grants?.[provider] ?? null,
  );
  service.repository.deleteConnectorGrant = vi.fn(async () => undefined);
  service.repository.upsertConnectorGrant = vi.fn(async () => undefined);
  service.recordConnectorAudit = vi.fn(async () => undefined);
  service.logLifeOpsWarn = vi.fn();
  return service;
}

describe("LifeOps messaging mixin runtime delegation", () => {
  it("does not connect Telegram from legacy LifeOps token refs", async () => {
    const service = serviceWithLegacyGrants({
      grants: { telegram: legacyGrant("telegram") },
    });

    const status = await service.getTelegramConnectorStatus("owner");

    expect(status.connected).toBe(false);
    expect(status.grantedCapabilities).toEqual([]);
    expect(status.storedCredentialsAvailable).toBe(true);
    expect(status.grant?.tokenRef).toBeNull();
    expect(status.degradations?.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "telegram_plugin_unavailable",
        "legacy_lifeops_credentials_ignored",
      ]),
    );
    await expect(
      service.sendTelegramMessage({
        target: "12345",
        message: "hello",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("@elizaos/plugin-telegram"),
    });
  });

  it("delegates Telegram sends through the runtime service account id", async () => {
    const handleSendMessage = vi.fn(async () => undefined);
    const service = serviceWithLegacyGrants({
      services: {
        telegram: {
          messageManager: {},
          handleSendMessage,
          bot: { botInfo: { id: 100, username: "agent_bot" } },
        },
      },
      grants: { telegram: legacyGrant("telegram") },
    });

    await expect(
      service.sendTelegramMessage({
        target: "12345",
        message: "hello",
      }),
    ).resolves.toEqual({ ok: true, messageId: null });

    expect(handleSendMessage).toHaveBeenCalledWith(
      service.runtime,
      expect.objectContaining({
        source: "telegram",
        accountId: "acct-telegram-owner",
        channelId: "12345",
      }),
      expect.objectContaining({
        text: "hello",
        metadata: { accountId: "acct-telegram-owner" },
      }),
    );
  });

  it("reports Telegram read capability only when the runtime service exposes search", async () => {
    const service = serviceWithLegacyGrants({
      services: {
        telegram: {
          connected: true,
          handleSendMessage: vi.fn(async () => undefined),
        },
      },
      grants: { telegram: legacyGrant("telegram") },
    });

    await expect(service.getTelegramConnectorStatus("owner")).resolves.toMatchObject({
      connected: true,
      grantedCapabilities: ["telegram.send"],
      degradations: expect.arrayContaining([
        expect.objectContaining({ code: "telegram_plugin_read_unavailable" }),
      ]),
    });
  });

  it("does not read or send Signal from legacy LifeOps token refs", async () => {
    const service = serviceWithLegacyGrants({
      grants: { signal: legacyGrant("signal") },
    });

    const status = await service.getSignalConnectorStatus("owner");

    expect(status.connected).toBe(false);
    expect(status.inbound).toBe(false);
    expect(status.grant?.tokenRef).toBeNull();
    expect(status.degradations?.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "signal_plugin_unavailable",
        "legacy_lifeops_credentials_ignored",
      ]),
    );
    await expect(service.readSignalInbound()).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("@elizaos/plugin-signal"),
    });
    await expect(
      service.sendSignalMessage({
        recipient: "+15550000001",
        text: "hello",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("@elizaos/plugin-signal"),
    });
  });

  it("delegates Signal reads and sends through runtime service account ids", async () => {
    const getRecentMessages = vi.fn(async () => [
      {
        id: "signal-1",
        roomId: "room-1",
        channelId: "+15550000001",
        roomName: "Signal DM",
        speakerName: "Ava",
        text: "recent",
        createdAt: 1234,
        isFromAgent: false,
        isGroup: false,
      },
    ]);
    const sendMessage = vi.fn(async () => ({ timestamp: 5678 }));
    const service = serviceWithLegacyGrants({
      services: {
        signal: {
          isServiceConnected: () => true,
          getAccountNumber: () => "+15551234567",
          getRecentMessages,
          sendMessage,
        },
      },
      grants: { signal: legacyGrant("signal") },
    });

    await expect(service.readSignalInbound(10)).resolves.toMatchObject([
      { id: "signal-1", text: "recent", isInbound: true },
    ]);
    expect(getRecentMessages).toHaveBeenCalledWith(10, "acct-signal-owner");

    await expect(
      service.sendSignalMessage({
        recipient: "+15550000001",
        text: "hello",
      }),
    ).resolves.toMatchObject({
      provider: "signal",
      recipient: "+15550000001",
      timestamp: 5678,
    });
    expect(sendMessage).toHaveBeenCalledWith("+15550000001", "hello", {
      accountId: "acct-signal-owner",
    });
  });

  it("does not send WhatsApp through env credential fallbacks", async () => {
    const previousAccessToken = process.env.ELIZA_WHATSAPP_ACCESS_TOKEN;
    const previousPhoneNumberId = process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID;
    process.env.ELIZA_WHATSAPP_ACCESS_TOKEN = "legacy-token";
    process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID = "legacy-phone-number-id";
    const service = serviceWithLegacyGrants({});

    try {
      await expect(
        service.sendWhatsAppMessage({
          to: "+15550000001",
          text: "hello",
        }),
      ).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining("@elizaos/plugin-whatsapp"),
      });
    } finally {
      if (previousAccessToken === undefined) {
        delete process.env.ELIZA_WHATSAPP_ACCESS_TOKEN;
      } else {
        process.env.ELIZA_WHATSAPP_ACCESS_TOKEN = previousAccessToken;
      }
      if (previousPhoneNumberId === undefined) {
        delete process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID;
      } else {
        process.env.ELIZA_WHATSAPP_PHONE_NUMBER_ID = previousPhoneNumberId;
      }
    }
  });

  it("delegates WhatsApp sends to the runtime service", async () => {
    const sendMessage = vi.fn(async () => ({ messages: [{ id: "wamid.1" }] }));
    const service = serviceWithLegacyGrants({
      services: {
        whatsapp: {
          connected: true,
          phoneNumber: "+15551234567",
          sendMessage,
          fetchConnectorMessages: vi.fn(async () => []),
        },
      },
    });

    await expect(service.getWhatsAppConnectorStatus()).resolves.toMatchObject({
      provider: "whatsapp",
      connected: true,
      outboundReady: true,
      inboundReady: true,
    });
    await expect(
      service.sendWhatsAppMessage({
        to: "+15550000001",
        text: "hello",
      }),
    ).resolves.toEqual({ ok: true, messageId: "wamid.1" });
    expect(sendMessage).toHaveBeenCalledWith({
      accountId: "default",
      type: "text",
      to: "+15550000001",
      content: "hello",
      replyToMessageId: undefined,
    });
  });

  it("reports WhatsApp missing hooks when the runtime service is connected but incomplete", async () => {
    const service = serviceWithLegacyGrants({
      services: {
        whatsapp: {
          connected: true,
        },
      },
    });

    await expect(service.getWhatsAppConnectorStatus()).resolves.toMatchObject({
      connected: false,
      outboundReady: false,
      inboundReady: false,
      degradations: expect.arrayContaining([
        expect.objectContaining({ code: "whatsapp_plugin_send_unavailable" }),
        expect.objectContaining({ code: "whatsapp_plugin_inbound_unavailable" }),
      ]),
    });
  });
});
