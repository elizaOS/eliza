/**
 * An inbound tapback reaches the assistant's core REACTION_RECEIVED handler
 * as a Memory and is stored. Drives the real chat.db poll and the real
 * assistant reaction handler; only chat.db and the memory store are stand-ins.
 */
import {
  createUniqueUuid,
  type EventPayload,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { expect, it, vi } from "vitest";
import type { ChatDbMessage, ChatDbReader } from "./chatdb-reader";
import { IMessageService } from "./service";
import type { IMessageSettings } from "./types";

it("stores an inbound tapback as a reaction memory on the message it targets", async () => {
  const handlers = (createAssistantPlugin().events ?? {}) as Record<
    string,
    Array<(payload: EventPayload) => Promise<void>>
  >;
  const stored: Memory[] = [];
  const reportError = vi.fn();
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(() => null),
    ensureConnection: vi.fn(async () => {}),
    createMemories: vi.fn(async (entries: Array<{ memory: Memory }>) =>
      entries.map(({ memory }) => {
        stored.push(memory);
        return memory.id;
      })
    ),
    // Await every registered handler, as the runtime's emitEvent does.
    emitEvent: vi.fn(async (event: string, payload: EventPayload) => {
      for (const handler of handlers[event] ?? []) {
        await handler({ ...payload, runtime: runtime as never });
      }
    }),
    reportError,
  } as unknown as IAgentRuntime;
  const row: ChatDbMessage = {
    rowId: 7,
    guid: "tapback-guid-7",
    text: "Loved “see you at 6”",
    kind: "reaction",
    handle: "+15551234567",
    chatId: "iMessage;-;+15551234567",
    chatType: "direct",
    displayName: null,
    timestamp: 1_700_000_000_000,
    isFromMe: false,
    service: "iMessage",
    isSent: true,
    isDelivered: true,
    isRead: false,
    dateRead: 0,
    dateEdited: 0,
    dateRetracted: 0,
    replyToGuid: null,
    reaction: {
      kind: "love",
      add: true,
      rawType: 2000,
      targetGuid: "original-guid-1",
      emoji: null,
    },
    attachments: [],
  };
  const service = new IMessageService(runtime);
  const internal = service as unknown as {
    chatDb: Pick<ChatDbReader, "fetchNewMessages">;
    lastRowId: number;
    contactsLoadAttempted: boolean;
    settings: IMessageSettings;
    pollForNewMessagesInner(): Promise<void>;
  };
  internal.chatDb = {
    fetchNewMessages: (sinceRowId: number) => (sinceRowId < row.rowId ? [row] : []),
  };
  internal.lastRowId = 0;
  internal.contactsLoadAttempted = true;
  internal.settings = {
    pollIntervalMs: 0,
    heartbeatIntervalMs: 60_000,
    dmPolicy: "open",
    groupPolicy: "allowlist",
    allowFrom: [],
    enabled: true,
  };

  await internal.pollForNewMessagesInner();

  expect(reportError).not.toHaveBeenCalled();
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    id: createUniqueUuid(runtime, "imessage-guid-tapback-guid-7"),
    entityId: createUniqueUuid(runtime, "+15551234567"),
    roomId: createUniqueUuid(runtime, "iMessage;-;+15551234567"),
    content: {
      source: "imessage",
      inReplyTo: createUniqueUuid(runtime, "imessage-guid-original-guid-1"),
    },
  });
  expect(internal.lastRowId).toBe(7);
});
