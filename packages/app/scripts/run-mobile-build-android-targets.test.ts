import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAndroidGradleCommandsForTarget } from "./mobile/android-gradle.ts";
import {
  ANDROID_BUILD_TARGETS,
  resolveAndroidBuildTarget,
  resolveAndroidGradleCommands,
  resolveMobileBuildPolicy,
} from "./run-mobile-build.ts";

const websiteBlockerSettings = "include ':elizaos-capacitor-websiteblocker'";
const mobileBuildScript = fileURLToPath(
  new URL("./run-mobile-build.ts", import.meta.url),
);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appPackageJsonPath = path.resolve(scriptsDir, "../../app/package.json");
const runMobileBuildSource = fs.readFileSync(
  path.resolve(scriptsDir, "run-mobile-build.ts"),
  "utf8",
);

describe("Android mobile build target table", () => {
  it("keeps one descriptor per public Android target", () => {
    expect(Object.keys(ANDROID_BUILD_TARGETS).sort()).toEqual([
      "android-cloud",
      "android-system",
    ]);

    expect(ANDROID_BUILD_TARGETS["android-cloud"]).toMatchObject({
      target: "android-cloud",
      webTarget: "android-cloud",
      env: { ELIZA_ANDROID_CLOUD_BUILD: "1" },
      cleartextPolicy: { allowCleartext: false, label: "cloud" },
    });
    expect(ANDROID_BUILD_TARGETS["android-system"]).toMatchObject({
      target: "android-system",
      webTarget: "android-system",
      buildMobileAgentBundle: true,
      cleartextPolicy: { allowCleartext: true, label: "AOSP" },
      agentRuntime: { bunChannel: "stable" },
    });
  });

  it("builds android-cloud as a debug APK in its debug mode", () => {
    expect(resolveAndroidBuildTarget("android-cloud")).toMatchObject({
      target: "android-cloud",
      webTarget: "android-cloud",
      artifactAuditKey: "cloud",
      postBuildKey: "logCloudRelease",
    });
    const debug = resolveAndroidBuildTarget("android-cloud", { debug: true });
    expect(debug).toMatchObject({
      target: "android-cloud",
      webTarget: "android-cloud-debug",
      env: { ELIZA_ANDROID_CLOUD_BUILD: "1" },
      stripSourceKey: "cloud",
      auditSourceKey: "cloud",
      cleartextPolicy: { allowCleartext: false, label: "cloud-debug" },
      artifactAuditKey: "cloudDebug",
    });
    expect(debug.postBuildKey).toBe(undefined);
    expect(resolveAndroidBuildTarget("android-system", { debug: true })).toBe(
      ANDROID_BUILD_TARGETS["android-system"],
    );
  });

  it("resolves the Android lane policies", () => {
    expect(resolveMobileBuildPolicy("android-system")).toMatchObject({
      capacitorTarget: "android",
      buildVariant: "direct",
      androidRuntimeMode: "local",
      runtimeExecutionMode: "local-yolo",
      releaseAuthority: "aosp-ota",
    });
    expect(resolveMobileBuildPolicy("android-cloud")).toMatchObject({
      capacitorTarget: "android",
      buildVariant: "store",
      androidRuntimeMode: "cloud",
      runtimeExecutionMode: "cloud",
      releaseAuthority: "google-play",
    });
    expect(resolveMobileBuildPolicy("android-cloud-debug")).toMatchObject({
      capacitorTarget: "android",
      buildVariant: "direct",
      androidRuntimeMode: "cloud",
      runtimeExecutionMode: "cloud",
      releaseAuthority: "developer-debug",
    });
  });

  it("dispatches the cloud debug and audit modes through the android-cloud target", () => {
    const packageJson = JSON.parse(fs.readFileSync(appPackageJsonPath, "utf8"));

    expect(packageJson.scripts["build:android:cloud:debug"]).toBe(
      "bun ../../packages/app/scripts/run-mobile-build.ts android-cloud --debug",
    );
    expect(runMobileBuildSource).toContain(
      'buildAndroidCloud({ debug: options.includes("--debug") })',
    );
    expect(runMobileBuildSource).toContain(
      'target === "android-cloud" && options[0] === "--audit"',
    );
    for (const removed of [
      "android-launcher",
      "android-cloud-hybrid",
      "android-cloud-debug",
      "android-cloud-audit",
    ]) {
      const result = spawnSync("node", [mobileBuildScript, removed], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: bun scripts/run-mobile-build.ts");
    }
  });

  it("refuses a leaked runtime-mode env before the web build", () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-android-runtime-mode-cli-"),
    );
    const sdkRoot = path.join(fixtureRoot, "android-sdk");
    const javaHome = path.join(fixtureRoot, "jdk-21");
    fs.mkdirSync(sdkRoot);
    fs.mkdirSync(javaHome);
    fs.writeFileSync(path.join(javaHome, "release"), 'JAVA_VERSION="21"\n');

    try {
      const result = spawnSync(
        process.execPath,
        [path.join(scriptsDir, "run-mobile-build.ts"), "android-system"],
        {
          cwd: scriptsDir,
          encoding: "utf8",
          env: {
            ...process.env,
            ANDROID_HOME: sdkRoot,
            ANDROID_SDK_ROOT: sdkRoot,
            JAVA_HOME: javaHome,
            VITE_ELIZA_IOS_RUNTIME_MODE: "cloud",
          },
        },
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "Refusing leaked Android runtime-mode env for target 'android-system'",
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails loudly for unknown public Android targets", () => {
    expect(() => resolveAndroidBuildTarget("android-tv")).toThrow(
      "[mobile-build] Unknown Android build target: android-tv",
    );
  });
});

describe("Android Gradle command table", () => {
  it("generates Play cloud release and debug commands from the same descriptor family", () => {
    expect(resolveAndroidGradleCommands("android-cloud")).toEqual({
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

  it("keeps the AOSP/system Gradle contract", () => {
    expect(resolveAndroidGradleCommands("android-system")).toEqual({
      metadataArgs: [
        ":capacitor-cordova-android-plugins:writeReleaseAarMetadata",
      ],
      buildArgs: ["-PelizaAospBuild=true", ":app:assembleRelease"],
    });
  });

  it("fails loudly for unknown AAR metadata variants", () => {
    const target = {
      ...ANDROID_BUILD_TARGETS["android-system"],
      gradle: {
        ...ANDROID_BUILD_TARGETS["android-system"].gradle,
        metadataVariant: "profile",
      },
    };

    expect(() =>
      resolveAndroidGradleCommandsForTarget(target, {
        settingsGradle: "",
      }),
    ).toThrow(
      "[mobile-build] Unknown Android AAR metadata variant for android-system: profile",
    );
  });
});
