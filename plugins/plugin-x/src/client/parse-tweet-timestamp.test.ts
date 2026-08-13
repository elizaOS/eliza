/**
 * Unit tests for `parseTweetV2ToV1` timestamp conversion. Deterministic:
 * no network. Proves invalid `created_at` stays non-finite so `getEpochMs`
 * can fail closed instead of treating the tweet as just posted.
 */

import type { TweetV2 } from "twitter-api-v2";
import { describe, expect, it } from "vitest";
import { getEpochMs, isInvalidTweetTimestamp } from "../utils/time";
import { parseTweetV2ToV1 } from "./tweets";

function tweetV2(createdAt?: string): TweetV2 {
  return {
    id: "123",
    text: "hello",
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
  } as TweetV2;
}

describe("parseTweetV2ToV1 timestamps", () => {
  it("stores a valid created_at as Unix seconds that getEpochMs lifts to ms", () => {
    const tweet = parseTweetV2ToV1(tweetV2("2024-03-20T18:40:00.000Z"));
    expect(tweet.timestamp).toBe(1_710_960_000);
    expect(getEpochMs(tweet.timestamp)).toBe(1_710_960_000_000);
  });

  it("keeps an invalid created_at non-finite so age filters skip it", () => {
    const tweet = parseTweetV2ToV1(tweetV2("not-a-date"));
    expect(Number.isFinite(tweet.timestamp)).toBe(false);
    expect(isInvalidTweetTimestamp(tweet.timestamp)).toBe(true);
    expect(() => getEpochMs(tweet.timestamp)).toThrow(
      /Invalid tweet timestamp/,
    );
  });
});
