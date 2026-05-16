import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @capacitor/app, @capacitor/browser, @capacitor/device before importing the module under test.
vi.mock("@capacitor/app", () => ({
  App: {
    getInfo: vi.fn(),
  },
}));

vi.mock("@capacitor/browser", () => ({
  Browser: {
    open: vi.fn(),
  },
}));

vi.mock("@capacitor/device", () => ({
  Device: {
    getInfo: vi.fn(),
  },
}));

import { App } from "@capacitor/app";
import { Device } from "@capacitor/device";
import { AndroidUpdateChecker } from "./android-update-checker";

const mockDeviceInfo = (platform: string) => {
  vi.mocked(Device.getInfo).mockResolvedValue({ platform } as Awaited<
    ReturnType<typeof Device.getInfo>
  >);
};

const mockAppInfo = (version: string, build: string) => {
  vi.mocked(App.getInfo).mockResolvedValue({ version, build } as Awaited<
    ReturnType<typeof App.getInfo>
  >);
};

const STABLE_MANIFEST_URL =
  "https://github.com/elizaOS/eliza/releases/latest/download/android-update-manifest-stable.json";

function makeManifest(versionCode: number) {
  return {
    schemaVersion: 1,
    channel: "stable" as const,
    latestVersion: `1.0.${versionCode}`,
    versionCode,
    releaseDate: "2026-01-01",
    downloadUrl: "https://example.com/Eliza.apk",
    sha256: "abc123",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  // Default: not android
  mockDeviceInfo("web");
  // Default import.meta.env
  vi.stubEnv("VITE_ANDROID_BUILD_VARIANT", "");
});

describe("AndroidUpdateChecker.check()", () => {
  it("returns null when platform is not android", async () => {
    mockDeviceInfo("ios");
    vi.stubEnv("VITE_ANDROID_BUILD_VARIANT", "sideload");

    const result = await AndroidUpdateChecker.check();

    expect(result).toBeNull();
  });

  it("returns null when VITE_ANDROID_BUILD_VARIANT is not 'sideload'", async () => {
    mockDeviceInfo("android");
    vi.stubEnv("VITE_ANDROID_BUILD_VARIANT", "playstore");

    const result = await AndroidUpdateChecker.check();

    expect(result).toBeNull();
  });

  it("returns updateAvailable: false when manifest versionCode equals current build", async () => {
    mockDeviceInfo("android");
    vi.stubEnv("VITE_ANDROID_BUILD_VARIANT", "sideload");
    mockAppInfo("1.0.10", "10");

    const manifest = makeManifest(10);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => manifest,
    } as Response);

    const result = await AndroidUpdateChecker.check("stable");

    expect(result).not.toBeNull();
    expect(result?.updateAvailable).toBe(false);
    expect(result?.currentVersionCode).toBe(10);
  });

  it("returns updateAvailable: true when manifest versionCode is higher than current build", async () => {
    mockDeviceInfo("android");
    vi.stubEnv("VITE_ANDROID_BUILD_VARIANT", "sideload");
    mockAppInfo("1.0.10", "10");

    const manifest = makeManifest(11);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => manifest,
    } as Response);

    const result = await AndroidUpdateChecker.check("stable");

    expect(result).not.toBeNull();
    expect(result?.updateAvailable).toBe(true);
    expect(result?.manifest.versionCode).toBe(11);
  });

  it("returns null and does not throw on network error", async () => {
    mockDeviceInfo("android");
    vi.stubEnv("VITE_ANDROID_BUILD_VARIANT", "sideload");
    mockAppInfo("1.0.10", "10");

    global.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

    const result = await AndroidUpdateChecker.check("stable");

    expect(result).toBeNull();
  });

  it("returns null and does not throw on non-ok HTTP response", async () => {
    mockDeviceInfo("android");
    vi.stubEnv("VITE_ANDROID_BUILD_VARIANT", "sideload");
    mockAppInfo("1.0.10", "10");

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    const result = await AndroidUpdateChecker.check("stable");

    expect(result).toBeNull();
  });

  it("skips check and returns null if last check was under 24h ago", async () => {
    mockDeviceInfo("android");
    vi.stubEnv("VITE_ANDROID_BUILD_VARIANT", "sideload");
    mockAppInfo("1.0.10", "10");

    // Set last check to 1 hour ago
    localStorage.setItem(
      "elizaos_android_update_last_check",
      String(Date.now() - 60 * 60 * 1000)
    );

    global.fetch = vi.fn();

    const result = await AndroidUpdateChecker.check("stable");

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches correct stable manifest URL", async () => {
    mockDeviceInfo("android");
    vi.stubEnv("VITE_ANDROID_BUILD_VARIANT", "sideload");
    mockAppInfo("1.0.10", "10");

    const manifest = makeManifest(10);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => manifest,
    } as Response);

    await AndroidUpdateChecker.check("stable");

    expect(global.fetch).toHaveBeenCalledWith(STABLE_MANIFEST_URL, expect.any(Object));
  });
});
