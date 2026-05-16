import { WebPlugin } from "@capacitor/core";
import type {
  AppBlockerPermissionResult,
  AppBlockerStatus,
  BlockAppsOptions,
  BlockAppsResult,
  SelectAppsResult,
  UnblockAppsResult,
} from "./definitions";

export class AppBlockerWeb extends WebPlugin {
  async checkPermissions(): Promise<AppBlockerPermissionResult> {
    return {
      status: "not-applicable",
      canRequest: false,
      canOpenSettings: false,
      settingsTarget: null,
      engine: "none",
      capabilities: {
        canSelectApps: false,
        canBlockApps: false,
        canScheduleTimedBlocks: false,
        canUnblockEarly: false,
        requiresFamilyControls: false,
        requiresUsageAccess: false,
        requiresOverlay: false,
      },
      reason: "App blocking is only available on mobile devices.",
    };
  }

  async requestPermissions(): Promise<AppBlockerPermissionResult> {
    return {
      status: "not-applicable",
      canRequest: false,
      canOpenSettings: false,
      settingsTarget: null,
      engine: "none",
      capabilities: {
        canSelectApps: false,
        canBlockApps: false,
        canScheduleTimedBlocks: false,
        canUnblockEarly: false,
        requiresFamilyControls: false,
        requiresUsageAccess: false,
        requiresOverlay: false,
      },
      reason: "App blocking is only available on mobile devices.",
    };
  }

  async getInstalledApps(): Promise<{ apps: [] }> {
    return { apps: [] };
  }

  async selectApps(): Promise<SelectAppsResult> {
    return { apps: [], cancelled: true };
  }

  async blockApps(_options: BlockAppsOptions): Promise<BlockAppsResult> {
    return {
      success: false,
      endsAt: null,
      error: "App blocking is only available on mobile devices.",
      blockedCount: 0,
    };
  }

  async unblockApps(): Promise<UnblockAppsResult> {
    return {
      success: false,
      error: "App blocking is only available on mobile devices.",
    };
  }

  async getStatus(): Promise<AppBlockerStatus> {
    return {
      status: "unavailable",
      available: false,
      active: false,
      platform: "web",
      engine: "none",
      capabilities: {
        canSelectApps: false,
        canBlockApps: false,
        canScheduleTimedBlocks: false,
        canUnblockEarly: false,
        requiresFamilyControls: false,
        requiresUsageAccess: false,
        requiresOverlay: false,
      },
      blockedCount: 0,
      blockedPackageNames: [],
      endsAt: null,
      permissionStatus: "not-applicable",
      canRequest: false,
      canOpenSettings: false,
      settingsTarget: null,
      reason: "App blocking is only available on mobile devices.",
    };
  }
}
