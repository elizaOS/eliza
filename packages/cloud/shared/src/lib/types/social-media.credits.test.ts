// Exercises social media.credits behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import { calculatePostCredits, type MediaAttachment, type SocialPlatform } from "./social-media";

/**
 * Tests for the post-credit pricing math (#8801 / #9943). calculatePostCredits
 * is finance-critical (it sets what a user is charged) and was untested — the
 * per-platform multipliers, the per-media surcharge, and the ceil rounding all
 * matter and are now pinned.
 */
const p = (...platforms: SocialPlatform[]): SocialPlatform[] => platforms;
const media = (n: number): MediaAttachment[] =>
  Array.from({ length: n }, () => ({ type: "image" as const, mimeType: "image/png" }));

describe("calculatePostCredits", () => {
  test("a single default-multiplier platform costs the base 10", () => {
    expect(calculatePostCredits(p("twitter"), {})).toBe(10);
  });

  test("applies the per-platform multiplier (tiktok 2x, instagram/linkedin 1.5x)", () => {
    expect(calculatePostCredits(p("tiktok"), {})).toBe(20);
    expect(calculatePostCredits(p("instagram"), {})).toBe(15);
    expect(calculatePostCredits(p("linkedin"), {})).toBe(15);
  });

  test("adds 5 credits per media attachment to the base before the multiplier", () => {
    expect(calculatePostCredits(p("twitter"), { media: media(2) })).toBe(20); // (10+10)*1
    expect(calculatePostCredits(p("tiktok"), { media: media(2) })).toBe(40); // (10+10)*2
  });

  test("ceil-rounds the per-platform subtotal", () => {
    // (10 + 1*5) * 1.5 = 22.5 -> 23
    expect(calculatePostCredits(p("instagram"), { media: media(1) })).toBe(23);
  });

  test("sums across multiple platforms", () => {
    expect(calculatePostCredits(p("twitter", "tiktok"), {})).toBe(30); // 10 + 20
  });

  test("an empty platform list costs nothing", () => {
    expect(calculatePostCredits(p(), { media: media(3) })).toBe(0);
  });
});
