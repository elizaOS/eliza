// @vitest-environment jsdom

/**
 * Unit coverage for persisting the mobile runtime mode (including the
 * server-target derivation). Capacitor Preferences + native detection mocked,
 * no real device.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  persistMobileRuntimeMode,
  persistMobileRuntimeModeForServerTarget,
} from "./mobile-runtime-mode";

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

describe("persistMobileRuntimeModeForServerTarget", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    capacitorState.isNative = true;
  });

  it("persists local mode to localStorage and Capacitor Preferences", async () => {
    persistMobileRuntimeModeForServerTarget("local");

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "local",
    );
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledWith({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
        value: "local",
      });
    });
  });

  it("removes the native preference when the target has no mobile mode", async () => {
    persistMobileRuntimeModeForServerTarget("");

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      null,
    );
    await vi.waitFor(() => {
      expect(preferencesRemoveMock).toHaveBeenCalledWith({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
      });
    });
  });
});

describe("persistMobileRuntimeMode (single write path)", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    capacitorState.isNative = true;
  });

  it("persists a direct mode write to both stores (used by boot reconciliation, #11030)", async () => {
    persistMobileRuntimeMode("local");

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "local",
    );
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledWith({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
        value: "local",
      });
    });
  });

  it("clears both stores when passed null", async () => {
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");

    persistMobileRuntimeMode(null);

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      null,
    );
    await vi.waitFor(() => {
      expect(preferencesRemoveMock).toHaveBeenCalledWith({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
      });
    });
  });
});
