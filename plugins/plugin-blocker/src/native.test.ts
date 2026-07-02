/**
 * Contract tests for `@elizaos/plugin-blocker/native` — the browser-safe
 * registration seam the mobile WebView uses to wire the Capacitor blocker
 * adapters into the engine registries (issue: renderer boot warning
 * "[Eliza] Blocker backends plugin not available:
 * e.registerNativeWebsiteBlockerBackend is not a function").
 *
 * Two invariants:
 * 1. Registration identity — a backend registered through the /native entry
 *    is the exact instance the engine dispatches to (same module instance as
 *    the engine's registry), for BOTH the website and app registries.
 * 2. Browser safety — bundling src/native.ts for the browser must succeed
 *    without any node:* builtin reaching the bundle. The hosts-file engine
 *    (node:child_process, node:fs, …) must stay out of the renderer graph;
 *    this is exactly what broke silently when the renderer alias pointed the
 *    bare specifier at a module without the registrars.
 */

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import * as nativeEntry from "./native.ts";
import type { NativeAppBlockerBackend } from "./services/app-blocker/engine.ts";
import { getAppBlockerStatus } from "./services/app-blocker/engine.ts";
import type {
  AppBlockerPermissionResult,
  AppBlockerStatus,
  BlockAppsResult,
  SelectAppsResult,
  UnblockAppsResult,
} from "./services/app-blocker/types.ts";
import type {
  NativeWebsiteBlockerBackend,
  SelfControlPermissionState,
  SelfControlStatus,
} from "./services/website-blocker/engine.ts";
import { getSelfControlStatus } from "./services/website-blocker/engine.ts";

function makeWebsiteStatus(
  overrides: Partial<SelfControlStatus> = {},
): SelfControlStatus {
  return {
    available: true,
    active: true,
    hostsFilePath: null,
    startedAt: null,
    endsAt: null,
    websites: ["x.com"],
    blockedWebsites: ["x.com"],
    allowedWebsites: [],
    requestedWebsites: ["x.com"],
    matchMode: "exact",
    managedBy: null,
    metadata: null,
    scheduledByAgentId: null,
    canUnblockEarly: true,
    requiresElevation: false,
    engine: "content-blocker",
    platform: "ios",
    supportsElevationPrompt: false,
    elevationPromptMethod: null,
    ...overrides,
  };
}

function makeWebsiteBackend(
  status: SelfControlStatus,
): NativeWebsiteBlockerBackend {
  const permission: SelfControlPermissionState = {
    id: "website-blocking",
    status: "granted",
    lastChecked: 0,
    canRequest: false,
  };
  return {
    getStatus: async () => status,
    startBlock: async () => ({ success: true, endsAt: null }),
    stopBlock: async () => ({ success: true, removed: true, status }),
    getPermissionState: async () => permission,
    requestPermission: async () => permission,
  };
}

afterEach(() => {
  // Reset both registries so tests stay order-independent.
  nativeEntry.registerNativeWebsiteBlockerBackend(
    null as unknown as NativeWebsiteBlockerBackend,
  );
  nativeEntry.registerNativeAppBlockerBackend(
    null as unknown as NativeAppBlockerBackend,
  );
});

describe("@elizaos/plugin-blocker/native registration seam", () => {
  it("exports the two registrars the renderer boot path calls", () => {
    expect(typeof nativeEntry.registerNativeWebsiteBlockerBackend).toBe(
      "function",
    );
    expect(typeof nativeEntry.registerNativeAppBlockerBackend).toBe("function");
    expect(typeof nativeEntry.getNativeWebsiteBlockerBackend).toBe("function");
    expect(typeof nativeEntry.getNativeAppBlockerBackend).toBe("function");
  });

  it("website backend registered via /native is the instance the engine dispatches to", async () => {
    const status = makeWebsiteStatus();
    const backend = makeWebsiteBackend(status);
    nativeEntry.registerNativeWebsiteBlockerBackend(backend);

    // Same module instance: the engine's getter sees it…
    expect(nativeEntry.getNativeWebsiteBlockerBackend()).toBe(backend);
    // …and the engine's status path dispatches to it instead of the
    // hosts-file reconciliation.
    await expect(getSelfControlStatus()).resolves.toBe(status);
  });

  it("app backend registered via /native is the instance the engine dispatches to", async () => {
    const status: AppBlockerStatus = {
      available: true,
      active: true,
      platform: "ios",
      engine: "family-controls",
      blockedCount: 1,
      blockedPackageNames: ["com.example.app"],
      endsAt: null,
      permissionStatus: "granted",
    };
    const calls: string[] = [];
    const permissionResult = {
      status: "granted",
      canRequest: false,
    } as AppBlockerPermissionResult;
    const backend: NativeAppBlockerBackend = {
      checkPermissions: async () => permissionResult,
      requestPermissions: async () => permissionResult,
      getInstalledApps: async () => ({ apps: [] }),
      selectApps: async () => ({ selected: [] }) as unknown as SelectAppsResult,
      blockApps: async () => ({ success: true }) as unknown as BlockAppsResult,
      unblockApps: async () =>
        ({ success: true }) as unknown as UnblockAppsResult,
      getStatus: async () => {
        calls.push("getStatus");
        return status;
      },
    };

    nativeEntry.registerNativeAppBlockerBackend(backend);
    expect(nativeEntry.getNativeAppBlockerBackend()).toBe(backend);
    await expect(getAppBlockerStatus()).resolves.toBe(status);
    expect(calls).toEqual(["getStatus"]);
  });

  it("unregistered registries return null (engine falls back to platform paths)", () => {
    expect(nativeEntry.getNativeWebsiteBlockerBackend()).toBeNull();
    expect(nativeEntry.getNativeAppBlockerBackend()).toBeNull();
  });
});

describe("@elizaos/plugin-blocker/native browser safety", () => {
  it("bundles for the browser without pulling any node:* builtin", async () => {
    const entry = fileURLToPath(new URL("./native.ts", import.meta.url));
    // esbuild fails the build outright if a node builtin is imported with
    // platform "browser" and no shim — which is the regression this guards:
    // the hosts-file engine must never become a runtime dependency of the
    // renderer registration seam.
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
      external: ["@capacitor/core"],
    });
    expect(result.errors).toEqual([]);
    const bundled = result.outputFiles?.[0]?.text ?? "";
    expect(bundled).toContain("registerNativeWebsiteBlockerBackend");
    expect(bundled).toContain("registerNativeAppBlockerBackend");
    expect(bundled).not.toMatch(/from\s*["']node:/);
  });
});
