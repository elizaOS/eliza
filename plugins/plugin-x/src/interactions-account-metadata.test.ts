import {
  EventType,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import { TwitterInteractionClient } from "./interactions";
import type { TwitterClientState, TwitterInteractionPayload } from "./types";

function createRuntime(): IAgentRuntime & {
  createMemory: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
} {
  return {
    agentId: "agent-1" as UUID,
    createMemory: vi.fn(async () => undefined),
    emitEvent: vi.fn(),
    getSetting: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime & {
    createMemory: ReturnType<typeof vi.fn>;
    emitEvent: ReturnType<typeof vi.fn>;
  };
}

function createClient(accountId: string): ClientBase {
  return { accountId } as unknown as ClientBase;
}

describe("Twitter interaction memory account metadata", () => {
  it("stamps interaction memories and reaction payload messages with accountId", async () => {
    const runtime = createRuntime();
    const client = new TwitterInteractionClient(
      createClient("secondary"),
      runtime,
      {} as TwitterClientState,
    );
    const interaction = {
      id: "like-1",
      type: "like",
      userId: "user-1",
      username: "alice",
      name: "Alice",
      targetTweetId: "tweet-1",
      targetTweet: {
        id: "tweet-1",
        text: "hello",
        conversationId: "conversation-1",
      },
    } as unknown as TwitterInteractionPayload;

    await client.handleInteraction(interaction);

    const storedMemory = runtime.createMemory.mock.calls[0][0] as Memory;
    expect(storedMemory.metadata).toEqual(
      expect.objectContaining({
        accountId: "secondary",
      }),
    );

    const reactionPayload = runtime.emitEvent.mock.calls.find(
      ([event]) => event === EventType.REACTION_RECEIVED,
    )?.[1] as { message?: Memory } | undefined;
    expect(reactionPayload?.message?.metadata).toEqual(
      expect.objectContaining({
        accountId: "secondary",
      }),
    );
  });
});
