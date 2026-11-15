import type { IAgentRuntime, Memory, TopicSearchHit } from "@elizaos/core";
import { matchTopicRooms } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { channelTopicSearchAction } from "./channel-topic-search.ts";

/**
 * content.text as packages/agent/src/api/chat-augmentation.ts rewrites it when
 * a turn retrieves contextual documents. The user's request is the last block.
 */
const AUGMENTED_TEXT = [
  "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
  "If the answer appears verbatim in the contextual documents, repeat it exactly.",
  "Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
  "",
  "<contextual_documents>",
  '<source title="source-1" similarity="1.000">',
  'Q: How do I see the tutorial again?\nA: Type "restart tutorial" in the chat any time. The tour runs right in the conversation and is always re-runnable — nothing is one-time-only.',
  "</source>",
  "</contextual_documents>",
  "",
  "<user_request>",
  "friday planning",
  "</user_request>",
].join("\n");

const topicsByRoom: Record<string, string[]> = {
  "room-planning": ["friday release planning"],
  "room-tutorial": ["tutorial replay", "tour restart"],
  "room-billing": ["invoice export", "billing portal"],
};

function runtimeWithTopics(): IAgentRuntime {
  const service = {
    searchTopics: (query: string, limit?: number): TopicSearchHit[] =>
      matchTopicRooms(topicsByRoom, query, limit),
    getTopicsForAllRooms: (): Record<string, string[]> => topicsByRoom,
  };
  return {
    getService: (name: string) => (name === "channel_topics" ? service : null),
  } as unknown as IAgentRuntime;
}

function messageWithText(text: string): Memory {
  return { content: { text } } as Memory;
}

describe("SEARCH_CHANNEL_TOPICS query", () => {
  it("searches the request inside the help-document envelope, not its preamble", async () => {
    const result = await channelTopicSearchAction.handler(
      runtimeWithTopics(),
      messageWithText(AUGMENTED_TEXT),
    );
    const hits = (result.data as { hits: TopicSearchHit[] }).hits;

    // Only the room whose topic holds the request tokens. The envelope's own
    // prose matched every room.
    expect(hits.map((hit) => hit.roomId)).toEqual(["room-planning"]);
    expect(result.text).not.toContain("No channels");
  });

  it("keeps an explicit query parameter ahead of the message text", async () => {
    const result = await channelTopicSearchAction.handler(
      runtimeWithTopics(),
      messageWithText(AUGMENTED_TEXT),
      undefined,
      { parameters: { query: "invoice" } },
    );
    const hits = (result.data as { hits: TopicSearchHit[] }).hits;

    expect(hits.map((hit) => hit.roomId)).toEqual(["room-billing"]);
  });
});
