#!/usr/bin/env node
// Sync the host's vendor/<vendorDir>/ tree into an AOSP checkout's
// `vendor/<vendorDir>/`, ready for `m -j... <productName>_*`.
//
// Reads `vendorDir` + `appName` from `app.config.ts > aosp:`, with
// `--source-vendor` and `--app-config` overrides for tests.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./lib/load-variant-config.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

const USAGE =
  "Usage: node eliza/packages/app-core/scripts/aosp/sync-to-aosp.mjs " +
  "[--source-vendor <VENDOR_DIR>] [--app-config <PATH>] <AOSP_ROOT>";

export function parseArgs(argv) {
  const args = {
    aospRoot: null,
    sourceVendor: null,
    appConfigPath: null,
  };
  const readFlagValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a path value`);
    }
    return path.resolve(value);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-vendor") {
      args.sourceVendor = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--app-config") {
      args.appConfigPath = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (!args.aospRoot) {
      args.aospRoot = path.resolve(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/**
 * Sync the host's `os/android/vendor/<vendorDir>/` into
 * `<aospRoot>/vendor/<vendorDir>/`. After the sync the staged APK
 * must already be present (the build orchestrator runs the APK build
 * before the sync); we fail loudly if it isn't.
 */
export function syncToAosp({ aospRoot, sourceVendor, vendorDir, appName }) {
  if (!aospRoot) throw new Error(USAGE);
  if (!fs.existsSync(sourceVendor)) {
    throw new Error(`Missing vendor source: ${sourceVendor}`);
  }

  const buildEnvsetup = path.join(aospRoot, "build", "envsetup.sh");
  if (!fs.existsSync(buildEnvsetup)) {
    throw new Error(
      `${aospRoot} does not look like an AOSP checkout; missing build/envsetup.sh`,
    );
  }

  const targetVendor = path.join(aospRoot, "vendor", vendorDir);
  fs.rmSync(targetVendor, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetVendor), { recursive: true });
  fs.cpSync(sourceVendor, targetVendor, {
    recursive: true,
    filter: (source) => !source.endsWith(".DS_Store"),
  });

  const apk = path.join(targetVendor, "apps", appName, `${appName}.apk`);
  if (!fs.existsSync(apk)) {
    throw new Error(
      `[aosp:sync] vendor/${vendorDir} synced without ${appName}.apk. ` +
        "Run `bun run build:android:system` before syncing the AOSP product.",
    );
  }

  return targetVendor;
}

export function main(argv = process.argv.slice(2)) {
  const {
    aospRoot,
    sourceVendor: sourceVendorArg,
    appConfigPath: appConfigArg,
  } = parseArgs(argv);

  const appConfigPath = resolveAppConfigPath({
    repoRoot,
    flagValue: appConfigArg,
  });
  const variant = loadAospVariantConfig({ appConfigPath });
  if (!variant) {
    throw new Error(
      `[aosp:sync] No \`aosp:\` block in ${appConfigPath}; nothing to sync.`,
    );
  }

  const sourceVendor =
    sourceVendorArg ??
    path.join(repoRoot, "os", "android", "vendor", variant.vendorDir);

  const targetVendor = syncToAosp({
    aospRoot,
    sourceVendor,
    vendorDir: variant.vendorDir,
    appName: variant.appName,
  });
  console.log(`[aosp:sync] Synced ${sourceVendor} -> ${targetVendor}`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}
