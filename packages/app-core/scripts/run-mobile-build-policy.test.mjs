import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findIosAppStoreForbiddenLocalAssets,
  IOS_OFFICIAL_PODS,
  resolveIosAppStoreLocalRuntimePolicy,
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
    iosAppStoreLocalRuntime: false,
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
    iosAppStoreLocalRuntime: false,
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
    iosAppStoreLocalRuntime: false,
  });
});

test("resolveMobileBuildPolicy keeps App Store iOS local in compliance mode", () => {
  assert.deepEqual(resolveMobileBuildPolicy("ios", { env: {} }), {
    capacitorTarget: "ios",
    buildVariant: "store",
    androidRuntimeMode: null,
    iosRuntimeMode: "local",
    releaseAuthority: "apple-app-store",
    appControlledOta: false,
    iosAppStoreLocalRuntime: true,
  });
  assert.deepEqual(resolveMobileBuildPolicy("ios-local", { env: {} }), {
    capacitorTarget: "ios",
    buildVariant: "direct",
    androidRuntimeMode: null,
    iosRuntimeMode: "local",
    releaseAuthority: "developer-toolchain",
    appControlledOta: false,
    iosAppStoreLocalRuntime: false,
  });
});

test("resolveIosAppStoreLocalRuntimePolicy fails closed for native local payloads", () => {
  assert.deepEqual(
    resolveIosAppStoreLocalRuntimePolicy({
      platform: "ios",
      env: {
        ELIZA_IOS_RUNTIME_MODE: "local",
        ELIZA_IOS_INCLUDE_LLAMA: "1",
        ELIZA_IOS_FULL_BUN_ENGINE: "1",
      },
    }),
    {
      enabled: true,
      iosRuntimeMode: "local",
      includeLlama: true,
      includeFullBunEngine: true,
      errors: [
        "ELIZA_IOS_LLAMA_APP_STORE_COMPLIANT=1 is required before an App Store local build may bundle llama.cpp",
        "ELIZA_IOS_FULL_BUN_ENGINE_APP_STORE_COMPLIANT=1 is required before an App Store local build may bundle ElizaBunEngine",
      ],
    },
  );
});

test("findIosAppStoreForbiddenLocalAssets flags native/toolchain payloads", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-ios-policy-"));
  try {
    fs.writeFileSync(path.join(tmp, "agent-bundle.js"), "globalThis.startEliza = function(){};");
    fs.writeFileSync(path.join(tmp, "pglite.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    fs.writeFileSync(path.join(tmp, "helper"), Buffer.from([0xfe, 0xed, 0xfa, 0xcf]));
    fs.writeFileSync(path.join(tmp, "model.gguf"), "not allowed");

    assert.deepEqual(findIosAppStoreForbiddenLocalAssets(tmp), [
      {
        path: "helper",
        reason: "Mach-O/native binary in agent resources",
      },
      {
        path: "model.gguf",
        reason: "local-only native/toolchain asset name",
      },
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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

test("iOS background runner pod resolves through the official package", () => {
  assert.equal(
    IOS_OFFICIAL_PODS.find(
      ([name]) => name === "CapacitorBackgroundRunner",
    )?.[1],
    "@capacitor/background-runner",
  );
});
