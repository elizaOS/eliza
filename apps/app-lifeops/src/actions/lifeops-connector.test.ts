import type { Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lifeops-google-helpers.js", () => ({
  INTERNAL_URL: new URL("http://127.0.0.1/"),
  hasLifeOpsAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent/actions/extract-params", () => ({
  extractActionParamsViaLlm: vi.fn(
    async (args: { existingParams: unknown }) => args.existingParams,
  ),
}));

vi.mock("../lifeops/service.js", () => {
  class FakeError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  class FakeLifeOpsService {
    getGoogleConnectorStatus = vi.fn(async () => ({
      provider: "google",
      connected: false,
    }));
    getXConnectorStatus = vi.fn(async () => ({
      provider: "x",
      connected: false,
    }));
    getTelegramConnectorStatus = vi.fn(async () => ({
      provider: "telegram",
      connected: false,
    }));
    getSignalConnectorStatus = vi.fn(async () => ({
      provider: "signal",
      connected: true,
    }));
    getDiscordConnectorStatus = vi.fn(async () => ({
      provider: "discord",
      connected: true,
    }));
    getIMessageConnectorStatus = vi.fn(async () => ({
      provider: "imessage",
      connected: true,
    }));
    getWhatsAppConnectorStatus = vi.fn(async () => ({
      provider: "whatsapp",
      connected: true,
    }));
    readSignalInbound = vi.fn(async () => [{ text: "Signal check" }]);
    sendSignalMessage = vi.fn(async () => ({
      ok: true,
      messageId: "signal-1",
    }));
    searchDiscordMessages = vi.fn(async () => [{ content: "ProjectAtlas" }]);
    sendDiscordMessage = vi.fn(async () => ({
      ok: true,
      messageId: "discord-1",
    }));
    readIMessages = vi.fn(async () => [{ text: "Project Atlas" }]);
    sendIMessage = vi.fn(async () => ({ ok: true, guid: "imessage-1" }));
    pullWhatsAppRecent = vi.fn(() => ({
      count: 1,
      messages: [{ text: "WhatsApp ping" }],
    }));
    sendWhatsAppMessage = vi.fn(async () => ({
      ok: true,
      messageId: "whatsapp-1",
    }));
    getHealthDataConnectorStatuses = vi.fn(async () => [
      { provider: "strava", connected: false },
      { provider: "fitbit", connected: false },
      { provider: "withings", connected: false },
      { provider: "oura", connected: false },
    ]);
    getBrowserSettings = vi.fn(async () => ({}));
    listBrowserCompanions = vi.fn(async () => []);
  }
  return {
    LifeOpsServiceError: FakeError,
    LifeOpsService: FakeLifeOpsService,
  };
});

describe("lifeOpsConnectorAction", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadHandler() {
    const { lifeOpsConnectorAction } = await import("./lifeops-connector.js");
    const { handler } = lifeOpsConnectorAction;
    if (!handler) {
      throw new Error("lifeOpsConnectorAction.handler is required");
    }
    return handler;
  }

  it("returns connector status without error for status subaction", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      {
        content: {
          text: "check telegram status",
        },
      } as Memory,
      undefined,
      {
        parameters: {
          connector: "telegram",
          subaction: "status",
        },
      },
      undefined,
    );
    expect(result).toBeDefined();
    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "telegram",
        subaction: "status",
      },
    });
  });

  it("returns aggregated status for list subaction with no connector", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "list connectors" } } as Memory,
      undefined,
      { parameters: { subaction: "list" } },
      undefined,
    );
    expect(result).toMatchObject({
      success: true,
      data: { actionName: "LIFEOPS_CONNECTOR" },
    });
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.connectors).toBeDefined();
  });

  it("verifies Signal with passive read and optional self-test send", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "verify signal" } } as Memory,
      undefined,
      {
        parameters: {
          connector: "signal",
          subaction: "verify",
          sendTarget: "+15551110001",
          sendMessage: "Signal self-test",
        },
      },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "signal",
        subaction: "verify",
        read: { ok: true, count: 1 },
        send: { ok: true },
      },
    });
  });

  it("verifies Discord with browser search and optional send", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "verify discord" } } as Memory,
      undefined,
      {
        parameters: {
          connector: "discord",
          subaction: "verify",
          query: "ProjectAtlas",
          sendTarget: "channel-1",
          sendMessage: "Discord self-test",
        },
      },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "discord",
        subaction: "verify",
        search: { ok: true, count: 1 },
        send: { ok: true },
      },
    });
  });

  it("verifies iMessage with passive read and optional self-test send", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "verify imessage" } } as Memory,
      undefined,
      {
        parameters: {
          connector: "imessage",
          subaction: "verify",
          sendTarget: "+15551112222",
          sendMessage: "iMessage self-test",
        },
      },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "imessage",
        subaction: "verify",
        read: { ok: true, count: 1 },
        send: { ok: true },
      },
    });
  });

  it("verifies WhatsApp with buffered passive read and optional self-test send", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "verify whatsapp" } } as Memory,
      undefined,
      {
        parameters: {
          connector: "whatsapp",
          subaction: "verify",
          sendTarget: "+15553338888",
          sendMessage: "WhatsApp self-test",
        },
      },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "whatsapp",
        subaction: "verify",
        read: { ok: true, count: 1 },
        send: { ok: true },
      },
    });
  });

  it("rejects when subaction is missing", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "" } } as Memory,
      undefined,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({
      success: false,
      data: { error: "MISSING_SUBACTION" },
    });
  });
});
