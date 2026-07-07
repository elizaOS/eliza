/**
 * Web fallback for the `ElizaAppBlocker` Capacitor plugin, loaded when the app
 * runs outside a native Android/iOS shell where Family Controls / Usage
 * Access are unavailable. Every method returns an explicit
 * not-applicable/unavailable result rather than throwing, so a
 * Capacitor-based Eliza agent app can call `AppBlocker` uniformly across
 * platforms; input validation still runs here so malformed `blockApps`
 * options are caught the same way on web as on the native bridges.
 */
import { WebPlugin } from "@capacitor/core";
import type {
  AppBlockerPermissionResult,
  AppBlockerStatus,
  BlockAppsOptions,
  BlockAppsResult,
  SelectAppsResult,
  UnblockAppsResult,
} from "./definitions";

const PACKAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

function validateBlockAppsOptions(options: BlockAppsOptions): void {
  const packageNames = Array.isArray(options?.packageNames)
    ? options.packageNames
    : [];
  const appTokens = Array.isArray(options?.appTokens) ? options.appTokens : [];

  for (const packageName of packageNames) {
    if (
      typeof packageName !== "string" ||
      !PACKAGE_NAME_RE.test(packageName.trim())
    ) {
      throw new Error("packageNames must contain valid Android package names");
    }
  }

  for (const token of appTokens) {
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error("appTokens must contain non-empty strings");
    }
  }

  if (
    options?.durationMinutes !== undefined &&
    options.durationMinutes !== null
  ) {
    if (
      typeof options.durationMinutes !== "number" ||
      !Number.isFinite(options.durationMinutes) ||
      options.durationMinutes <= 0
    ) {
      throw new Error("durationMinutes must be a positive finite number");
    }
  }
}

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

  async blockApps(options: BlockAppsOptions): Promise<BlockAppsResult> {
    validateBlockAppsOptions(options);
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
