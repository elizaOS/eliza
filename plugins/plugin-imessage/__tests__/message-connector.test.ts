import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { IMessageService } from "../src/service.js";
import type { IMessageServiceStatus } from "../src/types.js";

type RuntimeSendHandler = Parameters<IAgentRuntime["registerSendHandler"]>[1];
type ConnectorTargetInfo = Parameters<RuntimeSendHandler>[1];
type ConnectorContent = Parameters<RuntimeSendHandler>[2];
type MessageConnectorRegistration = Parameters<IAgentRuntime["registerMessageConnector"]>[0];

function makeStatus(): IMessageServiceStatus {
  return {
    available: true,
    connected: true,
    chatDbAvailable: true,
    sendOnly: false,
    chatDbPath: "/tmp/chat.db",
    reason: null,
    permissionAction: null,
  };
}

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

describe("iMessage message connector registration", () => {
  it("registers unified connector metadata, contact resolution, and normalized sends", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    const service = {
      getStatus: vi.fn(makeStatus),
      getContacts: vi.fn(() => new Map([["+14155552671", { name: "Alice" }]])),
      getChats: vi.fn(async () => []),
      getRecentMessages: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({ success: true, messageId: "msg-1" })),
    } as unknown as IMessageService;

    IMessageService.registerSendHandlers(runtime, service);

    expect(registrations).toHaveLength(1);
    const connector = registrations[0];
    expect(connector.source).toBe("imessage");
    expect(connector.capabilities).toContain("send_message");
    expect(connector.supportedTargetKinds).toEqual(
      expect.arrayContaining(["phone", "email", "contact", "group"])
    );

    const targets = await connector.resolveTargets?.("Alice", { runtime });
    expect(targets?.[0]).toEqual(
      expect.objectContaining({
        label: "Alice (+14155552671)",
        kind: "phone",
        target: expect.objectContaining({
          source: "imessage",
          accountId: "default",
          channelId: "+14155552671",
        }),
        metadata: expect.objectContaining({
          accountId: "default",
        }),
      })
    );

    await connector.sendHandler(
      runtime,
      { source: "imessage", entityId: "+1 (415) 555-2671" as UUID } as ConnectorTargetInfo,
      { text: "hello" } as ConnectorContent
    );

    expect(service.sendMessage).toHaveBeenCalledWith("+14155552671", "hello", {
      accountId: "default",
    });
  });

  it("stamps fetched platform memories with the local accountId", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    const service = {
      getStatus: vi.fn(makeStatus),
      getContacts: vi.fn(() => new Map()),
      getChats: vi.fn(async () => []),
      getRecentMessages: vi.fn(async () => []),
      getMessages: vi.fn(async () => [
        {
          id: "1",
          text: "hello",
          handle: "+14155552671",
          chatId: "iMessage;-;+14155552671",
          timestamp: 123,
          isFromMe: false,
          hasAttachments: false,
        },
      ]),
      sendMessage: vi.fn(async () => ({ success: true, messageId: "msg-1" })),
    } as unknown as IMessageService;

    IMessageService.registerSendHandlers(runtime, service);
    const memories = await registrations[0].fetchMessages?.({ runtime }, { limit: 1 });

    expect(memories?.[0]?.metadata).toEqual(
      expect.objectContaining({
        accountId: "default",
      })
    );
  });
});
