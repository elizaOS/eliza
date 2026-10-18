/**
 * Apple Contacts often store a phone without its country code ("(555)
 * 987-6543", or "07700 900123" with a trunk 0). chat.db handles are E.164
 * ("+15559876543"). The connector must still find that contact by the chat.db
 * handle. Real contact parsing and the real connector registration; the
 * service is a stand-in that holds the address book and recent messages.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { parseContactsOutput } from "../src/contacts-reader.js";
import { IMessageService } from "../src/service.js";
import type { IMessageMessage, IMessageServiceStatus } from "../src/types.js";

type MessageConnectorRegistration = Parameters<IAgentRuntime["registerMessageConnector"]>[0];

function status(): IMessageServiceStatus {
  return {
    transport: "native",
    available: true,
    connected: true,
    chatDbAvailable: true,
    sendOnly: false,
    chatDbPath: "/tmp/chat.db",
    reason: null,
    permissionAction: null,
    webhookPath: null,
    channelId: null,
  };
}

function register(addressBook: string, handles: string[]): MessageConnectorRegistration {
  const registrations: MessageConnectorRegistration[] = [];
  const runtime = {
    agentId: "agent-1" as UUID,
    registerMessageConnector: vi.fn((registration: MessageConnectorRegistration) => {
      registrations.push(registration);
    }),
    registerSendHandler: vi.fn(),
  } as unknown as IAgentRuntime;
  const recent: IMessageMessage[] = handles.map((handle, index) => ({
    id: String(index),
    text: "hi",
    handle,
    chatId: "",
    timestamp: Date.UTC(2026, 9, 1) + index,
    isFromMe: false,
    hasAttachments: false,
  }));
  const contacts = parseContactsOutput(addressBook);
  const service = {
    getStatus: vi.fn(status),
    getContacts: vi.fn(() => contacts),
    getChats: vi.fn(async () => []),
    getRecentMessages: vi.fn(async () => recent),
    getMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ success: true })),
  } as unknown as IMessageService;
  IMessageService.registerSendHandlers(runtime, service);
  return registrations[0];
}

async function senderLabels(addressBook: string, handles: string[]): Promise<string[]> {
  const registration = register(addressBook, handles);
  const targets = await registration.listRecentTargets?.({} as never);
  return (targets ?? []).map((target) => target.label ?? "");
}

describe("iMessage contact saved without a country code", () => {
  it("names a US sender whose contact has no +1", async () => {
    expect(await senderLabels("phone\t(555) 987-6543\tPat Lee", ["+15559876543"])).toEqual([
      "Pat Lee (+15559876543)",
    ]);
  });

  it("names a UK sender whose contact has the trunk 0", async () => {
    expect(await senderLabels("phone\t07700 900123\tSam Hill", ["+447700900123"])).toEqual([
      "Sam Hill (+447700900123)",
    ]);
  });

  it("gives the user context the contact name", async () => {
    const registration = register("phone\t(555) 987-6543\tPat Lee", []);
    const context = await registration.getUserContext?.("+15559876543");
    expect(context?.label).toBe("Pat Lee");
  });

  it("does not take a short number from another country as the sender", async () => {
    expect(await senderLabels("phone\t59876543\tOther Person", ["+15559876543"])).toEqual([
      "+15559876543",
    ]);
  });
});
