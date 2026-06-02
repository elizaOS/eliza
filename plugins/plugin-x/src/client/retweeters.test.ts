import { describe, expect, it, vi } from "vitest";
import { fetchRetweetersPage } from "./tweets";

describe("fetchRetweetersPage", () => {
  it("maps Twitter API v2 retweeters into plugin retweeters", async () => {
    const tweetRetweetedBy = vi.fn().mockResolvedValue({
      data: [
        {
          id: "user-1",
          username: "alice",
          name: "Alice",
          description: "builder",
        },
      ],
      meta: {
        next_token: "next",
        previous_token: "previous",
      },
    });
    const auth = {
      getV2Client: async () => ({ v2: { tweetRetweetedBy } }),
    };

    const result = await fetchRetweetersPage(
      "tweet-1",
      auth as never,
      "cursor-1",
      25,
    );

    expect(tweetRetweetedBy).toHaveBeenCalledWith(
      "tweet-1",
      expect.objectContaining({
        max_results: 25,
        pagination_token: "cursor-1",
      }),
    );
    expect(result).toEqual({
      retweeters: [
        {
          rest_id: "user-1",
          screen_name: "alice",
          name: "Alice",
          description: "builder",
        },
      ],
      bottomCursor: "next",
      topCursor: "previous",
    });
  });

  it("handles retweeter pages without data", async () => {
    const tweetRetweetedBy = vi.fn().mockResolvedValue({
      meta: {},
    });
    const auth = {
      getV2Client: async () => ({ v2: { tweetRetweetedBy } }),
    };

    const result = await fetchRetweetersPage("tweet-1", auth as never);

    expect(result).toEqual({
      retweeters: [],
      bottomCursor: undefined,
      topCursor: undefined,
    });
  });
});
