/**
 * Verifies Android APK discovery across the app build output and explicit
 * caller overrides without touching an attached device.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  androidApkNeedsBuild,
  androidDistNeedsBuild,
  androidInstallDecision,
  resolveApk,
} from "./android-device.ts";

describe("resolveApk", () => {
  it("selects the first existing canonical build artifact", () => {
    const appCoreApk =
      "/repo/packages/app/platforms/android/app/build/outputs/apk/debug/app-debug.apk";
    const staleAppApk =
      "/repo/packages/app/android/app/build/outputs/apk/debug/app-debug.apk";

    expect(
      resolveApk(null, {
        candidates: [appCoreApk, staleAppApk],
        existsSync: (candidate) => candidate === appCoreApk,
      }),
    ).toBe(appCoreApk);
  });

  it("validates an explicit caller path", () => {
    const explicit = "build/custom.apk";
    expect(resolveApk(explicit, { existsSync: () => true })).toBe(
      path.resolve(explicit),
    );
    expect(() => resolveApk(explicit, { existsSync: () => false })).toThrow(
      /APK not found/,
    );
  });

  it("fails when no canonical artifact exists", () => {
    expect(() =>
      resolveApk(null, {
        candidates: ["/missing/app-debug.apk"],
        existsSync: () => false,
      }),
    ).toThrow(/No debug APK found/);
  });
});

describe("Android renderer revision admission", () => {
  it.each([null, "a".repeat(40), "b".repeat(10), "b".repeat(40)])(
    "requires the complete current revision: %s",
    (commit) => {
      const headCommit = "b".repeat(40);
      const result = androidDistNeedsBuild({
        freshStamp: { commit, capacitorTarget: "android" },
        headCommit,
      });
      expect(result.build).toBe(commit !== headCommit);
    },
  );
});

describe("Android packaged and installed renderer revision admission", () => {
  it.each([null, "a".repeat(40), "b".repeat(40)])(
    "rejects matching content with a stale or absent APK revision: %s",
    (commit) => {
      const freshStamp = { buildId: "same-content", commit: "b".repeat(40) };
      const apkStamp = { buildId: "same-content", commit };
      expect(androidApkNeedsBuild({ freshStamp, apkStamp }).build).toBe(
        commit !== freshStamp.commit,
      );
    },
  );
  it.each([null, "a".repeat(40), "b".repeat(40)])(
    "reinstalls matching content with a stale or absent installed revision: %s",
    (commit) => {
      const freshStamp = { buildId: "same-content", commit: "b".repeat(40) };
      const installedStamp = { buildId: "same-content", commit };
      expect(
        androidInstallDecision({ freshStamp, installedStamp }).install,
      ).toBe(commit !== freshStamp.commit);
    },
  );
});
