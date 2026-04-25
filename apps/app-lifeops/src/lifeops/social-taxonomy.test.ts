import { describe, expect, it } from "vitest";
import { classifyScreenTimeTarget } from "./social-taxonomy.js";

describe("classifyScreenTimeTarget", () => {
  it("classifies browser YouTube sessions as social video", () => {
    expect(
      classifyScreenTimeTarget({
        source: "website",
        identifier: "youtube.com",
        displayName: "youtube.com",
        metadata: { browser: "Chrome", url: "https://www.youtube.com/watch" },
      }),
    ).toMatchObject({
      category: "video",
      device: "browser",
      service: "youtube",
      serviceLabel: "YouTube",
      browser: "Chrome",
    });
  });

  it("classifies Android X foreground usage as phone social time", () => {
    expect(
      classifyScreenTimeTarget({
        source: "app",
        identifier: "com.twitter.android",
        displayName: "X",
        metadata: { platform: "android", packageName: "com.twitter.android" },
      }),
    ).toMatchObject({
      category: "social",
      device: "phone",
      service: "x",
      serviceLabel: "X",
    });
  });
});
