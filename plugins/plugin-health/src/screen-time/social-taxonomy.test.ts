/**
 * Unit test for screen-time target classification (`classifyScreenTimeTarget`)
 * and `isSocialCategory`. Pure, deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  classifyScreenTimeTarget,
  isSocialCategory,
} from "./social-taxonomy.js";

describe("screen-time social taxonomy", () => {
  it("classifies social websites by hostname instead of substring", () => {
    expect(
      classifyScreenTimeTarget({
        source: "website",
        identifier: "https://mobile.twitter.com/home",
        displayName: "Home / X",
        metadata: { browser: "Safari" },
      }),
    ).toEqual({
      category: "social",
      device: "browser",
      service: "x",
      serviceLabel: "X",
      browser: "Safari",
    });

    expect(
      classifyScreenTimeTarget({
        source: "website",
        identifier: "https://twitterish.example",
        displayName: "Example",
      }).service,
    ).toBeNull();
  });

  it("classifies mobile app targets and social categories", () => {
    const result = classifyScreenTimeTarget({
      source: "app",
      identifier: "com.google.android.youtube",
      displayName: "YouTube",
      metadata: { platform: "android" },
    });

    expect(result.category).toBe("video");
    expect(result.device).toBe("phone");
    expect(result.service).toBe("youtube");
    expect(isSocialCategory(result.category)).toBe(true);
    expect(isSocialCategory("work")).toBe(false);
  });
});
