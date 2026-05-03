import { ChannelType, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildTwitterMessageMetadata } from "../utils/memory";

describe("buildTwitterMessageMetadata", () => {
  it("records stable Twitter sender identity on message metadata", () => {
    const entityId = "00000000-0000-0000-0000-000000000001" as UUID;

    const metadata = buildTwitterMessageMetadata(
      {
        id: "tweet-1",
        userId: "user-1",
        username: "alice",
        name: "Alice Example",
        conversationId: "conversation-1",
        timestamp: 1_700_000_000,
      },
      entityId,
    ) as Record<string, unknown>;

    expect(metadata).toMatchObject({
      type: "message",
      source: "twitter",
      provider: "twitter",
      entityName: "Alice Example",
      entityUserName: "alice",
      fromId: "user-1",
      sourceId: entityId,
      chatType: ChannelType.FEED,
      messageIdFull: "tweet-1",
      twitter: {
        id: "user-1",
        userId: "user-1",
        username: "alice",
        userName: "alice",
        name: "Alice Example",
        tweetId: "tweet-1",
        conversationId: "conversation-1",
      },
    });
  });
});
