/**
 * Unit tests for `fetchRetweetersPage` (Twitter API v2 retweeter payload
 * mapping) and `getAllRetweeters` (pagination termination, including
 * repeated-cursor and page-cap guards against an API that never stops
 * paginating); mocked API.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchRetweetersPage, getAllRetweeters } from "./tweets";

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

function retweeterPage(id: string, nextToken?: string) {
  return {
    data: [{ id, username: id, name: id, description: "" }],
    meta: nextToken ? { next_token: nextToken } : {},
  };
}

function terminalPage(id: string, previousToken?: string) {
  return {
    data: [{ id, username: id, name: id, description: "" }],
    meta: previousToken ? { previous_token: previousToken } : {},
  };
}

describe("getAllRetweeters", () => {
  it("concatenates pages until the API stops returning a next cursor", async () => {
    const tweetRetweetedBy = vi
      .fn()
      .mockResolvedValueOnce(retweeterPage("user-1", "c1"))
      .mockResolvedValueOnce(retweeterPage("user-2", "c2"))
      .mockResolvedValueOnce(retweeterPage("user-3"));
    const auth = {
      getV2Client: async () => ({ v2: { tweetRetweetedBy } }),
    };

    const result = await getAllRetweeters("tweet-1", auth as never);

    expect(result.map((r) => r.rest_id)).toEqual([
      "user-1",
      "user-2",
      "user-3",
    ]);
    expect(tweetRetweetedBy).toHaveBeenCalledTimes(3);
  });

  it("throws instead of looping forever when the API repeats the same cursor", async () => {
    const tweetRetweetedBy = vi
      .fn()
      .mockResolvedValueOnce(retweeterPage("user-1", "stuck"))
      .mockResolvedValueOnce(retweeterPage("user-2", "stuck"));
    const auth = {
      getV2Client: async () => ({ v2: { tweetRetweetedBy } }),
    };

    await expect(
      getAllRetweeters("tweet-1", auth as never),
    ).rejects.toMatchObject({
      code: "X_RETWEETERS_PAGINATION_CURSOR_REPEATED",
    });
    // Stopped after the repeat was detected, not after a third page.
    expect(tweetRetweetedBy).toHaveBeenCalledTimes(2);
  });

  it("throws on a longer cycle a same-as-previous-only check would miss (A -> B -> A)", async () => {
    const tweetRetweetedBy = vi
      .fn()
      .mockResolvedValueOnce(retweeterPage("user-1", "A"))
      .mockResolvedValueOnce(retweeterPage("user-2", "B"))
      .mockResolvedValueOnce(retweeterPage("user-3", "A"));
    const auth = {
      getV2Client: async () => ({ v2: { tweetRetweetedBy } }),
    };

    await expect(
      getAllRetweeters("tweet-1", auth as never),
    ).rejects.toMatchObject({
      code: "X_RETWEETERS_PAGINATION_CURSOR_REPEATED",
    });
    // Exactly 3 calls: the cycle back to "A" is caught on the page that
    // returns it, not after further oscillation.
    expect(tweetRetweetedBy).toHaveBeenCalledTimes(3);
  });

  it("completes on a terminal page whose previous_token echoes the just-sent cursor", async () => {
    const tweetRetweetedBy = vi
      .fn()
      .mockResolvedValueOnce(retweeterPage("user-1", "c1"))
      .mockResolvedValueOnce(terminalPage("user-2", "c1"));
    const auth = {
      getV2Client: async () => ({ v2: { tweetRetweetedBy } }),
    };

    const result = await getAllRetweeters("tweet-1", auth as never);

    expect(result.map((r) => r.rest_id)).toEqual(["user-1", "user-2"]);
    expect(tweetRetweetedBy).toHaveBeenCalledTimes(2);
    expect(tweetRetweetedBy).toHaveBeenNthCalledWith(
      2,
      "tweet-1",
      expect.objectContaining({ pagination_token: "c1" }),
    );
  });

  it("completes on a terminal page whose previous_token is a novel value", async () => {
    const tweetRetweetedBy = vi
      .fn()
      .mockResolvedValueOnce(retweeterPage("user-1", "c1"))
      .mockResolvedValueOnce(terminalPage("user-2", "novel-value"));
    const auth = {
      getV2Client: async () => ({ v2: { tweetRetweetedBy } }),
    };

    const result = await getAllRetweeters("tweet-1", auth as never);

    expect(result.map((r) => r.rest_id)).toEqual(["user-1", "user-2"]);
    expect(tweetRetweetedBy).toHaveBeenCalledTimes(2);
    expect(tweetRetweetedBy).toHaveBeenNthCalledWith(
      2,
      "tweet-1",
      expect.objectContaining({ pagination_token: "c1" }),
    );
  });

  it("caps total pages so a provider that never repeats but never stops still terminates", async () => {
    let page = 0;
    const tweetRetweetedBy = vi.fn().mockImplementation(async () => {
      page += 1;
      return retweeterPage(`user-${page}`, `cursor-${page}`);
    });
    const auth = {
      getV2Client: async () => ({ v2: { tweetRetweetedBy } }),
    };

    await expect(
      getAllRetweeters("tweet-1", auth as never),
    ).rejects.toMatchObject({ code: "X_RETWEETERS_PAGINATION_LIMIT_EXCEEDED" });
    expect(tweetRetweetedBy).toHaveBeenCalledTimes(1000);
  });
});
