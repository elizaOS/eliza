/**
 * Tests the pure unavailable-release payload contract used by the homepage CI
 * checker, including contradictory and malformed generated states.
 */

import { describe, expect, it } from "vitest";
import { unavailableReleaseFinding } from "../lib/homepage-release-validation.mjs";

describe("unavailableReleaseFinding", () => {
  const unavailableRelease = {
    publishedAtLabel: "unavailable",
    prerelease: false,
    url: "https://github.com/elizaos/eliza/releases",
    downloads: [],
    checksum: null,
  };

  it("accepts the exact empty unavailable shape", () => {
    expect(unavailableReleaseFinding(unavailableRelease)).toBeNull();
  });

  it("rejects a missing downloads array", () => {
    expect(
      unavailableReleaseFinding({
        ...unavailableRelease,
        downloads: undefined,
      })?.message,
    ).toContain("empty downloads array");
  });

  it("rejects injected downloads and reports their ids", () => {
    expect(
      unavailableReleaseFinding({
        ...unavailableRelease,
        downloads: [{ id: "windows-x64" }],
      }),
    ).toEqual({
      message: "unavailable release must not contain downloadable artifacts",
      details: ["found ids: windows-x64"],
    });
  });

  it("rejects a checksum on an unavailable release", () => {
    expect(
      unavailableReleaseFinding({
        ...unavailableRelease,
        checksum: { fileName: "SHA256SUMS.txt" },
      })?.message,
    ).toContain("must not contain a checksum");
  });

  it("rejects noncanonical metadata and fallback links", () => {
    expect(
      unavailableReleaseFinding({
        ...unavailableRelease,
        publishedAtLabel: "Aug 8, 2026",
      })?.message,
    ).toContain("canonical publication metadata");
    expect(
      unavailableReleaseFinding({
        ...unavailableRelease,
        url: "https://example.com/releases",
      })?.message,
    ).toContain("canonical releases page");
  });
});
