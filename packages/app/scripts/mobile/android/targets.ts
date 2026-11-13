/**
 * Frozen build-target definitions for the Android lanes (sideload, host e2e,
 * cloud, AOSP): web target, gradle flags, cleartext policy, overlay options, and
 * agent-runtime settings per lane.
 */
import {
  ANDROID_AOSP_GRADLE_FLAG,
  ANDROID_CLOUD_GRADLE_FLAGS,
} from "../android-gradle.ts";

function freezeAndroidBuildTarget(target) {
  return Object.freeze({
    ...target,
    env: Object.freeze({ ...(target.env ?? {}) }),
    overlayOptions: target.overlayOptions
      ? Object.freeze({ ...target.overlayOptions })
      : undefined,
    cleartextPolicy: Object.freeze({ ...target.cleartextPolicy }),
    agentRuntime: target.agentRuntime
      ? Object.freeze({ ...target.agentRuntime })
      : undefined,
    gradle: Object.freeze({
      ...target.gradle,
      flags: Object.freeze([...(target.gradle.flags ?? [])]),
    }),
  });
}

export const ANDROID_BUILD_TARGETS = Object.freeze({
  android: freezeAndroidBuildTarget({
    target: "android",
    webTarget: "android",
    buildMobileAgentBundle: true,
    preflightKey: "sideload",
    overlayOptions: { includeAospRoleLaunchers: false },
    cleartextPolicy: { allowCleartext: true, label: "sideload" },
    agentRuntime: { bunChannel: "stable" },
    gradle: {
      metadataVariant: "debug",
      finalTask: ":app:assembleDebug",
      includeWebsiteBlockerUnitTest: true,
      includeAospFlagFromEnv: true,
      passFlagsToMetadata: false,
    },
    artifactAuditKey: "sideload",
  }),
  "android-host-e2e": freezeAndroidBuildTarget({
    target: "android-host-e2e",
    webTarget: "android",
    env: { ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB: "1" },
    overlayOptions: { includeAospRoleLaunchers: false },
    cleartextPolicy: { allowCleartext: true, label: "host-e2e" },
    gradle: {
      flags: ["-PelizaStripAgentAssets=true"],
      metadataVariant: "debug",
      finalTask: ":app:assembleDebug",
      includeWebsiteBlockerUnitTest: true,
      includeAospFlagFromEnv: true,
      passFlagsToMetadata: false,
    },
    artifactAuditKey: "hostE2e",
  }),
  "android-cloud": freezeAndroidBuildTarget({
    target: "android-cloud",
    webTarget: "android-cloud",
    env: { ELIZA_ANDROID_CLOUD_BUILD: "1" },
    overlayOptions: { includeAospRoleLaunchers: false },
    cleartextPolicy: { allowCleartext: false, label: "cloud" },
    stripSourceKey: "cloud",
    auditSourceKey: "cloud",
    gradle: {
      flags: ANDROID_CLOUD_GRADLE_FLAGS,
      metadataVariant: "release",
      finalTask: ":app:bundleRelease",
      passFlagsToMetadata: true,
    },
    artifactAuditKey: "cloud",
    postBuildKey: "logCloudRelease",
  }),
  "android-system": freezeAndroidBuildTarget({
    target: "android-system",
    webTarget: "android-system",
    buildMobileAgentBundle: true,
    overlayOptions: { includeAospRoleLaunchers: true },
    cleartextPolicy: { allowCleartext: true, label: "AOSP" },
    agentRuntime: { bunChannel: "stable" },
    auditSourceKey: "system",
    gradle: {
      flags: [ANDROID_AOSP_GRADLE_FLAG],
      metadataVariant: "release",
      finalTask: ":app:assembleRelease",
      passFlagsToMetadata: false,
    },
    artifactAuditKey: "system",
    postBuildKey: "stageSystemApk",
  }),
});

/** The debug mode of `android-cloud`: the same strip and audits, as a debug APK. */
const ANDROID_CLOUD_DEBUG_TARGET = freezeAndroidBuildTarget({
  ...ANDROID_BUILD_TARGETS["android-cloud"],
  webTarget: "android-cloud-debug",
  cleartextPolicy: { allowCleartext: false, label: "cloud-debug" },
  gradle: {
    flags: ANDROID_CLOUD_GRADLE_FLAGS,
    metadataVariant: "debug",
    finalTask: ":app:assembleDebug",
    includeWebsiteBlockerUnitTest: true,
    passFlagsToMetadata: true,
  },
  artifactAuditKey: "cloudDebug",
  postBuildKey: undefined,
});

export function resolveAndroidBuildTarget(targetName, { debug = false } = {}) {
  const target =
    targetName === "android-cloud" && debug
      ? ANDROID_CLOUD_DEBUG_TARGET
      : ANDROID_BUILD_TARGETS[targetName];
  if (!target) {
    throw new Error(
      `[mobile-build] Unknown Android build target: ${targetName}`,
    );
  }
  return target;
}
