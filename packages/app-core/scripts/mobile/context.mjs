/** Resolves one mobile build’s app identity, checkout, platform, and artifact paths. All paths retain the stable CLI location as their anchor across source checkouts and packed consumer layouts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "../aosp/lib/load-variant-config.mjs";
import { resolveMainAppDir } from "../lib/app-dir.mjs";
import { androidUsesAppDirFor } from "../lib/mobile-build-decisions.mjs";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";

// ── Paths ───────────────────────────────────────────────────────────────

export const MOBILE_BUILD_SCRIPT_URL = new URL(
  "../run-mobile-build.mjs",
  import.meta.url,
).href;

export const __dirname = path.dirname(fileURLToPath(MOBILE_BUILD_SCRIPT_URL));

// When this elizaOS checkout is nested inside a consumer monorepo that
// wraps it as `eliza/`, the repo-root walk resolves to the OUTER
// repo and the build targets the consumer's app. Allow an explicit override
// so the elizaOS app itself can be built standalone from the nested checkout.
export const repoRoot = process.env.ELIZA_MOBILE_REPO_ROOT?.trim()
  ? path.resolve(process.env.ELIZA_MOBILE_REPO_ROOT.trim())
  : resolveRepoRootFromImportMeta(MOBILE_BUILD_SCRIPT_URL, {
      fallbackToCwd: true,
    });

export const appCoreRoot = path.resolve(__dirname, "..");

export const elizaCheckoutRoot = path.resolve(appCoreRoot, "..", "..");

export const packagesRoot = path.resolve(appCoreRoot, "..");

export const elizaRepoRoot = path.resolve(packagesRoot, "..");

export const appDir = resolveMainAppDir(repoRoot, "app");

export const iosDir = path.join(appDir, "ios", "App");

// Android build target. By default this is the canonical elizaOS platform tree
// (app-core/platforms/android), which the elizaOS app itself builds in. A
// whitelabel consumer that embeds the elizaOS checkout must NOT
// build in that shared tree — the identity overlay rewrites it in place, so
// after a whitelabel build the tree carries the consumer's package and a subsequent
// elizaOS build (or vice versa) is corrupted. Setting ELIZA_ANDROID_USE_APP_DIR=1
// builds in the host app's own dir (appDir/android, like iOS already does),
// treating app-core/platforms/android as a read-only template copied in by
// overlayAndroid/patchAndroidGradle/syncAndroidAppActionsResources. That keeps
// the two brands' Android builds fully separate.
export const androidBuildAppId = readAppIdentity().appId;

export const androidUsesAppDir = androidUsesAppDirFor(
  androidBuildAppId,
  process.env,
);

export const androidDir = androidUsesAppDir
  ? path.join(appDir, "android")
  : path.join(appCoreRoot, "platforms", "android");

export const localArtifactsDir = path.join(
  elizaRepoRoot,
  ".eliza-local",
  "artifacts",
);

export const androidSmsGatewayDebugApkArtifact = path.join(
  localArtifactsDir,
  "eliza-android-sms-gateway-debug.apk",
);

// AOSP system APK staging path. Brand-aware: forks declare their vendor
// dir + APK name in `app.config.ts > aosp:`. When that block is present
// (Eliza, etc.), stage to `<repoRoot>/os/android/vendor/<vendorDir>/
// apps/<appName>/<appName>.apk`. When absent, fall back to the upstream
// Canonical system images live in the sibling elizaOS/os checkout. App-only
// Android builds never write there; the AOSP lane sets ELIZAOS_OS_REPO_ROOT.
export function resolveSystemApkStagingDir() {
  const osRepositoryRoot = path.resolve(
    process.env.ELIZAOS_OS_REPO_ROOT ?? path.join(elizaRepoRoot, "..", "os"),
  );
  let variant = null;
  try {
    variant = loadAospVariantConfig({
      appConfigPath: resolveAppConfigPath({ repoRoot, flagValue: null }),
    });
  } catch {
    // app.config.ts missing or malformed — fall through to the elizaOS
    // default. The upstream layout is the right answer for forks that
    // never set up an aosp: block.
  }
  if (variant) {
    const vendorDir = path.join(
      osRepositoryRoot,
      "packages",
      "os",
      "android",
      "vendor",
      variant.vendorDir,
    );
    return {
      vendorDir,
      apkDir: path.join(vendorDir, "apps", variant.appName),
      apkName: `${variant.appName}.apk`,
    };
  }
  const elizaOsVendorDir = path.join(
    osRepositoryRoot,
    "packages",
    "os",
    "android",
    "vendor",
    "eliza",
  );
  return {
    vendorDir: elizaOsVendorDir,
    apkDir: path.join(elizaOsVendorDir, "apps", "Eliza"),
    apkName: "Eliza.apk",
  };
}

export const systemApkStaging = resolveSystemApkStagingDir();

export const elizaOsApkDir = systemApkStaging.apkDir;

export const elizaOsApkName = systemApkStaging.apkName;

export const platformsDir = path.join(appCoreRoot, "platforms");

export const nativePluginsDir = path.join(packagesRoot, "native", "plugins");

export const androidAgentSpikeDir = path.join(
  repoRoot,
  "scripts",
  "spike-android-agent",
);

// ── Phase 1: Resolve app identity from app.config.ts ────────────────────

export function readAppIdentity() {
  const cfgPath = path.join(appDir, "app.config.ts");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`app.config.ts not found at ${cfgPath}`);
  }
  const src = fs.readFileSync(cfgPath, "utf8");
  const configAppId = src.match(/appId:\s*["']([^"']+)["']/)?.[1];
  const appId =
    process.env.ELIZA_APP_ID?.trim() ||
    process.env.ELIZA_IOS_APP_ID?.trim() ||
    configAppId;
  const appName =
    process.env.ELIZA_APP_NAME?.trim() ||
    src.match(/appName:\s*["']([^"']+)["']/)?.[1];
  const urlScheme =
    process.env.ELIZA_APP_URL_SCHEME?.trim() ||
    src.match(/urlScheme:\s*["']([^"']+)["']/)?.[1] ||
    appId;
  if (!appId || !appName) {
    throw new Error("Could not parse appId/appName from app.config.ts");
  }
  // Opaque background the icon mark is flattened onto (iOS app icon + Android
  // legacy launcher + adaptive-icon background). Whitelabel seam: each app sets
  // its own brand color in app.config.ts (web.iconBackgroundColor). Falls back
  // to the upstream elizaOS accent so a config without the field is unchanged.
  const iconBackgroundColor =
    process.env.ELIZA_ICON_BACKGROUND?.trim() ||
    src.match(/iconBackgroundColor:\s*["']([^"']+)["']/)?.[1] ||
    "#FF5800";
  // android.userAgentMarkers is an optional array literal nested under
  // `android: { ... }`. Parse the array body via regex (rather than
  // executing the TS file) so this script stays bun-import-free.
  const userAgentMarkers = parseAndroidUserAgentMarkers(src);
  return { appId, appName, urlScheme, iconBackgroundColor, userAgentMarkers };
}

export function parseAndroidUserAgentMarkers(configSrc) {
  const block = configSrc.match(
    /android\s*:\s*\{[\s\S]*?userAgentMarkers\s*:\s*\[([\s\S]*?)\]/,
  );
  if (!block) return [];
  const body = block[1];
  const markers = [];
  const entryRe =
    /\{\s*systemProp\s*:\s*["']([^"']+)["']\s*,\s*uaPrefix\s*:\s*["']([^"']+)["']\s*[,}]/g;
  while (true) {
    const m = entryRe.exec(body);
    if (!m) break;
    markers.push({ systemProp: m[1], uaPrefix: m[2] });
  }
  return markers;
}

export const APP = readAppIdentity();
