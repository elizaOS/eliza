import { describe, expect, it, vi } from "vitest";

import { createNativeWebsiteBlockerBackend } from "./backend";
import type { WebsiteBlockerPlugin, WebsiteBlockerStatus } from "./definitions";

function makeStatus(
  overrides: Partial<WebsiteBlockerStatus> = {},
): WebsiteBlockerStatus {
  return {
    status: "inactive",
    available: true,
    active: false,
    hostsFilePath: null,
    endsAt: null,
    websites: [],
    requestedWebsites: [],
    blockedWebsites: [],
    allowedWebsites: [],
    matchMode: "exact",
    canUnblockEarly: true,
    requiresElevation: false,
    engine: "content-blocker",
    platform: "ios",
    supportsElevationPrompt: false,
    elevationPromptMethod: null,
    ...overrides,
  };
}

function makePlugin(
  overrides: Partial<WebsiteBlockerPlugin> = {},
): WebsiteBlockerPlugin {
  return {
    getStatus: vi.fn(async () => makeStatus()),
    startBlock: vi.fn(async () => ({
      success: true as const,
      endsAt: null,
      request: { websites: ["x.com"], durationMinutes: null },
    })),
    stopBlock: vi.fn(async () => ({
      success: true as const,
      removed: true,
      status: {
        active: false,
        endsAt: null,
        websites: [],
        canUnblockEarly: true,
        requiresElevation: false,
      },
    })),
    checkPermissions: vi.fn(async () => ({
      status: "granted" as const,
      canRequest: false,
      canOpenSettings: true,
      settingsTarget: "contentBlocker" as const,
      engine: "content-blocker" as const,
    })),
    requestPermissions: vi.fn(async () => ({
      status: "granted" as const,
      canRequest: false,
      canOpenSettings: true,
      settingsTarget: "contentBlocker" as const,
      engine: "content-blocker" as const,
    })),
    openSettings: vi.fn(async () => ({
      opened: true,
      target: "contentBlocker" as const,
      actualTarget: "contentBlocker" as const,
      reason: null,
    })),
    ...overrides,
  };
}

describe("createNativeWebsiteBlockerBackend", () => {
  it("maps engine startBlock onto the Capacitor plugin and returns the native engine result", async () => {
    const startBlock = vi.fn(async () => ({
      success: true as const,
      endsAt: "2026-06-17T12:00:00.000Z",
      request: { websites: ["x.com"], durationMinutes: 30 },
    }));
    const backend = createNativeWebsiteBlockerBackend(
      makePlugin({ startBlock }),
    );

    const result = await backend.startBlock({
      websites: ["x.com", "reddit.com"],
      durationMinutes: 30,
      scheduledByAgentId: "agent-1",
    });

    expect(startBlock).toHaveBeenCalledWith({
      websites: ["x.com", "reddit.com"],
      durationMinutes: 30,
    });
    expect(result).toEqual({
      success: true,
      endsAt: "2026-06-17T12:00:00.000Z",
    });
  });

  it("surfaces a native startBlock failure as an engine failure", async () => {
    const startBlock = vi.fn(async () => ({
      success: false as const,
      error: "content blocker disabled in Settings",
    }));
    const backend = createNativeWebsiteBlockerBackend(
      makePlugin({ startBlock }),
    );

    const result = await backend.startBlock({
      websites: ["x.com"],
      durationMinutes: null,
    });

    expect(result).toEqual({
      success: false,
      error: "content blocker disabled in Settings",
    });
  });

  it("maps getStatus into the engine SelfControlStatus shape, preserving the native engine", async () => {
    const backend = createNativeWebsiteBlockerBackend(
      makePlugin({
        getStatus: vi.fn(async () =>
          makeStatus({
            status: "active",
            active: true,
            websites: ["x.com"],
            blockedWebsites: ["x.com", "www.x.com"],
            endsAt: "2026-06-17T13:00:00.000Z",
            engine: "vpn-dns",
            platform: "android",
          }),
        ),
      }),
    );

    const status = await backend.getStatus();

    expect(status.active).toBe(true);
    expect(status.engine).toBe("vpn-dns");
    expect(status.platform).toBe("android");
    expect(status.blockedWebsites).toEqual(["x.com", "www.x.com"]);
    expect(status.endsAt).toBe("2026-06-17T13:00:00.000Z");
  });

  it("stopBlock includes the refreshed status from a follow-up getStatus", async () => {
    const getStatus = vi
      .fn(async () => makeStatus({ active: false }))
      .mockName("getStatus");
    const stopBlock = vi.fn(async () => ({
      success: true as const,
      removed: true,
      status: {
        active: false,
        endsAt: null,
        websites: [],
        canUnblockEarly: true,
        requiresElevation: false,
      },
    }));
    const backend = createNativeWebsiteBlockerBackend(
      makePlugin({ getStatus, stopBlock }),
    );

    const result = await backend.stopBlock();

    expect(stopBlock).toHaveBeenCalledOnce();
    expect(getStatus).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.removed).toBe(true);
      expect(result.status.active).toBe(false);
    }
  });

  it("maps permission checks into the engine permission-state shape", async () => {
    const backend = createNativeWebsiteBlockerBackend(makePlugin());

    const permission = await backend.getPermissionState();

    expect(permission.id).toBe("website-blocking");
    expect(permission.status).toBe("granted");
    expect(permission.canRequest).toBe(false);
    expect(typeof permission.lastChecked).toBe("number");
  });
});
