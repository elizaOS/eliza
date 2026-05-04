#!/usr/bin/env node
// eliza/packages/app-core/scripts/aosp/stage-models-dfm.mjs —
// restructure the regenerated apps/app/android/ tree so the bundled
// GGUF models live in a Play Store-friendly **dynamic feature
// module** instead of being baked into the base APK.
//
// Why:
//   Play Store hard-rejects APKs over 200MB. With both default models
//   bundled the base APK is ~600MB (bun runtime per ABI + ~400MB of
//   GGUFs + WebView assets). AABs lift that ceiling but only when the
//   GGUFs ship as a separate dynamic feature module — splitting moves
//   the models out of the base APK and into per-install delivery.
//
//   Install-time delivery (`dist:onDemand="false"` +
//   `dist:install-time required`) means Play installs the module
//   alongside the base APK on first install — no on-demand UI prompt,
//   no SplitInstallManager glue in app code. From the user's
//   perspective it's identical to bundling them in the base APK.
//
// What this script does:
//   1. Creates `apps/app/android/models/` as a `dynamic-feature`
//      gradle module with its own AndroidManifest.xml,
//      build.gradle, and assets dir.
//   2. Moves the staged GGUFs from
//        apps/app/android/app/src/main/assets/agent/models/
//      to
//        apps/app/android/models/src/main/assets/agent/models/
//   3. Patches app/build.gradle to declare `dynamicFeatures = [':models']`.
//   4. Patches settings.gradle to `include ':models'`.
//   5. Patches app/src/main/AndroidManifest.xml to declare the module
//      via `<dist:module>` (the base APK's manifest references the
//      DFM by name).
//
// AOSP/cuttlefish builds keep the APK path (`<PREFIX>_BUILD_FORMAT=apk`,
// the default). Cuttlefish needs an APK because cvd does not handle
// AABs. This script only runs when `<PREFIX>_BUILD_FORMAT=aab` (where
// `<PREFIX>` is the host app's `envPrefix`, e.g. ELIZA / ACME), or
// when invoked with `--force`.
//
// On-device asset access:
//   `ElizaAgentService` reads `getAssets().open("agent/models/...")`.
//   When the model module is install-time delivered, its assets are
//   merged into the application's AssetManager at install time, so
//   the same `getAssets().open(...)` call resolves to the DFM-shipped
//   files transparently. No service code change needed — verified by
//   AOSP `AssetManager` documentation.
//
// Idempotent: re-running with the DFM already created and assets
// already moved is a no-op (the move skips existing destinations).

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./lib/load-variant-config.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

const APP_ANDROID_DIR = path.join(repoRoot, "apps", "app", "android");
const MODELS_MODULE_DIR = path.join(APP_ANDROID_DIR, "models");
const APP_MODULE_DIR = path.join(APP_ANDROID_DIR, "app");

const SOURCE_MODELS_DIR = path.join(
  APP_MODULE_DIR,
  "src",
  "main",
  "assets",
  "agent",
  "models",
);
const DEST_MODELS_DIR = path.join(
  MODELS_MODULE_DIR,
  "src",
  "main",
  "assets",
  "agent",
  "models",
);

/**
 * Resolve the package name + variant display name from the host's
 * `app.config.ts`. The DFM's namespace is derived as
 * `<packageName>.models`; the strings.xml title is derived from
 * `variantName`.
 *
 * Returns null when no AOSP variant is declared (the script then
 * prints a helpful error rather than silently writing wrong files).
 */
function resolveVariant(appConfigPath) {
  if (!fsSync.existsSync(appConfigPath)) return null;
  return loadAospVariantConfig({ appConfigPath });
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
}

async function moveModelAssets() {
  if (!(await exists(SOURCE_MODELS_DIR))) {
    console.log(
      `[stage-models-dfm] No staged models at ${SOURCE_MODELS_DIR}; skipping move.`,
    );
    return;
  }
  await fs.mkdir(DEST_MODELS_DIR, { recursive: true });
  const entries = await fs.readdir(SOURCE_MODELS_DIR, { withFileTypes: true });
  let moved = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = path.join(SOURCE_MODELS_DIR, entry.name);
    const dst = path.join(DEST_MODELS_DIR, entry.name);
    if (await exists(dst)) {
      // Already moved on a prior run — leave the destination alone.
      // Remove the now-stale base APK copy if it's still there.
      await fs.rm(src, { force: true });
      continue;
    }
    await fs.rename(src, dst);
    moved += 1;
  }
  // Clean up the now-empty source dir (best effort; if anything is
  // left behind that's fine — the next run will pick it up).
  try {
    await fs.rmdir(SOURCE_MODELS_DIR);
  } catch {
    // Non-empty or already gone.
  }
  console.log(
    `[stage-models-dfm] Moved ${moved} model file(s) into the :models DFM at ${DEST_MODELS_DIR}.`,
  );
}

async function writeModelsManifest(modulePackage) {
  // The DFM's AndroidManifest declares its delivery type. Install-time
  // delivery (`dist:onDemand="false"`, `dist:install-time required`)
  // means Play installs the module alongside the base APK at install,
  // no on-demand prompt. The base APK's manifest references this
  // module via `<dist:module>` in the base manifest patch below.
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:dist="http://schemas.android.com/apk/distribution"
    package="${modulePackage}">

    <dist:module
        dist:instant="false"
        dist:title="@string/models_module_title">
        <dist:delivery>
            <dist:install-time>
                <dist:removable dist:value="false" />
            </dist:install-time>
        </dist:delivery>
        <dist:fusing dist:include="true" />
    </dist:module>

    <application />
</manifest>
`;
  await writeFile(
    path.join(MODELS_MODULE_DIR, "src", "main", "AndroidManifest.xml"),
    manifest,
  );
}

async function writeModelsBuildGradle(modulePackage) {
  // Dynamic-feature module: depends on `:app`, inherits its
  // applicationId, and ships only its own assets. Compile/min/target
  // SDK come from the root variables.gradle so we never drift away
  // from the base APK's targets (a DFM whose targetSdk diverges from
  // the base will be rejected at install time).
  const buildGradle = `apply plugin: 'com.android.dynamic-feature'

android {
    namespace = "${modulePackage}"
    compileSdk = rootProject.ext.compileSdkVersion

    defaultConfig {
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
    }
}

dependencies {
    implementation project(':app')
}
`;
  await writeFile(path.join(MODELS_MODULE_DIR, "build.gradle"), buildGradle);
}

async function writeModelsStrings(variantName) {
  // The DFM title is required by the install-time manifest. Keep the
  // strings.xml minimal — just the one title resource.
  const strings = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="models_module_title">${variantName} local-inference models</string>
</resources>
`;
  await writeFile(
    path.join(MODELS_MODULE_DIR, "src", "main", "res", "values", "strings.xml"),
    strings,
  );
}

async function patchSettingsGradle() {
  const settingsPath = path.join(APP_ANDROID_DIR, "settings.gradle");
  const current = await readIfExists(settingsPath);
  if (current === null) {
    throw new Error(`settings.gradle not found at ${settingsPath}`);
  }
  if (current.includes("include ':models'")) {
    return;
  }
  // Insert ':models' alongside the existing ':app' include so gradle
  // resolves the project. Place it right after the ':app' line so
  // the module ordering stays stable across regenerations.
  const patched = current.replace(
    /include\s+':app'/,
    "include ':app'\ninclude ':models'",
  );
  if (patched === current) {
    throw new Error(
      `settings.gradle is missing \`include ':app'\`; cannot inject :models DFM include`,
    );
  }
  await fs.writeFile(settingsPath, patched, "utf8");
  console.log("[stage-models-dfm] Patched settings.gradle to include :models.");
}

async function patchAppBuildGradle() {
  const appGradlePath = path.join(APP_MODULE_DIR, "build.gradle");
  const current = await readIfExists(appGradlePath);
  if (current === null) {
    throw new Error(`app/build.gradle not found at ${appGradlePath}`);
  }
  if (current.includes("dynamicFeatures")) {
    return;
  }
  // The dynamicFeatures block must live at the android-block top
  // level. Inject it right after `namespace = ...` so the placement
  // is deterministic.
  const patched = current.replace(
    /(namespace\s*=\s*"[^"]+")/,
    `$1\n    dynamicFeatures = [':models']`,
  );
  if (patched === current) {
    throw new Error(
      `app/build.gradle is missing namespace declaration; cannot inject dynamicFeatures`,
    );
  }
  await fs.writeFile(appGradlePath, patched, "utf8");
  console.log(
    "[stage-models-dfm] Patched app/build.gradle to declare dynamicFeatures = [':models'].",
  );
}

function parseDfmArgs(argv) {
  const out = { force: false, appConfigPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      out.force = true;
    } else if (arg === "--app-config") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--app-config requires a value");
      }
      out.appConfigPath = path.resolve(value);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app-core/scripts/aosp/stage-models-dfm.mjs [--force] [--app-config <PATH>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const { force, appConfigPath: appConfigArg } = parseDfmArgs(argv);

  // The script is opt-in. Build-aosp.mjs only invokes it when the
  // host's `<PREFIX>_BUILD_FORMAT` env var is `"aab"`. We accept any
  // env name ending in `_BUILD_FORMAT` so forks with different
  // envPrefix values don't have to fork this script. A direct
  // invocation can pass `--force` to bypass the env check.
  const buildFormat = readBuildFormatFromEnv(process.env);
  if (buildFormat !== "aab" && !force) {
    console.log(
      `[stage-models-dfm] *_BUILD_FORMAT=${buildFormat ?? "<unset>"}; nothing to do (set <PREFIX>_BUILD_FORMAT=aab or pass --force).`,
    );
    return;
  }

  if (!(await exists(APP_ANDROID_DIR))) {
    throw new Error(
      `apps/app/android/ not found at ${APP_ANDROID_DIR}; run \`bun run build:android:system\` first to regenerate the Capacitor tree.`,
    );
  }

  // Resolve variant config so the DFM's package name + display string
  // come from the host's `app.config.ts > aosp:` block instead of
  // hardcoded brand values.
  const appConfigPath = resolveAppConfigPath({
    repoRoot,
    flagValue: appConfigArg,
  });
  const variant = resolveVariant(appConfigPath);
  if (!variant) {
    throw new Error(
      `[stage-models-dfm] No \`aosp:\` block found in ${appConfigPath}. ` +
        `The DFM build needs a packageName + variantName from app.config.ts.`,
    );
  }
  const modulePackage = `${variant.packageName}.models`;

  await fs.mkdir(MODELS_MODULE_DIR, { recursive: true });
  await writeModelsManifest(modulePackage);
  await writeModelsBuildGradle(modulePackage);
  await writeModelsStrings(variant.variantName);
  await patchSettingsGradle();
  await patchAppBuildGradle();
  await moveModelAssets();

  console.log(
    "[stage-models-dfm] :models DFM staged. Build the AAB with `cd apps/app/android && ./gradlew :app:bundleRelease`.",
  );
}

/**
 * Look up `<PREFIX>_BUILD_FORMAT` across the typical host envPrefix
 * values without forcing the script to know which prefix the host is
 * using. If multiple are set, an explicit `aab` wins.
 */
function readBuildFormatFromEnv(env) {
  const candidates = Object.keys(env).filter((k) =>
    k.endsWith("_BUILD_FORMAT"),
  );
  if (candidates.length === 0) return null;
  for (const k of candidates) {
    if (env[k] === "aab") return "aab";
  }
  // Return the first non-empty value so the diagnostic in main()
  // shows the operator what was set.
  for (const k of candidates) {
    if (env[k]) return env[k];
  }
  return null;
}

export { main, moveModelAssets, patchAppBuildGradle, patchSettingsGradle };

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
