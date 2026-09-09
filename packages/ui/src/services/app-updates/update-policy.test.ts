/**
 * Pins the live app-update policy contract consumed by ReleaseCenterView:
 * the platform × build-variant × elizaOS branch matrix of resolveAppUpdatePolicy
 * (distribution channel, update authority, and the affordance flags the Updates
 * surface renders) and the install-method authority mapping + status triage of
 * mapAgentUpdateStatusToSnapshot. Deterministic unit harness over the real
 * exported functions — no mocks; the sibling app-core suite covers its own
 * parallel copy, which no production code imports.
 */
import type { AgentUpdateStatus } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  mapAgentUpdateStatusToSnapshot,
  resolveAppUpdatePolicy,
} from "./update-policy";

const baseInput = {
  native: false,
  buildVariant: "direct",
  elizaOS: false,
} as const;

describe("resolveAppUpdatePolicy", () => {
  it("grants desktop-direct builds GitHub auto-update authority with a manual check action", () => {
    const policy = resolveAppUpdatePolicy({
      ...baseInput,
      platform: "desktop",
    });
    expect(policy).toMatchObject({
      channel: "desktop-direct",
      authority: "github",
      canAutoUpdate: true,
      canManualCheck: true,
      canOpenReleaseNotes: true,
    });
    expect(policy.actionLabel).toBe("Check / Download Update");
  });

  it("routes desktop-store builds to store authority with no self-update affordances", () => {
    const policy = resolveAppUpdatePolicy({
      platform: "desktop",
      native: false,
      buildVariant: "store",
      elizaOS: false,
    });
    expect(policy).toMatchObject({
      channel: "desktop-store",
      authority: "store",
      canAutoUpdate: false,
      canManualCheck: false,
      canOpenReleaseNotes: true,
    });
    expect(policy.actionLabel).toBeNull();
  });

  it("keeps iOS App Store builds host-managed — never offers in-app download", () => {
    const policy = resolveAppUpdatePolicy({
      platform: "ios",
      native: true,
      buildVariant: "store",
      elizaOS: false,
    });
    expect(policy).toMatchObject({
      channel: "ios-app-store",
      authority: "store",
      canAutoUpdate: false,
      canManualCheck: false,
      canOpenReleaseNotes: true,
    });
  });

  it("keeps iOS sideload builds manual — GitHub authority but no auto or manual install action", () => {
    const policy = resolveAppUpdatePolicy({
      platform: "ios",
      native: true,
      buildVariant: "direct",
      elizaOS: false,
    });
    expect(policy).toMatchObject({
      channel: "ios-sideload",
      authority: "github",
      canAutoUpdate: false,
      canManualCheck: false,
      canOpenReleaseNotes: true,
    });
    expect(policy.actionLabel).toBeNull();
  });

  it("pins AOSP authority ahead of the store variant for elizaOS Android images", () => {
    // Branch order regression guard: elizaOS image check must win even when the
    // build variant says store — the system image owns updates either way.
    const aosp = resolveAppUpdatePolicy({
      platform: "android",
      native: true,
      buildVariant: "store",
      elizaOS: true,
    });
    expect(aosp).toMatchObject({
      channel: "android-aosp",
      authority: "aosp-image",
      canAutoUpdate: false,
      canManualCheck: false,
      canOpenReleaseNotes: true,
    });
  });

  it("routes Android store builds to Google Play authority", () => {
    const policy = resolveAppUpdatePolicy({
      platform: "android",
      native: true,
      buildVariant: "store",
      elizaOS: false,
    });
    expect(policy).toMatchObject({
      channel: "android-google-play",
      authority: "store",
      canAutoUpdate: false,
      canManualCheck: false,
      canOpenReleaseNotes: true,
    });
  });

  it("keeps Android sideload builds manual with GitHub release-note authority", () => {
    const policy = resolveAppUpdatePolicy({
      platform: "android",
      native: true,
      buildVariant: "direct",
      elizaOS: false,
    });
    expect(policy).toMatchObject({
      channel: "android-sideload",
      authority: "github",
      canAutoUpdate: false,
      canManualCheck: false,
      canOpenReleaseNotes: true,
    });
    expect(policy.actionLabel).toBeNull();
  });

  it("treats any non-desktop/native platform as web — updates happen on reload", () => {
    const policy = resolveAppUpdatePolicy({
      ...baseInput,
      platform: "web",
    });
    expect(policy).toMatchObject({
      channel: "web",
      authority: "web",
      canAutoUpdate: false,
      canManualCheck: false,
      canOpenReleaseNotes: true,
    });
    expect(policy.actionLabel).toBeNull();
  });
});

describe("mapAgentUpdateStatusToSnapshot", () => {
  const baseStatus: AgentUpdateStatus = {
    installMethod: "npm-global",
    currentVersion: "1.2.3",
    latestVersion: "1.2.4",
    channel: "stable",
    updateAvailable: true,
    lastCheckAt: "2026-09-09T00:00:00.000Z",
    error: null,
    updateInstructions: undefined,
    canAutoUpdate: undefined,
    channels: { stable: "1.2.4", beta: null, nightly: null },
    distTags: { stable: "1.2.4", beta: "1.3.0-beta.1", nightly: "1.3.0-dev.5" },
  };

  it.each([
    ["npm-global", "npm", "npm global"],
    ["bun-global", "bun", "Bun global"],
    ["homebrew", "homebrew", "Homebrew"],
    ["snap", "snap", "Snap"],
    ["apt", "apt", "Debian apt"],
    ["flatpak", "flatpak", "Flatpak"],
    ["local-dev", "local-dev", "Local development checkout"],
  ] as const)(
    "maps install method %s to the %s authority",
    (installMethod, authority, authorityLabel) => {
      const snapshot = mapAgentUpdateStatusToSnapshot({
        ...baseStatus,
        installMethod,
      });
      expect(snapshot).not.toBeNull();
      expect(snapshot?.authority).toBe(authority);
      expect(snapshot?.authorityLabel).toBe(authorityLabel);
      expect(snapshot?.installMethod).toBe(installMethod);
    },
  );

  it("reports an unknown install method as an explicit unknown authority, not a fabricated one", () => {
    const snapshot = mapAgentUpdateStatusToSnapshot({
      ...baseStatus,
      installMethod: "chocolatey",
    });
    expect(snapshot?.authority).toBe("unknown");
    expect(snapshot?.authorityLabel).toBe("Agent host");
  });

  it("triages error over update-available — a failed check never renders as an update offer", () => {
    const snapshot = mapAgentUpdateStatusToSnapshot({
      ...baseStatus,
      error: "registry unreachable",
      updateAvailable: true,
    });
    expect(snapshot?.status).toBe("error");
    expect(snapshot?.statusLabel).toBe("Check failed");
  });

  it("reports update-available ahead of current when no error is set", () => {
    const snapshot = mapAgentUpdateStatusToSnapshot(baseStatus);
    expect(snapshot?.status).toBe("update-available");
    expect(snapshot?.statusLabel).toBe("Update available");
  });

  it("reports current when the check succeeded with no update", () => {
    const snapshot = mapAgentUpdateStatusToSnapshot({
      ...baseStatus,
      updateAvailable: false,
    });
    expect(snapshot?.status).toBe("current");
    expect(snapshot?.statusLabel).toBe("Current");
  });

  it("prefers the agent-reported updateInstructions over the authority default detail", () => {
    const snapshot = mapAgentUpdateStatusToSnapshot({
      ...baseStatus,
      updateInstructions: "Run `npm i -g @elizaos/eliza@latest` on the host.",
    });
    expect(snapshot?.detail).toBe(
      "Run `npm i -g @elizaos/eliza@latest` on the host.",
    );
  });

  it("falls back to the authority detail when the agent reports no instructions", () => {
    const snapshot = mapAgentUpdateStatusToSnapshot(baseStatus);
    expect(snapshot?.detail).toBe(
      "The connected agent is updated with npm on the host running the agent.",
    );
  });

  it("defaults canAutoUpdate to false when the status omits it, while keeping manual check available", () => {
    const snapshot = mapAgentUpdateStatusToSnapshot(baseStatus);
    expect(snapshot?.canAutoUpdate).toBe(false);
    expect(snapshot?.canManualCheck).toBe(true);
  });

  it("returns null for absent status instead of fabricating a snapshot", () => {
    expect(mapAgentUpdateStatusToSnapshot(null)).toBeNull();
    expect(mapAgentUpdateStatusToSnapshot(undefined)).toBeNull();
  });
});
