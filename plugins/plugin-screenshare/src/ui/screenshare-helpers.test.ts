// Coverage for buildViewerUrl's base-URL normalization. The trailing-slash trim
// used a `/\/+$/` regex that was O(n²) on a base URL ending in a long slash run
// followed by another character; it is now a linear scan. These tests pin the
// trim result and prove the pathological input completes in linear time.

import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: vi.fn(() => ""),
    getRestAuthToken: vi.fn(() => "rest-token"),
  },
}));

import { buildViewerUrl } from "./screenshare-helpers";

describe("buildViewerUrl", () => {
  it("strips trailing slashes from the remote base", () => {
    const url = buildViewerUrl({
      baseUrl: "http://host////",
      sessionId: "s1",
      token: "t1",
    });
    expect(url.startsWith("http://host/api/apps/screenshare/viewer")).toBe(
      true,
    );
    expect(url).not.toContain("host////");
  });

  it("keeps a base with no trailing slash intact", () => {
    const url = buildViewerUrl({
      baseUrl: "http://host",
      sessionId: "s1",
      token: "t1",
    });
    expect(url.startsWith("http://host/api/apps/screenshare/viewer")).toBe(
      true,
    );
  });

  it("is linear on a long interior slash run (ReDoS input)", () => {
    // The old /\/+$/ regex was O(n²) here; a non-slash tail means nothing is
    // stripped, but the regex still rescanned the run from every offset.
    const evil = `http://a${"/".repeat(200_000)}b`;
    const start = performance.now();
    const url = buildViewerUrl({ baseUrl: evil, sessionId: "s", token: "t" });
    const elapsed = performance.now() - start;
    expect(url).toContain("/api/apps/screenshare/viewer");
    expect(elapsed).toBeLessThan(1000);
  });
});
