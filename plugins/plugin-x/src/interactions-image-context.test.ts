/** Unit tests that `TwitterInteractionClient` attaches IMAGE_DESCRIPTION-derived photo context to the message it hands the message service; mocked runtime. */
import {
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import type { Tweet } from "./client";
import { TwitterInteractionClient } from "./interactions";
import type { TwitterClientState } from "./types";

function asRuntime<T extends object>(runtime: T): IAgentRuntime & T {
  return runtime as IAgentRuntime & T;
}

function createRuntime() {
  const handleMessage = vi.fn(async () => ({ responseMessages: [] }));
  return {
    runtime: asRuntime({
      agentId: "agent-1" as UUID,
      character: { name: "Agent" },
      getSetting: vi.fn(() => undefined),
      getModel: vi.fn((type: string) =>
        type === ModelType.IMAGE_DESCRIPTION ? () => undefined : undefined,
      ),
      useModel: vi.fn(async () => ({
        title: "Photo",
        description: "a golden retriever in a field",
      })),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      messageService: { handleMessage },
    }),
    handleMessage,
  };
}

function createClient(): ClientBase {
  return {
    accountId: "default",
    lastCheckedTweetId: null,
    profile: { id: "bot-user", username: "bot" },
  } as unknown as ClientBase;
}

function tweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: "100",
    userId: "user-1",
    username: "alice",
    name: "Alice",
    conversationId: "conversation-1",
    text: "@bot look at this",
    timestamp: Date.now(),
    thread: [],
    photos: [],
    ...overrides,
  } as Tweet;
}

describe("Twitter image-description context", () => {
  beforeEach(() => {
    logger.log = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
  });

  it("attaches described tweet photos to the message handed to the message service", async () => {
    const { runtime, handleMessage } = createRuntime();
    const client = new TwitterInteractionClient(
      createClient(),
      runtime,
      {} as TwitterClientState,
    );

    const message: Memory = {
      id: "11111111-1111-1111-1111-111111111111" as UUID,
      entityId: "22222222-2222-2222-2222-222222222222" as UUID,
      agentId: runtime.agentId,
      roomId: "33333333-3333-3333-3333-333333333333" as UUID,
      content: { text: "@bot look at this", source: "twitter" },
      createdAt: Date.now(),
    };

    const withPhotos = tweet({
      photos: [
        {
          id: "photo-1",
          url: "https://pbs.twimg.com/a.jpg",
          alt_text: undefined,
        },
      ],
    });

    await client.handleTweet({
      tweet: withPhotos,
      message,
      thread: [withPhotos],
    });

    expect(runtime.useModel).toHaveBeenCalledWith(
      ModelType.IMAGE_DESCRIPTION,
      "https://pbs.twimg.com/a.jpg",
    );
    expect(handleMessage).toHaveBeenCalledTimes(1);

    const passedMessage = handleMessage.mock.calls[0]?.[1] as Memory;
    const attachments = passedMessage.content.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      id: "photo-1",
      contentType: "image",
      description: "a golden retriever in a field",
      text: "a golden retriever in a field",
    });
  });

  it("leaves attachments untouched when the tweet has no photos", async () => {
    const { runtime, handleMessage } = createRuntime();
    const client = new TwitterInteractionClient(
      createClient(),
      runtime,
      {} as TwitterClientState,
    );

    const message: Memory = {
      id: "11111111-1111-1111-1111-111111111112" as UUID,
      entityId: "22222222-2222-2222-2222-222222222222" as UUID,
      agentId: runtime.agentId,
      roomId: "33333333-3333-3333-3333-333333333333" as UUID,
      content: { text: "@bot hi", source: "twitter" },
      createdAt: Date.now(),
    };

    const plain = tweet();
    await client.handleTweet({ tweet: plain, message, thread: [plain] });

    expect(runtime.useModel).not.toHaveBeenCalled();
    const passedMessage = handleMessage.mock.calls[0]?.[1] as Memory;
    expect(passedMessage.content.attachments ?? []).toHaveLength(0);
  });
});
