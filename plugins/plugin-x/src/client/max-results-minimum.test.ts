/**
 * X API v2 rejects a `max_results` below the endpoint minimum with HTTP 400:
 * recent search accepts 10–100 and the user posts timeline accepts 5–100.
 * These tests stub the twitter-api-v2 client at the transport edge with a
 * recorder that enforces those ranges the way X does, then check that small
 * caller limits still send an accepted `max_results` and that the results are
 * trimmed back to the caller's limit.
 */
import { describe, expect, it } from "vitest";
import type { ClientBase } from "../base";
import { TwitterPostService } from "../services/PostService";
import type { TwitterAuth } from "./auth";
import { Client } from "./client";
import {
  SearchMode,
  searchProfiles,
  searchTweets,
  searchTweetsPage,
} from "./search";
import { fetchTweets, fetchTweetsAndReplies } from "./tweets";

type Params = { max_results?: number };

function tweetsPage(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    text: `tweet ${prefix}-${i}`,
    author_id: `author-${i}`,
    created_at: "2026-10-01T00:00:00.000Z",
  }));
}

function rejectOutOfRange(endpoint: string, params: Params, min: number) {
  const n = params.max_results;
  if (n !== undefined && (n < min || n > 100)) {
    throw new Error(
      `400 ${endpoint}: max_results must be between ${min} and 100, got ${n}`,
    );
  }
}

/**
 * Recent-search stub: records every params object, enforces 10–100, and serves
 * `pageSizes[i]` tweets on call i (12 when unspecified) with a next cursor.
 */
function recordingSearch(pageSizes: number[] = []) {
  const sent: Params[] = [];
  async function search(_query: string, params: Params) {
    sent.push({ ...params });
    rejectOutOfRange("search/recent", params, 10);
    const index = sent.length - 1;
    const tweets = tweetsPage(pageSizes[index] ?? 12, `s${index}`);
    return {
      tweets,
      includes: {
        users: tweets.map((tweet) => ({
          id: tweet.author_id,
          username: `user-${tweet.author_id}`,
          name: tweet.author_id,
        })),
      },
      meta: { next_token: `cursor-${index + 1}` },
      async *[Symbol.asyncIterator]() {
        yield* tweets;
      },
    };
  }
  return { sent, search };
}

/** User posts timeline stub: records params, enforces 5–100, serves 12 tweets. */
function recordingUserTimeline() {
  const sent: Params[] = [];
  async function userTimeline(_userId: string, params: Params) {
    sent.push({ ...params });
    rejectOutOfRange("users/:id/tweets", params, 5);
    const tweets = tweetsPage(12, `t${sent.length - 1}`);
    return {
      includes: undefined,
      meta: { next_token: `cursor-${sent.length}` },
      async *[Symbol.asyncIterator]() {
        yield* tweets;
      },
    };
  }
  return { sent, userTimeline };
}

function authWith(v2: Record<string, unknown>): TwitterAuth {
  const session = { client: "client-1", revision: 1 };
  return {
    getV2Client: async () => ({ v2 }),
    getAuthenticatedSession: async () => session,
    withAuthenticatedSession: async (
      operation: (current: unknown) => Promise<unknown>,
    ) => operation(session),
    isAuthenticatedSessionCurrent: () => true,
  } as unknown as TwitterAuth;
}

function clientWith(auth: TwitterAuth): Client {
  const client = new Client();
  (client as unknown as { auth: TwitterAuth }).auth = auth;
  return client;
}

describe("recent search sends max_results >= 10", () => {
  it("searchTweetsPage with limit 5 sends 10 and returns 5", async () => {
    const provider = recordingSearch();
    const result = await searchTweetsPage(
      "q",
      5,
      SearchMode.Latest,
      authWith({ search: provider.search }),
    );
    expect(provider.sent.map((p) => p.max_results)).toEqual([10]);
    expect(result.tweets).toHaveLength(5);
    expect(result.next).toBe("cursor-1");
  });

  it("searchTweetsPage keeps 10–100 limits and caps above 100", async () => {
    const provider = recordingSearch();
    const auth = authWith({ search: provider.search });
    await searchTweetsPage("q", 10, SearchMode.Latest, auth);
    await searchTweetsPage("q", 37, SearchMode.Latest, auth);
    await searchTweetsPage("q", 500, SearchMode.Latest, auth);
    expect(provider.sent.map((p) => p.max_results)).toEqual([10, 37, 100]);
  });

  it("searchTweets generator with limit 3 sends 10 and yields 3", async () => {
    const provider = recordingSearch();
    const ids: string[] = [];
    for await (const tweet of searchTweets(
      "q",
      3,
      SearchMode.Latest,
      authWith({ search: provider.search }),
    )) {
      ids.push(tweet.id ?? "");
    }
    expect(provider.sent.map((p) => p.max_results)).toEqual([10]);
    expect(ids).toHaveLength(3);
  });

  it("searchProfiles with 2 profiles sends 10 and returns 2", async () => {
    const provider = recordingSearch();
    const profiles: string[] = [];
    for await (const profile of searchProfiles(
      "q",
      2,
      authWith({ search: provider.search }),
    )) {
      profiles.push(profile.userId ?? "");
    }
    expect(provider.sent.map((p) => p.max_results)).toEqual([10]);
    expect(profiles).toHaveLength(2);
  });

  it("mentions follow-up page stays >= 10 (limit 25, first page 20) and returns 25", async () => {
    const provider = recordingSearch([20, 12]);
    const client = clientWith(authWith({ search: provider.search }));
    const base = {
      runtime: { agentId: "agent-1", reportError: () => {} },
      withAuthenticatedSession: async (
        operation: (session: unknown) => Promise<unknown>,
      ) => operation({ profile: { username: "agent" } }),
      fetchSearchTweets: (
        query: string,
        maxTweets: number,
        mode: SearchMode,
        cursor?: string,
      ) => client.fetchSearchTweets(query, maxTweets, mode, cursor),
    } as unknown as ClientBase;

    const posts = await new TwitterPostService(base).getMentions(
      "00000000-0000-0000-0000-000000000001",
      { limit: 25 },
    );

    expect(provider.sent).toHaveLength(2);
    expect(provider.sent[0].max_results).toBe(25);
    expect(provider.sent[1].max_results).toBeGreaterThanOrEqual(10);
    expect(posts).toHaveLength(25);
  });
});

describe("user posts timeline sends max_results >= 5", () => {
  it("Client.getUserTweets with limit 3 sends 5 and returns 3", async () => {
    const provider = recordingUserTimeline();
    const client = clientWith(
      authWith({ userTimeline: provider.userTimeline }),
    );
    const result = await client.getUserTweets("user-1", 3);
    expect(provider.sent.map((p) => p.max_results)).toEqual([5]);
    expect(result.tweets).toHaveLength(3);
  });

  it("Client.getUserTweetsIterator with limit 3 sends 5 and yields 3", async () => {
    const provider = recordingUserTimeline();
    const client = clientWith(
      authWith({ userTimeline: provider.userTimeline }),
    );
    const ids: string[] = [];
    for await (const tweet of client.getUserTweetsIterator("user-1", 3)) {
      ids.push(tweet.id ?? "");
    }
    expect(provider.sent.map((p) => p.max_results)).toEqual([5]);
    expect(ids).toHaveLength(3);
  });

  it("fetchTweets and fetchTweetsAndReplies with limit 3 send 5 and return 3", async () => {
    const provider = recordingUserTimeline();
    const auth = authWith({ userTimeline: provider.userTimeline });
    const own = await fetchTweets("user-1", 3, undefined, auth);
    const withReplies = await fetchTweetsAndReplies(
      "user-1",
      3,
      undefined,
      auth,
    );
    expect(provider.sent.map((p) => p.max_results)).toEqual([5, 5]);
    expect(own.tweets).toHaveLength(3);
    expect(withReplies.tweets).toHaveLength(3);
  });
});
