/** Owns android gradle using the shared build context and existing platform contracts. */

import { injectAndroidRuntimeBytePreservation } from "../../lib/android-runtime-packaging.mjs";
import fs from "node:fs";
import path from "node:path";
import {
  resolvePackageAbsolutePath,
  resolvePackageAbsolutePathCandidates,
} from "../build-tools.mjs";
import {
  APP,
  androidDir,
  androidUsesAppDir,
  appDir,
  elizaRepoRoot,
  nativePluginsDir,
  platformsDir,
  repoRoot,
} from "../context.mjs";
import { escapeXmlText } from "../escape.mjs";
import { ANDROID_OFFICIAL_CAPACITOR_PACKAGES } from "../ios-pods.mjs";
import { syncAndroidAppActionsResources } from "./app-actions.mjs";
import {
  appendMissingGradleDependency,
  applyAndroidGeneratedBuildTargetProperties,
  ensureGradleProperty,
  injectAndroidBackgroundRunnerAarFlatDir,
  injectAndroidSmsGatewayBuildConfigFields,
  injectAospAssetThinning,
  injectCopyForkLlamaLibTask,
  injectNativeLibLegacyPackaging,
  injectNoCompressTarGz,
  patchGradleFileForAgp9,
  replaceOrInsertGradleString,
  restrictLlamaCapacitorToArm64,
} from "./gradle-patches.mjs";
import { assertSharedTreeOnlyForEliza } from "./shared-tree.mjs";

export function patchInstalledCapacitorPluginGradleForAgp9(pkgName) {
  for (const pkgRoot of resolvePackageAbsolutePathCandidates(pkgName)) {
    patchGradleFileForAgp9(
      path.join(pkgRoot, "android", "build.gradle"),
      pkgName,
    );
  }
}

export function patchOfficialCapacitorGradleForAgp9() {
  for (const pkgName of ANDROID_OFFICIAL_CAPACITOR_PACKAGES) {
    patchInstalledCapacitorPluginGradleForAgp9(pkgName);
  }
}

export function patchLlamaCppCapacitorGradle() {
  for (const pkgRoot of resolvePackageAbsolutePathCandidates(
    "llama-cpp-capacitor",
  )) {
    const gradlePath = path.join(pkgRoot, "android", "build.gradle");
    patchGradleFileForAgp9(gradlePath, "llama-cpp-capacitor");
    restrictLlamaCapacitorToArm64(gradlePath);
  }
}

export function stageBackgroundRunnerAndroidJsEngineAar() {
  const settingsPath = path.join(androidDir, "capacitor.settings.gradle");
  if (!fs.existsSync(settingsPath)) return;
  const settings = fs.readFileSync(settingsPath, "utf8");
  if (!settings.includes(":capacitor-background-runner")) return;

  const aarName = "android-js-engine-release.aar";
  const source = [
    "@capacitor/background-runner",
    "@capacitor-community/background-runner",
  ]
    .map((pkgName) => resolvePackageAbsolutePath(pkgName))
    .filter(Boolean)
    .map((pkgRoot) =>
      path.join(pkgRoot, "android", "src", "main", "libs", aarName),
    )
    .find((candidate) => fs.existsSync(candidate));

  if (!source) {
    throw new Error(
      `[mobile-build] ${aarName} not found in @capacitor/background-runner; reinstall dependencies or check the package tarball.`,
    );
  }

  const targetDir = path.join(androidDir, "app", "libs");
  const target = path.join(targetDir, aarName);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  console.log(
    `[mobile-build] Staged Background Runner JS engine AAR: ${path.relative(repoRoot, target)}`,
  );
}

export function patchNativePluginGradleForAgp9() {
  if (!fs.existsSync(nativePluginsDir)) return;
  for (const entry of fs.readdirSync(nativePluginsDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    patchGradleFileForAgp9(
      path.join(nativePluginsDir, entry.name, "android", "build.gradle"),
      `@elizaos/capacitor-${entry.name}`,
    );
  }
}

export function patchAndroidGradleWrapperForReleaseCompat() {
  const wrapperPath = path.join(
    androidDir,
    "gradle",
    "wrapper",
    "gradle-wrapper.properties",
  );
  if (!fs.existsSync(wrapperPath)) return;
  const current = fs.readFileSync(wrapperPath, "utf8");
  const patched = current.replace(
    /^distributionUrl=.*$/m,
    "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.5.0-all.zip",
  );
  if (patched !== current) {
    fs.writeFileSync(wrapperPath, patched, "utf8");
    console.log("[mobile-build] Patched Android Gradle wrapper for AGP 9.");
  }
}

export function patchAndroidGradleProperties({ cloudBuild = false } = {}) {
  const propertiesPath = path.join(androidDir, "gradle.properties");
  if (!fs.existsSync(propertiesPath)) return;
  const current = fs.readFileSync(propertiesPath, "utf8");
  let patched = applyAndroidGeneratedBuildTargetProperties(current, {
    cloudBuild,
  });
  patched = patched.replace(
    /^android\.enableDexingArtifactTransform\.desugaring=.*\n?/m,
    "",
  );
  // Keep dexing on a full classpath to avoid fragile per-artifact transform
  // cache failures in generated local mobile builds.
  patched = ensureGradleProperty(
    patched,
    "android.useFullClasspathForDexingTransform",
    "true",
  );
  if (patched !== current) {
    fs.writeFileSync(propertiesPath, patched, "utf8");
    console.log("[mobile-build] Patched Android Gradle properties.");
  }
}

// llama-cpp-capacitor 0.x ships Android Gradle DSL 8 syntax in its own
// build.gradle. AGP 9 + Gradle 9 demand explicit `=` assignment for the
// project-level DSL keys it uses (`namespace`, `version`, `ndkVersion`,
// `lintOptions.abortOnError`) and rejects the legacy whitespace form, and
// the legacy proguard file path is no longer shipped. Patch the installed
// node_modules copy in place each build — modifying node_modules survives
// the gradle invocation but a fresh `bun install` will re-clobber it,
// which is fine because this function runs before every build.
export function patchInstalledLlamaCapacitorBuildGradle() {
  const candidates = [
    path.join(
      appDir,
      "node_modules",
      "llama-cpp-capacitor",
      "android",
      "build.gradle",
    ),
    path.join(
      repoRoot,
      "node_modules",
      "llama-cpp-capacitor",
      "android",
      "build.gradle",
    ),
  ];
  const bunStores = [
    path.join(appDir, "node_modules", ".bun"),
    path.join(repoRoot, "node_modules", ".bun"),
  ];
  for (const bunStore of bunStores) {
    if (!fs.existsSync(bunStore)) continue;
    for (const entry of fs.readdirSync(bunStore, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("llama-cpp-capacitor@")) continue;
      candidates.push(
        path.join(
          bunStore,
          entry.name,
          "node_modules",
          "llama-cpp-capacitor",
          "android",
          "build.gradle",
        ),
      );
    }
  }
  for (const gradlePath of candidates) {
    if (!fs.existsSync(gradlePath)) continue;
    const current = fs.readFileSync(gradlePath, "utf8");
    let patched = current
      .replaceAll(
        'namespace "ai.annadata.plugin.capacitor"',
        'namespace = "ai.annadata.plugin.capacitor"',
      )
      .replaceAll('version "3.22.1"', 'version = "3.22.1"')
      .replaceAll('ndkVersion "29.0.13113456"', 'ndkVersion = "29.0.13113456"')
      .replaceAll("abortOnError false", "abortOnError = false")
      .replaceAll(
        "getDefaultProguardFile('proguard-android.txt')",
        "getDefaultProguardFile('proguard-android-optimize.txt')",
      );
    patched = patched.replace(
      /\n\s*\/\/ Disable clean tasks[^\n]*\n\s*tasks\.whenTaskAdded\s*\{\s*task\s*->\s*\n\s*if\s*\(\s*task\.name\.contains\(["']Clean["']\)\s*&&\s*task\.name\.contains\(["']Debug["']\)\s*\)\s*\{\s*\n\s*task\.enabled\s*=\s*false\s*\n\s*\}\s*\n\s*\}\s*/g,
      "\n",
    );
    if (patched !== current) {
      fs.writeFileSync(gradlePath, patched, "utf8");
      console.log(
        `[mobile-build] Patched llama-cpp-capacitor build.gradle for AGP 9: ${path.relative(repoRoot, gradlePath)}`,
      );
    }
  }
}

export function patchAndroidGradle({ cloudBuild = false } = {}) {
  assertSharedTreeOnlyForEliza("patch gradle identity");
  patchAndroidGradleWrapperForReleaseCompat();
  patchAndroidGradleProperties({ cloudBuild });
  patchInstalledLlamaCapacitorBuildGradle();
  syncAndroidAppActionsResources();
  // Overwrite root build.gradle with our template (Maven mirrors, Kotlin version)
  const templateGradle = path.join(platformsDir, "android", "build.gradle");
  const targetGradle = path.join(androidDir, "build.gradle");
  if (fs.existsSync(templateGradle) && fs.existsSync(targetGradle)) {
    const current = fs.readFileSync(targetGradle, "utf8");
    const template = fs.readFileSync(templateGradle, "utf8");
    if (current !== template) {
      fs.writeFileSync(targetGradle, template, "utf8");
      console.log("[mobile-build] Patched android/build.gradle.");
    }
  }

  // Keep generated Android projects aligned with current Capacitor/AndroidX requirements.
  const varsPath = path.join(androidDir, "variables.gradle");
  if (fs.existsSync(varsPath)) {
    const vars = fs.readFileSync(varsPath, "utf8");
    const patched = vars
      .replace(/minSdkVersion\s*=\s*\d+/, "minSdkVersion = 26")
      .replace(/compileSdkVersion\s*=\s*\d+/, "compileSdkVersion = 36");
    if (patched !== vars) {
      fs.writeFileSync(varsPath, patched, "utf8");
      console.log("[mobile-build] Patched Android SDK versions.");
    }
  }

  const appGradlePath = path.join(androidDir, "app", "build.gradle");
  // Refresh app/build.gradle from the template every build so committed
  // template changes (e.g. the elizavoice-jni symbol gate) reach a white-label
  // android project. The initial template sync only runs when the project is
  // first materialized, so an existing apps/app/android would otherwise keep a
  // stale build.gradle across incremental builds. For the in-tree build the
  // template IS the target (same path) — skip so we don't self-copy.
  const templateAppGradle = path.join(
    platformsDir,
    "android",
    "app",
    "build.gradle",
  );
  if (
    fs.existsSync(templateAppGradle) &&
    path.resolve(templateAppGradle) !== path.resolve(appGradlePath)
  ) {
    const templateAppGradleContent = fs.readFileSync(templateAppGradle, "utf8");
    const currentAppGradle = fs.existsSync(appGradlePath)
      ? fs.readFileSync(appGradlePath, "utf8")
      : null;
    if (currentAppGradle !== templateAppGradleContent) {
      fs.mkdirSync(path.dirname(appGradlePath), { recursive: true });
      fs.writeFileSync(appGradlePath, templateAppGradleContent, "utf8");
      console.log("[mobile-build] Refreshed app/build.gradle from template.");
    }
  }
  if (fs.existsSync(appGradlePath)) {
    const current = fs.readFileSync(appGradlePath, "utf8");
    let patched = replaceOrInsertGradleString(current, "namespace", APP.appId);
    patched = replaceOrInsertGradleString(patched, "applicationId", APP.appId);
    patched = appendMissingGradleDependency(
      patched,
      "com.google.code.gson:gson:2.13.2",
    );
    patched = appendMissingGradleDependency(
      patched,
      "com.google.firebase:firebase-common-ktx:21.0.0",
    );
    patched = patched.replace(
      /getDefaultProguardFile\('proguard-android\.txt'\)/g,
      "getDefaultProguardFile('proguard-android-optimize.txt')",
    );
    patched = injectAndroidSmsGatewayBuildConfigFields(patched);
    patched = injectNoCompressTarGz(patched);
    patched = injectNativeLibLegacyPackaging(patched);
    patched = injectAndroidRuntimeBytePreservation(patched);
    patched = injectAospAssetThinning(patched);
    patched = injectCopyForkLlamaLibTask(patched);
    patched = injectAndroidBackgroundRunnerAarFlatDir(patched);
    // The template resolves `elizaRepoRoot` for the omnivoice FFI headers via a
    // relative `../../../..` walk from the gradle project dir. That only lands
    // on the eliza checkout when the android project is nested inside it (the
    // in-tree app-core/platforms/android build), where the relative form is
    // correct and portable — leave it alone. A white-label app builds in its
    // own android dir (appDir/android) OUTSIDE the checkout, so the same walk
    // overshoots the repo root (→ /home/.../plugins, header not found). Only
    // there do we pin it to the absolute checkout root this script resolved, so
    // we never rewrite the committed template with a machine-specific path.
    if (androidUsesAppDir) {
      patched = patched.replace(
        /def elizaRepoRoot = .*/,
        () =>
          `def elizaRepoRoot = new File(${JSON.stringify(elizaRepoRoot).replace(/\$/g, "\\$")})`,
      );
    }
    if (patched !== current) {
      fs.writeFileSync(appGradlePath, patched, "utf8");
      console.log(
        `[mobile-build] Applied Android package identity ${APP.appId}.`,
      );
    }
  }

  patchOfficialCapacitorGradleForAgp9();
  patchLlamaCppCapacitorGradle();
  patchNativePluginGradleForAgp9();
  stageBackgroundRunnerAndroidJsEngineAar();

  const stringsPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "res",
    "values",
    "strings.xml",
  );
  if (fs.existsSync(stringsPath)) {
    const current = fs.readFileSync(stringsPath, "utf8");
    const appName = escapeXmlText(APP.appName);
    const appId = escapeXmlText(APP.appId);
    const urlScheme = escapeXmlText(APP.urlScheme);
    const patched = current
      .replace(
        /<string name="app_name">[^<]*<\/string>/,
        `<string name="app_name">${appName}</string>`,
      )
      .replace(
        /<string name="title_activity_main">[^<]*<\/string>/,
        `<string name="title_activity_main">${appName}</string>`,
      )
      .replace(
        /<string name="package_name">[^<]*<\/string>/,
        `<string name="package_name">${appId}</string>`,
      )
      .replace(
        /<string name="custom_url_scheme">[^<]*<\/string>/,
        `<string name="custom_url_scheme">${urlScheme}</string>`,
      );
    if (patched !== current) {
      fs.writeFileSync(stringsPath, patched, "utf8");
      console.log(
        `[mobile-build] Applied Android app strings for ${APP.appName}.`,
      );
    }
  }
}
