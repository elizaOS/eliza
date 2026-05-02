/**
 * Permission Manager for Electrobun
 *
 * Permission checking across macOS, Windows, and Linux.
 * Shared implementation ported forward to Electrobun; no runtime-specific APIs required.
 */

import type { SendToWebview } from "../types.js";
import type {
  AllPermissionsState,
  PermissionCheckResult,
  PermissionState,
  SystemPermissionId,
} from "./permissions-shared";
import {
  isPermissionApplicable,
  SYSTEM_PERMISSIONS,
} from "./permissions-shared";

// Platform modules are loaded on demand so that the darwin module (which uses
// bun:ffi) is never imported on Linux/Windows, and vice versa. This is
// required for tests to run correctly on non-macOS CI environments.
type PlatformModule = typeof import("./permissions-darwin");

async function getPlatformModule(): Promise<PlatformModule | null> {
  switch (process.platform) {
    case "darwin":
      return await import("./permissions-darwin");
    case "win32":
      return (await import("./permissions-win32")) as PlatformModule;
    case "linux":
      return (await import("./permissions-linux")) as PlatformModule;
    default:
      return null;
  }
}

const platform = process.platform as "darwin" | "win32" | "linux";
const DEFAULT_CACHE_TIMEOUT_MS = 30000;

export class PermissionManager {
  private sendToWebview: SendToWebview | null = null;
  private cache: Map<SystemPermissionId, PermissionState> = new Map();
  private cacheTimeoutMs = DEFAULT_CACHE_TIMEOUT_MS;
  private shellEnabled = true;

  setSendToWebview(fn: SendToWebview): void {
    this.sendToWebview = fn;
  }

  setShellEnabled(enabled: boolean): void {
    this.shellEnabled = enabled;
    this.cache.delete("shell");
    this.sendToWebview?.("permissionsChanged", { id: "shell" });
  }

  isShellEnabled(): boolean {
    return this.shellEnabled;
  }

  private getFromCache(id: SystemPermissionId): PermissionState | null {
    const cached = this.cache.get(id);
    if (!cached) return null;
    if (Date.now() - cached.lastChecked >= this.cacheTimeoutMs) return null;
    return cached;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async checkPermission(
    id: SystemPermissionId,
    forceRefresh = false,
  ): Promise<PermissionState> {
    if (!isPermissionApplicable(id, platform)) {
      const state: PermissionState = {
        id,
        status: "not-applicable",
        lastChecked: Date.now(),
        canRequest: false,
      };
      this.cache.set(id, state);
      return state;
    }

    if (id === "shell" && !this.shellEnabled) {
      const state: PermissionState = {
        id,
        status: "denied",
        lastChecked: Date.now(),
        canRequest: false,
      };
      this.cache.set(id, state);
      return state;
    }

    if (!forceRefresh) {
      const cached = this.getFromCache(id);
      if (cached) return cached;
    }

    const mod = await getPlatformModule();
    const result: PermissionCheckResult = mod
      ? await mod.checkPermission(id)
      : { status: "not-applicable", canRequest: false };

    const state: PermissionState = {
      id,
      status: result.status,
      lastChecked: Date.now(),
      canRequest: result.canRequest,
    };
    this.cache.set(id, state);
    return state;
  }

  async checkAllPermissions(
    forceRefresh = false,
  ): Promise<AllPermissionsState> {
    const results = await Promise.all(
      SYSTEM_PERMISSIONS.map((p) => this.checkPermission(p.id, forceRefresh)),
    );
    return results.reduce((acc, state) => {
      acc[state.id] = state;
      return acc;
    }, {} as AllPermissionsState);
  }

  async requestPermission(id: SystemPermissionId): Promise<PermissionState> {
    if (!isPermissionApplicable(id, platform)) {
      return {
        id,
        status: "not-applicable",
        lastChecked: Date.now(),
        canRequest: false,
      };
    }

    const mod = await getPlatformModule();
    const result: PermissionCheckResult = mod
      ? await mod.requestPermission(id)
      : { status: "not-applicable", canRequest: false };

    const state: PermissionState = {
      id,
      status: result.status,
      lastChecked: Date.now(),
      canRequest: result.canRequest,
    };
    this.cache.set(id, state);
    this.sendToWebview?.("permissionsChanged", { id });
    return state;
  }

  async openSettings(id: SystemPermissionId): Promise<void> {
    const mod = await getPlatformModule();
    await mod?.openPrivacySettings(id);
  }

  async checkFeaturePermissions(
    featureId: string,
  ): Promise<{ granted: boolean; missing: SystemPermissionId[] }> {
    const requiredPerms = SYSTEM_PERMISSIONS.filter((p) =>
      p.requiredForFeatures.includes(featureId),
    ).map((p) => p.id);

    const states = await Promise.all(
      requiredPerms.map((id) => this.checkPermission(id)),
    );

    const missing = states
      .filter((s) => s.status !== "granted" && s.status !== "not-applicable")
      .map((s) => s.id);

    return { granted: missing.length === 0, missing };
  }

  dispose(): void {
    this.cache.clear();
    this.sendToWebview = null;
  }
}

let permissionManager: PermissionManager | null = null;

export function getPermissionManager(): PermissionManager {
  if (!permissionManager) {
    permissionManager = new PermissionManager();
  }
  return permissionManager;
}
