#!/usr/bin/env node
/** Builds Android and iOS targets from the host app’s canonical identity. Platform modules own source reconciliation, asset staging, and artifact audits; this entry point preserves CLI target selection and phase ordering. */

import { stageIosAgentRuntime } from "./mobile/ios/runtime-assets.ts";

export { syncAndroidVoiceStringResources } from "./mobile/android/app-actions.ts";
export {
  ANDROID_PERMISSIONS,
  androidAospRoleLauncherIntentFilter,
  ensureElizaBootReceiverManifest,
} from "./mobile/android/manifest-policy.ts";
export { shouldRemoveAndroidJavaSourceRoot } from "./mobile/android/overlay.ts";
export {
  isCapacitorPlatformReady,
  resolveCapacitorCli,
  resolvePlatformTemplateRoot,
  syncPlatformTemplateFiles,
} from "./mobile/build-tools.ts";
export { applyIosAppIdentity } from "./mobile/ios/identity.ts";
export {
  IOS_AGENT_ROOT_EXTENSION_ASSETS,
  IOS_AGENT_RUNTIME_ASSETS,
  resolveIosAgentRuntimeAssetPlan,
} from "./mobile/ios/runtime-assets.ts";
export { resolveMobileBuildPolicy } from "./mobile/web-build.ts";

import { prepareIosOverlay } from "./mobile/ios/overlay.ts";

export { prepareIosOverlay } from "./mobile/ios/overlay.ts";

import { generateIosBrandAssets } from "./mobile/assets.ts";

export {
  ANDROID_CLOUD_MANIFEST_MERGER_REMOVED_PERMISSIONS,
  ANDROID_CLOUD_NATIVE_SIGN_IN_JAVA_FILES,
  ANDROID_CLOUD_REWRITTEN_JAVA_FILES,
  ANDROID_CLOUD_STRIPPED_ASSET_DIRECTORIES,
  ANDROID_CLOUD_STRIPPED_ASSET_FILES,
  ANDROID_CLOUD_STRIPPED_COMPONENTS,
  ANDROID_CLOUD_STRIPPED_JAVA_FILES,
  ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
  ANDROID_CLOUD_STRIPPED_PERMISSIONS,
  ANDROID_CLOUD_STRIPPED_RESOURCE_FILES,
  ANDROID_CLOUD_STRIPPED_RESOURCE_VALUES,
  ANDROID_CLOUD_STRIPPED_TEST_JAVA_FILES,
  ANDROID_NATIVE_SIGN_IN_COMPONENTS,
  ANDROID_NATIVE_SIGN_IN_METADATA_NAMES,
  ANDROID_PLAY_ALLOWED_ACTIONS,
  ANDROID_PLAY_ALLOWED_CAPACITOR_CONFIG_PLUGINS,
  ANDROID_PLAY_ALLOWED_COMPONENTS,
  ANDROID_PLAY_ALLOWED_METADATA_NAMES,
  ANDROID_PLAY_ALLOWED_NATIVE_LIBRARIES,
  ANDROID_PLAY_ALLOWED_NATIVE_PLUGIN_PACKAGES,
  ANDROID_PLAY_ALLOWED_PERMISSIONS,
  ANDROID_PLAY_ALLOWED_QUERY_ACTIONS,
  ANDROID_PLAY_DATA_EXTRACTION_RULES,
  ANDROID_PLAY_FORBIDDEN_ASSET_MARKERS,
  ANDROID_PLAY_FORBIDDEN_INDEX_HTML_MARKERS,
  applyAndroidCloudSplashTheme,
  applyAndroidPlayManifestHardening,
  assertAndroidCloudNativeLibraryAllowlist,
  createAndroidPlayManifestPolicy,
  findAndroidCloudPackagedRuntimeOffenders,
  findAndroidPlayIndexHtmlFindings,
  findAndroidPlayTextAssetFindings,
  isAndroidVpsSidecarBuild,
  resolveAndroidCloudAllowedNativeLibraries,
  resolveAndroidCloudAllowedNativePluginPackages,
  resolveAndroidCloudStripPolicy,
  sanitizeAndroidCloudCapacitorConfig,
} from "./mobile/android/cloud-policy.ts";
export { removeInactiveAndroidJavaSourceRoots } from "./mobile/android/strip.ts";
export {
  resolveIosBuildTarget,
  shouldRunIosPodInstall,
} from "./mobile/ios/build-policy.ts";
export { patchLlamaCppCapacitorPodspecForXcframework } from "./mobile/ios/engine.ts";

import {
  buildAndroidCloud,
  buildAndroidSystem,
} from "./mobile/android/build.ts";

export {
  createAndroidBuildEnv,
  resolveAndroidGradleCommands,
  runAndroidBuild,
} from "./mobile/android/build.ts";

import { auditAndroidCloudArtifact } from "./mobile/artifact-inspection/android-audit.ts";

export {
  auditAndroidCloudArtifact,
  findAndroidBionicInferenceOffenders,
  findAndroidCloudAab,
} from "./mobile/artifact-inspection/android-audit.ts";

import { buildIos } from "./mobile/ios/build.ts";

export { configureIosAppStoreBuildDefaults } from "./mobile/ios/build.ts";

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ANDROID_BUNDLETOOL_JAR_ENV,
  ensureAndroidBundletoolJar,
} from "./lib/android-cloud-artifact-audit.ts";
import { APP } from "./mobile/context.ts";

export { cloudSafeMainActivityJava } from "./mobile/android/templates/main-activity.ts";
export { cloudSafePlayExportPluginJava } from "./mobile/android/templates/play-export.ts";
export { cloudSafePlaySettingsPluginJava } from "./mobile/android/templates/play-settings.ts";
export { cloudSafePlayVoicePluginJava } from "./mobile/android/templates/play-voice.ts";
export { cloudSafeSecureCredentialsPluginJava } from "./mobile/android/templates/secure-credentials.ts";

export {
  assertAndroidArtifactRetainsBackgroundRunnerJniBridge,
  assertAndroidArtifactShipsWebPayload,
  assertAndroidArtifactSnapshotUnchanged,
  listAndroidArtifactEntries,
  readAndroidArtifactEntryBuffers,
  snapshotAndroidArtifact,
} from "./mobile/artifact-inspection/archive.ts";

import { mobileBuildError } from "./mobile/build-error.ts";
import { resolveJavaHome } from "./mobile/toolchain.ts";

export {
  applyAndroidGeneratedBuildTargetProperties,
  injectAndroidBackgroundRunnerAarFlatDir,
  injectAospAssetThinning,
  injectCopyForkLlamaLibTask,
  injectNativeLibLegacyPackaging,
  injectNoCompressTarGz,
} from "./mobile/android/gradle-patches.ts";

import {
  isIosAppStoreBuild,
  shouldIncludeIosFullBunEngine,
} from "./mobile/ios/policy.ts";

export {
  androidUsesAppDirFor,
  MTP_FORK_SRC_CANDIDATES,
  mtpBuilderRepoRoot,
  mtpForceRebuildRequested,
  mtpSliceReuse,
} from "./lib/mobile-build-decisions.ts";
export {
  ANDROID_BUILD_TARGETS,
  resolveAndroidBuildTarget,
} from "./mobile/android/targets.ts";
export {
  ANDROID_APP_ACTION_CAPABILITIES,
  ANDROID_APP_ACTION_FORBIDDEN_MARKERS,
  ANDROID_APP_ACTION_REQUIRED_DEEP_LINKS,
  ANDROID_APP_ACTION_SHORTCUT_IDS,
  appendMissingAndroidManifestBlock,
  appendMissingApplicationBlock,
  applyAndroidCleartextPolicy,
  ensureAndroidMainActivityShortcutsMetadata,
  ensureAndroidMainActivityUrlSchemeFilter,
  ensureAndroidPermissionRemovalMarkers,
  ensureElizaOsActivityFilters,
  ensureManifestApplicationClosedBeforeTopLevelEntries,
  hasAndroidPermissionRequest,
  patchAndroidAppActionsXmlResource,
  removeAndroidPermissionRequests,
  removeApplicationComponentBlock,
  removeApplicationComponentClassBlock,
  removeXmlCommentsContaining,
  stripXmlComments,
  validateAndroidAppActionsXmlResource,
} from "./mobile/android-manifest.ts";
export {
  androidPlayManifestEvidenceFromAapt,
  dumpAndroidArtifactBadging,
  dumpAndroidArtifactManifest,
  resolveAndroidBuildTool,
} from "./mobile/artifact-inspection/android-tools.ts";
export {
  isIosAppStoreBuild,
  resolveIosCapacitorSyncEnv,
  shouldIncludeIosFullBunEngine,
} from "./mobile/ios/policy.ts";
export {
  ANDROID_OFFICIAL_CAPACITOR_PACKAGES,
  IOS_COCOAPODS_OWNED_SPM_PLUGINS,
  IOS_INCOMPATIBLE_SPM_PLUGINS,
  IOS_OFFICIAL_PODS,
  MOBILE_CAPACITOR_PLUGIN_MANIFEST,
  resolveIosCustomPods,
} from "./mobile/ios-pods.ts";

// ── Entry point ─────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const [target, ...options] = argv;
  if (
    target !== "android-cloud" &&
    target !== "android-system" &&
    target !== "ios" &&
    target !== "ios-local" &&
    target !== "ios-overlay"
  ) {
    console.error(
      "Usage: bun scripts/run-mobile-build.ts <android-cloud [--debug | --audit [aab-path]]|android-system|ios|ios-local|ios-overlay>",
    );
    process.exit(1);
  }
  if (target === "android-cloud" && options[0] === "--audit") {
    // The Gradle bundleRelease finalizer audits the final AAB through this
    // step, so a direct Gradle or fastlane build gets the same release audit.
    const jdk = resolveJavaHome(process.env);
    if (!jdk) throw mobileBuildError("JDK 21 not found. Set JAVA_HOME.");
    process.env[ANDROID_BUNDLETOOL_JAR_ENV] = await ensureAndroidBundletoolJar({
      env: process.env,
    });
    auditAndroidCloudArtifact({
      artifact: options[1],
      env: process.env,
      javaHome: jdk,
    });
  } else if (target === "android-cloud") {
    await buildAndroidCloud({ debug: options.includes("--debug") });
  } else if (target === "android-system") {
    await buildAndroidSystem();
  } else if (target === "ios") {
    await buildIos();
  } else if (target === "ios-local") {
    await buildIos({ local: true });
  } else {
    prepareIosOverlay();
    await generateIosBrandAssets();
    // The App Store release pipeline splits the build into `bun run build`
    // (web) + `cap:sync:ios` + this overlay + fastlane, so it never runs
    // buildIos()'s local-agent staging. When the build embeds the full Bun
    // engine, stage the agent runtime payload here (after cap sync, before
    // pod install / fastlane archive) so the shipped IPA actually contains the
    // agent the engine runs — without it the engine boots with nothing to
    // execute. The agent bundle must already be built (packages/agent
    // build:ios-bun); stageIosAgentRuntime throws with that hint if missing.
    if (shouldIncludeIosFullBunEngine()) {
      stageIosAgentRuntime({
        appStoreBuild: isIosAppStoreBuild(),
        includeFullBunEngine: true,
      });
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * Emit the wall-clock build duration so the startup-budget gate
 * (packages/app/scripts/check-startup-budget.ts) can regression-check build
 * time (issue #14414). Opt-in via ELIZA_MOBILE_BUILD_TIMING_OUT so default
 * builds are byte-for-byte unchanged; the file records the wall-clock the
 * `build` budget target is defined against.
 */
function writeBuildTiming(target, buildMs) {
  const out = process.env.ELIZA_MOBILE_BUILD_TIMING_OUT;
  if (!out) return;
  const budgetTarget =
    process.env.ELIZA_MOBILE_BUILD_TIMING_TARGET ??
    (target.startsWith("ios") ? "ios-ipa" : "android-apk");
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      {
        capturedAtIso: new Date().toISOString(),
        buildTarget: target,
        target: budgetTarget,
        buildMs: Math.round(buildMs),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `[mobile-build] build timing: ${Math.round(buildMs)}ms → ${out} (budget target ${budgetTarget})`,
  );
}

if (isMain) {
  console.log(`[mobile-build] App: ${APP.appName} (${APP.appId})`);
  const buildStart = Date.now();
  await main();
  writeBuildTiming(process.argv[2], Date.now() - buildStart);
}
