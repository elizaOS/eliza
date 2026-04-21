import { describe, expect, it } from "vitest";
import {
  getLifeOpsBrowserCompanionPackageStatus,
  resolveLifeOpsBrowserCompanionPackagePath,
  resolveLifeOpsBrowserExtensionPath,
} from "../src/routes/lifeops-browser-packaging.js";

describe("LifeOps browser packaging helpers", () => {
  it("resolves the extension workspace from app-lifeops", () => {
    const extensionPath = resolveLifeOpsBrowserExtensionPath();
    expect(extensionPath).toContain(
      "/apps/app-lifeops/extensions/lifeops-browser",
    );
  });

  it("maps package targets to the matching status path", () => {
    const status = {
      extensionPath: "/tmp/lifeops",
      chromeBuildPath: "/tmp/lifeops/dist/chrome",
      chromePackagePath: "/tmp/lifeops/dist/chrome.zip",
      safariWebExtensionPath: "/tmp/lifeops/dist/safari",
      safariAppPath: "/tmp/lifeops/dist/LifeOps Browser.app",
      safariPackagePath: "/tmp/lifeops/dist/safari.zip",
      releaseManifest: null,
    };

    expect(
      resolveLifeOpsBrowserCompanionPackagePath(status, "extension_root"),
    ).toBe("/tmp/lifeops");
    expect(
      resolveLifeOpsBrowserCompanionPackagePath(status, "chrome_build"),
    ).toBe("/tmp/lifeops/dist/chrome");
    expect(
      resolveLifeOpsBrowserCompanionPackagePath(status, "chrome_package"),
    ).toBe("/tmp/lifeops/dist/chrome.zip");
    expect(
      resolveLifeOpsBrowserCompanionPackagePath(status, "safari_web_extension"),
    ).toBe("/tmp/lifeops/dist/safari");
    expect(
      resolveLifeOpsBrowserCompanionPackagePath(status, "safari_app"),
    ).toBe("/tmp/lifeops/dist/LifeOps Browser.app");
    expect(
      resolveLifeOpsBrowserCompanionPackagePath(status, "safari_package"),
    ).toBe("/tmp/lifeops/dist/safari.zip");
  });

  it("returns a package status even before the runtime is healthy", () => {
    const status = getLifeOpsBrowserCompanionPackageStatus();
    expect(status.extensionPath).toContain(
      "/apps/app-lifeops/extensions/lifeops-browser",
    );
    expect(status.releaseManifest).not.toBeNull();
  });
});
