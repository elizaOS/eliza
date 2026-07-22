// @vitest-environment jsdom

/**
 * Verifies that native Preferences hydration restores launch-critical storage
 * before the web shell reads its first-run and Simulator smoke state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const nativePreferences = vi.hoisted(() => ({
  values: new Map<string, string>(),
  get: vi.fn<(options: { key: string }) => Promise<{ value: string | null }>>(),
  set: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "ios",
    isNativePlatform: () => true,
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: nativePreferences.get,
    set: nativePreferences.set,
    remove: nativePreferences.remove,
  },
}));

vi.mock("../surface-realm-channel", () => ({
  runAsPrivilegedShell: <T>(operation: () => T): T => operation(),
}));

import { getStorageValue, initializeStorageBridge } from "./storage-bridge";

describe("initializeStorageBridge", () => {
  beforeEach(() => {
    nativePreferences.values.clear();
    nativePreferences.get.mockReset();
    nativePreferences.get.mockImplementation(async ({ key }) => ({
      value: nativePreferences.values.get(key) ?? null,
    }));
    nativePreferences.set.mockClear();
    nativePreferences.remove.mockClear();
    window.localStorage.clear();
  });

  it("hydrates Cloud onboarding smoke state on a cold native launch", async () => {
    const request = JSON.stringify({ mode: "tap", requestedAt: 1 });
    const result = JSON.stringify({ ok: true, phase: "complete" });
    nativePreferences.values.set(
      "eliza:ios-cloud-onboarding-smoke:request",
      request,
    );
    nativePreferences.values.set(
      "eliza:ios-cloud-onboarding-smoke:result",
      result,
    );

    expect(
      await getStorageValue("eliza:ios-cloud-onboarding-smoke:request"),
    ).toBe(request);
    await initializeStorageBridge();

    expect(nativePreferences.get).toHaveBeenCalledWith({
      key: "eliza:ios-cloud-onboarding-smoke:request",
    });
    expect(nativePreferences.get).toHaveBeenCalledWith({
      key: "eliza:ios-cloud-onboarding-smoke:result",
    });
    expect(
      Storage.prototype.getItem.call(
        window.localStorage,
        "eliza:ios-cloud-onboarding-smoke:request",
      ),
    ).toBe(request);
    expect(
      Storage.prototype.getItem.call(
        window.localStorage,
        "eliza:ios-cloud-onboarding-smoke:result",
      ),
    ).toBe(result);
  });
});
