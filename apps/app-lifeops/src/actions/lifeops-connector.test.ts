import type { Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./lifeops-google-helpers.js", () => ({
  INTERNAL_URL: new URL("http://127.0.0.1/"),
  hasLifeOpsAccess: vi.fn(async () => true),
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
  return {
    LifeOpsServiceError: FakeError,
    LifeOpsService: vi.fn().mockImplementation(() => ({
      getGoogleConnectorStatus: vi.fn(async () => ({
        provider: "google",
        connected: false,
      })),
      getXConnectorStatus: vi.fn(async () => ({ provider: "x", connected: false })),
      getTelegramConnectorStatus: vi.fn(async () => ({
        provider: "telegram",
        connected: false,
      })),
      getSignalConnectorStatus: vi.fn(async () => ({
        provider: "signal",
        connected: false,
      })),
      getDiscordConnectorStatus: vi.fn(async () => ({
        provider: "discord",
        connected: false,
      })),
      getIMessageConnectorStatus: vi.fn(async () => ({
        provider: "imessage",
        connected: false,
      })),
      getWhatsAppConnectorStatus: vi.fn(async () => ({
        provider: "whatsapp",
        connected: false,
      })),
      getBrowserSettings: vi.fn(async () => ({})),
      listBrowserCompanions: vi.fn(async () => []),
    })),
  };
});

describe("lifeOpsConnectorAction", () => {
  it("returns connector status without error for status subaction", async () => {
    const { lifeOpsConnectorAction } = await import("./lifeops-connector.js");
    const result = await lifeOpsConnectorAction.handler!(
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
      data: { actionName: "LIFEOPS_CONNECTOR", connector: "telegram", subaction: "status" },
    });
  });

  it("returns aggregated status for list subaction with no connector", async () => {
    const { lifeOpsConnectorAction } = await import("./lifeops-connector.js");
    const result = await lifeOpsConnectorAction.handler!(
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

  it("rejects when subaction is missing", async () => {
    const { lifeOpsConnectorAction } = await import("./lifeops-connector.js");
    const result = await lifeOpsConnectorAction.handler!(
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
