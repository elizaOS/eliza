import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ANDROID_CLOUD_STRIPPED_COMPONENTS,
  ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
  ANDROID_CLOUD_STRIPPED_PERMISSIONS,
  ANDROID_CLOUD_STRIPPED_RESOURCE_FILES,
  ANDROID_PERMISSIONS,
  allowsAndroidCleartextForMobilePolicy,
  applyAndroidCleartextPolicy,
  configureIosAppStoreBuildDefaults,
  IOS_AGENT_RUNTIME_ASSETS,
  IOS_OFFICIAL_PODS,
  isIosAppStoreBuild,
  resolveIosAgentRuntimeAssetPlan,
  resolveIosBuildTarget,
  resolveIosCustomPods,
  resolveMobileBuildEnv,
  resolveMobileBuildPolicy,
} from "./run-mobile-build.mjs";

test("resolveMobileBuildPolicy marks Google Play Android as a store-managed cloud client", () => {
  assert.deepEqual(resolveMobileBuildPolicy("android-cloud"), {
    capacitorTarget: "android",
    buildVariant: "store",
    androidRuntimeMode: "cloud",
    iosRuntimeMode: null,
    runtimeExecutionMode: "cloud",
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
    runtimeExecutionMode: "local-yolo",
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
    runtimeExecutionMode: "local-yolo",
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
    "ElizaAccessibilityService",
    "ElizaAgentService",
    "ElizaBootReceiver",
    "ElizaNotificationListenerService",
    "ElizaVoiceCaptureService",
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
    "FOREGROUND_SERVICE_MICROPHONE",
    "FOREGROUND_SERVICE_SPECIAL_USE",
    "RECEIVE_BOOT_COMPLETED",
    "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
    "BIND_ACCESSIBILITY_SERVICE",
    "BIND_NOTIFICATION_LISTENER_SERVICE",
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
  assert.ok(
    ANDROID_CLOUD_STRIPPED_RESOURCE_FILES.includes(
      path.join("xml", "eliza_accessibility_service.xml"),
    ),
    "android-cloud should strip the accessibility-service resource",
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

test("Android cleartext policy follows local-agent runtime targets only", () => {
  assert.equal(allowsAndroidCleartextForMobilePolicy("android"), true);
  assert.equal(allowsAndroidCleartextForMobilePolicy("android-system"), true);
  assert.equal(allowsAndroidCleartextForMobilePolicy("android-cloud"), false);
  assert.equal(
    allowsAndroidCleartextForMobilePolicy("android-cloud-debug"),
    false,
  );
});

test("resolveMobileBuildEnv exposes a shared mobile runtime mode for native shells", () => {
  const androidCloud = resolveMobileBuildEnv("android-cloud", {});
  assert.equal(androidCloud.ELIZA_CAPACITOR_BUILD_TARGET, "android");
  assert.equal(androidCloud.VITE_ELIZA_ANDROID_RUNTIME_MODE, "cloud");
  assert.equal(androidCloud.VITE_ELIZA_MOBILE_RUNTIME_MODE, "cloud");
  assert.equal(androidCloud.VITE_ELIZA_RUNTIME_MODE, "cloud");
  assert.equal(androidCloud.ELIZA_RELEASE_AUTHORITY, "google-play");

  const iosStore = resolveMobileBuildEnv("ios", {});
  assert.equal(iosStore.ELIZA_CAPACITOR_BUILD_TARGET, "ios");
  assert.equal(iosStore.VITE_ELIZA_IOS_RUNTIME_MODE, "cloud-hybrid");
  assert.equal(iosStore.VITE_ELIZA_MOBILE_RUNTIME_MODE, "cloud-hybrid");
  assert.equal(iosStore.VITE_ELIZA_RUNTIME_MODE, "local-safe");
  assert.equal(iosStore.ELIZA_RELEASE_AUTHORITY, "apple-app-store");
  assert.equal(iosStore.VITE_ELIZA_IOS_FULL_BUN_AVAILABLE, "1");
});

test("resolveMobileBuildPolicy keeps App Store iOS local-runtime capable", () => {
  assert.deepEqual(resolveMobileBuildPolicy("ios"), {
    capacitorTarget: "ios",
    buildVariant: "store",
    androidRuntimeMode: null,
    iosRuntimeMode: "cloud-hybrid",
    runtimeExecutionMode: "local-safe",
    releaseAuthority: "apple-app-store",
    appControlledOta: false,
  });
  assert.deepEqual(resolveMobileBuildPolicy("ios-local"), {
    capacitorTarget: "ios",
    buildVariant: "direct",
    androidRuntimeMode: null,
    iosRuntimeMode: "local",
    runtimeExecutionMode: "local-safe",
    releaseAuthority: "developer-toolchain",
    appControlledOta: false,
  });
});

test("configureIosAppStoreBuildDefaults bakes the same local-safe runtime env", () => {
  const keys = [
    "ELIZA_CAPACITOR_BUILD_TARGET",
    "ELIZA_BUILD_VARIANT",
    "ELIZA_RELEASE_AUTHORITY",
    "ELIZA_IOS_RUNTIME_MODE",
    "VITE_ELIZA_IOS_RUNTIME_MODE",
    "ELIZA_RUNTIME_MODE",
    "RUNTIME_MODE",
    "LOCAL_RUNTIME_MODE",
    "VITE_ELIZA_RUNTIME_MODE",
    "VITE_ELIZA_MOBILE_RUNTIME_MODE",
    "VITE_ELIZA_IOS_FULL_BUN_AVAILABLE",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of keys) {
      delete process.env[key];
    }
    configureIosAppStoreBuildDefaults();
    assert.equal(process.env.ELIZA_CAPACITOR_BUILD_TARGET, "ios");
    assert.equal(process.env.ELIZA_BUILD_VARIANT, "store");
    assert.equal(process.env.ELIZA_RELEASE_AUTHORITY, "apple-app-store");
    assert.equal(process.env.ELIZA_IOS_RUNTIME_MODE, "cloud-hybrid");
    assert.equal(process.env.VITE_ELIZA_IOS_RUNTIME_MODE, "cloud-hybrid");
    assert.equal(process.env.ELIZA_RUNTIME_MODE, "local-safe");
    assert.equal(process.env.RUNTIME_MODE, "local-safe");
    assert.equal(process.env.LOCAL_RUNTIME_MODE, "local-safe");
    assert.equal(process.env.VITE_ELIZA_RUNTIME_MODE, "local-safe");
    assert.equal(process.env.VITE_ELIZA_MOBILE_RUNTIME_MODE, "cloud-hybrid");
    assert.equal(process.env.VITE_ELIZA_IOS_FULL_BUN_AVAILABLE, "1");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test("resolveIosBuildTarget defaults App Store iOS to a device build", () => {
  assert.deepEqual(
    resolveIosBuildTarget({
      env: { ELIZA_RELEASE_AUTHORITY: "apple-app-store" },
      appDirValue: "/tmp/no-app",
    }),
    {
      destination: "generic/platform=iOS",
      sdk: "iphoneos",
      reason: "App Store device build",
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

test("iOS App Store pod selection keeps no-JIT Bun local runtime but strips unsafe bridge pods", () => {
  const pods = resolveIosCustomPods({
    appStoreBuild: true,
    includeLlama: false,
    includeFullBunEngine: true,
    includeMobileAgentBridge: true,
  }).map(([name]) => name);

  assert.equal(isIosAppStoreBuild({ ELIZA_BUILD_VARIANT: "store" }), true);
  assert.equal(pods.includes("LlamaCppCapacitor"), false);
  assert.equal(pods.includes("ElizaosCapacitorBunRuntime"), true);
  assert.equal(pods.includes("ElizaosCapacitorMobileAgentBridge"), false);
  assert.equal(pods.includes("ElizaBunEngine"), true);
});

test("iOS App Store agent payload is allowed for the bundled no-JIT runtime", () => {
  assert.deepEqual(
    resolveIosAgentRuntimeAssetPlan({
      appStoreBuild: true,
      includeFullBunEngine: true,
    }).agentAssets,
    IOS_AGENT_RUNTIME_ASSETS,
  );
  assert.deepEqual(
    resolveIosAgentRuntimeAssetPlan({ appStoreBuild: false }).agentAssets,
    IOS_AGENT_RUNTIME_ASSETS,
  );
});

test("iOS direct compat pod selection includes JSContext runtime without full Bun", () => {
  const pods = resolveIosCustomPods({
    appStoreBuild: false,
    includeCompatBunRuntime: true,
    includeFullBunEngine: false,
  }).map(([name]) => name);

  assert.equal(pods.includes("ElizaosCapacitorBunRuntime"), true);
  assert.equal(pods.includes("ElizaosCapacitorMobileAgentBridge"), false);
  assert.equal(pods.includes("ElizaBunEngine"), false);
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
    entitlements.includes(
      "com.apple.security.cs.allow-dyld-environment-variables",
    ),
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
      content.includes(
        "com.apple.security.cs.allow-unsigned-executable-memory",
      ),
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
