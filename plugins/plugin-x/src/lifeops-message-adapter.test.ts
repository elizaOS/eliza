/**
 * MESSAGE list_inbox sends a conversation-scoped request (`channelIds`) to the
 * live adapter pull; the X adapter owns that scope (`channels: "implicit"`).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { XDmAdapter } from "./lifeops-message-adapter";

function dm(id: string, conversationId: string, text: string, at: number) {
  return {
    id,
    entityId: `sender-${id}`,
    roomId: conversationId,
    createdAt: at,
    content: { text },
    metadata: { x: { dmEventId: id, conversationId, senderId: `user-${id}` } },
  };
}

const xService = {
  fetchDirectMessagesForAccount: async () => [
    dm("e1", "conv-A", "hi from A", 1_000),
    dm("e2", "conv-B", "hi from B", 2_000),
  ],
};
const runtime = {
  agentId: "agent",
  getService: (name: string) => (name === "x" ? xService : null),
} as unknown as IAgentRuntime;

describe("XDmAdapter listMessages", () => {
  it("lists only the requested conversations", async () => {
    const refs = await new XDmAdapter().listMessages(runtime, {
      channelIds: ["conv-A"],
    });
    expect(refs.map((ref) => [ref.id, ref.channelId])).toEqual([
      ["twitter:e1", "conv-A"],
    ]);
  });

  it("lists every conversation without a channel scope", async () => {
    const refs = await new XDmAdapter().listMessages(runtime, {});
    expect(refs.map((ref) => ref.channelId)).toEqual(["conv-B", "conv-A"]);
  });
});
