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
});
