/**
 * Coverage for feature-flags.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  isCloudWalletEnabled,
  isLegacyAppsWorkspaceDiscoveryEnabled,
} from "./feature-flags.js";

describe("feature-flags", () => {
  const origCloud = process.env.ENABLE_CLOUD_WALLET;
  const origLegacy = process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
  afterEach(() => {
    if (origCloud === undefined) delete process.env.ENABLE_CLOUD_WALLET;
    else process.env.ENABLE_CLOUD_WALLET = origCloud;
    if (origLegacy === undefined)
      delete process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY;
    else process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY = origLegacy;
  });
  it("isCloudWalletEnabled respects 1/true", () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    expect(isCloudWalletEnabled()).toBe(true);
    process.env.ENABLE_CLOUD_WALLET = "true";
    expect(isCloudWalletEnabled()).toBe(true);
    process.env.ENABLE_CLOUD_WALLET = "false";
    expect(isCloudWalletEnabled()).toBe(false);
    delete process.env.ENABLE_CLOUD_WALLET;
    expect(isCloudWalletEnabled()).toBe(false);
  });
  it("legacy flag respects env", () => {
    process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY = "yes";
    expect(isLegacyAppsWorkspaceDiscoveryEnabled()).toBe(true);
    process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY = "0";
    expect(isLegacyAppsWorkspaceDiscoveryEnabled()).toBe(false);
  });
});
