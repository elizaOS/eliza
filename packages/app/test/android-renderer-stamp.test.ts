/**
 * Android renderer freshness tests cover the pure decisions behind the device
 * runner's APK install guard. The adb-facing readback is exercised by device
 * evidence; these tests keep the stale-install policy deterministic without an
 * attached emulator.
 */
import { describe, expect, it } from "vitest";

import {
  androidDistNeedsBuild,
  androidInstallDecision,
} from "../scripts/lib/android-device.mjs";
import { compareAndroidRendererBuildIds } from "../scripts/lib/android-renderer-stamp.mjs";

describe("Android renderer stamp decisions", () => {
  it("requires a build when dist has no renderer stamp", () => {
    expect(androidDistNeedsBuild({ freshStamp: null })).toMatchObject({
      build: true,
      reason: expect.stringContaining("dist has no"),
    });
  });

  it("requires a build when dist was baked for another Capacitor target", () => {
    expect(
      androidDistNeedsBuild({
        freshStamp: {
          buildId: "same",
          commit: "abc123",
          capacitorTarget: "ios",
        },
        headCommit: "abc123",
      }),
    ).toMatchObject({
      build: true,
      reason: expect.stringContaining("capacitorTarget=ios"),
    });
  });

  it("requires a build when dist belongs to another commit", () => {
    expect(
      androidDistNeedsBuild({
        freshStamp: {
          buildId: "same",
          commit: "111111111111",
          capacitorTarget: "android",
        },
        headCommit: "222222222222",
      }),
    ).toMatchObject({
      build: true,
      reason: expect.stringContaining("dist commit=111111111111"),
    });
  });

  it("accepts a matching Android dist stamp", () => {
    expect(
      androidDistNeedsBuild({
        freshStamp: {
          buildId: "same",
          commit: "abcdef123456",
          capacitorTarget: "android",
        },
        headCommit: "abcdef1234567890",
      }),
    ).toEqual({ build: false, reason: "dist renderer stamp is usable" });
  });

  it("installs when the device has no readable installed stamp", () => {
    expect(
      androidInstallDecision({
        freshStamp: { buildId: "fresh" },
        installedStamp: null,
      }),
    ).toMatchObject({
      install: true,
      reason: expect.stringContaining("no readable"),
    });
  });

  it("installs when the installed buildId differs from fresh dist", () => {
    expect(
      androidInstallDecision({
        freshStamp: { buildId: "fresh" },
        installedStamp: { buildId: "old" },
      }),
    ).toEqual({
      install: true,
      reason: "installed old != fresh fresh",
    });
  });

  it("skips install when installed and fresh buildIds match", () => {
    expect(
      androidInstallDecision({
        freshStamp: { buildId: "fresh" },
        installedStamp: { buildId: "fresh" },
      }),
    ).toEqual({
      install: false,
      reason: "installed buildId matches fresh fresh",
    });
  });

  it("rejects a packaged APK whose renderer buildId differs from fresh dist", () => {
    expect(() =>
      compareAndroidRendererBuildIds({
        fresh: { buildId: "fresh" },
        packaged: { buildId: "old" },
      }),
    ).toThrow(/stale Android APK/);
  });
});
