import type { PermissionState } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import type {
  AppleCalendarPluginLike,
  MobileSignalsPermissionStatus,
  MobileSignalsPluginLike,
} from "../bridge/native-plugins";
import {
  createMobileSignalsPermissionsRegistry,
  openMobilePermissionSettings,
} from "./mobile-permissions-client";

function permissions(
  overrides: Partial<MobileSignalsPermissionStatus> = {},
): MobileSignalsPermissionStatus {
  return {
    status: "not-determined",
    canRequest: true,
    screenTime: {
      supported: true,
      requirements: {
        entitlements: { familyControls: "com.apple.developer.family-controls" },
        frameworks: ["FamilyControls", "DeviceActivity"],
        deviceActivityReportExtension: false,
        deviceActivityMonitorExtension: false,
      },
      entitlements: { familyControls: true },
      provisioning: {
        satisfied: true,
        inspected: "not-inspectable",
        reason: null,
      },
      authorization: {
        status: "not-determined",
        canRequest: true,
      },
      reportAvailable: false,
      coarseSummaryAvailable: false,
      thresholdEventsAvailable: false,
      rawUsageExportAvailable: false,
      reason: "Screen Time authorization has not been granted yet.",
    },
    setupActions: [
      {
        id: "health_permissions",
        label: "Health",
        status: "needs-action",
        canRequest: true,
        canOpenSettings: true,
        settingsTarget: "health",
        reason: "Grant health read access.",
      },
      {
        id: "screen_time_authorization",
        label: "Screen Time",
        status: "needs-action",
        canRequest: true,
        canOpenSettings: true,
        settingsTarget: "screenTime",
        reason: "Grant Screen Time authorization.",
      },
      {
        id: "notification_settings",
        label: "Notifications",
        status: "needs-action",
        canRequest: false,
        canOpenSettings: true,
        settingsTarget: "notification",
        reason: "Open notification settings.",
      },
    ],
    permissions: { sleep: false, biometrics: false },
    ...overrides,
  };
}

function plugin(status = permissions()): MobileSignalsPluginLike {
  return {
    checkPermissions: vi.fn(async () => status),
    requestPermissions: vi.fn(async () => status),
    openSettings: vi.fn(async ({ target } = {}) => ({
      opened: true,
      target: target ?? "app",
      actualTarget: target ?? "app",
      reason: null,
    })),
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    getSnapshot: vi.fn(),
    addListener: vi.fn(),
  } as unknown as MobileSignalsPluginLike;
}

function appleCalendarPlugin(
  status = {
    calendar: "prompt" as const,
    canRequest: true,
    reason: null,
  },
): AppleCalendarPluginLike {
  return {
    checkPermissions: vi.fn(async () => status),
    requestPermissions: vi.fn(async () => ({
      calendar: "granted" as const,
      canRequest: false,
      reason: null,
    })),
  };
}

describe("createMobileSignalsPermissionsRegistry", () => {
  it("maps HealthKit/Health Connect status into canonical health permission", async () => {
    const native = plugin(
      permissions({
        status: "granted",
        canRequest: false,
        permissions: { sleep: true, biometrics: true },
      }),
    );
    const registry = createMobileSignalsPermissionsRegistry(native);

    const state = await registry.check("health");

    expect(state).toMatchObject({
      id: "health",
      status: "granted",
      canRequest: false,
    });
    expect(native.checkPermissions).toHaveBeenCalled();
  });

  it("requests only mobile health when the health card primary button is used", async () => {
    const native = plugin();
    const registry = createMobileSignalsPermissionsRegistry(native);

    await registry.request("health", {
      reason: "Read sleep data.",
      feature: { app: "lifeops", action: "sleep.read" },
    });

    expect(native.requestPermissions).toHaveBeenCalledWith({
      target: "health",
    });
  });

  it("opens settings for Screen Time when it cannot be requested directly", async () => {
    const native = plugin(
      permissions({
        screenTime: {
          ...permissions().screenTime,
          authorization: {
            status: "not-determined",
            canRequest: false,
          },
          reason: "Enable Usage Access in Android Settings.",
        },
      }),
    );
    const registry = createMobileSignalsPermissionsRegistry(native);

    await registry.request("screentime", {
      reason: "Read usage summaries.",
      feature: { app: "lifeops", action: "usage.read" },
    });

    expect(native.openSettings).toHaveBeenCalled();
    expect(native.requestPermissions).not.toHaveBeenCalled();
  });

  it("requests native notifications when the platform can prompt", async () => {
    const native = plugin(
      permissions({
        setupActions: [
          {
            id: "notification_settings",
            label: "Notifications",
            status: "needs-action",
            canRequest: true,
            canOpenSettings: true,
            settingsTarget: "notification",
            reason: "Allow notifications.",
          },
        ],
      }),
    );
    const registry = createMobileSignalsPermissionsRegistry(native);

    await registry.request("notifications", {
      reason: "Send reminder prompts.",
      feature: { app: "lifeops", action: "reminders.notify" },
    });

    expect(native.requestPermissions).toHaveBeenCalledWith({
      target: "notifications",
    });
    expect(native.openSettings).not.toHaveBeenCalled();
  });

  it("requests native Apple Calendar through the calendar plugin", async () => {
    const native = plugin();
    const calendar = appleCalendarPlugin();
    const registry = createMobileSignalsPermissionsRegistry(
      native,
      undefined,
      calendar,
    );

    await registry.request("calendar", {
      reason: "Read schedule.",
      feature: { app: "lifeops", action: "calendar.read" },
    });

    expect(calendar.requestPermissions).toHaveBeenCalled();
    expect(native.requestPermissions).not.toHaveBeenCalled();
  });

  it("opens notification settings when native notifications cannot prompt", async () => {
    const native = plugin();
    const registry = createMobileSignalsPermissionsRegistry(native);

    await registry.request("notifications", {
      reason: "Send reminder prompts.",
      feature: { app: "lifeops", action: "reminders.notify" },
    });

    expect(native.openSettings).toHaveBeenCalledWith({
      target: "notification",
    });
    expect(native.requestPermissions).not.toHaveBeenCalled();
  });

  it("delegates non-mobile permissions to the fallback client", async () => {
    const fallbackState: PermissionState = {
      id: "reminders",
      status: "not-determined",
      lastChecked: 1,
      canRequest: true,
      platform: "darwin",
    };
    const fallback = {
      getPermission: vi.fn(async () => fallbackState),
      requestPermission: vi.fn(async () => fallbackState),
      openPermissionSettings: vi.fn(async () => {}),
    };
    const registry = createMobileSignalsPermissionsRegistry(plugin(), fallback);

    const state = await registry.check("reminders");

    expect(state).toBe(fallbackState);
    expect(fallback.getPermission).toHaveBeenCalledWith("reminders");
  });
});

describe("openMobilePermissionSettings", () => {
  it("routes notifications to the native notification settings target", async () => {
    const native = plugin();

    await openMobilePermissionSettings("notifications", native);

    expect(native.openSettings).toHaveBeenCalledWith({
      target: "notification",
    });
  });
});
