import type { IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "../base";
import { createTwitterPostCallback } from "./twitter-post-callback";

const mockedSendTweet = vi.hoisted(() => vi.fn());
const mockedAddToRecentTweets = vi.hoisted(() => vi.fn());
const mockedCreateMemorySafe = vi.hoisted(() => vi.fn());
const mockedEnsureTwitterContext = vi.hoisted(() => vi.fn());
const mockedIsDuplicateTweet = vi.hoisted(() => vi.fn());

vi.mock("../utils", () => ({
  sendTweet: mockedSendTweet,
}));

vi.mock("./memory", () => ({
  addToRecentTweets: mockedAddToRecentTweets,
  createMemorySafe: mockedCreateMemorySafe,
  ensureTwitterContext: mockedEnsureTwitterContext,
  isDuplicateTweet: mockedIsDuplicateTweet,
}));

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  } as IAgentRuntime;
}

describe("createTwitterPostCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnsureTwitterContext.mockResolvedValue({ roomId: "room-ctx" });
    mockedIsDuplicateTweet.mockResolvedValue(false);
    mockedSendTweet.mockResolvedValue({ id: "tweet-1" });
  });

  it("skips posting in dry-run mode", async () => {
    const callback = createTwitterPostCallback({
      client: { accountId: "default" } as ClientBase,
      runtime: makeRuntime(),
      state: { TWITTER_DRY_RUN: true },
      roomId: "room-1" as UUID,
      userId: "user-1",
      username: "agent",
    });

    await expect(callback({ text: "hello" })).resolves.toEqual([]);
    expect(mockedSendTweet).not.toHaveBeenCalled();
  });

  it("skips duplicate generated tweets", async () => {
    mockedIsDuplicateTweet.mockResolvedValue(true);

    const callback = createTwitterPostCallback({
      client: { accountId: "default" } as ClientBase,
      runtime: makeRuntime(),
      state: {},
      roomId: "room-1" as UUID,
      userId: "user-1",
      username: "agent",
    });

    await expect(callback({ text: "duplicate text" })).resolves.toEqual([]);
    expect(mockedSendTweet).not.toHaveBeenCalled();
  });

  it("posts generated tweet and returns created memory", async () => {
    const onPosted = vi.fn();
    const callback = createTwitterPostCallback({
      client: { accountId: "default" } as ClientBase,
      runtime: makeRuntime(),
      state: {},
      roomId: "room-1" as UUID,
      userId: "user-1",
      username: "agent",
      onPosted,
    });

    const memories = await callback({ text: "new post text" });

    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(mockedSendTweet).toHaveBeenCalledWith(
      expect.anything(),
      "new post text",
      [],
      undefined,
      [],
    );
    expect(mockedCreateMemorySafe).toHaveBeenCalledTimes(1);
    expect(mockedAddToRecentTweets).toHaveBeenCalledWith(
      expect.anything(),
      "agent",
      "new post text",
    );
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content?.text).toBe("new post text");
  });
});
