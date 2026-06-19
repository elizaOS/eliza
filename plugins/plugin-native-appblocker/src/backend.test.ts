import { describe, expect, it, vi } from "vitest";

import { createNativeAppBlockerBackend } from "./backend";
import type { AppBlockerPlugin, AppBlockerStatus } from "./definitions";

const CAPABILITIES = {
  canSelectApps: true,
  canBlockApps: true,
  canScheduleTimedBlocks: false,
  canUnblockEarly: true,
  requiresFamilyControls: true,
  requiresUsageAccess: false,
  requiresOverlay: false,
};

function makeStatus(
  overrides: Partial<AppBlockerStatus> = {},
): AppBlockerStatus {
  return {
    status: "inactive",
    available: true,
    active: false,
    platform: "ios",
    engine: "family-controls",
    capabilities: CAPABILITIES,
    blockedCount: 0,
    blockedPackageNames: [],
    endsAt: null,
    permissionStatus: "granted",
    canRequest: false,
    canOpenSettings: true,
    settingsTarget: "screenTime",
    ...overrides,
  };
}

function makePlugin(
  overrides: Partial<AppBlockerPlugin> = {},
): AppBlockerPlugin {
  return {
    checkPermissions: vi.fn(async () => ({
      status: "granted" as const,
      canRequest: false,
      canOpenSettings: true,
      settingsTarget: "screenTime" as const,
      engine: "family-controls" as const,
      capabilities: CAPABILITIES,
    })),
    requestPermissions: vi.fn(async () => ({
      status: "granted" as const,
      canRequest: false,
      canOpenSettings: true,
      settingsTarget: "screenTime" as const,
      engine: "family-controls" as const,
      capabilities: CAPABILITIES,
    })),
    getInstalledApps: vi.fn(async () => ({ apps: [] })),
    selectApps: vi.fn(async () => ({ apps: [], cancelled: false })),
    blockApps: vi.fn(async () => ({
      success: true,
      endsAt: null,
      blockedCount: 2,
    })),
    unblockApps: vi.fn(async () => ({ success: true })),
    getStatus: vi.fn(async () => makeStatus()),
    ...overrides,
  };
}

describe("createNativeAppBlockerBackend", () => {
  it("forwards blockApps to the Capacitor plugin", async () => {
    const blockApps = vi.fn(async () => ({
      success: true,
      endsAt: null,
      blockedCount: 3,
    }));
    const backend = createNativeAppBlockerBackend(makePlugin({ blockApps }));

    const result = await backend.blockApps({ packageNames: ["a", "b", "c"] });

    expect(blockApps).toHaveBeenCalledWith({ packageNames: ["a", "b", "c"] });
    expect(result.blockedCount).toBe(3);
  });

  it("maps getStatus into the trimmed engine status shape", async () => {
    const backend = createNativeAppBlockerBackend(
      makePlugin({
        getStatus: vi.fn(async () =>
          makeStatus({
            active: true,
            blockedCount: 2,
            blockedPackageNames: ["com.x", "com.reddit"],
            engine: "usage-stats-overlay",
            platform: "android",
          }),
        ),
      }),
    );

    const status = await backend.getStatus();

    expect(status).toEqual({
      available: true,
      active: true,
      platform: "android",
      engine: "usage-stats-overlay",
      blockedCount: 2,
      blockedPackageNames: ["com.x", "com.reddit"],
      endsAt: null,
      permissionStatus: "granted",
      reason: undefined,
    });
  });

  it("maps permission checks into the trimmed engine permission shape", async () => {
    const backend = createNativeAppBlockerBackend(makePlugin());

    const permission = await backend.checkPermissions();

    expect(permission).toEqual({
      status: "granted",
      canRequest: false,
      reason: undefined,
    });
  });

  it("forwards unblockApps to the Capacitor plugin", async () => {
    const unblockApps = vi.fn(async () => ({ success: true }));
    const backend = createNativeAppBlockerBackend(makePlugin({ unblockApps }));

    const result = await backend.unblockApps();

    expect(unblockApps).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
  });
});
