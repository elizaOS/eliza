/** Owns Android target orchestration and environment assembly using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ANDROID_BUNDLETOOL_JAR_ENV,
  ensureAndroidBundletoolJar,
} from "../../lib/android-cloud-artifact-audit.mjs";
import { normalizeCapacitorSettingsFile } from "../../lib/portable-capacitor-settings.mjs";
import { stageAndroidAgentRuntime } from "../../lib/stage-android-agent.mjs";
import { buildMobileAgentBundle } from "../agent-bundle.mjs";
import { resolveAndroidGradleCommandsForTarget } from "../android-gradle.mjs";
import {
  auditAndroidCloudArtifact,
  auditAndroidHostE2eArtifact,
  auditAndroidLauncherArtifact,
  auditAndroidSideloadArtifact,
  auditAndroidSmsGatewayArtifact,
  auditAndroidSystemArtifact,
} from "../artifact-inspection/android-audit.mjs";
import {
  preserveAndroidSmsGatewayArtifact,
  stageAndroidSystemApk,
} from "../artifact-inspection/provenance.mjs";
import { generateAndroidBrandAssets } from "../assets.mjs";
import { prependPath, run, runCapacitor } from "../build-tools.mjs";
import {
  APP,
  androidAgentSpikeDir,
  androidDir,
  appDir,
  MOBILE_BUILD_SCRIPT_URL,
} from "../context.mjs";
import {
  ensureBunRuntimeRegistered,
  ensurePlatform,
  mirrorCapacitorWebPayloadIntoAndroidDir,
} from "../platform-sync.mjs";
import { resolveAndroidBuildTarget } from "../targets/android.mjs";
import { resolveAndroidSdkRoot, resolveJavaHome } from "../toolchain.mjs";
import { buildWeb, ensureRendererDistMatchesLane } from "../web-build.mjs";
import {
  enforceAndroidLp3ColorPolicyBuildPolicy,
  enforceAndroidLp3RemoteFallbackBuildPolicy,
  resolveAndroidLp3ColorPolicyBuildEnv,
} from "./cloud-policy.mjs";
import { patchAndroidGradle } from "./gradle.mjs";
import {
  overlayAndroid,
  sanitizeAndroidManifestWhenPlatformTemplatesMissing,
  writeAndroidCleartextPolicy,
} from "./overlay.mjs";
import {
  auditAndroidCloudSource,
  auditAndroidLauncherSource,
  auditAndroidSmsGatewaySource,
  auditAndroidSystemSource,
} from "./source-audit.mjs";
import { stripAndroidForCloud, stripAndroidForSmsGateway } from "./strip.mjs";

export function enforceAndroidSideloadBuildPolicy({ env = process.env } = {}) {
  // Hard refusal: the default `android` target is sideload-only and will be
  // rejected by Play. If CI or a contributor signals Play-Store intent via
  // env vars, fail loudly and point them at the right target.
  const playStoreFlagged =
    env.ELIZA_PLAY_STORE_BUILD === "1" ||
    env.ELIZA_BUILD_VARIANT?.toLowerCase() === "store";
  if (playStoreFlagged) {
    console.error(
      "[mobile-build] Refusing target `android` under ELIZA_PLAY_STORE_BUILD / " +
        "ELIZA_BUILD_VARIANT=store. The default `android` APK embeds the " +
        "on-device agent runtime and requests Play-rejected permissions " +
        "(MANAGE_APP_OPS_MODES, PACKAGE_USAGE_STATS). Use " +
        "`build:android:cloud` (Play-Store-compliant thin client) or " +
        "`build:android:system` (AOSP privileged platform-signed APK).",
    );
    process.exit(2);
  }

  console.warn(
    "[mobile-build] WARNING: target `android` produces an APK that embeds " +
      "the on-device agent runtime (libeliza_bun.so disguise) and requests " +
      "system-only permissions (MANAGE_APP_OPS_MODES, PACKAGE_USAGE_STATS). " +
      "It is SIDELOAD-ONLY and will be rejected by the Play Store. Use " +
      "`build:android:cloud` for a Play-Store-compliant thin client, or " +
      "`build:android:system` for the AOSP privileged platform-signed APK.",
  );
}

export function requireAndroidSmsGatewaySecret({ env = process.env } = {}) {
  if (!env.ELIZA_ANDROID_SMS_GATEWAY_SECRET) {
    throw new Error(
      "ELIZA_ANDROID_SMS_GATEWAY_SECRET is required for android-sms-gateway.",
    );
  }
}

export const ANDROID_PREFLIGHTS = Object.freeze({
  sideload: enforceAndroidSideloadBuildPolicy,
});

export const ANDROID_AFTER_TOOLCHAIN = Object.freeze({
  smsGatewaySecret: requireAndroidSmsGatewaySecret,
});

export const ANDROID_SOURCE_STRIPS = Object.freeze({
  cloud: stripAndroidForCloud,
  smsGateway: stripAndroidForSmsGateway,
});

export const ANDROID_SOURCE_AUDITS = Object.freeze({
  cloud: auditAndroidCloudSource,
  launcher: auditAndroidLauncherSource,
  smsGateway: auditAndroidSmsGatewaySource,
  system: auditAndroidSystemSource,
});

export const ANDROID_ARTIFACT_AUDITS = Object.freeze({
  sideload: ({ javaHome }) => auditAndroidSideloadArtifact({ javaHome }),
  hostE2e: ({ javaHome }) => auditAndroidHostE2eArtifact({ javaHome }),
  cloud: ({ env, javaHome }) => auditAndroidCloudArtifact({ env, javaHome }),
  cloudDebug: ({ env, javaHome }) =>
    auditAndroidCloudArtifact({ debug: true, env, javaHome }),
  launcher: ({ androidSdkRoot, env, javaHome }) =>
    auditAndroidLauncherArtifact({ androidSdkRoot, env, javaHome }),
  smsGateway: ({ androidSdkRoot, javaHome }) =>
    auditAndroidSmsGatewayArtifact({ androidSdkRoot, javaHome }),
  system: ({ androidSdkRoot, javaHome }) =>
    auditAndroidSystemArtifact({ androidSdkRoot, javaHome }),
});

export const ANDROID_POST_BUILDS = Object.freeze({
  logCloudRelease: ({ artifact }) =>
    console.log(`[mobile-build] android-cloud release AAB: ${artifact}`),
  preserveSmsGateway: ({ artifact }) => {
    preserveAndroidSmsGatewayArtifact(artifact);
    console.log(`[mobile-build] android-sms-gateway debug APK: ${artifact}`);
  },
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

export function resolveAndroidSmsGatewayEnvDefaults(env) {
  return {
    ELIZA_ANDROID_SMS_GATEWAY_ENABLED:
      env.ELIZA_ANDROID_SMS_GATEWAY_ENABLED ?? "true",
    ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL:
      env.ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL ??
      "https://api.eliza.app/api/webhooks/blooio/local?bridge=bluebubbles",
    ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER:
      env.ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER ?? "+14159611510",
    ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL:
      env.ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL ??
      "Eliza Cloud Gateway (+14159611510)",
  };
}

export function createAndroidBuildEnv(
  target,
  { androidSdkRoot, env, javaHome },
) {
  return {
    ...env,
    ...target.env,
    ...(target.includeSmsGatewayEnvDefaults
      ? resolveAndroidSmsGatewayEnvDefaults(env)
      : {}),
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
  const resolvedEnv = resolveAndroidLp3ColorPolicyBuildEnv(env);
  const target = resolveAndroidBuildTarget(targetName, { debug });
  const targetEnv = { ...resolvedEnv, ...target.env };
  enforceAndroidLp3ColorPolicyBuildPolicy({
    targetName: target.target,
    env: resolvedEnv,
    appId: APP.appId,
  });
  enforceAndroidLp3RemoteFallbackBuildPolicy({
    targetName: target.target,
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
  runAndroidTargetPhase(
    target,
    ANDROID_AFTER_TOOLCHAIN,
    "afterToolchainResolvedKey",
    { env: resolvedEnv },
  );

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
  const { buildArgs, metadataArgs } = resolveAndroidGradleCommands(
    target.target,
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

export async function buildAndroidSmsGateway() {
  await runAndroidBuild("android-sms-gateway");
}

export async function buildAndroidSystem() {
  await runAndroidBuild("android-system");
}
