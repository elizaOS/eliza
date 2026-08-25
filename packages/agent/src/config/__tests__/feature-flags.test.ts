import { afterEach, describe, expect, it } from "vitest";
import {
  isCloudWalletEnabled,
  isLegacyAppsWorkspaceDiscoveryEnabled,
} from "../feature-flags.ts";

const KEYS = [
  "ENABLE_CLOUD_WALLET",
  "ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY",
];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("isCloudWalletEnabled", () => {
  it("is false by default", () => {
    expect(isCloudWalletEnabled()).toBe(false);
  });

  it("reads truthy values", () => {
    for (const v of ["1", "true", "yes", "on", " TRUE "]) {
      process.env.ENABLE_CLOUD_WALLET = v;
      expect(isCloudWalletEnabled()).toBe(true);
    }
  });

  it("reads falsy values", () => {
    process.env.ENABLE_CLOUD_WALLET = "0";
    expect(isCloudWalletEnabled()).toBe(false);
  });

  it("falls back on unrecognized values", () => {
    process.env.ENABLE_CLOUD_WALLET = "maybe";
    expect(isCloudWalletEnabled()).toBe(false);
  });
});

describe("isLegacyAppsWorkspaceDiscoveryEnabled", () => {
  it("is false by default", () => {
    expect(isLegacyAppsWorkspaceDiscoveryEnabled()).toBe(false);
  });

  it("enables with the flag", () => {
    process.env.ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY = "1";
    expect(isLegacyAppsWorkspaceDiscoveryEnabled()).toBe(true);
  });
});
