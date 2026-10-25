/** Google Chat account switches saved in Settings or the character file take effect. */
import { AgentRuntime, type IAgentRuntime, type MessageConnectorRegistration } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { resolveGoogleChatAccountSettings } from "./accounts.ts";
import { GoogleChatService } from "./service.ts";

function runtime(settings: Record<string, string> = {}) {
  return new AgentRuntime({ character: { name: "ChatSettings", settings } });
}

describe("resolveGoogleChatAccountSettings", () => {
  it("honors switches turned off in Settings", () => {
    const rt = runtime();
    // The Settings UI saves strings; the runtime reads them back as booleans.
    rt.setSetting("GOOGLE_CHAT_ENABLED", "false");
    rt.setSetting("GOOGLE_CHAT_REQUIRE_MENTION", "false");
    expect(rt.getSetting("GOOGLE_CHAT_ENABLED")).toBe(false);

    expect(resolveGoogleChatAccountSettings(rt)).toMatchObject({
      enabled: false,
      requireMention: false,
    });
  });

  it("honors switches turned off in the character file", () => {
    const rt = runtime({
      GOOGLE_CHAT_ENABLED: "false",
      GOOGLE_CHAT_REQUIRE_MENTION: "false",
    });
    expect(resolveGoogleChatAccountSettings(rt)).toMatchObject({
      enabled: false,
      requireMention: false,
    });
  });

  it("keeps the defaults when nothing is set", () => {
    expect(resolveGoogleChatAccountSettings(runtime())).toMatchObject({
      enabled: true,
      requireMention: true,
    });
  });
});

describe("Google Chat connector availability", () => {
  it("reports a space-list failure instead of an empty workspace", async () => {
    let connector: MessageConnectorRegistration | undefined;
    const connectorRuntime = {
      emitEvent: vi.fn(),
      registerMessageConnector: vi.fn((registration: MessageConnectorRegistration) => {
        connector = registration;
      }),
    } as unknown as IAgentRuntime;
    const service = new GoogleChatService(connectorRuntime);
    vi.spyOn(service, "getAccessToken").mockResolvedValue("token");
    service.fetchImpl = vi.fn(
      async () =>
        new Response("temporarily unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        })
    ) as typeof fetch;
    (
      service as unknown as {
        getState: () => { accountId: string; cachedSpaces: [] };
      }
    ).getState = () => ({ accountId: "default", cachedSpaces: [] });
    GoogleChatService.registerSendHandlers(connectorRuntime, service, "default");

    await expect(connector?.listRooms?.({ runtime: connectorRuntime })).rejects.toMatchObject({
      name: "GoogleChatApiError",
      statusCode: 503,
    });
  });
});
