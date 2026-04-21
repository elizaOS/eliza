import { describe, expect, it } from "vitest";
import { MobileSignalsWeb } from "./web.js";

describe("MobileSignalsWeb Screen Time status", () => {
  it("reports Screen Time as unavailable without fabricating usage data", async () => {
    const plugin = new MobileSignalsWeb();

    const permissions = await plugin.checkPermissions();
    expect(permissions.screenTime).toEqual({
      supported: false,
      requirements: {
        entitlements: {
          familyControls: "com.apple.developer.family-controls",
          appAndWebsiteUsage:
            "com.apple.developer.family-controls.app-and-website-usage",
        },
        frameworks: ["FamilyControls", "DeviceActivity"],
        deviceActivityReportExtension: false,
        deviceActivityMonitorExtension: false,
        android: {
          usageStatsPermission: "android.permission.PACKAGE_USAGE_STATS",
          usageAccessSettingsAction: "android.settings.USAGE_ACCESS_SETTINGS",
        },
      },
      entitlements: {
        familyControls: false,
        appAndWebsiteUsage: false,
      },
      provisioning: {
        satisfied: false,
        inspected: "not-inspectable",
        reason: "Web fallback has no Family Controls or DeviceActivity access.",
      },
      authorization: {
        status: "unavailable",
        canRequest: false,
      },
      reportAvailable: false,
      coarseSummaryAvailable: false,
      thresholdEventsAvailable: false,
      rawUsageExportAvailable: false,
      android: {
        usageAccessGranted: false,
        packageUsageStatsPermissionDeclared: false,
        canOpenUsageAccessSettings: false,
        foregroundEventsAvailable: false,
        totalTimeForegroundMs: null,
      },
      reason: "Web fallback has no Family Controls or DeviceActivity access.",
    });
    expect(permissions.setupActions).toEqual([
      {
        id: "health_permissions",
        label: "Health permissions",
        status: "unavailable",
        canRequest: false,
        canOpenSettings: false,
        settingsTarget: null,
        reason: "Web fallback has no HealthKit or Health Connect access.",
      },
      {
        id: "screen_time_authorization",
        label: "Screen Time",
        status: "unavailable",
        canRequest: false,
        canOpenSettings: false,
        settingsTarget: null,
        reason: "Web fallback cannot open native Screen Time settings.",
      },
    ]);

    const snapshot = await plugin.getSnapshot();
    expect(snapshot.healthSnapshot?.screenTime).toEqual(permissions.screenTime);

    await expect(plugin.openSettings({ target: "usageAccess" })).resolves.toEqual({
      opened: false,
      target: "usageAccess",
      actualTarget: "app",
      reason: "Web fallback cannot open native device settings.",
    });
  });
});
