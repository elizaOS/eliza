/**
 * An explicit message limit of 0 is an empty page. `limit || 20` used to
 * search for the default page instead.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ClientBase } from "../base";
import { SearchMode } from "../client";
import { TwitterMessageService } from "./MessageService";

function createClient(fetchSearchTweets: ReturnType<typeof vi.fn>): ClientBase {
  const client = {
    runtime: {
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
      reportError: vi.fn(),
    } as unknown as IAgentRuntime,
    getAuthenticatedProfile: vi.fn(async () => ({
      id: "bot-user",
      username: "bot",
    })),
    twitterClient: {},
    fetchSearchTweets,
  } as unknown as ClientBase;
  client.withAuthenticatedSession = async (operation) =>
    operation({
      client: client.twitterClient as never,
      profile: await client.getAuthenticatedProfile(),
      revision: 1,
    });
  return client;
}

describe("TwitterMessageService explicit empty page", () => {
  it("treats a message limit of 0 as an empty page", async () => {
    const fetchSearchTweets = vi.fn(async () => ({
      tweets: [
        {
          id: "tweet-1",
          userId: "user-1",
          username: "alice",
          conversationId: "conversation-1",
          text: "hello",
          timestamp: 1_710_969_600,
        },
      ],
    }));
    const service = new TwitterMessageService(createClient(fetchSearchTweets));

    await expect(
      service.getMessages({
        agentId: "00000000-0000-0000-0000-000000000001" as UUID,
        limit: 0,
      }),
    ).resolves.toEqual([]);
    expect(fetchSearchTweets).not.toHaveBeenCalled();

    await service.getMessages({
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
      limit: 1,
    });
    expect(fetchSearchTweets).toHaveBeenCalledWith(
      "@bot",
      1,
      SearchMode.Latest,
    );

    fetchSearchTweets.mockClear();
    await service.getMessages({
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    });
    expect(fetchSearchTweets).toHaveBeenCalledWith(
      "@bot",
      20,
      SearchMode.Latest,
    );
  });
});
