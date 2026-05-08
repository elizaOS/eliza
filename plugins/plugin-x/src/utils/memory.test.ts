import type { UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildTwitterMessageMetadata } from "./memory";

describe("Twitter memory metadata", () => {
  it("includes accountId on inbound tweet metadata", () => {
    const metadata = buildTwitterMessageMetadata(
      {
        id: "tweet-1",
        userId: "user-1",
        username: "alice",
        name: "Alice",
        conversationId: "conversation-1",
        timestamp: 123,
      },
      "entity-1" as UUID,
      "secondary",
    ) as unknown as {
      accountId?: string;
      twitter?: { accountId?: string };
    };

    expect(metadata.accountId).toBe("secondary");
    expect(metadata.twitter?.accountId).toBe("secondary");
  });
});
