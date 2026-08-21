/** Exercises run mobile build android targets behavior with deterministic app-core test fixtures. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAndroidGradleCommandsForTarget } from "./mobile/android-gradle.mjs";
import {
  ANDROID_BUILD_TARGETS,
  resolveAndroidBuildTarget,
  resolveAndroidGradleCommands,
  resolveMobileBuildPolicy,
} from "./run-mobile-build.mjs";

const websiteBlockerSettings = "include ':elizaos-capacitor-websiteblocker'";
const mobileBuildScript = fileURLToPath(
  new URL("./run-mobile-build.mjs", import.meta.url),
);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appPackageJsonPath = path.resolve(scriptsDir, "../../app/package.json");
const runMobileBuildSource = fs.readFileSync(
  path.resolve(scriptsDir, "run-mobile-build.mjs"),
  "utf8",
);

describe("Android mobile build target table", () => {
  it("keeps one descriptor per public Android target", () => {
    expect(Object.keys(ANDROID_BUILD_TARGETS).sort()).toEqual([
      "android",
      "android-cloud",
      "android-cloud-debug",
      "android-cloud-hybrid",
      "android-host-e2e",
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
    expect(ANDROID_BUILD_TARGETS["android-host-e2e"]).toMatchObject({
      target: "android-host-e2e",
      webTarget: "android",
      env: {
        ELIZA_ANDROID_HOST_E2E_BUILD: "1",
        ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB: "1",
      },
      cleartextPolicy: { allowCleartext: true, label: "host-e2e" },
      gradle: {
        flags: ["-PelizaStripAgentAssets=true"],
        metadataVariant: "debug",
        finalTask: ":app:assembleDebug",
      },
      artifactAuditKey: "hostE2e",
    });
    expect(ANDROID_BUILD_TARGETS["android-host-e2e"]).not.toHaveProperty(
      "buildMobileAgentBundle",
    );
    expect(ANDROID_BUILD_TARGETS["android-host-e2e"].agentRuntime).toBe(
      undefined,
    );
    expect(ANDROID_BUILD_TARGETS["android-cloud"]).toMatchObject({
      target: "android-cloud",
      webTarget: "android-cloud",
      env: { ELIZA_ANDROID_CLOUD_BUILD: "1" },
      cleartextPolicy: { allowCleartext: false, label: "cloud" },
    });
    expect(ANDROID_BUILD_TARGETS["android-cloud-hybrid"]).toMatchObject({
      target: "android-cloud-hybrid",
      webTarget: "android-cloud-hybrid",
      env: { ELIZA_ANDROID_CLOUD_HYBRID_BUILD: "1" },
      buildMobileAgentBundle: true,
      cleartextPolicy: { allowCleartext: true, label: "cloud-hybrid" },
      agentRuntime: { bunChannel: "stable" },
      gradle: {
        metadataVariant: "debug",
        finalTask: ":app:assembleDebug",
      },
      artifactAuditKey: "sideload",
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

  it("runs the exact mobile CLI through a pre-mutation Android guard", () => {
    // The production package scripts invoke this CLI with Node. `process.execPath`
    // points at Bun under `bun test`, which spends long enough compiling this
    // large orchestrator to hit Bun's per-test timeout before the guard runs.
    const result = spawnSync("node", [mobileBuildScript, "android"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ELIZA_PLAY_STORE_BUILD: "1",
      },
    });

    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Refusing target `android` under ELIZA_PLAY_STORE_BUILD",
    );
  });

  it("resolves Android lane policies without changing android default or cloud-only modes", () => {
    expect(resolveMobileBuildPolicy("android")).toMatchObject({
      capacitorTarget: "android",
      buildVariant: "direct",
      androidRuntimeMode: "local",
      runtimeExecutionMode: "local-yolo",
      releaseAuthority: "github-release-android-package-installer",
    });
    expect(resolveMobileBuildPolicy("android-cloud")).toMatchObject({
      capacitorTarget: "android",
      buildVariant: "store",
      androidRuntimeMode: "cloud",
      runtimeExecutionMode: "cloud",
      releaseAuthority: "google-play",
    });
    expect(resolveMobileBuildPolicy("android-cloud-hybrid")).toMatchObject({
      capacitorTarget: "android",
      buildVariant: "direct",
      androidRuntimeMode: "cloud-hybrid",
      runtimeExecutionMode: "local-yolo",
      releaseAuthority: "github-release-android-package-installer",
    });
  });

  it("exposes and dispatches a first-class Android cloud-hybrid target", () => {
    const packageJson = JSON.parse(fs.readFileSync(appPackageJsonPath, "utf8"));

    expect(packageJson.scripts["build:android:cloud-hybrid"]).toBe(
      "node ../../packages/app-core/scripts/run-mobile-build.mjs android-cloud-hybrid",
    );
    expect(runMobileBuildSource).toContain('target !== "android-cloud-hybrid"');
    expect(runMobileBuildSource).toContain(
      'await runAndroidBuild("android-cloud-hybrid")',
    );

    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-android-cloud-hybrid-cli-"),
    );
    const sdkRoot = path.join(fixtureRoot, "android-sdk");
    const javaHome = path.join(fixtureRoot, "jdk-21");
    fs.mkdirSync(sdkRoot);
    fs.mkdirSync(javaHome);
    fs.writeFileSync(path.join(javaHome, "release"), 'JAVA_VERSION="21"\n');

    try {
      const result = spawnSync(
        process.execPath,
        [path.join(scriptsDir, "run-mobile-build.mjs"), "android-cloud-hybrid"],
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
        "Refusing leaked Android runtime-mode env for target 'android-cloud-hybrid'",
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("exposes and dispatches the host-emulator build target", () => {
    const packageJson = JSON.parse(fs.readFileSync(appPackageJsonPath, "utf8"));

    expect(packageJson.scripts["build:android:host-e2e"]).toBe(
      "node ../../packages/app-core/scripts/run-mobile-build.mjs android-host-e2e",
    );
    expect(runMobileBuildSource).toContain('target !== "android-host-e2e"');
    expect(runMobileBuildSource).toContain(
      'await runAndroidBuild("android-host-e2e")',
    );
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

  it("generates Android cloud-hybrid commands as a direct local-agent APK lane", () => {
    expect(
      resolveAndroidGradleCommands("android-cloud-hybrid", {
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
