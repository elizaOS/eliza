/**
 * Real-module tests for `Client.fetchSearchTweets` page cursors. The v2
 * recent-search paginator is the injected transport; conversion and cursor
 * plumbing run unmocked.
 */
import { describe, expect, it, vi } from "vitest";
import type { TwitterAuth } from "./auth";
import { Client } from "./client";
import { SearchMode } from "./search";

function fakeAuth(v2: Record<string, unknown>): TwitterAuth {
  const session = {
    client: {},
    profile: { userId: "1", username: "bot", name: "Bot" },
    revision: 1,
  };
  return {
    getV2Client: async () => ({ v2 }),
    withAuthenticatedSession: async <T>(
      operation: (session: typeof session) => Promise<T>,
    ) => operation(session),
    getAuthenticatedSession: async () => session,
    isAuthenticatedSessionCurrent: () => true,
    deferUntil: () => undefined,
    logout: async () => undefined,
  } as unknown as TwitterAuth;
}

function tweetPage(ids: string[], next?: string) {
  const tweets = ids.map((id) => ({
    id,
    text: `tweet-${id}`,
    author_id: "u1",
    created_at: "2026-01-01T00:00:00.000Z",
    conversation_id: id,
  }));
  const paginator = {
    tweets,
    includes: { users: [{ id: "u1", name: "User", username: "user" }] },
    meta: { next_token: next },
    async *[Symbol.asyncIterator]() {
      yield* tweets;
    },
  };
  return paginator;
}

describe("Client.fetchSearchTweets pagination", () => {
  it("returns the v2 next_token and forwards a resume cursor", async () => {
    const search = vi.fn(
      async (_query: string, options: { next_token?: string }) => {
        if (options.next_token === "page-2") {
          return tweetPage(["8", "9"]);
        }
        return tweetPage(["10", "11"], "page-2");
      },
    );
    const client = new Client();
    client.updateAuth(fakeAuth({ search }));

    const first = await client.fetchSearchTweets(
      "from:user",
      20,
      SearchMode.Latest,
    );
    expect(first.tweets.map((tweet) => tweet.id)).toEqual(["10", "11"]);
    expect(first.next).toBe("page-2");
    expect(search.mock.calls[0]?.[1]).not.toHaveProperty("next_token");

    const second = await client.fetchSearchTweets(
      "from:user",
      20,
      SearchMode.Latest,
      "page-2",
    );
    expect(second.tweets.map((tweet) => tweet.id)).toEqual(["8", "9"]);
    expect(second.next).toBeUndefined();
    expect(search.mock.calls[1]?.[1]).toMatchObject({ next_token: "page-2" });
  });

  it("does not send a blank cursor as next_token", async () => {
    const search = vi.fn(async () => tweetPage(["1"]));
    const client = new Client();
    client.updateAuth(fakeAuth({ search }));

    await client.fetchSearchTweets("hello", 20, SearchMode.Latest, "  ");
    expect(search.mock.calls[0]?.[1]).not.toHaveProperty("next_token");
  });

  it("keeps first-page tweet ids stable for previously valid uncursored searches", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const search = vi.fn(async () => tweetPage(ids, "more"));
    const client = new Client();
    client.updateAuth(fakeAuth({ search }));

    const result = await client.fetchSearchTweets(
      "javascript",
      5,
      SearchMode.Latest,
    );
    expect(result.tweets.map((tweet) => tweet.id)).toEqual(ids);
    expect(result.tweets.map((tweet) => tweet.username)).toEqual(
      Array(5).fill("user"),
    );
  });
});
