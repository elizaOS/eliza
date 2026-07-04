/** Supports app-core build, packaging, or development orchestration for android mjs. */
import {
  ANDROID_AOSP_GRADLE_FLAG,
  ANDROID_CLOUD_GRADLE_FLAGS,
} from "../android-gradle.mjs";

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
  "android-cloud-debug": freezeAndroidBuildTarget({
    target: "android-cloud-debug",
    webTarget: "android-cloud-debug",
    env: { ELIZA_ANDROID_CLOUD_BUILD: "1" },
    overlayOptions: { includeAospRoleLaunchers: false },
    cleartextPolicy: { allowCleartext: false, label: "cloud-debug" },
    stripSourceKey: "cloud",
    auditSourceKey: "cloud",
    gradle: {
      flags: ANDROID_CLOUD_GRADLE_FLAGS,
      metadataVariant: "debug",
      finalTask: ":app:assembleDebug",
      includeWebsiteBlockerUnitTest: true,
      passFlagsToMetadata: true,
    },
    artifactAuditKey: "cloudDebug",
  }),
  "android-sms-gateway": freezeAndroidBuildTarget({
    target: "android-sms-gateway",
    webTarget: "android-cloud-debug",
    env: { ELIZA_ANDROID_CLOUD_BUILD: "1" },
    includeSmsGatewayEnvDefaults: true,
    afterToolchainResolvedKey: "smsGatewaySecret",
    cleartextPolicy: { allowCleartext: false, label: "sms-gateway" },
    stripSourceKey: "smsGateway",
    auditSourceKey: "smsGateway",
    gradle: {
      flags: ANDROID_CLOUD_GRADLE_FLAGS,
      metadataVariant: "debug",
      finalTask: ":app:assembleDebug",
      passFlagsToMetadata: true,
    },
    artifactAuditKey: "smsGateway",
    postBuildKey: "preserveSmsGateway",
  }),
  "android-system": freezeAndroidBuildTarget({
    target: "android-system",
    webTarget: "android-system",
    buildMobileAgentBundle: true,
    overlayOptions: { includeAospRoleLaunchers: true },
    cleartextPolicy: { allowCleartext: true, label: "AOSP" },
    agentRuntime: {
      bunChannel: "canary",
      objective: true,
    },
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

function resolveAndroidBuildTargetKey(targetName, { debug = false } = {}) {
  return targetName === "android-cloud" && debug
    ? "android-cloud-debug"
    : targetName;
}

export function resolveAndroidBuildTarget(targetName, options = {}) {
  const targetKey = resolveAndroidBuildTargetKey(targetName, options);
  const target = ANDROID_BUILD_TARGETS[targetKey];
  if (!target) {
    throw new Error(
      `[mobile-build] Unknown Android build target: ${targetName}`,
    );
  }
  return target;
}
