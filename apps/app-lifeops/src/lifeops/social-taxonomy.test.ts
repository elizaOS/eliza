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

  it("does not classify unrelated domains that merely contain social tokens", () => {
    expect(
      classifyScreenTimeTarget({
        source: "website",
        identifier: "examplex.com",
        displayName: "examplex.com",
        metadata: { browser: "Chrome", url: "https://examplex.com" },
      }),
    ).toMatchObject({
      category: "other",
      service: null,
    });

    expect(
      classifyScreenTimeTarget({
        source: "website",
        identifier: "slackline.example.com",
        displayName: "slackline.example.com",
        metadata: { url: "https://slackline.example.com" },
      }),
    ).toMatchObject({
      category: "other",
      service: null,
    });
  });

  it("does not classify app names as browsers through substring matches", () => {
    expect(
      classifyScreenTimeTarget({
        source: "app",
        identifier: "com.example.architecture",
        displayName: "Architecture Notes",
        metadata: {},
      }),
    ).toMatchObject({
      category: "other",
      browser: null,
    });
  });
});
