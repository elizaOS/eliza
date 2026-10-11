/**
 * Ordering contract for the iMessage connector's searchMessages: the chat.db
 * reader returns a chat oldest-first, but search results must come back
 * newest-first so `limit` keeps the most recent matches (as fetchMessages and
 * the Slack, Discord, Telegram and Google Chat connectors do).
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { IMessageService } from "../src/service.js";
import type { IMessageMessage, IMessageServiceStatus } from "../src/types.js";

type MessageConnectorRegistration = Parameters<IAgentRuntime["registerMessageConnector"]>[0];
type SearchContext = Parameters<NonNullable<MessageConnectorRegistration["searchMessages"]>>[0];

function makeStatus(): IMessageServiceStatus {
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

function makeRuntime(registrations: MessageConnectorRegistration[]): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    registerMessageConnector: vi.fn((registration: MessageConnectorRegistration) => {
      registrations.push(registration);
    }),
    registerSendHandler: vi.fn(),
    emitEvent: vi.fn(),
    getRoom: vi.fn(async () => null),
    getMemoryById: vi.fn(async () => null),
    getMemories: vi.fn(async () => []),
  } as unknown as IAgentRuntime;
}

function chatMessage(id: string, text: string, timestamp: number): IMessageMessage {
  return {
    id,
    text,
    handle: "+14155552671",
    chatId: "iMessage;-;+14155552671",
    timestamp,
    isFromMe: false,
    hasAttachments: false,
  };
}

const JAN = Date.UTC(2026, 0, 15);
const JUN = Date.UTC(2026, 5, 15);
const OCT = Date.UTC(2026, 9, 15);

/** Chronological (oldest-first), the order the chat.db reader returns. */
const CHAT_HISTORY: IMessageMessage[] = [
  chatMessage("101", "dinner in January?", JAN),
  chatMessage("102", "unrelated message", JUN - 1),
  chatMessage("103", "dinner in June?", JUN),
  chatMessage("104", "dinner in October?", OCT),
];

function registerWithHistory(): MessageConnectorRegistration {
  const registrations: MessageConnectorRegistration[] = [];
  const runtime = makeRuntime(registrations);
  const service = {
    getStatus: vi.fn(makeStatus),
    getContacts: vi.fn(() => new Map()),
    getChats: vi.fn(async () => []),
    getRecentMessages: vi.fn(async () => []),
    getMessages: vi.fn(async () => CHAT_HISTORY.map((message) => ({ ...message }))),
    sendMessage: vi.fn(async () => ({ success: true })),
  } as unknown as IMessageService;

  IMessageService.registerSendHandlers(runtime, service);
  expect(registrations).toHaveLength(1);
  return registrations[0];
}

function searchContext(registration: MessageConnectorRegistration): SearchContext {
  const runtime = makeRuntime([]);
  return {
    runtime,
    roomId: "room-1" as UUID,
    source: registration.source,
  } as unknown as SearchContext;
}

describe("iMessage connector — searchMessages ordering", () => {
  it("keeps the newest match when limit is 1", async () => {
    const registration = registerWithHistory();
    const results = await registration.searchMessages?.(searchContext(registration), {
      query: "dinner",
      limit: 1,
    });

    expect(results?.map((memory) => memory.content.text)).toEqual(["dinner in October?"]);
  });

  it("returns every match newest-first when no limit is given", async () => {
    const registration = registerWithHistory();
    const results = await registration.searchMessages?.(searchContext(registration), {
      query: "dinner",
    });

    expect(results?.map((memory) => memory.content.text)).toEqual([
      "dinner in October?",
      "dinner in June?",
      "dinner in January?",
    ]);
    expect(results?.map((memory) => memory.createdAt)).toEqual([OCT, JUN, JAN]);
  });
});
