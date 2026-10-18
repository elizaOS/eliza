/**
 * A Google Chat message over the provider byte limit is sent in chunks. If a
 * later request fails, the connector must keep the provider ids for the chunks
 * already accepted so its caller does not retry the complete message.
 */
import type { IAgentRuntime, MessageConnector, SendHandlerOutcome } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { GoogleChatService } from "./service.ts";

function connectorHarness(failOnCall: number) {
  let connector: MessageConnector | undefined;
  let calls = 0;
  const sent: string[] = [];
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    emitEvent: vi.fn(),
    getRoom: vi.fn(async () => null),
    registerMessageConnector: vi.fn((value: MessageConnector) => {
      connector = value;
    }),
  } as unknown as IAgentRuntime;
  const service = new GoogleChatService(runtime);
  vi.spyOn(service, "getAccessToken").mockResolvedValue("token");
  (service as unknown as { getState: () => { accountId: string } }).getState = () => ({
    accountId: "default",
  });
  service.fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    if (calls === failOnCall) {
      return Response.json(
        { error: { message: "Google Chat refused the next chunk" } },
        { status: 503 }
      );
    }
    const body = JSON.parse(String(init?.body)) as { text?: string };
    sent.push(body.text ?? "");
    return Response.json({ name: `spaces/AAA/messages/M${calls}` });
  }) as typeof fetch;
  GoogleChatService.registerSendHandlers(runtime, service, "default");
  if (!connector) throw new Error("Google Chat connector was not registered");
  return { connector, runtime, sent };
}

describe("Google Chat long message partial delivery", () => {
  it("returns the ids accepted before a later chunk fails", async () => {
    const { connector, runtime, sent } = connectorHarness(2);
    const outcome = (await connector.sendHandler(
      runtime,
      { source: "google-chat", channelId: "spaces/AAA" },
      { text: "a".repeat(65_000) }
    )) as SendHandlerOutcome;

    expect(sent).toHaveLength(1);
    expect(outcome).toMatchObject({
      kind: "partially_delivered",
      code: "GOOGLE_CHAT_PARTIALLY_SENT",
      receipt: { providerMessageIds: ["spaces/AAA/messages/M1"] },
    });
  });

  it("returns every provider id after complete chunk delivery", async () => {
    const { connector, runtime, sent } = connectorHarness(0);
    const outcome = (await connector.sendHandler(
      runtime,
      { source: "google-chat", channelId: "spaces/AAA" },
      { text: "a".repeat(65_000) }
    )) as SendHandlerOutcome;

    expect(sent).toHaveLength(3);
    expect(outcome).toMatchObject({
      kind: "delivered",
      receipt: {
        providerMessageIds: [
          "spaces/AAA/messages/M1",
          "spaces/AAA/messages/M2",
          "spaces/AAA/messages/M3",
        ],
      },
    });
  });
});
