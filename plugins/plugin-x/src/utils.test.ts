/** Unit tests for `sendTweet`, covering that a published tweet is returned even when post-publish local cache bookkeeping fails; mocked client. */
import { describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import { sendTweet } from "./utils";

describe("sendTweet", () => {
  it("returns the accepted tweet when local cache bookkeeping fails after publish", async () => {
    const client = {
      lastCheckedTweetId: null,
      twitterClient: {
        sendTweet: vi.fn().mockResolvedValue({
          data: {
            data: {
              id: "123",
              text: "hello",
            },
          },
        }),
      },
      cacheLatestCheckedTweetId: vi
        .fn()
        .mockRejectedValue(new Error("cache unavailable")),
      cacheTweet: vi.fn(),
    } as unknown as ClientBase;

    await expect(sendTweet(client, "hello")).resolves.toMatchObject({
      id: "123",
      text: "hello",
    });
    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(1);
    expect(client.cacheLatestCheckedTweetId).toHaveBeenCalledTimes(1);
  });
});
