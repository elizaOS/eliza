import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  applyAndroidCleartextPolicy,
  ANDROID_CLOUD_STRIPPED_COMPONENTS,
  ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
  ANDROID_CLOUD_STRIPPED_PERMISSIONS,
  ANDROID_PERMISSIONS,
  IOS_OFFICIAL_PODS,
  isIosAppStoreBuild,
  resolveIosBuildTarget,
  resolveIosCustomPods,
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

test("AOSP Android keeps assistant/full-control permissions in the system manifest overlay", () => {
  for (const permission of [
    "PACKAGE_USAGE_STATS",
    "MANAGE_APP_OPS_MODES",
    "MANAGE_VIRTUAL_MACHINE",
    "READ_FRAME_BUFFER",
    "INJECT_EVENTS",
    "REAL_GET_TASKS",
    "FOREGROUND_SERVICE_MEDIA_PROJECTION",
    "FOREGROUND_SERVICE_SPECIAL_USE",
    "RECEIVE_BOOT_COMPLETED",
    "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  ]) {
    assert.ok(
      ANDROID_PERMISSIONS.includes(permission),
      `ANDROID_PERMISSIONS should include ${permission}`,
    );
  }
});

test("Google Play Android strips AOSP assistant/full-control components and permissions", () => {
  for (const component of [
    "ElizaAssistActivity",
    "ElizaAgentService",
    "ElizaBootReceiver",
  ]) {
    assert.ok(
      ANDROID_CLOUD_STRIPPED_COMPONENTS.includes(component),
      `android-cloud should strip ${component}`,
    );
  }
  for (const permission of [
    "PACKAGE_USAGE_STATS",
    "MANAGE_APP_OPS_MODES",
    "READ_FRAME_BUFFER",
    "INJECT_EVENTS",
    "REAL_GET_TASKS",
    "FOREGROUND_SERVICE_MEDIA_PROJECTION",
    "FOREGROUND_SERVICE_SPECIAL_USE",
    "RECEIVE_BOOT_COMPLETED",
  ]) {
    assert.ok(
      ANDROID_CLOUD_STRIPPED_PERMISSIONS.includes(permission),
      `android-cloud should strip ${permission}`,
    );
  }
  assert.ok(
    ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS.some(
      ([pkg]) => pkg === "@elizaos/capacitor-screencapture",
    ),
    "android-cloud should strip the MediaProjection screen-capture plugin",
  );
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

test("resolveMobileBuildPolicy keeps App Store iOS local-runtime capable", () => {
  assert.deepEqual(resolveMobileBuildPolicy("ios"), {
    capacitorTarget: "ios",
    buildVariant: "store",
    androidRuntimeMode: null,
    iosRuntimeMode: "cloud-hybrid",
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

test("iOS App Store pod selection keeps no-JIT Bun local runtime and leaves llama optional", () => {
  const pods = resolveIosCustomPods({
    appStoreBuild: true,
    includeLlama: false,
    includeFullBunEngine: true,
  }).map(([name]) => name);

  assert.equal(isIosAppStoreBuild({ ELIZA_BUILD_VARIANT: "store" }), true);
  assert.equal(pods.includes("LlamaCppCapacitor"), false);
  assert.equal(pods.includes("ElizaosCapacitorBunRuntime"), true);
  assert.equal(pods.includes("ElizaosCapacitorMobileAgentBridge"), false);
  assert.equal(pods.includes("ElizaBunEngine"), true);
});

test("iOS direct full-Bun pod selection includes local execution bridge pods", () => {
  const pods = resolveIosCustomPods({
    appStoreBuild: false,
    includeLlama: true,
    includeFullBunEngine: true,
  }).map(([name]) => name);

  assert.equal(pods.includes("LlamaCppCapacitor"), true);
  assert.equal(pods.includes("ElizaosCapacitorBunRuntime"), true);
  assert.equal(pods.includes("ElizaosCapacitorMobileAgentBridge"), true);
  assert.equal(pods.includes("ElizaBunEngine"), true);
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

test("Mac App Store entitlements scope JIT to Bun and reject broad executable-memory exceptions", () => {
  const entitlementsRoot = path.join(
    import.meta.dirname,
    "..",
    "platforms",
    "electrobun",
    "entitlements",
  );
  const parent = fs.readFileSync(
    path.join(entitlementsRoot, "mas.entitlements"),
    "utf8",
  );
  const child = fs.readFileSync(
    path.join(entitlementsRoot, "mas-child.entitlements"),
    "utf8",
  );
  const bun = fs.readFileSync(
    path.join(entitlementsRoot, "mas-bun.entitlements"),
    "utf8",
  );

  for (const content of [parent, child, bun]) {
    assert.equal(
      content.includes("com.apple.security.cs.allow-unsigned-executable-memory"),
      false,
    );
    assert.equal(
      content.includes("com.apple.security.cs.disable-library-validation"),
      false,
    );
  }
  assert.equal(parent.includes("com.apple.security.cs.allow-jit"), false);
  assert.equal(child.includes("com.apple.security.cs.allow-jit"), false);
  assert.equal(bun.includes("com.apple.security.cs.allow-jit"), true);
});
