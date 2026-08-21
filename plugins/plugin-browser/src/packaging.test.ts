/**
 * Verifies Firefox-aware package discovery, release metadata, and path routing.
 */

import { describe, expect, it } from "vitest";
import type { BrowserBridgeCompanionPackageStatus } from "./contracts.js";
import {
  browserBridgePackageContentType,
  buildBrowserBridgeReleaseManifestForVersion,
  resolveBrowserBridgeCompanionPackagePath,
} from "./packaging.js";

describe("browser bridge packaging", () => {
  it("publishes install metadata for Chrome, Firefox, and Safari", () => {
    const manifest = buildBrowserBridgeReleaseManifestForVersion(
      "2.0.3-beta.7",
      {
        GITHUB_REPOSITORY: "elizaOS/eliza",
        ELIZA_BROWSER_BRIDGE_CHROME_STORE_URL:
          "https://chromewebstore.google.com/detail/eliza/test",
        ELIZA_BROWSER_BRIDGE_FIREFOX_ADDONS_URL:
          "https://addons.mozilla.org/firefox/addon/eliza/",
        ELIZA_BROWSER_BRIDGE_SAFARI_STORE_URL:
          "https://apps.apple.com/app/eliza/id1",
      },
    );

    expect(manifest).toMatchObject({
      releaseTag: "v2.0.3-beta.7",
      firefoxVersion: "2.0.3-beta.7",
      firefox: {
        installKind: "firefox_addons",
        installUrl: "https://addons.mozilla.org/firefox/addon/eliza/",
        asset: {
          fileName: "browser-bridge-firefox-v2.0.3-beta.7.xpi",
          sha256: null,
        },
      },
    });
  });

  it("routes Firefox build and package targets without Chrome fallback", () => {
    const status = {
      extensionPath: "/extension",
      chromeBuildPath: "/extension/dist/chrome",
      chromePackagePath: "/extension/dist/artifacts/chrome.zip",
      firefoxBuildPath: "/extension/dist/firefox",
      firefoxPackagePath: "/extension/dist/artifacts/firefox.xpi",
      safariWebExtensionPath: "/extension/dist/safari",
      safariAppPath: "/extension/dist/artifacts/safari.app",
      safariPackagePath: "/extension/dist/artifacts/safari.zip",
      releaseManifest: null,
    } satisfies BrowserBridgeCompanionPackageStatus;

    expect(
      resolveBrowserBridgeCompanionPackagePath(status, "firefox_build"),
    ).toBe("/extension/dist/firefox");
    expect(
      resolveBrowserBridgeCompanionPackagePath(status, "firefox_package"),
    ).toBe("/extension/dist/artifacts/firefox.xpi");
    expect(browserBridgePackageContentType("firefox")).toBe(
      "application/x-xpinstall",
    );
    expect(browserBridgePackageContentType("chrome")).toBe("application/zip");
  });
});
