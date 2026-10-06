// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const cloudLocked = vi.hoisted(() => vi.fn(() => false));
vi.mock("../platform/android-runtime", () => ({
  isAndroidCloudBuild: cloudLocked,
}));

import {
  isRuntimeChooserEnabled,
  RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY,
} from "./first-run-runtime-flag";
import { MOBILE_RUNTIME_MODE_STORAGE_KEY } from "./mobile-runtime-mode";

beforeEach(() => {
  localStorage.clear();
  cloudLocked.mockReturnValue(false);
  vi.stubEnv("VITE_ELIZA_ENABLE_RUNTIME_CHOOSER", "0");
  vi.stubEnv("MODE", "test");
});
afterEach(() => vi.unstubAllEnvs());

it("retains the saved remote setup path after its connection record was lost", () => {
  expect(isRuntimeChooserEnabled()).toBe(false);
  localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "remote-mac");
  expect(isRuntimeChooserEnabled()).toBe(true);
  expect(localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
    "remote-mac",
  );
});

it("keeps Cloud/store locks and explicit chooser preference authoritative", () => {
  localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "remote-mac");
  expect(isRuntimeChooserEnabled(true)).toBe(false);
  cloudLocked.mockReturnValue(true);
  expect(isRuntimeChooserEnabled()).toBe(false);
  cloudLocked.mockReturnValue(false);
  localStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "0");
  expect(isRuntimeChooserEnabled()).toBe(false);
});

it.each(["cloud", "local", "cloud-hybrid"])(
  "does not replace ordinary %s first-run policy",
  (mode) => {
    localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, mode);
    expect(isRuntimeChooserEnabled()).toBe(false);
  },
);
