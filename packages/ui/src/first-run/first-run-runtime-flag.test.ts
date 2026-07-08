// @vitest-environment jsdom

/**
 * The runtime-chooser gate (#13377/#15527): cloud-only onboarding is the
 * default on web/desktop builds; the localStorage override flips it without a
 * rebuild; the Play-Store cloud-locked Android build can never re-enable it;
 * and Android local sideload/system builds follow the same cloud-only default
 * unless a developer/test lane opts into the chooser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAndroidCloudBuild: vi.fn(() => false),
  isAndroidLocalSideloadBuild: vi.fn(() => false),
}));

vi.mock("../platform/android-runtime", () => ({
  isAndroidCloudBuild: mocks.isAndroidCloudBuild,
  isAndroidLocalSideloadBuild: mocks.isAndroidLocalSideloadBuild,
}));

import {
  isRuntimeChooserEnabled,
  RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY,
} from "./first-run-runtime-flag";

beforeEach(() => {
  localStorage.clear();
  mocks.isAndroidCloudBuild.mockReturnValue(false);
  mocks.isAndroidLocalSideloadBuild.mockReturnValue(false);
});

afterEach(() => {
  localStorage.clear();
});

describe("isRuntimeChooserEnabled", () => {
  it("defaults to OFF — cloud-only onboarding is the production default", () => {
    expect(isRuntimeChooserEnabled()).toBe(false);
  });

  it("the localStorage override enables the chooser without a rebuild", () => {
    localStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "1");
    expect(isRuntimeChooserEnabled()).toBe(true);
  });

  it("an explicit '0' override keeps the chooser off", () => {
    localStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "0");
    expect(isRuntimeChooserEnabled()).toBe(false);
  });

  it("garbage override values fall back to the build default (off)", () => {
    localStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "yes please");
    expect(isRuntimeChooserEnabled()).toBe(false);
  });

  it("the cloud-locked Android build can never re-enable the chooser", () => {
    mocks.isAndroidCloudBuild.mockReturnValue(true);
    localStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "1");
    expect(isRuntimeChooserEnabled()).toBe(false);
  });

  it("the Android local sideload build still defaults the chooser OFF", () => {
    mocks.isAndroidLocalSideloadBuild.mockReturnValue(true);
    expect(isRuntimeChooserEnabled()).toBe(false);
  });

  it("an explicit '1' override enables the chooser on the sideload build", () => {
    mocks.isAndroidLocalSideloadBuild.mockReturnValue(true);
    localStorage.setItem(RUNTIME_CHOOSER_OVERRIDE_STORAGE_KEY, "1");
    expect(isRuntimeChooserEnabled()).toBe(true);
  });
});
