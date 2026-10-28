/**
 * MESSAGE read_channel and search pass a Telegram target named by channelId
 * (and threadId) without a roomId. The read must stay in that chat, not merge
 * every known chat. Real TelegramService read paths; only the runtime memory
 * store and the known-chat cache are stubbed.
 */
import {
  createUniqueUuid,
  type IAgentRuntime,
  type Memory,
  type MessageConnectorQueryContext,
  type UUID,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { TelegramService } from "./service";

const GROUP = "-1001234567890";
const OTHER = "-1009999999999";

function harness() {
  const runtime = {
    agentId: "00000000-0000-4000-8000-0000000000a1",
  } as unknown as IAgentRuntime;
  const roomOf = (key: string) => createUniqueUuid(runtime, key) as UUID;
  const byRoom = new Map<UUID, Memory[]>([
    [roomOf(GROUP), [memory(roomOf(GROUP), "group: invoice sent", 1)]],
    [roomOf(`${GROUP}-7`), [memory(roomOf(`${GROUP}-7`), "topic: invoice", 2)]],
    [roomOf(OTHER), [memory(roomOf(OTHER), "private: invoice PIN 4412", 3)]],
  ]);
  Object.assign(runtime, {
    getMemories: async ({
      roomId,
      offset,
    }: {
      roomId: UUID;
      offset: number;
    }) => (offset === 0 ? (byRoom.get(roomId) ?? []) : []),
    getRoom: async () => null,
  });
  const service = Object.create(TelegramService.prototype) as TelegramService;
  Object.assign(service, {
    runtime,
    defaultAccountId: "default",
    accountStates: new Map(),
    knownChats: new Map([
      [GROUP, { id: Number(GROUP), type: "supergroup", title: "Team" }],
      [OTHER, { id: Number(OTHER), type: "private", first_name: "Sam" }],
    ]),
  });
  const context = { runtime } as unknown as MessageConnectorQueryContext;
  return { service, context };
}

function memory(roomId: UUID, text: string, createdAt: number): Memory {
  return {
    id: createUniqueUuid({ agentId: roomId } as never, text) as UUID,
    entityId: roomId,
    roomId,
    createdAt,
    content: { text, source: "telegram" },
  } as Memory;
}

const texts = (memories: Memory[]) => memories.map((m) => m.content.text);

it("reads only the chat named by channelId", async () => {
  const { service, context } = harness();
  const read = await service.fetchConnectorMessages(context, {
    target: { source: "telegram", channelId: GROUP },
    limit: 10,
  });
  expect(texts(read)).toEqual(["group: invoice sent"]);
});

it("reads only the forum topic named by channelId and threadId", async () => {
  const { service, context } = harness();
  const read = await service.fetchConnectorMessages(context, {
    target: { source: "telegram", channelId: GROUP, threadId: "7" },
  });
  expect(texts(read)).toEqual(["topic: invoice"]);
});

it("searches only the chat named by channelId", async () => {
  const { service, context } = harness();
  const found = await service.searchConnectorMessages(context, {
    target: { source: "telegram", channelId: GROUP },
    query: "invoice",
  });
  expect(texts(found)).toEqual(["group: invoice sent"]);
});
