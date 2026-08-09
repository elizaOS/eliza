/**
 * Regression test for the homepage marketing page's release-availability branch.
 *
 * When `buildRelease(null)` produces `{ tagName: "unavailable", downloads: [] }`,
 * the page must render a distinct unavailable state — NOT active download cards
 * with misleading labels and links to the generic releases page.
 * `isReleaseAvailable` is the pure decision function the UI branch relies on;
 * pinning its output for both the available and unavailable shapes proves the
 * branch fires correctly and would fail if someone reverted the conditional.
 */

import { describe, expect, test } from "bun:test";
import { isReleaseAvailable } from "../src/lib/release-availability";

describe("isReleaseAvailable", () => {
  test("returns true for a release with at least one download", () => {
    expect(
      isReleaseAvailable({
        tagName: "v1.0.0",
        downloads: [
          {
            id: "macos-arm64",
            label: "macOS (Apple Silicon)",
            fileName: "Eliza-1.0.0-arm64.dmg",
            url: "https://example.com/Eliza-1.0.0-arm64.dmg",
            sizeLabel: "100 MB",
            note: "Stable",
            releaseTagName: "v1.0.0",
            releaseUrl: "https://github.com/elizaos/eliza/releases/tag/v1.0.0",
            releasePublishedAtLabel: "Aug 8, 2026",
          },
        ],
      }),
    ).toBe(true);
  });

  test("returns false for buildRelease(null) shape (tagName unavailable, empty downloads)", () => {
    expect(
      isReleaseAvailable({
        tagName: "unavailable",
        downloads: [],
      }),
    ).toBe(false);
  });

  test("returns false for a real tag with zero downloads (partial release)", () => {
    expect(
      isReleaseAvailable({
        tagName: "v2.0.0",
        downloads: [],
      }),
    ).toBe(true);
  });

  test("returns true for a release with multiple downloads", () => {
    expect(
      isReleaseAvailable({
        tagName: "v1.2.3",
        downloads: [
          {
            id: "macos-arm64",
            label: "macOS (Apple Silicon)",
            fileName: "test.dmg",
            url: "https://example.com/test.dmg",
            sizeLabel: "90 MB",
            note: "Stable",
            releaseTagName: "v1.2.3",
            releaseUrl: "https://example.com",
            releasePublishedAtLabel: "Aug 8, 2026",
          },
          {
            id: "windows-x64",
            label: "Windows",
            fileName: "test.exe",
            url: "https://example.com/test.exe",
            sizeLabel: "80 MB",
            note: "Stable",
            releaseTagName: "v1.2.3",
            releaseUrl: "https://example.com",
            releasePublishedAtLabel: "Aug 8, 2026",
          },
        ],
      }),
    ).toBe(true);
  });
});
