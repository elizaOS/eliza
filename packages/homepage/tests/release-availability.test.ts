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
  const completeDownloads = [
    "macos-arm64",
    "macos-x64",
    "windows-x64",
    "linux-x64",
    "android-apk",
  ].map((id) => ({
    id,
    label: id,
    fileName: `${id}.artifact`,
    url: `https://example.com/${id}.artifact`,
    sizeLabel: "100 MB",
    note: "Stable",
    releaseTagName: "v1.0.0",
    releaseUrl: "https://github.com/elizaos/eliza/releases/tag/v1.0.0",
    releasePublishedAtLabel: "Aug 8, 2026",
  }));

  test("returns false for a release with only one required download", () => {
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
    ).toBe(false);
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
    ).toBe(false);
  });

  test("returns false for the unavailable sentinel even if downloads are injected", () => {
    expect(
      isReleaseAvailable({
        tagName: "unavailable",
        downloads: completeDownloads,
      }),
    ).toBe(false);
  });

  test("returns true for a real release with every required download", () => {
    expect(
      isReleaseAvailable({
        tagName: "v1.2.3",
        downloads: completeDownloads,
      }),
    ).toBe(true);
  });
});
