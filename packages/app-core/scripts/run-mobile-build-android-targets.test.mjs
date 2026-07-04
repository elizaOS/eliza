/** Exercises run mobile build android targets behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import { resolveAndroidGradleCommandsForTarget } from "./mobile/android-gradle.mjs";
import {
  ANDROID_BUILD_TARGETS,
  resolveAndroidBuildTarget,
  resolveAndroidGradleCommands,
} from "./run-mobile-build.mjs";

const websiteBlockerSettings = "include ':elizaos-capacitor-websiteblocker'";

describe("Android mobile build target table", () => {
  it("keeps one descriptor per public Android target", () => {
    expect(Object.keys(ANDROID_BUILD_TARGETS).sort()).toEqual([
      "android",
      "android-cloud",
      "android-cloud-debug",
      "android-sms-gateway",
      "android-system",
    ]);

    expect(ANDROID_BUILD_TARGETS.android).toMatchObject({
      target: "android",
      webTarget: "android",
      buildMobileAgentBundle: true,
      cleartextPolicy: { allowCleartext: true, label: "sideload" },
      agentRuntime: { bunChannel: "stable" },
    });
    expect(ANDROID_BUILD_TARGETS["android-cloud"]).toMatchObject({
      target: "android-cloud",
      webTarget: "android-cloud",
      env: { ELIZA_ANDROID_CLOUD_BUILD: "1" },
      cleartextPolicy: { allowCleartext: false, label: "cloud" },
    });
    expect(ANDROID_BUILD_TARGETS["android-cloud-debug"]).toMatchObject({
      target: "android-cloud-debug",
      webTarget: "android-cloud-debug",
      cleartextPolicy: { allowCleartext: false, label: "cloud-debug" },
    });
    expect(ANDROID_BUILD_TARGETS["android-sms-gateway"]).toMatchObject({
      target: "android-sms-gateway",
      webTarget: "android-cloud-debug",
      includeSmsGatewayEnvDefaults: true,
      cleartextPolicy: { allowCleartext: false, label: "sms-gateway" },
    });
    expect(ANDROID_BUILD_TARGETS["android-system"]).toMatchObject({
      target: "android-system",
      webTarget: "android-system",
      buildMobileAgentBundle: true,
      cleartextPolicy: { allowCleartext: true, label: "AOSP" },
      agentRuntime: { bunChannel: "canary", objective: true },
    });
  });

  it("maps android-cloud debug opts to the debug descriptor", () => {
    expect(resolveAndroidBuildTarget("android-cloud").target).toBe(
      "android-cloud",
    );
    expect(
      resolveAndroidBuildTarget("android-cloud", { debug: true }).target,
    ).toBe("android-cloud-debug");
  });

  it("fails loudly for unknown public Android targets", () => {
    expect(() => resolveAndroidBuildTarget("android-tv")).toThrow(
      "[mobile-build] Unknown Android build target: android-tv",
    );
  });
});

describe("Android Gradle command table", () => {
  it("generates sideload commands with optional websiteblocker and AOSP flags", () => {
    expect(
      resolveAndroidGradleCommands("android", {
        env: {},
        settingsGradle: websiteBlockerSettings,
      }),
    ).toEqual({
      metadataArgs: [
        ":capacitor-cordova-android-plugins:writeDebugAarMetadata",
      ],
      buildArgs: [
        ":elizaos-capacitor-websiteblocker:testDebugUnitTest",
        ":app:assembleDebug",
      ],
    });

    expect(
      resolveAndroidGradleCommands("android", {
        env: { ELIZA_GRADLE_AOSP_BUILD: "1" },
        settingsGradle: "",
      }).buildArgs,
    ).toEqual(["-PelizaAospBuild=true", ":app:assembleDebug"]);
  });

  it("generates Play cloud release and debug commands from the same descriptor family", () => {
    expect(resolveAndroidGradleCommands("android-cloud", { env: {} })).toEqual({
      metadataArgs: [
        "-PelizaCloudBuild=true",
        "-PelizaStripAgentAssets=true",
        ":capacitor-cordova-android-plugins:writeReleaseAarMetadata",
      ],
      buildArgs: [
        "-PelizaCloudBuild=true",
        "-PelizaStripAgentAssets=true",
        ":app:bundleRelease",
      ],
    });

    expect(
      resolveAndroidGradleCommands("android-cloud", {
        debug: true,
        env: {},
        settingsGradle: websiteBlockerSettings,
      }),
    ).toEqual({
      metadataArgs: [
        "-PelizaCloudBuild=true",
        "-PelizaStripAgentAssets=true",
        ":capacitor-cordova-android-plugins:writeDebugAarMetadata",
      ],
      buildArgs: [
        "-PelizaCloudBuild=true",
        "-PelizaStripAgentAssets=true",
        ":elizaos-capacitor-websiteblocker:testDebugUnitTest",
        ":app:assembleDebug",
      ],
    });
  });

  it("keeps SMS gateway and AOSP/system Gradle contracts separate", () => {
    expect(
      resolveAndroidGradleCommands("android-sms-gateway", {
        env: {},
        settingsGradle: websiteBlockerSettings,
      }),
    ).toEqual({
      metadataArgs: [
        "-PelizaCloudBuild=true",
        "-PelizaStripAgentAssets=true",
        ":capacitor-cordova-android-plugins:writeDebugAarMetadata",
      ],
      buildArgs: [
        "-PelizaCloudBuild=true",
        "-PelizaStripAgentAssets=true",
        ":app:assembleDebug",
      ],
    });

    expect(resolveAndroidGradleCommands("android-system", { env: {} })).toEqual(
      {
        metadataArgs: [
          ":capacitor-cordova-android-plugins:writeReleaseAarMetadata",
        ],
        buildArgs: ["-PelizaAospBuild=true", ":app:assembleRelease"],
      },
    );
  });

  it("fails loudly for unknown AAR metadata variants", () => {
    const target = {
      ...ANDROID_BUILD_TARGETS.android,
      gradle: {
        ...ANDROID_BUILD_TARGETS.android.gradle,
        metadataVariant: "profile",
      },
    };

    expect(() =>
      resolveAndroidGradleCommandsForTarget(target, {
        env: {},
        settingsGradle: "",
      }),
    ).toThrow(
      "[mobile-build] Unknown Android AAR metadata variant for android: profile",
    );
  });
});
