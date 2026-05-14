import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  applyAndroidCleartextPolicy,
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

test("Android manifest cleartext policy can be stamped per target", () => {
  const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name" android:usesCleartextTraffic="true">
    </application>
</manifest>`;

  assert.match(
    applyAndroidCleartextPolicy(manifest, { allowCleartext: false }),
    /android:usesCleartextTraffic="false"/,
  );
  assert.match(
    applyAndroidCleartextPolicy(manifest, { allowCleartext: true }),
    /android:usesCleartextTraffic="true"/,
  );
});

test("Android manifest cleartext policy is inserted when absent", () => {
  const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
    </application>
</manifest>`;

  assert.match(
    applyAndroidCleartextPolicy(manifest, { allowCleartext: false }),
    /<application\s+android:usesCleartextTraffic="false"\s+android:label/,
  );
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

test("iOS app entitlements do not request JIT or dynamic code signing", () => {
  const entitlementsPath = path.join(
    import.meta.dirname,
    "..",
    "platforms",
    "ios",
    "App",
    "App",
    "App.entitlements",
  );
  const entitlements = fs.readFileSync(entitlementsPath, "utf8");
  assert.equal(entitlements.includes("com.apple.security.cs.allow-jit"), false);
  assert.equal(
    entitlements.includes("com.apple.security.cs.allow-dyld-environment-variables"),
    false,
  );
  assert.equal(
    entitlements.includes("com.apple.security.cs.disable-library-validation"),
    false,
  );
});
