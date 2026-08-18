/**
 * Android renderer freshness tests cover the pure decisions behind the device
 * runner's APK install guard. The adb-facing readback is exercised by device
 * evidence; these tests keep the stale-install policy deterministic without an
 * attached emulator.
 */
import { describe, expect, it } from "vitest";

import {
  androidApkNeedsBuild,
  androidDistNeedsBuild,
  androidInstallDecision,
} from "../scripts/lib/android-device.mjs";
import { compareAndroidRendererBuildIds } from "../scripts/lib/android-renderer-stamp.mjs";

const CURRENT_COMMIT = "a".repeat(40);
const STALE_COMMIT = "b".repeat(40);

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
          commit: CURRENT_COMMIT,
          capacitorTarget: "ios",
        },
        headCommit: CURRENT_COMMIT,
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
          commit: STALE_COMMIT,
          capacitorTarget: "android",
        },
        headCommit: CURRENT_COMMIT,
      }),
    ).toMatchObject({
      build: true,
      reason: expect.stringContaining(`dist commit=${STALE_COMMIT}`),
    });
  });

  it("accepts a matching Android dist stamp", () => {
    expect(
      androidDistNeedsBuild({
        freshStamp: {
          buildId: "same",
          commit: CURRENT_COMMIT,
          capacitorTarget: "android",
        },
        headCommit: CURRENT_COMMIT,
      }),
    ).toEqual({ build: false, reason: "dist renderer stamp is usable" });
  });

  it("rejects abbreviated or missing Android dist commits", () => {
    for (const commit of [null, CURRENT_COMMIT.slice(0, 12)]) {
      expect(
        androidDistNeedsBuild({
          freshStamp: {
            buildId: "same",
            commit,
            capacitorTarget: "android",
          },
          headCommit: CURRENT_COMMIT,
        }),
      ).toMatchObject({ build: true });
    }
  });

  it("installs when the device has no readable installed stamp", () => {
    expect(
      androidInstallDecision({
        freshStamp: { buildId: "fresh", commit: CURRENT_COMMIT },
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
        freshStamp: { buildId: "fresh", commit: CURRENT_COMMIT },
        installedStamp: { buildId: "old", commit: STALE_COMMIT },
      }),
    ).toEqual({
      install: true,
      reason: "installed old != fresh fresh",
    });
  });

  it("skips install only when installed buildId and full commit match", () => {
    expect(
      androidInstallDecision({
        freshStamp: { buildId: "fresh", commit: CURRENT_COMMIT },
        installedStamp: { buildId: "fresh", commit: CURRENT_COMMIT },
      }),
    ).toEqual({
      install: false,
      reason: "installed buildId and commit match fresh fresh",
    });
  });

  it("installs when equal buildIds carry a stale or malformed commit", () => {
    for (const commit of [null, CURRENT_COMMIT.slice(0, 12), STALE_COMMIT]) {
      expect(
        androidInstallDecision({
          freshStamp: { buildId: "fresh", commit: CURRENT_COMMIT },
          installedStamp: { buildId: "fresh", commit },
        }),
      ).toMatchObject({ install: true });
    }
  });

  it("refuses install decisions from a stale fresh renderer stamp", () => {
    expect(() =>
      androidInstallDecision({
        freshStamp: { buildId: "fresh", commit: STALE_COMMIT },
        installedStamp: null,
        expectedCommit: CURRENT_COMMIT,
      }),
    ).toThrow(/does not match expected HEAD/);
  });

  it("requires an APK rebuild when the packaged stamp is missing", () => {
    expect(
      androidApkNeedsBuild({
        freshStamp: { buildId: "fresh", commit: CURRENT_COMMIT },
        apkStamp: null,
      }),
    ).toMatchObject({
      build: true,
      reason: expect.stringContaining("APK has no readable"),
    });
  });

  it("requires an APK rebuild when the packaged buildId differs from fresh dist", () => {
    expect(
      androidApkNeedsBuild({
        freshStamp: { buildId: "fresh", commit: CURRENT_COMMIT },
        apkStamp: { buildId: "old", commit: STALE_COMMIT },
      }),
    ).toEqual({
      build: true,
      reason: "APK old != fresh fresh",
    });
  });

  it("accepts an APK whose packaged buildId and full commit match fresh dist", () => {
    expect(
      androidApkNeedsBuild({
        freshStamp: { buildId: "fresh", commit: CURRENT_COMMIT },
        apkStamp: { buildId: "fresh", commit: CURRENT_COMMIT },
      }),
    ).toEqual({
      build: false,
      reason: "APK buildId and commit match fresh fresh",
    });
  });

  it("rebuilds when equal APK buildIds carry a stale or malformed commit", () => {
    for (const commit of [null, CURRENT_COMMIT.slice(0, 12), STALE_COMMIT]) {
      expect(
        androidApkNeedsBuild({
          freshStamp: { buildId: "fresh", commit: CURRENT_COMMIT },
          apkStamp: { buildId: "fresh", commit },
        }),
      ).toMatchObject({ build: true });
    }
  });

  it("refuses APK decisions from a stale fresh renderer stamp", () => {
    expect(() =>
      androidApkNeedsBuild({
        freshStamp: { buildId: "fresh", commit: STALE_COMMIT },
        apkStamp: null,
        expectedCommit: CURRENT_COMMIT,
      }),
    ).toThrow(/does not match expected HEAD/);
  });

  it("rejects a packaged APK whose renderer buildId differs from fresh dist", () => {
    expect(() =>
      compareAndroidRendererBuildIds({
        fresh: { buildId: "fresh" },
        packaged: { buildId: "old" },
      }),
    ).toThrow(/stale Android APK/);
  });

  it("does not let matching buildIds hide a stale packaged commit", () => {
    expect(() =>
      compareAndroidRendererBuildIds({
        fresh: { buildId: "fresh", commit: CURRENT_COMMIT },
        packaged: { buildId: "fresh", commit: STALE_COMMIT },
        expectedCommit: CURRENT_COMMIT,
      }),
    ).toThrow(/stale Android APK/);
  });
});
