import { describe, expect, it } from "bun:test";
import { getHomeFeedUrl } from "./HomePageClient";

describe("getHomeFeedUrl", () => {
  it("returns /feed when no referral code is present", () => {
    expect(getHomeFeedUrl(new URLSearchParams())).toBe("/feed");
  });

  it("preserves and encodes the referral code when present", () => {
    const searchParams = new URLSearchParams({
      ref: "hello world+vip",
    });

    expect(getHomeFeedUrl(searchParams)).toBe("/feed?ref=hello%20world%2Bvip");
  });
});
