/**
 * Restoring a web-chat conversation awaits the room and its latest message.
 * A DELETE or a second restore of the same id can land during those awaits.
 */
import type { AgentRuntime, Room } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  type ConversationRestoreTarget,
  restoreConversationFromDb,
  restoreConversationsFromDb,
  WEB_CONVERSATION_CHANNEL_PREFIX,
  webChatWorldId,
} from "./conversation-restore.ts";

const CONV_ID = "conversation-1";

function gatedRuntime() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const room = {
    id: stringToUuid(`${WEB_CONVERSATION_CHANNEL_PREFIX}${CONV_ID}`),
    name: "Saved chat",
    worldId: webChatWorldId("Eliza"),
    channelId: `${WEB_CONVERSATION_CHANNEL_PREFIX}${CONV_ID}`,
  } as Room;
  const rt = {
    character: { name: "Eliza" },
    getRoom: async () => room,
    getRoomsByWorld: async () => [room],
    getMemories: async () => {
      await gate;
      return [];
    },
  } as unknown as AgentRuntime;
  return { rt, release };
}

function emptyTarget(): ConversationRestoreTarget {
  return { conversations: new Map(), deletedConversationIds: new Set() };
}

describe("conversation restore races", () => {
  it("does not bring back a conversation deleted while it was being restored", async () => {
    const { rt, release } = gatedRuntime();
    const target = emptyTarget();
    const pending = restoreConversationFromDb(rt, target, CONV_ID);
    target.deletedConversationIds.add(CONV_ID);
    release();
    expect(await pending).toBeUndefined();
    expect(target.conversations.has(CONV_ID)).toBe(false);
  });

  it("gives concurrent restores of one id the same registered conversation", async () => {
    const { rt, release } = gatedRuntime();
    const target = emptyTarget();
    const first = restoreConversationFromDb(rt, target, CONV_ID);
    const second = restoreConversationFromDb(rt, target, CONV_ID);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(target.conversations.get(CONV_ID)).toBe(a);
  });

  it("skips a conversation deleted during the boot restore scan", async () => {
    const { rt, release } = gatedRuntime();
    const target = emptyTarget();
    const pending = restoreConversationsFromDb(rt, target);
    // Let the scan reach the gated message read.
    await new Promise((resolve) => setImmediate(resolve));
    target.deletedConversationIds.add(CONV_ID);
    release();
    expect(await pending).toBe(0);
    expect(target.conversations.has(CONV_ID)).toBe(false);
  });
});
