import assert from "node:assert/strict";
import test from "node:test";

import {
  IOS_OFFICIAL_PODS,
  resolveIosBuildTarget,
  resolveMobileBuildPolicy,
} from "./run-mobile-build.mjs";

test("resolveMobileBuildPolicy marks Google Play Android as a store-managed cloud client", () => {
  assert.deepEqual(resolveMobileBuildPolicy("android-cloud"), {
    capacitorTarget: "android",
    buildVariant: "store",
    androidRuntimeMode: "cloud",
    iosRuntimeMode: null,
    releaseAuthority: "google-play",
    appControlledOta: false,
  });
});

test("resolveMobileBuildPolicy marks sideload Android as direct but installer-consent managed", () => {
  assert.deepEqual(resolveMobileBuildPolicy("android"), {
    capacitorTarget: "android",
    buildVariant: "direct",
    androidRuntimeMode: "local",
    iosRuntimeMode: null,
    releaseAuthority: "github-release-android-package-installer",
    appControlledOta: false,
  });
});

test("resolveMobileBuildPolicy marks AOSP Android as an OTA-owned system image", () => {
  assert.deepEqual(resolveMobileBuildPolicy("android-system"), {
    capacitorTarget: "android",
    buildVariant: "direct",
    androidRuntimeMode: "local",
    iosRuntimeMode: null,
    releaseAuthority: "aosp-ota",
    appControlledOta: false,
  });
});

test("resolveMobileBuildPolicy separates App Store iOS from local iOS builds", () => {
  assert.deepEqual(resolveMobileBuildPolicy("ios"), {
    capacitorTarget: "ios",
    buildVariant: "store",
    androidRuntimeMode: null,
    iosRuntimeMode: "cloud",
    releaseAuthority: "apple-app-store",
    appControlledOta: false,
  });
  assert.deepEqual(resolveMobileBuildPolicy("ios-local"), {
    capacitorTarget: "ios",
    buildVariant: "direct",
    androidRuntimeMode: null,
    iosRuntimeMode: "local",
    releaseAuthority: "developer-toolchain",
    appControlledOta: false,
  });
});

test("resolveIosBuildTarget honors simulator overrides used by local iOS smoke builds", () => {
  assert.deepEqual(
    resolveIosBuildTarget({
      env: {
        ELIZA_IOS_BUILD_DESTINATION: "generic/platform=iOS Simulator",
        ELIZA_IOS_BUILD_SDK: "iphonesimulator",
      },
      appDirValue: "/tmp/no-app",
    }),
    {
      destination: "generic/platform=iOS Simulator",
      sdk: "iphonesimulator",
      reason: "explicit environment override",
    },
  );
});

test("iOS background runner pod resolves through the official package", () => {
  assert.equal(
    IOS_OFFICIAL_PODS.find(
      ([name]) => name === "CapacitorBackgroundRunner",
    )?.[1],
    "@capacitor/background-runner",
  );
});
