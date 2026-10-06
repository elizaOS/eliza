/**
 * A recorded public-metric count of 0 is zero, not a missing field.
 * `count || undefined` dropped likes, replies, reposts, views, and quotes
 * when the provider reported none.
 */

import { describe, expect, it } from "vitest";
import type { TwitterAuth } from "./auth";
import { SearchMode, searchTweetsPage } from "./search";

function authWith(tweets: unknown[]): TwitterAuth {
  return {
    getV2Client: async () => ({
      v2: {
        search: async () => ({ tweets }),
      },
    }),
  } as unknown as TwitterAuth;
}

describe("X search public metrics", () => {
  it("keeps a recorded count of 0", async () => {
    const page = await searchTweetsPage(
      "hello",
      10,
      SearchMode.Latest,
      authWith([
        {
          id: "zero",
          text: "quiet",
          public_metrics: {
            like_count: 0,
            reply_count: 0,
            retweet_count: 0,
            impression_count: 0,
            quote_count: 0,
          },
        },
        {
          id: "some",
          text: "busy",
          public_metrics: {
            like_count: 3,
            reply_count: 1,
            retweet_count: 2,
            impression_count: 4,
            quote_count: 5,
          },
        },
        { id: "bare", text: "no metrics" },
      ]),
    );

    expect(page.tweets.map((tweet) => tweet.likes)).toEqual([0, 3, undefined]);
    expect(page.tweets.map((tweet) => tweet.replies)).toEqual([
      0,
      1,
      undefined,
    ]);
    expect(page.tweets.map((tweet) => tweet.retweets)).toEqual([
      0,
      2,
      undefined,
    ]);
    expect(page.tweets.map((tweet) => tweet.views)).toEqual([0, 4, undefined]);
    expect(page.tweets.map((tweet) => tweet.quotes)).toEqual([0, 5, undefined]);
  });
});
