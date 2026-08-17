/**
 * Verifies the runtime-chooser gate through the package's jsdom harness.
 * Cloud-only onboarding is the production default; Vite development and
 * explicit overrides expose local and remote choices, while the Play-Store
 * cloud-locked Android invariant remains absolute.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAndroidCloudBuild: vi.fn(() => false),
}));

vi.mock("../platform/android-runtime", () => ({
  isAndroidCloudBuild: mocks.isAndroidCloudBuild,
}));

import {
  isRuntimeChooserEnabled,
  RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY,
  resolveRuntimeChooserEnabled,
} from "./first-run-runtime-flag";

beforeEach(() => {
  localStorage.clear();
  mocks.isAndroidCloudBuild.mockReturnValue(false);
});

afterEach(() => {
  localStorage.clear();
});

describe("isRuntimeChooserEnabled", () => {
  it("keeps test mode cloud-only instead of mistaking DEV=true for the dev server", () => {
    expect(import.meta.env.DEV).toBe(true);
    expect(import.meta.env.MODE).toBe("test");
    expect(isRuntimeChooserEnabled()).toBe(false);
  });

  it("the localStorage '0' override disables the chooser", () => {
    localStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "0");
    expect(isRuntimeChooserEnabled()).toBe(false);
  });

  it("the localStorage '1' override enables the chooser without a rebuild", () => {
    localStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "1");
    expect(isRuntimeChooserEnabled()).toBe(true);
  });

  it("garbage override values fall back to the build default", () => {
    localStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "yes please");
    expect(isRuntimeChooserEnabled()).toBe(false);
  });

  it("the cloud-locked Android build can never re-enable the chooser", () => {
    mocks.isAndroidCloudBuild.mockReturnValue(true);
    localStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "1");
    expect(isRuntimeChooserEnabled()).toBe(false);
  });
});

describe("resolveRuntimeChooserEnabled", () => {
  const productionDefaults = {
    isCloudOnlyBuild: false,
    isCloudLockedAndroid: false,
    override: null,
    isViteDev: false,
    isBuildEnabled: false,
  } as const;

  it("keeps an unflagged production build cloud-only", () => {
    expect(resolveRuntimeChooserEnabled(productionDefaults)).toBe(false);
  });

  it("enables an unflagged Vite development build", () => {
    expect(
      resolveRuntimeChooserEnabled({
        ...productionDefaults,
        isViteDev: true,
      }),
    ).toBe(true);
  });

  it("allows an explicit build flag in production", () => {
    expect(
      resolveRuntimeChooserEnabled({
        ...productionDefaults,
        isBuildEnabled: true,
      }),
    ).toBe(true);
  });

  it("gives either explicit runtime override precedence over both defaults", () => {
    expect(
      resolveRuntimeChooserEnabled({
        ...productionDefaults,
        override: true,
      }),
    ).toBe(true);
    expect(
      resolveRuntimeChooserEnabled({
        ...productionDefaults,
        override: false,
        isViteDev: true,
        isBuildEnabled: true,
      }),
    ).toBe(false);
  });

  it("keeps a cloud-locked Android build disabled under every opt-in", () => {
    expect(
      resolveRuntimeChooserEnabled({
        isCloudOnlyBuild: false,
        isCloudLockedAndroid: true,
        override: true,
        isViteDev: true,
        isBuildEnabled: true,
      }),
    ).toBe(false);
  });

  it("keeps every cloud-only build disabled under every opt-in", () => {
    expect(
      resolveRuntimeChooserEnabled({
        isCloudOnlyBuild: true,
        isCloudLockedAndroid: false,
        override: true,
        isViteDev: true,
        isBuildEnabled: true,
      }),
    ).toBe(false);
  });
});
