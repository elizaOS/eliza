/**
 * Coverage for twitter-api.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./owned-bounded-fetch", () => ({
  ownedBoundedFetch: vi.fn(
    async (input) => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ),
}));

import { TWITTER_API_BASE, TWITTER_REQUEST_TIMEOUT_MS, twitterFetch } from "./twitter-api.js";

describe("twitter-api", () => {
  it("exposes bases", () => {
    expect(TWITTER_API_BASE).toBe("https://api.twitter.com/2");
    expect(TWITTER_REQUEST_TIMEOUT_MS).toBe(30000);
  });
  it("twitterFetch delegates", async () => {
    const res = await twitterFetch("https://api.twitter.com/2/tweets");
    expect(res.status).toBe(200);
  });
});
