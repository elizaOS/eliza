/**
 * Gradle invocation constants and command builders for Android targets:
 * AAR-metadata tasks, cloud/AOSP property flags, and per-target build/test
 * command assembly.
 */
export const ANDROID_AAR_METADATA_TASKS = Object.freeze({
  debug: ":capacitor-cordova-android-plugins:writeDebugAarMetadata",
  release: ":capacitor-cordova-android-plugins:writeReleaseAarMetadata",
});

export const ANDROID_CLOUD_GRADLE_FLAGS = Object.freeze([
  "-PelizaCloudBuild=true",
  "-PelizaStripAgentAssets=true",
]);

export const ANDROID_AOSP_GRADLE_FLAG = "-PelizaAospBuild=true";

export function resolveAndroidGradleCommandsForTarget(
  target,
  { settingsGradle = "" } = {},
) {
  const flags = [...(target.gradle.flags ?? [])];
  const buildArgs = [...flags];
  if (
    target.gradle.includeWebsiteBlockerUnitTest &&
    settingsGradle.includes(":elizaos-capacitor-websiteblocker")
  ) {
    buildArgs.push(":elizaos-capacitor-websiteblocker:testDebugUnitTest");
  }
  buildArgs.push(target.gradle.finalTask);

  const metadataTask =
    ANDROID_AAR_METADATA_TASKS[target.gradle.metadataVariant];
  if (!metadataTask) {
    throw new Error(
      `[mobile-build] Unknown Android AAR metadata variant for ${target.target}: ${target.gradle.metadataVariant}`,
    );
  }

  return {
    buildArgs,
    metadataArgs: [
      ...(target.gradle.passFlagsToMetadata ? flags : []),
      metadataTask,
    ],
  };
}
