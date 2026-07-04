// @vitest-environment jsdom

/**
 * Unit coverage for boot-time reconciliation of a stale persisted mobile
 * runtime mode against the build's native truth (the #11030 splash-hang guard).
 * Capacitor Preferences + native detection mocked, no real device.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_RUNTIME_MODE_STORAGE_KEY } from "./mobile-runtime-mode";
import {
  planMobileRuntimeModeReconcile,
  readMobileRuntimeBuildTruth,
  reconcilePersistedMobileRuntimeModeAtBoot,
} from "./reconcile-mobile-runtime-mode";

const { capacitorState, preferencesRemoveMock, preferencesSetMock } =
  vi.hoisted(() => ({
    capacitorState: { isNative: true },
    preferencesRemoveMock: vi.fn(async () => undefined),
    preferencesSetMock: vi.fn(async () => undefined),
  }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.isNative,
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    remove: preferencesRemoveMock,
    set: preferencesSetMock,
  },
}));

const STEWARD_TOKEN_KEY = "steward_session_token";
const ACTIVE_SERVER_KEY = "elizaos:active-server";

function installNativeCapacitorGlobal(platform: "ios" | "android"): void {
  (globalThis as Record<string, unknown>).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  delete (globalThis as Record<string, unknown>).Capacitor;
  vi.clearAllMocks();
  capacitorState.isNative = true;
});

describe("planMobileRuntimeModeReconcile — the unusability predicate", () => {
  const localBuild = {
    buildMode: "local" as const,
    hasBuildApiBase: false,
    hasLocalEngine: true,
  };
  const cloudOnlyBuild = {
    buildMode: "cloud" as const,
    hasBuildApiBase: false,
    hasLocalEngine: false,
  };

  it("adopts local when a stale cloud mode has no endpoint in a local build (the #11030 device hang)", () => {
    expect(
      planMobileRuntimeModeReconcile({
        persistedMode: "cloud",
        build: localBuild,
        hasUsableCloudSession: false,
      }),
    ).toEqual({
      action: "adopt-build-mode",
      from: "cloud",
      to: "local",
      reason: "persisted-cloud-mode-has-no-endpoint-in-local-build",
    });
  });

  it("adopts local for a stale cloud-hybrid mode under the same conditions", () => {
    expect(
      planMobileRuntimeModeReconcile({
        persistedMode: "cloud-hybrid",
        build: localBuild,
        hasUsableCloudSession: false,
      }),
    ).toEqual({
      action: "adopt-build-mode",
      from: "cloud-hybrid",
      to: "local",
      reason: "persisted-cloud-mode-has-no-endpoint-in-local-build",
    });
  });

  it("keeps a user-chosen cloud mode when the build stamps a cloud apiBase", () => {
    expect(
      planMobileRuntimeModeReconcile({
        persistedMode: "cloud",
        build: { ...localBuild, hasBuildApiBase: true },
        hasUsableCloudSession: false,
      }),
    ).toEqual({ action: "keep" });
  });

  it("keeps a user-chosen cloud mode when a usable cloud session exists on the device", () => {
    expect(
      planMobileRuntimeModeReconcile({
        persistedMode: "cloud",
        build: localBuild,
        hasUsableCloudSession: true,
      }),
    ).toEqual({ action: "keep" });
  });

  it("adopts cloud when a stale local mode has no engine in this build", () => {
    expect(
      planMobileRuntimeModeReconcile({
        persistedMode: "local",
        build: cloudOnlyBuild,
        hasUsableCloudSession: false,
      }),
    ).toEqual({
      action: "adopt-build-mode",
      from: "local",
      to: "cloud",
      reason: "persisted-local-mode-has-no-engine-in-this-build",
    });
  });

  it("keeps a persisted local mode when the build can host the on-device agent", () => {
    expect(
      planMobileRuntimeModeReconcile({
        persistedMode: "local",
        build: {
          buildMode: "cloud",
          hasBuildApiBase: true,
          hasLocalEngine: true,
        },
        hasUsableCloudSession: false,
      }),
    ).toEqual({ action: "keep" });
  });

  it("keeps when persisted mode equals the build mode", () => {
    expect(
      planMobileRuntimeModeReconcile({
        persistedMode: "cloud",
        build: cloudOnlyBuild,
        hasUsableCloudSession: false,
      }),
    ).toEqual({ action: "keep" });
  });

  it("keeps when nothing is persisted", () => {
    expect(
      planMobileRuntimeModeReconcile({
        persistedMode: null,
        build: localBuild,
        hasUsableCloudSession: false,
      }),
    ).toEqual({ action: "keep" });
  });

  it("never reconciles user-configured external targets (remote-mac / tunnel-to-mobile)", () => {
    for (const persistedMode of ["remote-mac", "tunnel-to-mobile"] as const) {
      expect(
        planMobileRuntimeModeReconcile({
          persistedMode,
          build: cloudOnlyBuild,
          hasUsableCloudSession: false,
        }),
      ).toEqual({ action: "keep" });
      expect(
        planMobileRuntimeModeReconcile({
          persistedMode,
          build: localBuild,
          hasUsableCloudSession: false,
        }),
      ).toEqual({ action: "keep" });
    }
  });
});

describe("readMobileRuntimeBuildTruth — build-stamped native truth", () => {
  it("reads an iOS local sideload build (build:ios:local lane)", () => {
    expect(
      readMobileRuntimeBuildTruth("ios", {
        VITE_ELIZA_IOS_RUNTIME_MODE: "local",
      }),
    ).toEqual({
      platform: "ios",
      buildMode: "local",
      hasBuildApiBase: false,
      hasLocalEngine: true,
    });
  });

  it("reads an iOS cloud store build with a stamped apiBase", () => {
    expect(
      readMobileRuntimeBuildTruth("ios", {
        VITE_ELIZA_IOS_RUNTIME_MODE: "cloud",
        VITE_ELIZA_IOS_API_BASE: "https://agent.example",
      }),
    ).toEqual({
      platform: "ios",
      buildMode: "cloud",
      hasBuildApiBase: true,
      hasLocalEngine: false,
    });
  });

  it("treats a full-Bun iOS build as having a local engine even in cloud mode", () => {
    expect(
      readMobileRuntimeBuildTruth("ios", {
        VITE_ELIZA_IOS_RUNTIME_MODE: "cloud",
        VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "1",
      }).hasLocalEngine,
    ).toBe(true);
  });

  it("reads the Android sideload (local) and Play-Store (cloud) APK variants", () => {
    expect(
      readMobileRuntimeBuildTruth("android", {
        VITE_ELIZA_ANDROID_RUNTIME_MODE: "local",
      }),
    ).toEqual({
      platform: "android",
      buildMode: "local",
      hasBuildApiBase: false,
      hasLocalEngine: true,
    });
    expect(
      readMobileRuntimeBuildTruth("android", {
        VITE_ELIZA_ANDROID_RUNTIME_MODE: "cloud",
        VITE_ELIZA_MOBILE_API_BASE: "https://agent.example",
      }),
    ).toEqual({
      platform: "android",
      buildMode: "cloud",
      hasBuildApiBase: true,
      hasLocalEngine: false,
    });
  });
});

describe("reconcilePersistedMobileRuntimeModeAtBoot", () => {
  it("no-ops on web / non-native shells", () => {
    // No globalThis.Capacitor installed → not a native platform.
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");

    const applied = reconcilePersistedMobileRuntimeModeAtBoot({
      env: { VITE_ELIZA_IOS_RUNTIME_MODE: "local" },
    });

    expect(applied).toBeNull();
    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "cloud",
    );
  });

  it("corrects a stale cloud mode on an iOS local build and persists through both stores", async () => {
    installNativeCapacitorGlobal("ios");
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");

    const applied = reconcilePersistedMobileRuntimeModeAtBoot({
      env: { VITE_ELIZA_IOS_RUNTIME_MODE: "local" },
    });

    expect(applied).toEqual({ from: "cloud", to: "local" });
    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "local",
    );
    // The correction must reach Capacitor Preferences too — the stale value
    // originally came back FROM Preferences after a reinstall (#11030).
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledWith({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
        value: "local",
      });
    });
  });

  it("corrects a stale local mode on a cloud-only build (no engine) to cloud", () => {
    installNativeCapacitorGlobal("ios");
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "local");

    const applied = reconcilePersistedMobileRuntimeModeAtBoot({
      env: {
        VITE_ELIZA_IOS_RUNTIME_MODE: "cloud",
        VITE_ELIZA_IOS_API_BASE: "https://agent.example",
      },
    });

    expect(applied).toEqual({ from: "local", to: "cloud" });
    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "cloud",
    );
  });

  it("does NOT clobber a cloud mode backed by a live Steward session on a local build", () => {
    installNativeCapacitorGlobal("ios");
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "live-session-token");

    const applied = reconcilePersistedMobileRuntimeModeAtBoot({
      env: { VITE_ELIZA_IOS_RUNTIME_MODE: "local" },
    });

    expect(applied).toBeNull();
    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "cloud",
    );
  });

  it("does NOT clobber a cloud mode backed by a persisted cloud active-server", () => {
    installNativeCapacitorGlobal("ios");
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");
    window.localStorage.setItem(
      ACTIVE_SERVER_KEY,
      JSON.stringify({
        id: "cloud:agent-123",
        kind: "cloud",
        label: "Dedicated agent",
        apiBase: "https://agent-123.elizacloud.ai",
      }),
    );

    const applied = reconcilePersistedMobileRuntimeModeAtBoot({
      env: { VITE_ELIZA_IOS_RUNTIME_MODE: "local" },
    });

    expect(applied).toBeNull();
    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "cloud",
    );
  });

  it("no-ops when the persisted mode already matches the Android build", () => {
    installNativeCapacitorGlobal("android");
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "local");

    const applied = reconcilePersistedMobileRuntimeModeAtBoot({
      env: { VITE_ELIZA_ANDROID_RUNTIME_MODE: "local" },
    });

    expect(applied).toBeNull();
    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "local",
    );
  });

  it("corrects a stale cloud mode on the Android sideload (local) APK", () => {
    installNativeCapacitorGlobal("android");
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");

    const applied = reconcilePersistedMobileRuntimeModeAtBoot({
      env: { VITE_ELIZA_ANDROID_RUNTIME_MODE: "local" },
    });

    expect(applied).toEqual({ from: "cloud", to: "local" });
    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "local",
    );
  });
});
