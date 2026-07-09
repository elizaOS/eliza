/**
 * Verifies Android APK discovery across the app-core build output and explicit
 * caller overrides without touching an attached device.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveApk } from "./android-device.mjs";

describe("resolveApk", () => {
  it("selects the first existing canonical build artifact", () => {
    const appCoreApk =
      "/repo/packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk";
    const staleAppApk =
      "/repo/packages/app/android/app/build/outputs/apk/debug/app-debug.apk";

    assert.equal(
      resolveApk(null, {
        candidates: [appCoreApk, staleAppApk],
        existsSync: (candidate) => candidate === appCoreApk,
      }),
      appCoreApk,
    );
  });

  it("validates an explicit caller path", () => {
    const explicit = "build/custom.apk";
    assert.equal(
      resolveApk(explicit, { existsSync: () => true }),
      path.resolve(explicit),
    );
    assert.throws(
      () => resolveApk(explicit, { existsSync: () => false }),
      /APK not found/,
    );
  });

  it("fails when no canonical artifact exists", () => {
    assert.throws(
      () =>
        resolveApk(null, {
          candidates: ["/missing/app-debug.apk"],
          existsSync: () => false,
        }),
      /No debug APK found/,
    );
  });
});
