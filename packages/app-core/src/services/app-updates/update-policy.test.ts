import { describe, expect, it } from "vitest";
import {
  mapAgentUpdateStatusToSnapshot,
  resolveAppUpdatePolicy,
} from "./update-policy";

describe("resolveAppUpdatePolicy", () => {
  it("allows forced GitHub auto-update only for direct desktop builds", () => {
    expect(
      resolveAppUpdatePolicy({
        platform: "desktop",
        native: true,
        buildVariant: "direct",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "desktop-direct",
      authority: "github",
      canAutoUpdate: true,
      canManualCheck: true,
    });

    expect(
      resolveAppUpdatePolicy({
        platform: "desktop",
        native: true,
        buildVariant: "store",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "desktop-store",
      authority: "store",
      canAutoUpdate: false,
      canManualCheck: false,
    });
  });

  it("keeps App Store and Play builds store-managed", () => {
    expect(
      resolveAppUpdatePolicy({
        platform: "ios",
        native: true,
        buildVariant: "store",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "ios-app-store",
      authority: "store",
      canAutoUpdate: false,
    });

    expect(
      resolveAppUpdatePolicy({
        platform: "android",
        native: true,
        buildVariant: "store",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "android-google-play",
      authority: "store",
      canAutoUpdate: false,
    });
  });

  it("distinguishes Android sideload from AOSP system distribution", () => {
    expect(
      resolveAppUpdatePolicy({
        platform: "android",
        native: true,
        buildVariant: "direct",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "android-sideload",
      authority: "github",
      canAutoUpdate: false,
    });

    expect(
      resolveAppUpdatePolicy({
        platform: "android",
        native: true,
        buildVariant: "direct",
        elizaOS: true,
      }),
    ).toMatchObject({
      channel: "android-aosp",
      authority: "aosp-image",
      canAutoUpdate: false,
    });
  });

  it("never claims iOS sideload builds can install OTA binaries", () => {
    expect(
      resolveAppUpdatePolicy({
        platform: "ios",
        native: true,
        buildVariant: "direct",
        elizaOS: false,
      }),
    ).toMatchObject({
      channel: "ios-sideload",
      authority: "github",
      canAutoUpdate: false,
      canManualCheck: false,
    });
  });
});

describe("mapAgentUpdateStatusToSnapshot", () => {
  const baseStatus = {
    currentVersion: "2.0.0",
    channel: "stable" as const,
    installMethod: "npm-global",
    updateAvailable: false,
    latestVersion: "2.0.0",
    channels: {
      stable: "2.0.0",
      beta: "2.1.0-beta.1",
      nightly: null,
    },
    distTags: {
      stable: "latest",
      beta: "beta",
      nightly: "nightly",
    },
    lastCheckAt: "2026-05-11T12:00:00.000Z",
    error: null,
  };

  it("maps package-managed agent status without exposing an install action", () => {
    expect(mapAgentUpdateStatusToSnapshot(baseStatus)).toMatchObject({
      authority: "npm",
      authorityLabel: "npm global",
      status: "current",
      statusLabel: "Current",
      canManualCheck: true,
      canAutoUpdate: false,
      actionLabel: null,
    });
  });

  it("shows apt-managed Debian agents as package-manager constrained", () => {
    expect(
      mapAgentUpdateStatusToSnapshot({
        ...baseStatus,
        installMethod: "apt",
        updateAvailable: true,
        latestVersion: "2.0.1",
      }),
    ).toMatchObject({
      authority: "apt",
      authorityLabel: "Debian apt",
      status: "update-available",
      statusLabel: "Update available",
      canAutoUpdate: false,
      actionLabel: null,
    });
  });

  it("prioritizes check errors over stale update availability", () => {
    expect(
      mapAgentUpdateStatusToSnapshot({
        ...baseStatus,
        updateAvailable: true,
        error: "Unable to reach the npm registry.",
      }),
    ).toMatchObject({
      status: "error",
      statusLabel: "Check failed",
      error: "Unable to reach the npm registry.",
    });
  });
});
