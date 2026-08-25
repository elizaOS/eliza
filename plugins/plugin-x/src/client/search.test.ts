import { describe, expect, it, vi } from "vitest";
import {
  SearchMode,
  searchProfiles,
  searchTweets,
  searchTweetsPage,
} from "./search";

/**
 * Boundary contract for the v2 recent-search `max_results` parameter.
 *
 * The X API v2 search endpoint only accepts `max_results` in [10, 100]
 * (HTTP 400 outside that range). The client currently forwards the caller's
 * raw count (`Math.min(maxTweets, 100)`), so any request for fewer than 10
 * results — including 0 or negative counts — is sent verbatim and rejected
 * by the API, turning a small bounded request into a total failure. These
 * tests pin the current degenerate passthrough (documented, not ideal) and
 * the failure mode it produces, so the boundary is visible to reviewers.
 */

/** Build an auth stub whose v2.search returns a fixed page payload. */
function makePageAuth(page: {
  tweets?: unknown[];
  includes?: unknown;
  meta?: { next_token?: string };
}) {
  const search = vi.fn(async () => page);
  const auth = {
    getV2Client: vi.fn(async () => ({ v2: { search } })),
  };
  return { auth, search };
}

/** Build an auth stub whose v2.search returns an async-iterable stream. */
function makeStreamAuth(tweets: unknown[], includes?: unknown) {
  const search = vi.fn(async () => ({
    includes,
    [Symbol.asyncIterator]: async function* () {
      for (const tweet of tweets) yield tweet;
    },
  }));
  const auth = {
    getV2Client: vi.fn(async () => ({ v2: { search } })),
  };
  return { auth, search };
}

const TWEET = (id: string) => ({
  id,
  text: `tweet ${id}`,
  author_id: "user-1",
  created_at: "2026-08-25T00:00:00.000Z",
  conversation_id: id,
});

describe("searchTweetsPage max_results passthrough", () => {
  it("forwards counts below the v2 minimum of 10 verbatim (degenerate)", async () => {
    const { auth, search } = makePageAuth({
      tweets: Array.from({ length: 10 }, (_, i) => TWEET(`t${i}`)),
      includes: {},
      meta: { next_token: "tok-1" },
    });
    const result = await searchTweetsPage("foo", 5, SearchMode.Latest, auth);
    // X API v2 rejects max_results < 10 with HTTP 400; the raw value is
    // forwarded today, so a 5-tweet request fails server-side.
    expect(search.mock.calls[0][1].max_results).toBe(5);
    expect(result.tweets.length).toBeLessThanOrEqual(5);
  });

  it("forwards non-positive counts verbatim (degenerate)", async () => {
    const { auth, search } = makePageAuth({
      tweets: Array.from({ length: 10 }, (_, i) => TWEET(`t${i}`)),
      includes: {},
    });
    const result = await searchTweetsPage("foo", 0, SearchMode.Latest, auth);
    expect(search.mock.calls[0][1].max_results).toBe(0);
    expect(result.tweets).toEqual([]);
  });

  it("caps counts at the v2 search maximum of 100", async () => {
    const { auth, search } = makePageAuth({
      tweets: Array.from({ length: 100 }, (_, i) => TWEET(`t${i}`)),
      includes: {},
    });
    await searchTweetsPage("foo", 250, SearchMode.Latest, auth);
    expect(search.mock.calls[0][1].max_results).toBe(100);
  });

  it("forwards a non-blank resume cursor as next_token", async () => {
    const { auth, search } = makePageAuth({
      tweets: [TWEET("t1")],
      includes: {},
      meta: { next_token: "tok-2" },
    });
    const result = await searchTweetsPage(
      "foo",
      20,
      SearchMode.Latest,
      auth,
      "tok-2",
    );
    expect(search.mock.calls[0][1].next_token).toBe("tok-2");
    expect(result.next).toBe("tok-2");
  });
});

describe("searchTweets generator max_results passthrough", () => {
  it("forwards sub-minimum counts verbatim in the generator (degenerate)", async () => {
    const { auth, search } = makeStreamAuth(
      Array.from({ length: 10 }, (_, i) => TWEET(`t${i}`)),
      {},
    );
    const collected = [];
    for await (const tweet of searchTweets("foo", 3, SearchMode.Latest, auth)) {
      collected.push(tweet);
    }
    expect(search.mock.calls[0][1].max_results).toBe(3);
    expect(collected.length).toBeLessThanOrEqual(3);
  });

  it("defaults undefined maxTweets to 100", async () => {
    const { auth, search } = makeStreamAuth([TWEET("t1")], {});
    for await (const _ of searchTweets(
      "foo",
      undefined,
      SearchMode.Latest,
      auth,
    )) {
      void _;
    }
    expect(search.mock.calls[0][1].max_results).toBe(100);
  });
});

describe("searchProfiles max_results passthrough", () => {
  it("forwards maxProfiles * 2 below the v2 minimum verbatim (degenerate)", async () => {
    const { auth, search } = makeStreamAuth([], { users: [] });
    for await (const _ of searchProfiles("foo", 1, auth)) {
      void _;
    }
    expect(search.mock.calls[0][1].max_results).toBe(2);
  });
});

describe("search failure mode for sub-minimum requests", () => {
  it("surfaces the API 400 as an ElizaError with query context", async () => {
    // Mirror the real API: reject max_results < 10 with HTTP 400.
    const search = vi.fn(
      async (query: string, opts: { max_results: number }) => {
        if (opts.max_results < 10) {
          throw new Error(
            "400 Bad Request: max_results must be between 10 and 100",
          );
        }
        return { tweets: [], includes: {}, meta: {} };
      },
    );
    const auth = { getV2Client: vi.fn(async () => ({ v2: { search } })) };
    await expect(
      searchTweetsPage("foo", 5, SearchMode.Latest, auth),
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "X_SEARCH_FAILED",
      context: { query: "foo", searchMode: SearchMode.Latest },
    });
  });
});
