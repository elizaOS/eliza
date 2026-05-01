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
      connected: true,
      reason: "connected",
      grantedCapabilities: ["google.gmail.triage", "google.calendar.read"],
    }));
    getXConnectorStatus = vi.fn(async () => ({
      provider: "x",
      connected: true,
      grantedCapabilities: ["x.read", "x.dm.read"],
      feedRead: true,
      dmInbound: true,
    }));
    getTelegramConnectorStatus = vi.fn(async () => ({
      provider: "telegram",
      connected: false,
    }));
    verifyTelegramConnector = vi.fn(async () => ({
      provider: "telegram",
      side: "owner",
      verifiedAt: "2026-04-29T00:00:00.000Z",
      read: {
        ok: true,
        error: null,
        dialogCount: 1,
        dialogs: [],
      },
      send: {
        ok: false,
        error: "Telegram send did not return a message id.",
        target: "me",
        message: "self-test",
        messageId: null,
      },
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
    getGmailTriage = vi.fn(async () => ({
      summary: { unreadCount: 1 },
      messages: [{ subject: "Google check" }],
    }));
    getCalendarFeed = vi.fn(async () => ({
      events: [{ title: "Calendar check" }],
    }));
    sendGmailMessage = vi.fn(async () => ({ ok: true }));
    searchXPosts = vi.fn(async () => [{ text: "X check" }]);
    readXInboundDms = vi.fn(async () => [{ text: "X DM check" }]);
    sendXDirectMessage = vi.fn(async () => ({
      ok: true,
      status: 201,
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
    getHealthConnectorStatus = vi.fn(async () => ({
      available: true,
      backend: "healthkit",
      lastCheckedAt: "2026-04-21T12:00:00.000Z",
    }));
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

  it("keeps per-connector list as a list result instead of rewriting it to status", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "list telegram connector" } } as Memory,
      undefined,
      {
        parameters: {
          connector: "telegram",
          subaction: "list",
        },
      },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "telegram",
        subaction: "list",
      },
    });
  });

  it("does not hide a failed Telegram verification send leg", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "verify telegram" } } as Memory,
      undefined,
      {
        parameters: {
          connector: "telegram",
          subaction: "verify",
        },
      },
      undefined,
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "telegram",
        subaction: "verify",
        response: {
          read: { ok: true },
          send: { ok: false },
        },
      },
    });
  });

  it("treats per-connector list as a status-producing list branch", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "list signal connector" } } as Memory,
      undefined,
      { parameters: { connector: "signal", subaction: "list" } },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "signal",
        subaction: "list",
      },
    });
    expect(JSON.stringify(result)).not.toContain("NOT_IMPLEMENTED");
    expect(JSON.stringify(result)).not.toContain("UNSUPPORTED_OPERATION");
  });

  it("verifies Google with real status plus Gmail and Calendar reads", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "verify google" } } as Memory,
      undefined,
      {
        parameters: {
          connector: "google",
          subaction: "verify",
        },
      },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "google",
        subaction: "verify",
        read: {
          gmail: { ok: true, count: 1 },
          calendar: { ok: true, count: 1 },
        },
      },
    });
  });

  it("verifies X with passive DM read and optional search/send probes", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "verify x" } } as Memory,
      undefined,
      {
        parameters: {
          connector: "x",
          subaction: "verify",
          query: "LifeOps",
          sendTarget: "x-user-1",
          sendMessage: "X self-test",
        },
      },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "x",
        subaction: "verify",
        read: { ok: true, count: 1 },
        search: { ok: true, query: "LifeOps" },
        send: { ok: true },
      },
    });
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

  it("verifies Browser Bridge readiness from connected companions", async () => {
    const handler = await loadHandler();
    const result = await handler(
      {} as never,
      { content: { text: "verify browser bridge" } } as Memory,
      undefined,
      {
        parameters: {
          connector: "browser_bridge",
          subaction: "verify",
        },
      },
      undefined,
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        actionName: "LIFEOPS_CONNECTOR",
        connector: "browser_bridge",
        subaction: "verify",
        verification: {
          connected: false,
        },
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
