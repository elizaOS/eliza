/** Unit tests for `TwitterPostService` inverse actions (unlike / unrepost), driving a mocked Twitter client. */
import type { UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "../base";
import { TwitterPostService } from "./PostService";

describe("TwitterPostService inverse post actions", () => {
  const unlikeTweet = vi.fn();
  const unretweet = vi.fn();
  let service: TwitterPostService;

  beforeEach(() => {
    unlikeTweet.mockReset();
    unretweet.mockReset();
    service = new TwitterPostService({
      twitterClient: {
        unlikeTweet,
        unretweet,
      },
    } as unknown as ClientBase);
  });

  it("unlikes posts through the Twitter client", async () => {
    await service.unlikePost(
      "tweet-1",
      "00000000-0000-0000-0000-000000000001" as UUID,
    );

    expect(unlikeTweet).toHaveBeenCalledWith("tweet-1");
  });

  it("removes reposts through the Twitter client", async () => {
    await service.unrepost(
      "tweet-2",
      "00000000-0000-0000-0000-000000000001" as UUID,
    );

    expect(unretweet).toHaveBeenCalledWith("tweet-2");
  });

  it("surfaces a getPosts fetch failure via reportError instead of silently returning []", async () => {
    const reportError = vi.fn();
    const getUserTweets = vi
      .fn()
      .mockRejectedValue(new Error("twitter 429 rate limited"));
    const failing = new TwitterPostService({
      runtime: { reportError },
      twitterClient: { getUserTweets },
    } as unknown as ClientBase);

    const posts = await failing.getPosts({
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
      userId: "123",
      limit: 5,
    });

    expect(posts).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      "XPostService.getPosts",
      expect.any(Error),
    );
  });
});
