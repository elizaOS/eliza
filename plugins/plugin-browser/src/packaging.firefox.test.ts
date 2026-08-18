/**
 * Verifies the additive Firefox companion packaging contract without invoking host UI managers.
 */

import { describe, expect, it } from "vitest";
import { BROWSER_BRIDGE_KINDS } from "./contracts.js";
import {
  buildBrowserBridgeReleaseManifestForVersion,
  resolveBrowserBridgeCompanionPackagePath,
} from "./packaging.js";

describe("Firefox companion packaging", () => {
  it("advertises Firefox as a supported companion kind", () => {
    expect(BROWSER_BRIDGE_KINDS).toEqual(["chrome", "firefox", "safari"]);
  });

  it("emits an AMO-aware Firefox release target", () => {
    const manifest = buildBrowserBridgeReleaseManifestForVersion(
      "2.0.0-beta.2",
      {
        GITHUB_REPOSITORY: "elizaOS/eliza",
        ELIZA_BROWSER_BRIDGE_FIREFOX_ADDONS_URL:
          "https://addons.mozilla.org/firefox/addon/agent-browser-bridge/",
      },
    );

    expect(manifest?.firefox).toMatchObject({
      installKind: "firefox_addons",
      installUrl:
        "https://addons.mozilla.org/firefox/addon/agent-browser-bridge/",
      storeListingUrl:
        "https://addons.mozilla.org/firefox/addon/agent-browser-bridge/",
    });
    expect(manifest?.firefox.asset.fileName).toBe(
      "browser-bridge-firefox-v2.0.0-beta.2.zip",
    );
  });

  it("resolves Firefox build and archive paths independently", () => {
    const status = {
      extensionPath: "/extension",
      chromeBuildPath: null,
      chromePackagePath: null,
      firefoxBuildPath: "/extension/dist/firefox",
      firefoxPackagePath: "/extension/dist/artifacts/firefox.zip",
      safariWebExtensionPath: null,
      safariAppPath: null,
      safariPackagePath: null,
      releaseManifest: null,
    };

    expect(
      resolveBrowserBridgeCompanionPackagePath(status, "firefox_build"),
    ).toBe("/extension/dist/firefox");
    expect(
      resolveBrowserBridgeCompanionPackagePath(status, "firefox_package"),
    ).toBe("/extension/dist/artifacts/firefox.zip");
  });
});
