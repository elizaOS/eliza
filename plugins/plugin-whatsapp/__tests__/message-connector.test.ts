import type {
  IAgentRuntime,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppConnectorService } from "../src/runtime-service";

type RuntimeSendHandler = Parameters<IAgentRuntime["registerSendHandler"]>[1];
type ConnectorTargetInfo = Parameters<RuntimeSendHandler>[1];
type ConnectorContent = Parameters<RuntimeSendHandler>[2];
type MessageConnectorRegistration = Parameters<IAgentRuntime["registerMessageConnector"]>[0];

function makeRuntime(registrations: MessageConnectorRegistration[]): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    registerMessageConnector: vi.fn((registration: MessageConnectorRegistration) => {
      registrations.push(registration);
    }),
    registerSendHandler: vi.fn(),
    getRoom: vi.fn(async () => null),
    getMemoryById: vi.fn(async () => null),
  } as unknown as IAgentRuntime;
}

describe("WhatsApp message connector registration", () => {
  it("registers unified metadata, resolves known targets, and normalizes phone sends", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    const known = {
      chatId: "+14155552671",
      senderId: "+14155552671",
      label: "Alice",
      isGroup: false,
      lastMessageAt: 123,
    };
    const service = {
      connected: true,
      config: { transport: "cloudapi" },
      sendMessage: vi.fn(async () => ({ messages: [{ id: "wamid.1" }] })),
      listKnownTargets: vi.fn(() => [known]),
      getKnownTarget: vi.fn((chatId: string) => (chatId === known.chatId ? known : null)),
      findKnownChatByParticipant: vi.fn((participant: string) =>
        participant === known.senderId ? known : null
      ),
    } as unknown as WhatsAppConnectorService;

    WhatsAppConnectorService.registerSendHandlers(runtime, service);

    expect(registrations).toHaveLength(1);
    const connector = registrations[0];
    expect(connector.source).toBe("whatsapp");
    expect(connector.capabilities).toContain("send_message");
    expect(connector.supportedTargetKinds).toEqual(
      expect.arrayContaining(["phone", "contact", "group"])
    );

    const targets = await connector.resolveTargets?.("Alice", { runtime });
    expect(targets?.[0]).toEqual(
      expect.objectContaining({
        label: "Alice",
        kind: "phone",
        target: expect.objectContaining({
          channelId: "+14155552671",
        }),
      })
    );

    await connector.sendHandler(
      runtime,
      { source: "whatsapp", entityId: "+1 (415) 555-2671" as UUID } as ConnectorTargetInfo,
      { text: "hello" } as ConnectorContent
    );

    expect(service.sendMessage).toHaveBeenCalledWith({
      type: "text",
      to: "+14155552671",
      content: "hello",
      replyToMessageId: undefined,
    });
  });
});
