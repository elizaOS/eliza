import { describe, expect, it } from "vitest";
import {
  buildBrowserBridgeReleaseMetadata,
  buildChromeExtensionVersion,
  buildGitHubReleaseAssetDownloadUrl,
  buildGitHubReleasePageUrl,
  buildSafariExtensionVersions,
  parseReleaseVersion,
  resolveBrowserBridgeReleaseRepository,
  resolveBrowserBridgeStoreUrls,
  versionedArtifactName,
} from "./release-version.mjs";

describe("Agent Browser Bridge release versioning", () => {
  it("maps prerelease versions into Chrome-compatible manifest versions", () => {
    expect(
      buildChromeExtensionVersion(parseReleaseVersion("2.0.0-alpha.116")),
    ).toBe("2.0.0.30116");
    expect(
      buildChromeExtensionVersion(parseReleaseVersion("2.0.0-beta.2")),
    ).toBe("2.0.0.40002");
    expect(buildChromeExtensionVersion(parseReleaseVersion("2.0.0-rc.1"))).toBe(
      "2.0.0.50001",
    );
    expect(buildChromeExtensionVersion(parseReleaseVersion("2.0.0"))).toBe(
      "2.0.0.60000",
    );
  });

  it("maps nightly prerelease dates into bounded numeric build identifiers", () => {
    const metadata = buildBrowserBridgeReleaseMetadata(
      parseReleaseVersion("2.0.0-nightly.20260411"),
    );

    expect(metadata.chromeVersion).toBe("2.0.0.12293");
    expect(metadata.safariBuildVersion).toBe("200007293");
  });

  it("derives Safari marketing and build versions from tagged releases", () => {
    expect(buildSafariExtensionVersions(parseReleaseVersion("2.1.3"))).toEqual({
      marketingVersion: "2.1.3",
      buildVersion: "201039000",
    });
    expect(
      buildSafariExtensionVersions(parseReleaseVersion("2.1.3-alpha.4")),
    ).toEqual({
      marketingVersion: "2.1.3",
      buildVersion: "201036004",
    });
  });

  it("creates versioned artifact names using the release tag", () => {
    const release = parseReleaseVersion("2.0.0-alpha.116");
    expect(versionedArtifactName("browser-bridge-chrome", "zip", release)).toBe(
      "browser-bridge-chrome-v2.0.0-alpha.116.zip",
    );
  });

  it("builds portable GitHub release URLs from repository metadata", () => {
    const release = parseReleaseVersion("2.0.0");

    expect(buildGitHubReleasePageUrl("elizaos/eliza", release)).toBe(
      "https://github.com/elizaos/eliza/releases/tag/v2.0.0",
    );
    expect(
      buildGitHubReleaseAssetDownloadUrl(
        "elizaos/eliza",
        release,
        "browser-bridge-chrome-v2.0.0.zip",
      ),
    ).toBe(
      "https://github.com/elizaos/eliza/releases/download/v2.0.0/browser-bridge-chrome-v2.0.0.zip",
    );
  });

  it("reads repository and optional store URLs from the environment", () => {
    expect(
      resolveBrowserBridgeReleaseRepository({
        GITHUB_REPOSITORY: "elizaos/custom",
      }),
    ).toBe("elizaos/custom");
    expect(
      resolveBrowserBridgeReleaseRepository({
        GITHUB_REPOSITORY: "   ",
      }),
    ).toBe("elizaos/eliza");
    expect(
      resolveBrowserBridgeStoreUrls({
        ELIZA_BROWSER_BRIDGE_CHROME_STORE_URL:
          "https://chromewebstore.google.com/detail/agent-browser-bridge/example",
        ELIZA_BROWSER_BRIDGE_SAFARI_STORE_URL:
          "https://apps.apple.com/us/app/agent-browser-bridge/id1234567890",
      }),
    ).toEqual({
      chromeWebStoreUrl:
        "https://chromewebstore.google.com/detail/agent-browser-bridge/example",
      safariAppStoreUrl:
        "https://apps.apple.com/us/app/agent-browser-bridge/id1234567890",
    });
  });
});
