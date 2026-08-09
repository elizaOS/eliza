/**
 * Regression tests for the homepage release-data generator's selection logic.
 *
 * The generator's `pickStableRelease()` / `pickRelease()` previously selected
 * internal CI evidence releases (the `pr-evidence` tag family) as the public
 * "Latest release" when they were mis-flagged as non-prerelease with
 * non-empty asset arrays. These cases pin the fix from #18073: internal
 * releases are excluded and a usable product release requires installer assets.
 */
import { describe, expect, it } from "vitest";
import {
  hasDownloadableRelease,
  hasInstallerAsset,
  isInternalRelease,
  pickRelease,
  pickStableRelease,
} from "../write-homepage-release-data.mjs";

function makeAsset(name: string, size = 1024) {
  return { name, size, browser_download_url: `https://example.com/${name}` };
}

function makeRelease(opts: {
  tag_name: string;
  name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  assets?: ReturnType<typeof makeAsset>[];
}) {
  return {
    tag_name: opts.tag_name,
    name: opts.name ?? opts.tag_name,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    published_at: opts.published_at ?? "2026-07-01T00:00:00Z",
    html_url: `https://github.com/elizaOS/eliza/releases/tag/${opts.tag_name}`,
    assets: opts.assets ?? [],
  };
}

const evidenceAssets = [
  makeAsset("evidence-1.json"),
  makeAsset("evidence-2.txt"),
  makeAsset("screenshot-1.png"),
];

/** A complete set of platform installer assets that resolves all five
 * required download IDs from buildRelease(): macos-arm64, macos-x64,
 * windows-x64, linux-x64, android-apk. */
const installerAssets = [
  makeAsset("ElizaOSApp-1.0.0-macos-arm64.dmg"),
  makeAsset("ElizaOSApp-1.0.0-macos-x64.dmg"),
  makeAsset("ElizaOSApp-Setup-1.0.0.exe"),
  makeAsset("elizaos-1.0.0-linux.AppImage"),
  makeAsset("Eliza-1.0.0.apk"),
];

describe("isInternalRelease", () => {
  it("detects pr-evidence tag family", () => {
    expect(
      isInternalRelease(
        makeRelease({
          tag_name: "pr-evidence-4",
          name: "[internal] CI evidence asset store (part 4)",
        }),
      ),
    ).toBe(true);
  });

  it("detects [internal] name prefix", () => {
    expect(
      isInternalRelease(
        makeRelease({
          tag_name: "some-other-tag",
          name: "[internal] infrastructure release",
        }),
      ),
    ).toBe(true);
  });

  it("does not flag a normal product release", () => {
    expect(
      isInternalRelease(
        makeRelease({ tag_name: "v1.0.0", name: "Eliza v1.0.0" }),
      ),
    ).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(isInternalRelease(null)).toBe(false);
    expect(isInternalRelease(undefined)).toBe(false);
  });
});

describe("hasInstallerAsset", () => {
  it("detects real installer assets", () => {
    const release = makeRelease({
      tag_name: "v1.0.0",
      assets: installerAssets,
    });
    expect(hasInstallerAsset(release)).toBe(true);
  });

  it("rejects releases with only CI evidence files", () => {
    const release = makeRelease({
      tag_name: "pr-evidence-4",
      assets: evidenceAssets,
    });
    expect(hasInstallerAsset(release)).toBe(false);
  });

  it("rejects releases with arbitrary non-installer assets", () => {
    const release = makeRelease({
      tag_name: "v1.0.0",
      assets: [makeAsset("changelog.txt"), makeAsset("README.md")],
    });
    expect(hasInstallerAsset(release)).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(hasInstallerAsset(null)).toBe(false);
    expect(hasInstallerAsset(undefined)).toBe(false);
  });
});

describe("pickStableRelease — internal release exclusion", () => {
  it("excludes a newer non-prerelease internal evidence release, selects older valid release", () => {
    const releases = [
      makeRelease({
        tag_name: "pr-evidence-4",
        name: "[internal] CI evidence asset store (part 4)",
        prerelease: false,
        published_at: "2026-07-31T19:34:10Z",
        assets: evidenceAssets,
      }),
      makeRelease({
        tag_name: "v1.0.0",
        prerelease: false,
        published_at: "2026-06-15T10:00:00Z",
        assets: installerAssets,
      }),
    ];
    const picked = pickStableRelease(releases);
    expect(picked).not.toBeNull();
    expect(picked?.tag_name).toBe("v1.0.0");
  });

  it("prefers a release with installer assets over one with arbitrary assets", () => {
    const releases = [
      makeRelease({
        tag_name: "v0.9.0",
        prerelease: false,
        published_at: "2026-07-20T00:00:00Z",
        assets: [makeAsset("notes.txt"), makeAsset("logo.png")],
      }),
      makeRelease({
        tag_name: "v1.0.0",
        prerelease: false,
        published_at: "2026-06-01T00:00:00Z",
        assets: installerAssets,
      }),
    ];
    const picked = pickStableRelease(releases);
    expect(picked).not.toBeNull();
    expect(picked?.tag_name).toBe("v1.0.0");
  });

  it("returns null when only internal releases exist (renders unavailable state)", () => {
    const releases = [
      makeRelease({
        tag_name: "pr-evidence-1",
        name: "[internal] CI evidence (part 1)",
        prerelease: true,
        published_at: "2026-07-28T00:00:00Z",
        assets: evidenceAssets,
      }),
      makeRelease({
        tag_name: "pr-evidence-4",
        name: "[internal] CI evidence asset store (part 4)",
        prerelease: false,
        published_at: "2026-07-31T19:34:10Z",
        assets: evidenceAssets,
      }),
    ];
    const picked = pickStableRelease(releases);
    expect(picked).toBeNull();
  });

  it("selects a valid product release with installer assets", () => {
    const releases = [
      makeRelease({
        tag_name: "v2.0.0",
        prerelease: false,
        published_at: "2026-08-01T00:00:00Z",
        assets: installerAssets,
      }),
    ];
    const picked = pickStableRelease(releases);
    expect(picked).not.toBeNull();
    expect(picked?.tag_name).toBe("v2.0.0");
  });
});

describe("pickRelease — general exclusion", () => {
  it("excludes internal releases from the general pick path", () => {
    const releases = [
      makeRelease({
        tag_name: "pr-evidence-4",
        name: "[internal] CI evidence asset store (part 4)",
        prerelease: false,
        published_at: "2026-07-31T00:00:00Z",
        assets: evidenceAssets,
      }),
      makeRelease({
        tag_name: "v1.2.0-beta",
        prerelease: true,
        published_at: "2026-07-15T00:00:00Z",
        assets: installerAssets,
      }),
    ];
    // pickRelease does not filter by prerelease; it should still skip internal.
    const picked = pickRelease(releases);
    expect(picked).not.toBeNull();
    expect(picked?.tag_name).toBe("v1.2.0-beta");
  });
});

describe("hasDownloadableRelease — buildRelease integration", () => {
  it("returns true for a release with correctly named installer assets", () => {
    const release = makeRelease({
      tag_name: "v1.0.0",
      assets: [
        makeAsset("ElizaOSApp-1.0.0-macos-arm64.dmg"),
        makeAsset("ElizaOSApp-1.0.0-macos-x64.dmg"),
        makeAsset("ElizaOSApp-Setup-1.0.0.exe"),
        makeAsset("elizaos-1.0.0-linux.AppImage"),
        makeAsset("Eliza-1.0.0.apk"),
      ],
    });
    expect(hasDownloadableRelease(release)).toBe(true);
  });

  it("returns false for a release with only a loosely-named .dmg that buildRelease rejects", () => {
    // This is the RP round 2 shadowing scenario: only-one.dmg passes
    // hasInstallerAsset but produces 0 downloads from buildRelease.
    const release = makeRelease({
      tag_name: "v2.0.0",
      assets: [makeAsset("only-one.dmg")],
    });
    expect(hasInstallerAsset(release)).toBe(true);
    expect(hasDownloadableRelease(release)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(hasDownloadableRelease(null)).toBe(false);
    expect(hasDownloadableRelease(undefined)).toBe(false);
  });
});

describe("pickStableRelease — shadowing edge case (RP round 2)", () => {
  it("skips a newer release with loose installer-like asset, selects older release with real downloads", () => {
    // newer v2 has only-one.dmg (passes hasInstallerAsset, but buildRelease
    // produces 0 downloads). Older v1 has correctly named installers.
    const releases = [
      makeRelease({
        tag_name: "v2.0.0",
        prerelease: false,
        published_at: "2026-08-01T00:00:00Z",
        assets: [makeAsset("only-one.dmg")],
      }),
      makeRelease({
        tag_name: "v1.0.0",
        prerelease: false,
        published_at: "2026-06-01T00:00:00Z",
        assets: [
          makeAsset("ElizaOSApp-1.0.0-macos-arm64.dmg"),
          makeAsset("ElizaOSApp-1.0.0-macos-x64.dmg"),
          makeAsset("ElizaOSApp-Setup-1.0.0.exe"),
          makeAsset("elizaos-1.0.0-linux.AppImage"),
          makeAsset("Eliza-1.0.0.apk"),
        ],
      }),
    ];
    const picked = pickStableRelease(releases);
    expect(picked).not.toBeNull();
    expect(picked?.tag_name).toBe("v1.0.0");
  });
});

describe("pickStableRelease — newer incomplete release shadows older complete (standujar review #18100)", () => {
  // The standujar review on #18100 proved that hasDownloadableRelease() was
  // too permissive: returning true for any release where buildRelease()
  // resolved even ONE download. This let a newer release with only a subset
  // of the required installer set shadow an older release with all five.
  // The fix aligns the predicate with check-homepage-release-data.mjs's
  // REQUIRED_IDS: macos-arm64, macos-x64, windows-x64, linux-x64, android-apk.

  /** All five required platform assets for a complete release. */
  const completeAssets = [
    makeAsset("ElizaOSApp-1.5.0-macos-arm64.dmg"),
    makeAsset("ElizaOSApp-1.5.0-macos-x64.dmg"),
    makeAsset("ElizaOSApp-Setup-1.5.0.exe"),
    makeAsset("elizaos-1.5.0-linux.AppImage"),
    makeAsset("Eliza-1.5.0.apk"),
  ];

  it("does NOT select a newer partial release (1 of 5 assets) over an older complete one (5 of 5)", () => {
    const releases = [
      // Newer release: only the Windows installer. Recognized as real, but
      // incomplete — 1 of 5 required IDs.
      makeRelease({
        tag_name: "v2.0.0",
        prerelease: false,
        published_at: "2026-08-05T00:00:00Z",
        assets: [makeAsset("ElizaOSApp-Setup-2.0.0.exe")],
      }),
      // Older release: all five required assets — the complete product.
      makeRelease({
        tag_name: "v1.5.0",
        prerelease: false,
        published_at: "2026-07-01T00:00:00Z",
        assets: completeAssets,
      }),
    ];
    const picked = pickStableRelease(releases);
    expect(picked).not.toBeNull();
    expect(picked?.tag_name).toBe("v1.5.0");
  });

  it("hasDownloadableRelease returns false for a release missing required IDs", () => {
    const partial = makeRelease({
      tag_name: "v2.0.0",
      assets: [makeAsset("ElizaOSApp-Setup-2.0.0.exe")],
    });
    expect(hasDownloadableRelease(partial)).toBe(false);
  });

  it("hasDownloadableRelease returns true for a release with all five required IDs", () => {
    const complete = makeRelease({
      tag_name: "v1.5.0",
      assets: completeAssets,
    });
    expect(hasDownloadableRelease(complete)).toBe(true);
  });
});
