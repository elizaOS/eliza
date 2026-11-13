/** Owns Android target orchestration and environment assembly using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ANDROID_BUNDLETOOL_JAR_ENV,
  ensureAndroidBundletoolJar,
} from "../../lib/android-cloud-artifact-audit.ts";
import { normalizeCapacitorSettingsFile } from "../../lib/portable-capacitor-settings.ts";
import { stageAndroidAgentRuntime } from "../../lib/stage-android-agent.ts";
import { buildMobileAgentBundle } from "../agent-bundle.ts";
import { resolveAndroidGradleCommandsForTarget } from "../android-gradle.ts";
import {
  auditAndroidCloudArtifact,
  auditAndroidHostE2eArtifact,
  auditAndroidSideloadArtifact,
  auditAndroidSystemArtifact,
} from "../artifact-inspection/android-audit.ts";
import { stageAndroidSystemApk } from "../artifact-inspection/provenance.ts";
import { generateAndroidBrandAssets } from "../assets.ts";
import { prependPath, run, runCapacitor } from "../build-tools.ts";
import {
  androidAgentSpikeDir,
  androidDir,
  appDir,
  MOBILE_BUILD_SCRIPT_URL,
} from "../context.ts";
import {
  ensureBunRuntimeRegistered,
  ensurePlatform,
  mirrorCapacitorWebPayloadIntoAndroidDir,
} from "../platform-sync.ts";
import { resolveAndroidSdkRoot, resolveJavaHome } from "../toolchain.ts";
import { buildWeb, ensureRendererDistMatchesLane } from "../web-build.ts";
import { enforceAndroidVpsSidecarBuildPolicy } from "./cloud-policy.ts";
import { patchAndroidGradle } from "./gradle.ts";
import {
  overlayAndroid,
  sanitizeAndroidManifestWhenPlatformTemplatesMissing,
  writeAndroidCleartextPolicy,
} from "./overlay.ts";
import {
  auditAndroidCloudSource,
  auditAndroidSystemSource,
} from "./source-audit.ts";
import { stripAndroidForCloud } from "./strip.ts";
import { resolveAndroidBuildTarget } from "./targets.ts";

export function enforceAndroidSideloadBuildPolicy({ env = process.env } = {}) {
  // Hard refusal: the default `android` target is sideload-only and will be
  // rejected by Play. If CI or a contributor signals Play-Store intent via
  // env vars, fail loudly and point them at the right target.
  if (
    env.ELIZA_BUILD_VARIANT?.toLowerCase() === "store" ||
    env.ELIZA_PLAY_STORE_BUILD === "1"
  ) {
    console.error(
      "[mobile-build] Refusing target `android` under " +
        "ELIZA_BUILD_VARIANT=store or ELIZA_PLAY_STORE_BUILD=1. " +
        "The default `android` APK embeds the " +
        "on-device agent runtime and requests Play-rejected permissions " +
        "(MANAGE_APP_OPS_MODES, PACKAGE_USAGE_STATS). Use " +
        "`build:android:cloud` (Play-Store-compliant thin client) or " +
        "`build:android:system` (AOSP image launcher APK).",
    );
    process.exit(2);
  }

  console.warn(
    "[mobile-build] WARNING: target `android` produces an APK that embeds " +
      "the on-device agent runtime (libeliza_bun.so disguise) and requests " +
      "system-only permissions (MANAGE_APP_OPS_MODES, PACKAGE_USAGE_STATS). " +
      "It is SIDELOAD-ONLY and will be rejected by the Play Store. Use " +
      "`build:android:cloud` for a Play-Store-compliant thin client, or " +
      "`build:android:system` for the AOSP image launcher APK.",
  );
}

export const ANDROID_PREFLIGHTS = Object.freeze({
  sideload: enforceAndroidSideloadBuildPolicy,
});

export const ANDROID_SOURCE_STRIPS = Object.freeze({
  cloud: stripAndroidForCloud,
});

export const ANDROID_SOURCE_AUDITS = Object.freeze({
  cloud: auditAndroidCloudSource,
  system: auditAndroidSystemSource,
});

export const ANDROID_ARTIFACT_AUDITS = Object.freeze({
  sideload: ({ javaHome }) => auditAndroidSideloadArtifact({ javaHome }),
  hostE2e: ({ javaHome }) => auditAndroidHostE2eArtifact({ javaHome }),
  cloud: ({ env, javaHome }) => auditAndroidCloudArtifact({ env, javaHome }),
  cloudDebug: ({ env, javaHome }) =>
    auditAndroidCloudArtifact({ debug: true, env, javaHome }),
  system: ({ javaHome }) => auditAndroidSystemArtifact({ javaHome }),
});

export const ANDROID_POST_BUILDS = Object.freeze({
  logCloudRelease: ({ artifact }) =>
    console.log(`[mobile-build] android-cloud release AAB: ${artifact}`),
  stageSystemApk: stageAndroidSystemApk,
});

export function runAndroidTargetPhase(target, registry, keyField, ...args) {
  const key = target[keyField];
  if (!key) return undefined;
  const fn = registry[key];
  if (!fn) {
    throw new Error(
      `[mobile-build] Android target ${target.target} references unknown ${keyField}: ${key}`,
    );
  }
  return fn(...args);
}

export function resolveAndroidGradleCommands(
  targetName,
  { debug = false, env = process.env, settingsGradle = "" } = {},
) {
  const target = resolveAndroidBuildTarget(targetName, { debug });
  return resolveAndroidGradleCommandsForTarget(target, {
    env,
    settingsGradle,
  });
}

export function createAndroidBuildEnv(
  target,
  { androidSdkRoot, env, javaHome },
) {
  return {
    ...env,
    ...target.env,
    ANDROID_HOME: androidSdkRoot,
    ANDROID_SDK_ROOT: androidSdkRoot,
    // The Gradle AAB-audit finalizer resolves this orchestrator by walking up
    // from the android project dir, which only lands on a source checkout. In
    // npm-packages / white-label layouts the walk misses, so pass the running
    // script's own absolute path through for the finalizer to prefer.
    ELIZA_MOBILE_AUDIT_SCRIPT:
      env.ELIZA_MOBILE_AUDIT_SCRIPT?.trim() ||
      fileURLToPath(MOBILE_BUILD_SCRIPT_URL),
    JAVA_HOME: javaHome,
    NODE_BINARY: env.NODE_BINARY?.trim() || process.execPath,
    PATH: prependPath(env, [
      path.join(javaHome, "bin"),
      path.join(androidSdkRoot, "platform-tools"),
    ]),
  };
}

export function readAndroidSettingsGradle() {
  return fs.readFileSync(
    path.join(androidDir, "capacitor.settings.gradle"),
    "utf8",
  );
}

export async function runAndroidBuild(
  targetName,
  { debug = false, env = process.env } = {},
) {
  const resolvedEnv = { ...env };
  const target = resolveAndroidBuildTarget(targetName, { debug });
  const targetEnv = { ...resolvedEnv, ...target.env };
  enforceAndroidVpsSidecarBuildPolicy({
    targetName: target.target,
    debug,
    env: resolvedEnv,
  });
  runAndroidTargetPhase(target, ANDROID_PREFLIGHTS, "preflightKey", {
    env: resolvedEnv,
  });

  const sdk = resolveAndroidSdkRoot(resolvedEnv);
  const jdk = resolveJavaHome(resolvedEnv);
  if (!sdk)
    throw new Error(
      "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME.",
    );
  if (!jdk) throw new Error("JDK 21 not found. Set JAVA_HOME.");

  await buildWeb(target.webTarget);
  if (target.buildMobileAgentBundle) await buildMobileAgentBundle();
  await ensurePlatform("android", { env: targetEnv });
  await ensureRendererDistMatchesLane(target.webTarget);
  await runCapacitor(["sync", "android"], { env: targetEnv });
  normalizeCapacitorSettingsFile(
    path.join(androidDir, "capacitor.settings.gradle"),
    {
      appPackageRootRelative: path
        .relative(androidDir, appDir)
        .split(path.sep)
        .join("/"),
    },
  );
  ensureBunRuntimeRegistered();
  mirrorCapacitorWebPayloadIntoAndroidDir();

  patchAndroidGradle({
    cloudBuild: target.env.ELIZA_ANDROID_CLOUD_BUILD === "1",
  });
  await generateAndroidBrandAssets({
    cloudBuild: target.env.ELIZA_ANDROID_CLOUD_BUILD === "1",
  });
  overlayAndroid(target.overlayOptions);
  sanitizeAndroidManifestWhenPlatformTemplatesMissing();
  writeAndroidCleartextPolicy(target.cleartextPolicy);
  if (target.agentRuntime) {
    await stageAndroidAgentRuntime({
      androidDir,
      spikeDir: androidAgentSpikeDir,
      ...target.agentRuntime,
    });
  }
  runAndroidTargetPhase(target, ANDROID_SOURCE_STRIPS, "stripSourceKey", {
    env: targetEnv,
  });
  runAndroidTargetPhase(
    target,
    ANDROID_SOURCE_AUDITS,
    "auditSourceKey",
    "pre-gradle",
    { env: targetEnv },
  );

  const buildEnv = createAndroidBuildEnv(target, {
    androidSdkRoot: sdk,
    env: resolvedEnv,
    javaHome: jdk,
  });
  const { buildArgs, metadataArgs } = resolveAndroidGradleCommandsForTarget(
    target,
    {
      env: resolvedEnv,
      settingsGradle: readAndroidSettingsGradle(),
    },
  );
  await run("./gradlew", metadataArgs, {
    cwd: androidDir,
    env: buildEnv,
  });
  await run("./gradlew", buildArgs, {
    cwd: androidDir,
    env: buildEnv,
  });
  runAndroidTargetPhase(
    target,
    ANDROID_SOURCE_AUDITS,
    "auditSourceKey",
    "post-gradle",
    { env: targetEnv },
  );
  if (target.artifactAuditKey === "cloud") {
    resolvedEnv[ANDROID_BUNDLETOOL_JAR_ENV] = await ensureAndroidBundletoolJar({
      env: resolvedEnv,
    });
  }
  const artifact = runAndroidTargetPhase(
    target,
    ANDROID_ARTIFACT_AUDITS,
    "artifactAuditKey",
    {
      androidSdkRoot: sdk,
      env: resolvedEnv,
      javaHome: jdk,
    },
  );
  runAndroidTargetPhase(target, ANDROID_POST_BUILDS, "postBuildKey", {
    artifact,
    androidSdkRoot: sdk,
    javaHome: jdk,
  });
}

export async function buildAndroid() {
  await runAndroidBuild("android");
}

export async function buildAndroidCloud({ debug = false } = {}) {
  await runAndroidBuild("android-cloud", { debug });
}

export async function buildAndroidSystem() {
  await runAndroidBuild("android-system");
}
