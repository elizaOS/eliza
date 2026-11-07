/**
 * X API v2 truncates posts longer than 280 characters in `text` and returns
 * the full body in `note_tweet.text` when the `note_tweet` field is requested.
 * These tests stub the twitter-api-v2 client at the transport edge and check
 * that search and the v2-to-v1 parser carry the full body through.
 */
import type { TweetV2 } from "twitter-api-v2";
import { describe, expect, it } from "vitest";
import type { TwitterAuth } from "./auth";
import { SearchMode, searchTweetsPage } from "./search";
import { parseTweetV2ToV1 } from "./tweets";

const LONG_BODY = `${"Long post that keeps going past the old limit. ".repeat(8)}The final clause the agent must see.`;
const TRUNCATED = `${LONG_BODY.slice(0, 270)}… https://t.co/abc`;

type SearchParams = { "tweet.fields"?: string[] };

function recordingSearch(tweets: TweetV2[], includedTweets: TweetV2[] = []) {
  const sent: SearchParams[] = [];
  async function search(_query: string, params: SearchParams) {
    sent.push({ ...params });
    return {
      tweets,
      includes: {
        users: [{ id: "author-1", username: "poster", name: "Poster" }],
        tweets: includedTweets,
      },
      meta: {},
    };
  }
  return { sent, search };
}

function authWith(v2: Record<string, unknown>): TwitterAuth {
  return { getV2Client: async () => ({ v2 }) } as unknown as TwitterAuth;
}

describe("note_tweet full text", () => {
  it("search requests note_tweet and returns the full body", async () => {
    const provider = recordingSearch([
      {
        id: "1",
        text: TRUNCATED,
        author_id: "author-1",
        note_tweet: { text: LONG_BODY },
      } as TweetV2,
    ]);
    const result = await searchTweetsPage(
      "@agent",
      10,
      SearchMode.Latest,
      authWith({ search: provider.search }),
    );
    expect(provider.sent[0]["tweet.fields"]).toContain("note_tweet");
    expect(result.tweets[0].text).toBe(LONG_BODY);
  });

  it("search returns the full body of a long reply parent", async () => {
    const provider = recordingSearch(
      [
        {
          id: "2",
          text: "@poster agreed",
          author_id: "author-2",
          referenced_tweets: [{ type: "replied_to", id: "1" }],
        } as TweetV2,
      ],
      [
        {
          id: "1",
          text: TRUNCATED,
          author_id: "author-1",
          note_tweet: { text: LONG_BODY },
        } as TweetV2,
      ],
    );
    const result = await searchTweetsPage(
      "@agent",
      10,
      SearchMode.Latest,
      authWith({ search: provider.search }),
    );
    expect(result.tweets[0].text).toBe("@poster agreed");
    expect(result.tweets[0].inReplyToStatus?.text).toBe(LONG_BODY);
  });

  it("search leaves a short post unchanged", async () => {
    const provider = recordingSearch([
      { id: "3", text: "short post", author_id: "author-1" } as TweetV2,
    ]);
    const result = await searchTweetsPage(
      "@agent",
      10,
      SearchMode.Latest,
      authWith({ search: provider.search }),
    );
    expect(result.tweets[0].text).toBe("short post");
  });

  it("parseTweetV2ToV1 prefers note_tweet.text", () => {
    expect(
      parseTweetV2ToV1({
        id: "1",
        text: TRUNCATED,
        note_tweet: { text: LONG_BODY },
      } as TweetV2).text,
    ).toBe(LONG_BODY);
    expect(parseTweetV2ToV1({ id: "3", text: "short" } as TweetV2).text).toBe(
      "short",
    );
  });
});
