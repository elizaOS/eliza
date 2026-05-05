/**
 * brand-config.mjs — Brand resolver for the distro-android toolchain.
 *
 * The cuttlefish/AOSP toolchain (build-aosp, sync-to-aosp, validate,
 * boot-validate, e2e-validate, …) was originally written assuming a
 * single brand: "eliza" / "Eliza" / "com.elizaai.eliza". To support
 * whitelabeling (e.g. ElizaOS as the default, ElizaOS as a downstream
 * brand), every brand-coupled string is centralised here.
 *
 * Brand config schema:
 *   {
 *     "brand":               "eliza",                  // lowercase token; vendor/<X> dir, init.<X>.rc, eliza_*.mk filename prefix
 *     "appName":             "Eliza",                  // PascalCase; APK module name, vendor/<X>/apps/<APP_NAME>/<APP_NAME>.apk
 *     "distroName":          "ElizaOS",                // brand display name for log messages
 *     "packageName":         "com.elizaai.eliza",     // APK Java package id
 *     "classPrefix":         "Eliza",                  // Java class name prefix (ElizaDialActivity, ElizaSmsReceiver, …)
 *     "productName":         "eliza_cf_x86_64_phone",  // Cuttlefish product name (used for lunch target + product makefile filename)
 *     "lunchTarget":         "eliza_cf_x86_64_phone-trunk_staging-userdebug",
 *     "envPrefix":           "ELIZA",                  // env var prefix (ELIZA_PIXEL_CODENAME, ELIZA_AOSP_BUILD, …)
 *     "vendorDir":            "packages/os/android/vendor/eliza" // optional override of source vendor dir relative to repo root
 *     "buildAndroidSystemCmd": ["bun", "run", "build:android:system"]  // command to rebuild the privileged APK
 *   }
 *
 * Resolution order (first match wins):
 *   1. CLI flag: --brand-config <path>
 *   2. Env var:  DISTRO_ANDROID_BRAND_CONFIG
 *   3. Default:  scripts/distro-android/brand.eliza.json (relative to this file)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const BRAND_CONFIG_FLAG = "--brand-config";
export const BRAND_CONFIG_ENV = "DISTRO_ANDROID_BRAND_CONFIG";
export const DEFAULT_BRAND_CONFIG = path.join(here, "brand.eliza.json");

const REQUIRED_FIELDS = [
  "brand",
  "appName",
  "distroName",
  "packageName",
  "classPrefix",
  "productName",
  "lunchTarget",
  "envPrefix",
];

/**
 * Pulls --brand-config <path> from argv, returns { brandConfigPath, remaining }.
 * Mutates nothing; callers continue parsing `remaining` for their own flags.
 */
export function extractBrandConfigFlag(argv) {
  const remaining = [];
  let brandConfigPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === BRAND_CONFIG_FLAG) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${BRAND_CONFIG_FLAG} requires a path value`);
      }
      brandConfigPath = path.resolve(value);
      i += 1;
    } else {
      remaining.push(arg);
    }
  }
  return { brandConfigPath, remaining };
}

/**
 * Resolve the brand config path from CLI flag (already extracted), env var,
 * or fall back to the default.
 */
export function resolveBrandConfigPath(brandConfigPath = null) {
  if (brandConfigPath) return brandConfigPath;
  if (process.env[BRAND_CONFIG_ENV]) {
    return path.resolve(process.env[BRAND_CONFIG_ENV]);
  }
  return DEFAULT_BRAND_CONFIG;
}

/**
 * Load and validate a brand config JSON file.
 */
export function loadBrandConfig(configPath) {
  const resolved = resolveBrandConfigPath(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Brand config not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Brand config ${resolved} is not valid JSON: ${err.message}`,
    );
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof parsed[field] !== "string" || parsed[field].length === 0) {
      throw new Error(
        `Brand config ${resolved} is missing required string field "${field}"`,
      );
    }
  }
  // Defaults for optional fields.
  parsed.initRcName = parsed.initRcName ?? `init.${parsed.brand}.rc`;
  parsed.vendorDir =
    parsed.vendorDir ?? `packages/os/android/vendor/${parsed.brand}`;
  parsed.buildAndroidSystemCmd = parsed.buildAndroidSystemCmd ?? [
    "bun",
    "run",
    "build:android:system",
  ];
  parsed.commonMakefile = parsed.commonMakefile ?? `${parsed.brand}_common.mk`;
  parsed.pixelMakefilePrefix = parsed.pixelMakefilePrefix ?? `${parsed.brand}`;
  parsed.cuttlefishMakefile =
    parsed.cuttlefishMakefile ?? `${parsed.productName}.mk`;
  // System property prefix used by init.<brand>.rc and the boot
  // validator. Defaults to distroName lowercased (e.g. ElizaOS →
  // "elizaos", ElizaOS → "elizaos") so `ro.<propertyPrefix>.product`
  // matches what the AOSP build sets via PRODUCT_PROPERTY_OVERRIDES.
  parsed.propertyPrefix =
    parsed.propertyPrefix ?? parsed.distroName.toLowerCase();
  parsed.brandConfigPath = resolved;
  return parsed;
}

/**
 * Convenience: extract --brand-config from argv, resolve, load.
 * Returns { brand, remaining }.
 */
export function loadBrandFromArgv(argv) {
  const { brandConfigPath, remaining } = extractBrandConfigFlag(argv);
  const brand = loadBrandConfig(brandConfigPath);
  return { brand, remaining };
}
